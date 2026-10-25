// Disposable fixtures only; execute the downloaded staging user API against real SDK transactions.
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createRequire } = require('module');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const prefix = 'contribution_probe_' + process.env.PROBE_RUN;
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
  await db.collection('users').doc(actorId).set({ data: { status: 'active', nickName: '虚构编写者', firstEnteredFamilyAt: db.serverDate(), firstExampleViewedAt: db.serverDate() } });
  await db.collection('families').doc(familyId).set({ data: { status: 'active', creatorId: actorId, relationRevision: 0, contentRevision: 0, personCount: 2, relationCount: 0, adminCount: 1, name: '资料编写虚构验收' } });
  await db.collection('family_memberships').doc(membershipId).set({ data: { familyId, userId: actorId, role: 'admin', status: 'active', displayName: '虚构编写者' } });
  for (const [suffix, gender] of [['self', 'male'], ['other', 'female']]) await db.collection('persons').doc(pid(suffix)).set({ data: { familyId, status: 'active', name: '虚构' + suffix, gender, lifeStatus: 'deceased' } });
  async function call(type, fields = {}, code) {
    const result = await api({ type, familyId, requestId: prefix + '_' + ++sequence, ...fields });
    if (code) { check(!result.success && result.code === code, 'PROBE_EXPECTED_' + code + '_GOT_' + result.code); return result; }
    check(result.success, result.code || 'PROBE_API_FAILURE'); return result.data;
  }
  const date = { calendar: 'lunar', precision: 'day', year: 1932, month: 8, day: 8, isLeapMonth: false };
  await call('person.update', { personId: pid('self'), data: { birthDateInfo: date, bio: '虚构家族记忆' } });
  let data = await call('contribution.list', { personId: pid('self') });
  check(data.items.length === 1 && data.items[0].changes.some(c => c.before === '不详' && c.after === '农历 1932年8月8日'), 'PROBE_DATE_DIFF');
  await call('person.update', { personId: pid('self'), data: { birthDateInfo: date, bio: '虚构家族记忆' } });
  check((await call('contribution.list')).items.length === 1, 'PROBE_NO_CHANGE');
  outcomes.push('field_diff_lunar_and_no_change');
  await db.collection('family_memberships').doc(membershipId).update({ data: { role: 'member' } });
  const pending = await call('person.update', { personId: pid('self'), data: { birthPlace: '虚构籍贯' } });
  check((await call('contribution.list')).items.length === 1, 'PROBE_PENDING');
  await db.collection('family_memberships').doc(membershipId).update({ data: { role: 'admin', displayName: '虚构审核者' } });
  await call('change.review', { changeRequestId: pending.requestId, decision: 'approve' });
  data = await call('contribution.list');
  check(data.items.some(item => item.authorName === '虚构编写者' && item.reviewerName === '虚构审核者' && item.changes.some(c => c.after === '虚构籍贯')), 'PROBE_AUTHOR_REVIEWER');
  outcomes.push('approved_author_and_reviewer');
  await call('relation.linkExisting', { anchorPersonId: pid('self'), relatedPersonId: pid('other'), relationType: 'spouse' });
  check((await call('contribution.list', { personId: pid('other') })).items.some(item => item.changes.some(c => c.label === '亲属关系')), 'PROBE_RELATION_ENDPOINT');
  const family = await get('families', familyId);
  await call('relation.reorderSpouses', { personId: pid('self'), orderedPersonIds: [pid('other'), pid('self')], relationRevision: family.relationRevision });
  outcomes.push('relation_endpoints_and_spouse_order');
  const stamp = new Date('2026-10-23T00:00:00Z');
  for (let i = 0; i < 36; i++) await db.collection('audit_logs').doc(prefix + '_legacy_' + String(i).padStart(3, '0')).set({ data: { familyId, actorId, actorName: '虚构早期编写者', action: 'person.update', objectType: 'person', objectId: pid('self'), summary: '虚构早期摘要', createdAt: stamp } });
  await db.collection('family_memberships').doc(membershipId).update({ data: { role: 'viewer' } });
  const seen = new Set(); let cursor = ''; let count = 0;
  do {
    data = await call('contribution.list', { cursor });
    for (const row of data.items) { check(!seen.has(row._id), 'PROBE_DUPLICATE_PAGE'); seen.add(row._id); count++; }
    cursor = data.nextCursor;
  } while (cursor);
  check(count >= 39, 'PROBE_FULL_FREE_HISTORY');
  const summary = await call('contribution.summary');
  check(summary.count === 1, 'PROBE_AUTHOR_DEDUP');
  const filtered = await call('contribution.list', { authorKey: summary.authors[0].key });
  check(filtered.items.length === 30 && filtered.items.every(item => item.authorKey === summary.authors[0].key), 'PROBE_AUTHOR_FILTER');
  check(filtered.items.some(item => item.legacy), 'PROBE_LEGACY_SUMMARY');
  outcomes.push('viewer_free_history_stable_pages_legacy_and_filter');
  await call('contribution.list', { personId: pid('other'), authorKey: '$ne' }, 'INVALID_CONTRIBUTION_QUERY');
  await call('contribution.list', { cursor: 'bad' }, 'INVALID_CONTRIBUTION_CURSOR');
  const serialized = JSON.stringify(filtered);
  check(!serialized.includes(actorId) && !serialized.includes(actor) && !serialized.includes('reviewerId'), 'PROBE_IDENTITY_LEAK');
  await db.collection('family_memberships').doc(membershipId).update({ data: { status: 'left' } });
  await call('contribution.list', {}, 'NO_FAMILY_ACCESS');
  outcomes.push('permission_validation_and_no_identity_leak');
  return { success: true, outcomes };
}
exports.main = async event => {
  const actual = cloud.getWXContext() || {}; const env = process.env.TCB_ENV || process.env.SCF_NAMESPACE || actual.ENV;
  check(process.env.PROBE_ENV && process.env.PROBE_ENV !== 'cloud1-d5gs5yj4l283d9c6d' && env === process.env.PROBE_ENV && (!actual.ENV || actual.ENV === process.env.PROBE_ENV), 'PROBE_ENV');
  check(event && event.secret === process.env.PROBE_SECRET && event.run === process.env.PROBE_RUN, 'PROBE_AUTH');
  if (event.action === 'cleanup') return cleanup();
  check(event.action === 'run', 'PROBE_ACTION'); return run();
};
