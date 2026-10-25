// Business cleanup is separate from expiry cleanup. Callers must have claimed
// the deletion first; every batch rechecks its claim before changing records.
const FAMILY_COLLECTIONS = new Set(['family_memberships', 'user_family_preferences', 'persons', 'relations', 'invitations', 'change_requests', 'media_assets', 'moderation_tasks', 'reports', 'notifications', 'audit_logs', 'membership_grants', 'export_tasks']);
const ACCOUNT_FIELDS = { invitations: 'createdBy', audit_logs: 'actorId', payment_orders: 'payerUserId', membership_codes: 'redeemedBy', membership_redemptions: 'redeemedBy' };
async function read(db, name, id) {
  try { return (await db.collection(name).doc(id).get()).data; }
  catch (error) { if (error.errCode === -1 || error.code === 'DOCUMENT_NOT_FOUND') return null; throw error; }
}
function rejected() { throw Object.assign(new Error('维护任务状态或范围已改变，请恢复任务后重试'), { code: 'MAINTENANCE_BATCH_REJECTED' }); }
function validate(name, where, method, claim) {
  if (!claim || !where || !['update', 'remove'].includes(method)) rejected();
  if (claim.kind === 'account') {
    const field = name === 'audit_logs' ? ['actorId', 'contribution.authorId', 'contribution.reviewerId'].find(key => where[key] === claim.userId) : ACCOUNT_FIELDS[name];
    if (method !== 'update' || !claim.requestId || !claim.userId || !field || where[field] !== claim.userId) rejected();
    if (Object.keys(where).some(key => key !== field && !(name === 'invitations' && key === 'status' && where.status === 'active'))) rejected();
  } else if (claim.kind === 'family') {
    const field = name === 'membership_codes' ? 'redeemedFamilyId' : 'familyId';
    if (!claim.familyId || where[field] !== claim.familyId) rejected();
    if (method === 'remove' ? !FAMILY_COLLECTIONS.has(name) : !['payment_orders', 'membership_redemptions', 'membership_codes'].includes(name)) rejected();
    if (Object.keys(where).some(key => key !== field && !(name === 'payment_orders' && key === 'status' && where.status === 'pending'))) rejected();
  } else rejected();
}
async function verifyClaim(db, claim) {
  if (claim.kind === 'family') {
    const family = await read(db, 'families', claim.familyId);
    if (!family || family.status !== 'deleting') rejected();
  } else {
    const request = await read(db, 'account_deletion_requests', claim.requestId);
    const user = await read(db, 'users', claim.userId);
    if (!request || request.userId !== claim.userId || request.status !== 'processing' || !user || user.status !== 'deleted') rejected();
  }
}
async function apply(db, name, where, data, limit, claim, method = 'update') {
  validate(name, where, method, claim);
  if (!Number.isInteger(limit) || limit < 1) rejected();
  let selected = 0; let processed = 0; let cursor = '';
  while (selected < limit) {
    const condition = cursor ? db.command.and([where, { _id: db.command.gt(cursor) }]) : where;
    const size = Math.min(100, limit - selected);
    const page = await db.collection(name).where(condition).orderBy('_id', 'asc').limit(size).get();
    const ids = (page.data || []).map(row => row._id).filter(Boolean).slice(0, size);
    if (!ids.length) break;
    selected += ids.length;
    await verifyClaim(db, claim);
    const query = db.collection(name).where(db.command.and([where, { _id: db.command.in(ids) }]));
    const result = method === 'remove' ? await query.remove() : await query.update({ data });
    const count = Number(result && result.stats && result.stats[method === 'remove' ? 'removed' : 'updated']) || 0;
    processed += count;
    if (!count || ids.length < size) break;
    cursor = ids[ids.length - 1];
  }
  return processed;
}
module.exports = { apply, verifyClaim };
