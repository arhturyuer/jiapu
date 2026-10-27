// Disposable staging fixtures; execute downloaded user source and deployed jobs.
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');
const { createRequire } = require('module');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const prefix = 'profile_probe_' + process.env.PROBE_RUN;
const actor = prefix + '_actor';
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const actorId = 'u_' + hash(actor), familyId = prefix + '_family', membershipId = 'fm_' + hash(familyId + ':' + actor);
function check(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
async function get(name, id) {
  try { return (await db.collection(name).doc(id).get()).data; }
  catch (error) { if (/does not exist|not found/i.test(error.message || error.errMsg || '')) return null; throw error; }
}
async function rows(name, where) {
  const result = (await db.collection(name).where(where).limit(100).get()).data || [];
  check(result.length < 100, 'PROBE_CLEANUP_LIMIT'); return result;
}
function runtime(seen) {
  const file = path.join(__dirname, 'user/index.js'), localRequire = createRequire(file);
  const mockedCloud = { init() {}, DYNAMIC_CURRENT_ENV: cloud.DYNAMIC_CURRENT_ENV, database: () => db,
    getWXContext: () => ({ OPENID: actor, ENV: process.env.PROBE_ENV }),
    openapi: { security: { msgSecCheck: async ({ content }) => { seen.push(content); return { result: { suggest: content.includes('尾部拒绝') ? 'risky' : 'pass' } }; } } } };
  const sandbox = { exports: {}, module: { exports: {} }, __dirname: path.dirname(file), __filename: file,
    require: name => name === 'wx-server-sdk' ? mockedCloud : name === './job-dispatcher' ? { dispatchJob: async () => ({ requestId: prefix }) } : localRequire(name),
    process, Buffer, URL, Date, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file }); return sandbox.exports.main;
}
function zipEntry(buffer, name) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  check(end >= 0, 'PROBE_ZIP_END');
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    check(buffer.readUInt32LE(offset) === 0x02014b50, 'PROBE_ZIP_DIRECTORY');
    const length = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    if (buffer.subarray(offset + 46, offset + 46 + length).toString('utf8') === name) {
      const local = buffer.readUInt32LE(offset + 42), size = buffer.readUInt32LE(offset + 20);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const bytes = buffer.subarray(start, start + size);
      return JSON.parse((buffer.readUInt16LE(offset + 10) === 8 ? zlib.inflateRawSync(bytes) : bytes).toString('utf8'));
    }
    offset += 46 + length + extra + comment;
  }
  throw new Error('PROBE_ZIP_ENTRY_MISSING');
}
async function job(action, taskId) {
  const response = await cloud.callFunction({ name: 'youpuJobs', data: { action, taskId, internalSecret: process.env.PROBE_JOBS_SECRET } });
  check(response.result && response.result.success, 'PROBE_DEPLOYED_JOB_FAILED'); return response.result.data;
}
async function run() {
  const seen = [], api = runtime(seen), outcomes = []; let sequence = 0;
  await db.collection('users').doc(actorId).set({ data: { status: 'active', nickName: '虚构资料验收者', firstEnteredFamilyAt: db.serverDate(), firstExampleViewedAt: db.serverDate() } });
  await db.collection('families').doc(familyId).set({ data: { name: '资料页虚构验收', description: '', status: 'active', creatorId: actorId, personCount: 1, relationCount: 0, adminCount: 1, contentRevision: 0, relationRevision: 0, proLifetime: true } });
  await db.collection('family_memberships').doc(membershipId).set({ data: { familyId, userId: actorId, role: 'admin', status: 'active', displayName: '虚构资料验收者' } });
  await db.collection('persons').doc(prefix + '_person').set({ data: { familyId, name: '虚构人物', status: 'active', gender: 'unknown' } });
  async function call(type, fields = {}, code) {
    const result = await api({ type, familyId, name: '资料页虚构验收', description: '', requestId: prefix + '_' + ++sequence, ...fields });
    if (code) { check(!result.success && result.code === code, 'PROBE_EXPECTED_' + code + '_GOT_' + result.code); return; }
    check(result.success, result.code || 'PROBE_API'); return result.data;
  }
  const anonymous = await cloud.callFunction({ name: 'youpuUserApi', data: { type: 'family.profile', familyId } });
  check(anonymous.result && anonymous.result.success === false, 'PROBE_GATEWAY_ANONYMOUS_DENIED');
  const legacyCopy = await call('family.copy.create', { name: '旧资料虚构副本' });
  await job('task.family-copy', legacyCopy.taskId);
  const legacyTask = await get('family_copy_tasks', legacyCopy.taskId);
  check(legacyTask.status === 'completed', 'PROBE_LEGACY_COPY_COMPLETED');
  const legacyFamily = await get('families', legacyTask.targetFamilyId);
  check(legacyFamily && !legacyFamily.history && !legacyFamily.familyMotto, 'PROBE_LEGACY_COPY_DEFAULTS');
  outcomes.push('legacy_profile_copy_and_deployed_anonymous_denial');
  const expected = { surname: '虚', ancestralHome: '虚构祖籍', hallName: '虚构堂号', generationPoem: '甲乙\n丙丁', history: '虚构历史'.repeat(700), familyMotto: '以诚待人\n和睦传家', featuredSection: 'familyMotto' };
  await call('family.update', expected);
  const detail = await call('family.profile');
  for (const [key, value] of Object.entries(expected)) check(detail.profile[key] === value, 'PROBE_DETAIL_' + key);
  const summary = (await call('family.list')).families.find(row => row._id === familyId);
  check(!('history' in summary) && summary.featuredExcerpt === expected.familyMotto, 'PROBE_LIGHT_SUMMARY');
  await call('family.update');
  check((await call('family.profile')).profile.history === expected.history, 'PROBE_OLD_CLIENT');
  outcomes.push('full_profile_summary_old_client_compatibility');
  await call('family.update', { history: '前'.repeat(2850) + prefix + '尾部拒绝' }, 'CONTENT_NOT_ALLOWED');
  check(seen.some(text => text.includes('尾部拒绝')), 'PROBE_TAIL_MODERATION');
  check((await get('families', familyId)).history === expected.history, 'PROBE_REJECTED_ATOMICITY');
  outcomes.push('long_text_tail_moderation_and_atomic_rejection');
  for (const role of ['member', 'viewer']) {
    await db.collection('family_memberships').doc(membershipId).update({ data: { role } });
    check((await call('family.profile')).profile.history === expected.history, 'PROBE_ROLE_READ');
    await call('family.update', { surname: '拒绝' }, 'NO_PERMISSION');
  }
  await db.collection('family_memberships').doc(membershipId).update({ data: { role: 'admin' } });
  const records = await call('contribution.list');
  check(records.items.some(row => row.changes.some(change => change.label === '家训' && change.after === expected.familyMotto)), 'PROBE_CONTRIBUTION');
  await call('family.update', { history: '清空后恢复' }); await call('family.update', { history: '' });
  check((await call('family.profile')).profile.history === '', 'PROBE_CLEAR');
  await call('family.update', { history: expected.history });
  outcomes.push('roles_contributions_and_explicit_clear');
  const copy = await call('family.copy.create', { name: '虚构资料副本' });
  await job('task.family-copy', copy.taskId);
  const copiedTask = await get('family_copy_tasks', copy.taskId);
  check(copiedTask.status === 'completed', 'PROBE_COPY_COMPLETED');
  const copied = await get('families', copiedTask.targetFamilyId);
  for (const [key, value] of Object.entries(expected)) check(copied[key] === value, 'PROBE_COPY_' + key);
  check(copied.proLifetime !== true, 'PROBE_COPY_ENTITLEMENT');
  outcomes.push('deployed_copy_worker_preserves_profile');
  const backup = await call('family.backup.create');
  await job('task.family-backup', backup.taskId);
  const task = await get('export_tasks', backup.taskId);
  check(task.status === 'completed' && task.parts.length === 1, 'PROBE_BACKUP_COMPLETED');
  const file = await cloud.downloadFile({ fileID: task.parts[0].fileId });
  const exported = zipEntry(file.fileContent, '家谱信息.json');
  for (const [key, value] of Object.entries(expected)) check(exported[key] === value, 'PROBE_BACKUP_' + key);
  outcomes.push('deployed_backup_zip_preserves_profile');
  await db.collection('family_memberships').doc(membershipId).update({ data: { status: 'left' } });
  await call('family.profile', {}, 'NO_FAMILY_ACCESS');
  outcomes.push('left_member_denied');
  return { success: true, outcomes };
}
async function cleanup() {
  const copies = await rows('family_copy_tasks', { userId: actorId });
  check(copies.every(task => task.sourceFamilyId === familyId && task.status !== 'processing'), 'PROBE_ACTIVE_COPY_OR_SCOPE');
  const familyIds = [familyId, ...copies.map(task => task.targetFamilyId)];
  for (const id of familyIds) {
    const family = await get('families', id); if (family) check(family.creatorId === actorId, 'PROBE_FIXTURE_OWNER');
    const exports = await rows('export_tasks', { familyId: id });
    check(exports.every(task => task.userId === actorId && task.status !== 'processing'), 'PROBE_ACTIVE_BACKUP_OR_SCOPE');
    for (const task of exports) {
      const files = (task.parts || []).map(part => part.fileId);
      if (files.length) { const deleted = await cloud.deleteFile({ fileList: files }); check(deleted.fileList && deleted.fileList.every(file => Number(file.status || 0) === 0), 'PROBE_FILE_CLEANUP'); }
    }
    for (const name of ['persons', 'relations', 'family_memberships', 'audit_logs', 'change_requests', 'notifications', 'export_tasks']) {
      for (const row of await rows(name, { familyId: id })) await db.collection(name).doc(row._id).remove();
      check((await rows(name, { familyId: id })).length === 0, 'PROBE_CLEANUP_REMAINING');
    }
    for (const row of await rows('analytics_activity_daily', { entityId: id })) await db.collection('analytics_activity_daily').doc(row._id).remove();
    if (family) await db.collection('families').doc(id).remove();
  }
  for (const task of copies) {
    for (const chunk of await rows('family_copy_chunks', { taskId: task._id })) await db.collection('family_copy_chunks').doc(chunk._id).remove();
    await db.collection('family_copy_tasks').doc(task._id).remove();
  }
  for (const [name, where] of [['idempotency_records', { actorId }], ['rate_limits', { actorId }], ['moderation_tasks', { requestedBy: actorId }], ['analytics_activity_daily', { entityId: actorId }]]) {
    for (const row of await rows(name, where)) await db.collection(name).doc(row._id).remove();
    check((await rows(name, where)).length === 0, 'PROBE_ACTOR_CLEANUP_REMAINING');
  }
  if (await get('users', actorId)) await db.collection('users').doc(actorId).remove();
  return { success: true, cleaned: true };
}
exports.main = async event => {
  const actual = cloud.getWXContext() || {}, env = process.env.TCB_ENV || process.env.SCF_NAMESPACE || actual.ENV;
  check(process.env.PROBE_ENV && process.env.PROBE_ENV !== 'cloud1-d5gs5yj4l283d9c6d' && env === process.env.PROBE_ENV && (!actual.ENV || actual.ENV === process.env.PROBE_ENV), 'PROBE_ENV');
  check(event && event.secret === process.env.PROBE_SECRET && event.run === process.env.PROBE_RUN, 'PROBE_AUTH');
  if (event.action === 'cleanup') return cleanup();
  check(event.action === 'run', 'PROBE_ACTION'); return run();
};
