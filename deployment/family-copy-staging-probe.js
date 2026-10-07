// Temporary staging-only function, packaged by verify-family-copy-staging.mjs.
// Never part of either production function's deployable directory.
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const copyApi = require('./family-copy-api');
const dispatcher = require('./job-dispatcher');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
function check(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
async function read(scope, name, id) {
  try { return (await scope.collection(name).doc(id).get()).data || null; }
  catch (error) { if (/document with _id [^\s]+ does not exist/.test(String(error.errMsg || error.message))) return null; throw error; }
}
async function list(name, where) {
  let cursor = ''; const rows = [];
  while (true) {
    const result = await db.collection(name).where(Object.assign({}, where, cursor ? { _id: db.command.gt(cursor) } : {})).orderBy('_id', 'asc').limit(100).get();
    const page = result.data || []; rows.push(...page);
    check(rows.length <= 5000, 'PROBE_LIMIT');
    if (page.length < 100) return rows;
    cursor = page[page.length - 1]._id;
  }
}
async function remove(name, where) { for (const row of await list(name, where)) await db.collection(name).doc(row._id).remove(); }
function ids(run, size) {
  const sourceId = 'copy_probe_' + run + '_' + size;
  return { sourceId, actors: ['admin', 'member', 'viewer'].map(role => ({ id: 'u_cp_' + hash(sourceId + role), role })) };
}
async function seed(run, large, phase, offset) {
  const size = large ? 500 : 12; const fixture = ids(run, size);
  if (phase === 'start') {
  await db.collection('system_config').doc('copy_probe_' + run).set({ data: { fixtures: [ids(run, 12), ids(run, 500)] } });
  const actors = large ? fixture.actors.slice(0, 1) : fixture.actors;
  await db.collection('families').doc(fixture.sourceId).set({ data: {
    name: '复制验收虚构家谱', description: '仅 staging 虚构验收资料', status: 'active', creatorId: actors[0].id,
    personCount: size, relationCount: large ? 2000 : 15, adminCount: 1, contentRevision: 0,
    proLifetime: true, createdAt: db.serverDate(), updatedAt: db.serverDate()
  } });
  for (const actor of actors) {
    await db.collection('users').doc(actor.id).set({ data: { status: 'active', nickName: '虚构验收用户', createdAt: db.serverDate() } });
    await db.collection('family_memberships').doc('fm_cp_' + hash(fixture.sourceId + actor.id)).set({ data: { familyId: fixture.sourceId, userId: actor.id, role: actor.role, status: 'active', displayName: '虚构验收用户', joinedAt: db.serverDate() } });
  }
  return { size, initialized: true };
  }
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
  const avatarCount = large ? 100 : 3;
  if (phase === 'avatars') for (let i = offset; i < Math.min(avatarCount, offset + 10); i += 1) {
    const assetId = 'media_cp_' + hash(fixture.sourceId + ':' + i);
    const cloudPath = 'copy-probe/' + run + '/' + size + '/' + i + '.png';
    const uploaded = await cloud.uploadFile({ cloudPath, fileContent: image });
    await db.collection('media_assets').doc(assetId).set({ data: {
      familyId: fixture.sourceId, ownerId: fixture.actors[0].id, kind: 'person_avatar', status: 'active',
      moderationStatus: i === avatarCount - 1 ? 'review' : 'approved', fileId: uploaded.fileID, cloudPath, size: image.length, createdAt: db.serverDate()
    } });
  }
  if (phase === 'persons') for (let i = offset; i < Math.min(size, offset + 50); i += 1) await db.collection('persons').doc('pcp_' + hash(fixture.sourceId + ':' + i)).set({ data: {
    familyId: fixture.sourceId, name: '虚构人物' + i, gender: i % 2 ? 'female' : 'male', lifeStatus: 'living', bio: '虚构简介', birthPlace: '虚构地点',
    birthDate: '', birthDateInfo: { calendar: 'solar', precision: 'year', year: 1980 }, birthDateRange: { start: '1980-01-01', end: '1980-12-31' },
    avatarAssetId: i < avatarCount ? 'media_cp_' + hash(fixture.sourceId + ':' + i) : '', status: 'active', createdAt: db.serverDate(), updatedAt: db.serverDate()
  } });
  let count = 0;
  const maximum = large ? 2000 : 15;
  for (let gap = 1; count < maximum; gap += 1) for (let i = 0; i + gap < size && count < maximum; i += 1) {
    const current = count++;
    if (phase !== 'relations' || current < offset || current >= offset + 50) continue;
    await db.collection('relations').doc('rcp_' + hash(fixture.sourceId + ':' + current)).set({ data: {
      familyId: fixture.sourceId, type: 'parent_child', fromPersonId: 'pcp_' + hash(fixture.sourceId + ':' + i), toPersonId: 'pcp_' + hash(fixture.sourceId + ':' + (i + gap)), childOrder: i, status: 'active'
    } });
  }
  return { size, relationCount: maximum, avatarCount };
}
async function runCase(run, large, role, startOnly) {
  const fixture = ids(run, large ? 500 : 12); const actor = fixture.actors.find(item => item.role === role);
  const memberId = 'fm_cp_' + hash(fixture.sourceId + actor.id);
  const service = copyApi.createService({
    db, assert: check, getOpenid: () => actor.id,
    requireActiveUser: async () => { const user = await read(db, 'users', actor.id); check(user && user.status === 'active', 'ACCOUNT_UNAVAILABLE'); return user; },
    requireMembership: async (familyId, roles, scope) => {
      const family = await read(scope, 'families', familyId); const membership = await read(scope, 'family_memberships', memberId);
      check(family && family.status === 'active' && membership && membership.familyId === familyId && membership.status === 'active' && roles.includes(membership.role), 'NO_FAMILY_ACCESS');
      return { family, membership };
    },
    membershipId: familyId => 'fm_cp_' + hash(familyId + actor.id), moderateText: async () => {}, dispatchJob: async () => {},
    mutate: async (action, event, openid, callback) => db.runTransaction(async tx => {
      const key = 'idem_cp_' + hash(actor.id + ':' + event.requestId);
      const existing = await read(tx, 'idempotency_records', key);
      if (existing) return existing.result;
      const result = await callback(tx);
      await tx.collection('idempotency_records').doc(key).set({ data: { actorId: actor.id, result } });
      return result;
    })
  });
  const input = { familyId: fixture.sourceId, name: '虚构验收副本', requestId: 'probe-' + run + '-' + role };
  const task = await service.create(input); const retry = await service.create(input);
  check(task.taskId === retry.taskId, 'PROBE_IDEMPOTENCY');
  const actorAfter = await read(db, 'users', actor.id); check(actorAfter.copyCount === 1, 'PROBE_QUOTA');
  if (startOnly && task.status !== 'completed') {
  let blocked = false;
  try { await service.create(Object.assign({}, input, { requestId: input.requestId + '-parallel' })); }
  catch (error) { blocked = error.code === 'COPY_IN_PROGRESS'; }
  check(blocked, 'PROBE_CONCURRENCY');
  }
  if (startOnly) {
    await dispatcher.dispatchJob('task.family-copy', task.taskId);
    return { taskId: task.taskId, started: true };
  }
  const status = (await service.status({ taskId: task.taskId })).task;
  if (['pending', 'processing'].includes(status.status)) return { taskId: task.taskId, status: status.status, stage: status.stage };
  check(status.status === 'completed', 'PROBE_COMPLETION_' + status.failureCode);
  const target = await read(db, 'families', status.family._id);
  check(!target.proLifetime && target.creatorId === actor.id && target.adminCount === 1, 'PROBE_TARGET');
  const persons = await list('persons', { familyId: target._id });
  const relations = await list('relations', { familyId: target._id });
  const assets = await list('media_assets', { familyId: target._id });
  check(persons.length === (large ? 500 : 12) && relations.length === (large ? 2000 : 15) && status.missingAvatars.length === 1, 'PROBE_COUNTS');
  check(persons.every(p => p.bio === '虚构简介' && p.birthDateInfo.year === 1980), 'PROBE_FIELDS');
  check(assets.length === (large ? 99 : 2) && assets.every(a => a.ownerId === actor.id && a.cloudPath.startsWith('family-copies/')), 'PROBE_MEDIA');
  for (const asset of assets) check((await cloud.downloadFile({ fileID: asset.fileId })).fileContent.length > 0, 'PROBE_MEDIA_BYTES');
  const repeated = await cloud.callFunction({ name: 'youpuJobs', data: { action: 'task.family-copy', taskId: task.taskId, internalSecret: process.env.JOB_DISPATCH_SECRET } });
  check(repeated.result.data.skipped, 'PROBE_DUPLICATE');
  const snapshots = await list('family_copy_chunks', { taskId: task.taskId }); check(!snapshots.length, 'PROBE_SNAPSHOT_CLEAN');
  return { role, personCount: persons.length, relationCount: relations.length, independentAvatars: assets.length, missingAvatars: status.missingAvatars.length, taskId: task.taskId, targetFamilyId: target._id };
}
async function cleanup(run) {
  const deadline = Date.now() + 15000;
  const fixtures = [ids(run, 12), ids(run, 500)];
  for (const fixture of fixtures) {
    const tasks = await list('family_copy_tasks', { sourceFamilyId: fixture.sourceId });
    check(!tasks.some(t => t.status === 'processing' && new Date(t.leaseUntil).getTime() > Date.now()), 'PROBE_STILL_RUNNING');
    const families = [fixture.sourceId].concat(tasks.map(t => t.targetFamilyId));
    for (const familyId of families) {
      const media = await list('media_assets', { familyId });
      for (let i = 0; i < media.length; i += 20) {
        const files = media.slice(i, i + 20).map(a => a.fileId).filter(Boolean);
        if (files.length) {
          const response = await cloud.deleteFile({ fileList: files });
          check(response.fileList.every(f => Number(f.status || 0) === 0 || /not.?found|not.?exist/i.test(f.errMsg || '')), 'PROBE_CLEAN_FILES');
        }
        for (const asset of media.slice(i, i + 20)) await db.collection('media_assets').doc(asset._id).update({ data: { fileId: '' } });
        if (Date.now() > deadline) return { cleaned: false };
      }
      for (const collection of ['persons', 'relations', 'family_memberships', 'media_assets', 'audit_logs']) {
        const rows = await list(collection, { familyId });
        for (let i = 0; i < rows.length; i += 20) {
          await Promise.all(rows.slice(i, i + 20).map(row => db.collection(collection).doc(row._id).remove()));
          if (Date.now() > deadline) return { cleaned: false };
        }
      }
      await db.collection('families').doc(familyId).remove();
    }
    for (const task of tasks) { await remove('family_copy_chunks', { taskId: task._id }); await db.collection('family_copy_tasks').doc(task._id).remove(); }
    for (const actor of fixture.actors) { await remove('idempotency_records', { actorId: actor.id }); await db.collection('users').doc(actor.id).remove(); }
  }
  await db.collection('system_config').doc('copy_probe_' + run).remove();
  return { cleaned: true };
}
exports.main = async function (event) {
  try {
    const actual = cloud.getWXContext().ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE;
    check(process.env.PROBE_ENV && actual === process.env.PROBE_ENV && actual !== 'cloud1-d5gs5yj4l283d9c6d' && event.secret === process.env.PROBE_SECRET, 'PROBE_UNAUTHORIZED');
    check(/^[a-f0-9]{12}$/.test(event.run || ''), 'PROBE_RUN_INVALID');
    let data;
    if (event.action === 'seed') data = await seed(event.run, Boolean(event.large), event.phase, Math.max(0, Number(event.offset) || 0));
    else if (event.action === 'run') { check(['admin', 'member', 'viewer'].includes(event.role), 'PROBE_ROLE'); data = await runCase(event.run, Boolean(event.large), event.role, event.startOnly === true); }
    else if (event.action === 'gateway') {
      const fixture = ids(event.run, 12);
      const taskId = 'copy_forbidden_' + event.run;
      await db.collection('family_copy_tasks').doc(taskId).set({ data: { userId: fixture.actors[0].id, sourceFamilyId: fixture.sourceId, targetFamilyId: 'fcopy_forbidden_' + event.run, status: 'failed', stage: 'snapshot', createdAt: db.serverDate() } });
      const create = await cloud.callFunction({ name: 'youpuUserApi', data: { type: 'family.copy.create', familyId: fixture.sourceId, name: '虚构权限验收', requestId: 'gateway-' + event.run } });
      check(create.result && !create.result.success && ['NO_FAMILY_ACCESS', 'UNAUTHENTICATED'].includes(create.result.code), 'PROBE_GATEWAY_CREATE');
      const status = await cloud.callFunction({ name: 'youpuUserApi', data: { type: 'family.copy.status', taskId } });
      check(status.result && !status.result.success && ['COPY_NOT_FOUND', 'UNAUTHENTICATED'].includes(status.result.code), 'PROBE_GATEWAY_STATUS');
      const schema = await read(db, 'system_config', 'schema');
      check(schema.version === 11, 'PROBE_SCHEMA');
      data = { createDenied: create.result.code, taskDenied: status.result.code, schemaVersion: schema.version };
    }
    else if (event.action === 'inspect') {
      data = {};
      for (const size of [12, 500]) {
        const fixture = ids(event.run, size);
        data[size] = { people: (await db.collection('persons').where({ familyId: fixture.sourceId }).count()).total, relations: (await db.collection('relations').where({ familyId: fixture.sourceId }).count()).total };
      }
    }
    else if (event.action === 'cleanup') data = await cleanup(event.run);
    else throw new Error('PROBE_ACTION');
    return { success: true, data };
  } catch (error) { return { success: false, code: error.code || 'PROBE_FAILED', message: String(error.message).slice(0, 200) }; }
};
