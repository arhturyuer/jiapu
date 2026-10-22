// Disposable fixtures only; execute the downloaded staging user API against real SDK transactions.
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createRequire } = require('module');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const prefix = 'spouse_probe_' + process.env.PROBE_RUN;
const actor = prefix + '_actor';
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const actorId = 'u_' + hash(actor); const familyId = prefix + '_family';
const membershipId = 'fm_' + hash(familyId + ':' + actor);
const pid = suffix => prefix + '_' + suffix;
function check(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
async function get(name, id) { return (await db.collection(name).doc(id).get().catch(() => ({ data: null }))).data; }
function runtime() {
  const file = path.join(__dirname, 'user/index.js'); const localRequire = createRequire(file);
  const mockCloud = { init() {}, DYNAMIC_CURRENT_ENV: cloud.DYNAMIC_CURRENT_ENV, database: () => db,
    getWXContext: () => ({ OPENID: actor, ENV: process.env.PROBE_ENV }),
    openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } };
  const sandbox = { exports: {}, module: { exports: {} }, __dirname: path.dirname(file), __filename: file,
    require: name => name === 'wx-server-sdk' ? mockCloud : localRequire(name), Buffer, URL, Date, process, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file }); return sandbox.exports.main;
}
async function rows(name, where) {
  const found = (await db.collection(name).where(where).limit(100).get()).data || [];
  check(found.length < 100, 'PROBE_CLEANUP_LIMIT'); return found;
}
async function cleanup() {
  const family = await get('families', familyId);
  if (family) check(family.creatorId === actorId, 'PROBE_FIXTURE_OWNER');
  for (const [name, where] of [
    ['persons', { familyId }], ['relations', { familyId }], ['change_requests', { familyId }], ['audit_logs', { familyId }],
    ['notifications', { familyId }], ['idempotency_records', { actorId }], ['rate_limits', { actorId }], ['analytics_activity_daily', { entityId: actorId }], ['analytics_activity_daily', { entityId: familyId }]
  ]) {
    for (const row of await rows(name, where)) await db.collection(name).doc(row._id).remove();
    check((await rows(name, where)).length === 0, 'PROBE_CLEANUP_REMAINING');
  }
  for (const [name, id] of [['family_memberships', membershipId], ['families', familyId], ['users', actorId]]) {
    if (await get(name, id)) await db.collection(name).doc(id).remove();
  }
  return { success: true, cleaned: true };
}
async function run() {
  const api = runtime(); let sequence = 0; const outcomes = [];
  await db.collection('users').doc(actorId).set({ data: { status: 'active', firstEnteredFamilyAt: db.serverDate(), firstExampleViewedAt: db.serverDate() } });
  await db.collection('families').doc(familyId).set({ data: { status: 'active', creatorId: actorId, relationRevision: 0, contentRevision: 0, personCount: 2, relationCount: 1, adminCount: 1, name: '夫妻顺序虚构验收' } });
  await db.collection('family_memberships').doc(membershipId).set({ data: { familyId, userId: actorId, role: 'admin', status: 'active', displayName: '虚构管理员' } });
  for (const [suffix, gender] of [['self', 'male'], ['wife', 'female']]) await db.collection('persons').doc(pid(suffix)).set({ data: { familyId, status: 'active', name: '虚构' + suffix, gender } });
  const pair = [pid('self'), pid('wife')].sort();
  const relationId = 'r_' + crypto.createHash('sha256').update([familyId, 'spouse', ...pair].join(':')).digest('hex').slice(0, 40);
  await db.collection('relations').doc(relationId).set({ data: { familyId, type: 'spouse', fromPersonId: pair[0], toPersonId: pair[1], status: 'active' } });
  async function call(type, fields = {}, code) {
    const result = await api({ type, requestId: prefix + '_' + ++sequence, ...fields });
    if (code) { check(!result.success && result.code === code, 'PROBE_EXPECTED_' + code + '_GOT_' + result.code); return result; }
    check(result.success, result.code || 'PROBE_API_FAILURE'); return result.data;
  }
  async function reorder(personId, ids, extra = {}, code) {
    const family = await get('families', familyId);
    return call('relation.reorderSpouses', { familyId, personId, orderedPersonIds: ids, relationRevision: family.relationRevision, ...extra }, code);
  }
  await reorder(pid('self'), [pid('wife'), pid('self')]);
  check((await get('persons', pid('self'))).spouseDisplayOrder.join() === [pid('wife'), pid('self')].join(), 'PROBE_SINGLE_SWAP');
  await reorder(pid('wife'), [pid('self'), pid('wife')]);
  check((await get('persons', pid('self'))).spouseDisplayOrder.join() === [pid('self'), pid('wife')].join(), 'PROBE_SHARED_COUPLE');
  outcomes.push('single_couple_both_editors');
  const added = await call('person.createRelated', { familyId, anchorPersonId: pid('self'), relationType: 'spouse', person: { name: '虚构新增配偶', gender: 'female' } });
  const newId = added.person._id;
  check((await get('persons', pid('self'))).spouseDisplayOrder.slice(-1)[0] === newId, 'PROBE_APPEND');
  await reorder(pid('self'), [newId, pid('self'), pid('wife')]);
  const loaded = await call('graph.get', { familyId });
  const graph = require('./user/pdf-shared/graph-layout');
  const sorted = graph.layoutGraph(loaded.persons, loaded.relations, { mode: 'full' }).nodes.sort((a, b) => a.x - b.x).map(p => p._id);
  check(sorted.join() === [newId, pid('self'), pid('wife')].join(), 'PROBE_GRAPH_ORDER');
  const detail = await call('person.get', { personId: pid('self') });
  check(detail.relatives.filter(r => r.role === 'spouse').map(r => r.person._id).join() === [newId, pid('wife')].join(), 'PROBE_DETAIL');
  const snap = require('./user/pdf-shared/pdf-layout-snapshot');
  for (const nameLayout of ['horizontal', 'vertical']) {
    const value = snap.create(loaded.persons, loaded.relations, nameLayout, loaded.contentRevision);
    const restored = snap.restore(value, loaded.persons, loaded.relations, loaded.contentRevision, nameLayout);
    check(restored.nodes.sort((a, b) => a.x - b.x).map(p => p._id).join() === sorted.join(), 'PROBE_PDF_SNAPSHOT');
  }
  outcomes.push('multiple_append_graph_detail_pdf_snapshot');
  await reorder(pid('self'), [pid('wife'), newId], {}, 'GRAPH_CHANGED');
  await reorder(pid('self'), [newId, pid('wife'), pid('self')], { relationRevision: 0 }, 'GRAPH_CHANGED');
  await db.collection('family_memberships').doc(membershipId).update({ data: { role: 'viewer' } });
  await reorder(pid('self'), [newId, pid('wife'), pid('self')], {}, 'NO_PERMISSION');
  await db.collection('family_memberships').doc(membershipId).update({ data: { role: 'member' } });
  const pending = await reorder(pid('self'), [pid('self'), pid('wife'), newId]);
  check(pending.pending && (await get('persons', pid('self'))).spouseDisplayOrder[0] === newId, 'PROBE_PENDING');
  await db.collection('family_memberships').doc(membershipId).update({ data: { role: 'admin' } });
  await call('change.review', { changeRequestId: pending.requestId, decision: 'approve' });
  check((await get('persons', pid('self'))).spouseDisplayOrder[0] === pid('self'), 'PROBE_APPROVE');
  outcomes.push('permissions_revision_member_review');
  // A single-spouse editor now overlaps the owner's larger group: reversal conflicts.
  await reorder(pid('wife'), [pid('wife'), pid('self')], {}, 'SPOUSE_ORDER_CONFLICT');
  outcomes.push('overlapping_group_conflict');
  await call('person.delete', { personId: newId });
  check((await get('persons', pid('self'))).spouseDisplayOrder.join() === [pid('self'), pid('wife')].join(), 'PROBE_DELETE_PRESERVES');
  outcomes.push('delete_preserves_order');
  return { success: true, outcomes };
}
exports.main = async event => {
  const actual = cloud.getWXContext() || {}; const env = process.env.TCB_ENV || process.env.SCF_NAMESPACE || actual.ENV;
  check(process.env.PROBE_ENV && process.env.PROBE_ENV !== 'cloud1-d5gs5yj4l283d9c6d' && env === process.env.PROBE_ENV && (!actual.ENV || actual.ENV === process.env.PROBE_ENV), 'PROBE_ENV');
  check(event && event.secret === process.env.PROBE_SECRET && event.run === process.env.PROBE_RUN, 'PROBE_AUTH');
  if (event.action === 'cleanup') return cleanup();
  check(event.action === 'run', 'PROBE_ACTION'); return run();
};
