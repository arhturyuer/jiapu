const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const apiModule = require('../cloudfunctions/youpuUserApi/family-copy');
const jobsModule = require('../cloudfunctions/youpuJobs/family-copy');
const { createDatabase } = require('./helpers/family-copy-db');
function business(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
function harness(role = 'viewer') {
  const db = createDatabase(); const files = new Map(); const dispatched = []; let downloadHook; let deleteHook;
  db.put('users', 'actor', { status: 'active', nickName: '虚构用户' });
  db.put('families', 'source', { name: '虚构家谱', description: '家谱简介', status: 'active', proLifetime: true });
  db.put('family_memberships', 'source-member', { familyId: 'source', userId: 'actor', role, status: 'active' });
  db.put('persons', 'p1', { familyId: 'source', name: '同名', gender: 'male', bio: '完整简介', status: 'active', avatarAssetId: 'photo', birthDate: '1980-01-01', birthDateInfo: { calendar: 'lunar', precision: 'day', year: 1980, month: 1, day: 1 }, birthDateRange: { start: '1980-01-01', end: '1980-01-01' } });
  db.put('persons', 'p2', { familyId: 'source', name: '同名', gender: 'female', status: 'active' });
  db.put('persons', 'p3', { familyId: 'source', name: '孩子', gender: 'unknown', status: 'active' });
  for (const [id, type, from, to, order] of [['r1', 'spouse', 'p1', 'p2'], ['r2', 'parent_child', 'p1', 'p3', 0], ['r3', 'parent_child', 'p2', 'p3', 0]]) db.put('relations', id, { familyId: 'source', type, fromPersonId: from, toPersonId: to, status: 'active', ...(order === undefined ? {} : { childOrder: order }) });
  const original = 'cloud://fake-env.fake-bucket/source.jpg'; files.set(original, Buffer.from('fake-image'));
  db.put('media_assets', 'photo', { familyId: 'source', kind: 'person_avatar', status: 'active', moderationStatus: 'approved', fileId: original, cloudPath: 'source.jpg', size: 10, ownerId: 'other' });
  const cloud = {
    downloadFile: async ({ fileID }) => { if (downloadHook) await downloadHook(fileID); if (!files.has(fileID)) throw new Error('missing file'); return { fileContent: files.get(fileID) }; },
    uploadFile: async ({ cloudPath, fileContent }) => { const fileID = 'cloud://fake-env.fake-bucket/' + cloudPath; files.set(fileID, fileContent); return { fileID }; },
    deleteFile: async ({ fileList }) => { if (deleteHook) return deleteHook(fileList); fileList.forEach(id => files.delete(id)); return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }; }
  };
  const dispatchJob = async (action, taskId) => { dispatched.push({ action, taskId }); };
  let actorId = 'actor';
  const options = {
    db, assert: business, getOpenid: () => actorId,
    requireActiveUser: async () => { const user = db.get('users', actorId); business(user && user.status === 'active', 'ACCOUNT_UNAVAILABLE'); return user; },
    requireMembership: async (familyId, roles, scope) => {
      const family = (await scope.collection('families').doc(familyId).get()).data;
      const membership = (await scope.collection('family_memberships').doc('source-member').get()).data;
      business(family && family.status === 'active', 'FAMILY_ARCHIVED');
      business(membership && membership.userId === actorId && membership.familyId === familyId && membership.status === 'active', 'NO_FAMILY_ACCESS');
      business(roles.includes(membership.role), 'NO_PERMISSION');
      return { family, membership };
    },
    membershipId: familyId => familyId + '-member', moderateText: async () => {}, dispatchJob,
    mutate: async (type, event, openid, callback) => db.runTransaction(async tx => {
      const key = openid + ':' + event.requestId;
      const prior = (await tx.collection('idempotency_records').doc(key).get()).data;
      if (prior) return prior.result;
      const result = await callback(tx);
      await tx.collection('idempotency_records').doc(key).set({ data: { result } });
      return result;
    })
  };
  const api = apiModule.createService(options);
  const worker = jobsModule.createWorker({ db, cloud, dispatchJob });
  return { db, files, dispatched, api, worker, cloud, setActor: value => { actorId = value; }, setDownloadHook: value => { downloadHook = value; }, setDeleteHook: value => { deleteHook = value; }, options,
    create: key => api.create({ familyId: 'source', name: '新家谱', requestId: key || 'request' }) };
}

test('三种角色可复制，原谱资料、日期、排行和头像完整且副本独立', async () => {
  for (const role of ['admin', 'member', 'viewer']) {
    const h = harness(role); const task = await h.create();
    assert.equal(h.db.all('families').length, 1);
    assert.equal(h.db.get('users', 'actor').firstCreatedFamilyAt, undefined);
    await h.worker.process(task.taskId);
    const status = (await h.api.status({ taskId: task.taskId })).task;
    assert.equal(status.status, 'completed');
    assert.equal(status.personCount, 3); assert.equal(status.relationCount, 3);
    const target = h.db.get('families', status.family._id);
    assert.equal(target.creatorId, 'actor'); assert.equal(target.description, '家谱简介');
    assert.equal(target.proLifetime, undefined); assert.equal(target.adminCount, 1);
    const persons = h.db.all('persons').filter(p => p.familyId === target._id);
    const person = persons.find(p => p.gender === 'male');
    assert.deepEqual(person.birthDateInfo, h.db.get('persons', 'p1').birthDateInfo);
    assert.deepEqual(person.birthDateRange, h.db.get('persons', 'p1').birthDateRange);
    assert.equal(person.bio, '完整简介'); assert.notEqual(person._id, 'p1');
    const image = h.db.get('media_assets', person.avatarAssetId);
    assert.equal(image.ownerId, 'actor'); assert.notEqual(image.fileId, h.db.get('media_assets', 'photo').fileId);
    assert.deepEqual(h.files.get(image.fileId), Buffer.from('fake-image'));
    assert.equal(h.db.all('family_memberships').filter(m => m.familyId === target._id).length, 1);
    const relations = h.db.all('relations').filter(r => r.familyId === target._id);
    assert.ok(relations.filter(r => r.type === 'parent_child').every(r => r.childOrder === 0));
    assert.ok(relations.every(r => persons.some(p => p._id === r.fromPersonId) && persons.some(p => p._id === r.toPersonId)));
    h.db.put('families', 'source', { status: 'deleted' }); h.files.delete('cloud://fake-env.fake-bucket/source.jpg');
    assert.ok(h.files.has(image.fileId));
    assert.equal((await h.api.status({ taskId: task.taskId })).task.family._id, target._id);
    assert.equal(h.db.all('family_copy_chunks').length, 0);
    assert.ok(h.db.get('users', 'actor').firstCreatedFamilyAt);
  }
});

test('同一请求并发重试不扣第二次额度，重复派发只发布一次', async () => {
  const h = harness(); const [first, second] = await Promise.all([h.create(), h.create()]);
  assert.equal(first.taskId, second.taskId); assert.equal(h.db.get('users', 'actor').copyCount, 1);
  const result = await Promise.all([h.worker.process(first.taskId), h.worker.process(first.taskId)]);
  assert.equal(result.filter(r => r.completed).length, 1);
  assert.equal(h.db.all('families').length, 2);
  assert.equal((await h.create()).status, 'completed'); assert.equal(h.db.get('users', 'actor').copyCount, 1);
  await assert.rejects(h.api.create({ familyId: 'source', name: '改名', requestId: 'request' }), { code: 'COPY_REQUEST_CHANGED' });
});

test('每天最多三次且同时一个任务；北京时间归日、拒绝不扣额度', async () => {
  const h = harness(); let task = await h.create('1');
  await assert.rejects(h.create('2'), { code: 'COPY_IN_PROGRESS' });
  assert.equal(h.db.get('users', 'actor').copyCount, 1);
  await h.worker.process(task.taskId);
  for (const key of ['2', '3']) { task = await h.create(key); await h.worker.process(task.taskId); }
  await assert.rejects(h.create('4'), { code: 'COPY_DAILY_LIMIT' });
  assert.equal(apiModule.day(Date.parse('2026-10-06T15:59:59Z')), '2026-10-06');
  assert.equal(apiModule.day(Date.parse('2026-10-06T16:00:00Z')), '2026-10-07');
  const user = h.db.get('users', 'actor'); user.copyDay = '2000-01-01'; h.db.put('users', 'actor', user);
  await h.create('4'); assert.equal(h.db.get('users', 'actor').copyCount, 1);
});

test('未加入、已退出、冻结、归档及跨用户任务查询拒绝', async () => {
  for (const change of [h => h.db.put('family_memberships', 'source-member', { status: 'left' }), h => h.db.put('families', 'source', { status: 'archived' }), h => h.db.put('users', 'actor', { status: 'frozen' })]) {
    const h = harness(); change(h); await assert.rejects(h.create()); assert.equal(h.db.all('family_copy_tasks').length, 0);
  }
  const h = harness(); const task = await h.create();
  h.db.put('users', 'other', { status: 'active' }); h.setActor('other');
  await assert.rejects(h.api.status({ taskId: task.taskId }), { code: 'COPY_NOT_FOUND' });
  assert.equal((await h.api.status({ familyId: 'source' })).task, null);
});

test('不可用头像、下载失败不阻止完整复制，并返回需补充的人物', async () => {
  for (const change of [h => { const a = h.db.get('media_assets', 'photo'); a.moderationStatus = 'review'; h.db.put('media_assets', 'photo', a); }, h => h.files.clear(), h => h.setDownloadHook(async () => { throw new Error('transport failed'); })]) {
    const h = harness(); change(h); const task = await h.create(); await h.worker.process(task.taskId);
    const result = (await h.api.status({ taskId: task.taskId })).task;
    assert.equal(result.status, 'completed'); assert.equal(result.missingAvatars.length, 1);
    assert.equal(result.missingAvatars[0].name, '同名');
    assert.equal(h.db.get('persons', result.missingAvatars[0].personId).avatarAssetId, '');
    assert.equal(h.db.all('media_assets').filter(a => a.familyId === result.family._id).length, 0);
  }
});

test('读取资料期间版本变化重新读取，持续变化三次失败，无半成品', async () => {
  for (const continual of [false, true]) {
    const h = harness(); let bumps = 0;
    h.db.queryHook = async (name, where) => { if (name === 'persons' && where.familyId === 'source' && (continual || bumps === 0)) { const f = h.db.get('families', 'source'); f.contentRevision = (f.contentRevision || 0) + 1; h.db.put('families', 'source', f); bumps += 1; } };
    const task = await h.create(); await h.worker.process(task.taskId);
    const result = (await h.api.status({ taskId: task.taskId })).task;
    assert.equal(result.status, continual ? 'failed' : 'completed');
    if (continual) { assert.equal(result.failureCode, 'GRAPH_CHANGED'); assert.equal(bumps, 3); assert.equal(h.db.all('families').length, 1); }
  }
});

test('复制过程中访问权撤销，终止并清理；清理失败保留标记，维护重试', async () => {
  const h = harness(); h.setDownloadHook(async () => {
    const membership = h.db.get('family_memberships', 'source-member'); membership.status = 'left'; h.db.put('family_memberships', 'source-member', membership);
  });
  h.setDeleteHook(async fileList => ({ fileList: fileList.map(fileID => ({ fileID, status: -1, errMsg: 'temporary failure' })) }));
  const task = await h.create(); await h.worker.process(task.taskId);
  const record = h.db.get('family_copy_tasks', task.taskId);
  assert.equal(record.status, 'failed'); assert.equal(record.failureCode, 'COPY_SOURCE_UNAVAILABLE'); assert.equal(record.cleanupPending, true);
  assert.equal(h.db.all('families').length, 1); assert.equal((await h.api.status({ taskId: task.taskId })).task.missingAvatars.length, 0);
  h.setDeleteHook(null); await h.worker.maintenance();
  assert.equal(h.db.get('family_copy_tasks', task.taskId).cleanupPending, false);
  assert.equal(h.db.all('persons').filter(p => p.familyId === record.targetFamilyId).length, 0);
});

test('500 人、2000 条关系分页复制；数量超限与坏关系明确失败', async () => {
  const h = harness();
  for (const p of h.db.all('persons')) await h.db.collection('persons').doc(p._id).remove();
  for (const r of h.db.all('relations')) await h.db.collection('relations').doc(r._id).remove();
  for (let i = 0; i < 500; i += 1) h.db.put('persons', 'large' + i, { familyId: 'source', name: '虚构人物' + i, bio: '简介'.repeat(200), gender: 'unknown', status: 'active' });
  let count = 0;
  for (let gap = 1; count < 2000; gap += 1) for (let i = 0; i + gap < 500 && count < 2000; i += 1) h.db.put('relations', 'large-r' + count++, { familyId: 'source', type: 'parent_child', fromPersonId: 'large' + i, toPersonId: 'large' + (i + gap), status: 'active', childOrder: i });
  const task = await h.create(); await h.worker.process(task.taskId);
  const result = (await h.api.status({ taskId: task.taskId })).task;
  assert.equal(result.status, 'completed'); assert.equal(result.personCount, 500); assert.equal(result.relationCount, 2000);
  h.db.put('persons', 'over', { familyId: 'source', name: '超限', status: 'active' });
  const next = await h.create('over'); await h.worker.process(next.taskId);
  assert.equal((await h.api.status({ taskId: next.taskId })).task.failureCode, 'COPY_LIMIT_EXCEEDED');
  assert.throws(() => jobsModule.validateGraph([{ _id: 'x', name: 'x' }], [{ type: 'spouse', fromPersonId: 'x', toPersonId: 'missing' }]), { code: 'COPY_INVALID_GRAPH' });
  assert.throws(() => jobsModule.validateGraph([{ _id: 'a', name: 'a' }, { _id: 'b', name: 'b' }], [{ type: 'parent_child', fromPersonId: 'a', toPersonId: 'b' }, { type: 'parent_child', fromPersonId: 'b', toPersonId: 'a' }]), { code: 'COPY_INVALID_GRAPH' });
});

test('超过单次时间预算保存检查点后续派发，断点继续不重复人物', async () => {
  const h = harness(); const task = await h.create(); let value = Date.now(); let jumps = 0;
  h.db.writeHook = async (name, id, data) => { if (name === 'family_copy_tasks' && data.personsDone && jumps++ === 0) value += 721000; };
  const worker = jobsModule.createWorker({ db: h.db, cloud: h.cloud, dispatchJob: h.options.dispatchJob, now: () => value });
  const first = await worker.process(task.taskId);
  assert.equal(first.continued, true); assert.equal(h.db.get('family_copy_tasks', task.taskId).status, 'pending');
  assert.equal(h.db.all('families').length, 1); h.db.writeHook = null;
  await worker.process(task.taskId);
  assert.equal(h.db.get('family_copy_tasks', task.taskId).status, 'completed');
  assert.equal(h.db.all('persons').filter(p => p.familyId !== 'source').length, 3);
});

test('资料修改审计在同一事务更新 contentRevision，拒绝和邀请不更新', async () => {
  const source = fs.readFileSync('cloudfunctions/youpuUserApi/index.js', 'utf8');
  const code = source.slice(source.indexOf('async function audit('), source.indexOf('async function mutate('));
  const db = createDatabase(); db.put('families', 'source', { status: 'active' });
  const context = { db, _: db.command, userId: value => value, cleanText: value => value };
  // Audit add is independent of the family revision assertions.
  const scope = { collection: name => name === 'audit_logs' ? { add: async () => {} } : db.collection(name) };
  vm.runInNewContext(code, context);
  for (const action of ['family.update', 'person.create_related', 'person.update', 'person.delete', 'relation.link_existing', 'relation.remove', 'relation.reorder_children', 'change.approve']) await context.audit(scope, { familyId: 'source', action });
  assert.equal(db.get('families', 'source').contentRevision, 8);
  for (const action of ['change.reject', 'invite.create', 'family.archive']) await context.audit(scope, { familyId: 'source', action });
  assert.equal(db.get('families', 'source').contentRevision, 8);
});

test('任务派发副本一致，新集合规则与索引覆盖、API mutation 注册', () => {
  assert.equal(fs.readFileSync('cloudfunctions/youpuJobs/job-dispatcher.js', 'utf8'), fs.readFileSync('cloudfunctions/youpuUserApi/job-dispatcher.js', 'utf8'));
  const source = fs.readFileSync('cloudfunctions/youpuUserApi/index.js', 'utf8');
  assert.ok(source.slice(source.indexOf('const MUTATION_TYPES'), source.indexOf('class BusinessError')).includes("'family.copy.create'"));
  const indexes = JSON.parse(fs.readFileSync('deployment/database-indexes.json'));
  for (const collection of ['family_copy_tasks', 'family_copy_chunks']) {
    assert.ok(indexes.indexes[collection].length);
    assert.ok(fs.readFileSync('deployment/apply-security.mjs', 'utf8').includes("'" + collection + "'"));
    assert.ok(fs.readFileSync('cloudfunctions/youpuJobs/index.js', 'utf8').includes("'" + collection + "'"));
  }
});

test('大量头像逐张复制且共享头像去重，复制文件不复用原谱 ID', async () => {
  const h = harness();
  for (let i = 0; i < 100; i += 1) {
    const sourceId = 'photo' + i; const fileId = 'cloud://fake-env.fake-bucket/' + sourceId + '.png';
    h.files.set(fileId, Buffer.from('avatar-' + i));
    h.db.put('media_assets', sourceId, { familyId: 'source', kind: 'person_avatar', status: 'active', moderationStatus: 'approved', fileId, cloudPath: sourceId + '.png', ownerId: 'other' });
    h.db.put('persons', 'avatar-person' + i, { familyId: 'source', name: '人物' + i, status: 'active', avatarAssetId: sourceId });
  }
  const second = h.db.get('persons', 'p2'); second.avatarAssetId = 'photo'; h.db.put('persons', 'p2', second);
  const task = await h.create(); await h.worker.process(task.taskId);
  const result = (await h.api.status({ taskId: task.taskId })).task;
  assert.equal(result.status, 'completed'); assert.equal(result.avatarsDone, 102);
  const assets = h.db.all('media_assets').filter(a => a.familyId === result.family._id);
  assert.equal(assets.length, 101);
  assert.ok(assets.every(a => a.ownerId === 'actor' && a.fileId.includes('/family-copies/')));
});

test('处理前权限变化、目标发布事务失败，未记录创建转化且清理全部临时资料', async () => {
  for (const state of ['revoked', 'publish-failure']) {
    const h = harness(); const task = await h.create();
    if (state === 'revoked') { const member = h.db.get('family_memberships', 'source-member'); member.status = 'left'; h.db.put('family_memberships', member._id, member); }
    else h.db.writeHook = async (name, id) => { if (name === 'family_memberships' && id !== 'source-member') throw new Error('forced publish failure'); };
    await h.worker.process(task.taskId);
    assert.equal(h.db.get('family_copy_tasks', task.taskId).status, 'failed');
    assert.equal(h.db.all('families').length, 1);
    assert.equal(h.db.get('users', 'actor').firstCreatedFamilyAt, undefined);
    assert.equal(h.db.all('persons').length, 3); assert.equal(h.db.all('family_copy_chunks').length, 0);
    assert.equal(h.db.get('users', 'actor').activeCopyTaskId, '');
  }
});

test('已失效执行令牌不能提交、过期任务维护释放占用，响应失败的派发可恢复', async () => {
  const h = harness(); const task = await h.create();
  h.setDownloadHook(async () => { const current = h.db.get('family_copy_tasks', task.taskId); current.token = 'newer-worker'; h.db.put('family_copy_tasks', task.taskId, current); });
  await h.worker.process(task.taskId);
  assert.equal(h.db.all('families').length, 1);
  assert.equal(h.db.get('family_copy_tasks', task.taskId).status, 'processing');
  const current = h.db.get('family_copy_tasks', task.taskId); current.leaseUntil = new Date(0); current.createdAt = new Date(0); h.db.put('family_copy_tasks', task.taskId, current);
  await h.worker.maintenance();
  assert.equal(h.db.get('family_copy_tasks', task.taskId).failureCode, 'COPY_TIMEOUT');
  assert.equal(h.db.get('users', 'actor').activeCopyTaskId, '');
  const retry = await h.create('new-request');
  assert.notEqual(retry.taskId, task.taskId); assert.equal(h.db.get('users', 'actor').copyCount, 2);
});

test('新目标离开后任务结果不再返回人物名称或家谱内容', async () => {
  const h = harness(); h.files.clear(); const task = await h.create(); await h.worker.process(task.taskId);
  const record = h.db.get('family_copy_tasks', task.taskId);
  const member = h.db.get('family_memberships', record.targetMembershipId); member.status = 'left'; h.db.put('family_memberships', member._id, member);
  const result = (await h.api.status({ taskId: task.taskId })).task;
  assert.equal(result.family, null); assert.deepEqual(result.missingAvatars, []);
  const repeated = await h.create();
  assert.equal(repeated.family, null); assert.deepEqual(repeated.missingAvatars, []);
});

test('jobs 冷启动不读取请求上下文，原谱跨环境头像不能下载', async () => {
  const db = createDatabase(); const exported = {}; let contextReads = 0;
  vm.runInNewContext(fs.readFileSync('cloudfunctions/youpuJobs/index.js', 'utf8'), {
    exports: exported, process, Buffer, console,
    require: name => name === 'wx-server-sdk' ? {
      init: () => {}, database: () => db,
      getWXContext: () => { contextReads += 1; throw new Error('request context unavailable before invocation'); }
    } : name === 'archiver' ? () => {} : name.startsWith('./') ? require('../cloudfunctions/youpuJobs/' + name.slice(2)) : require(name)
  });
  assert.equal(typeof exported.main, 'function'); assert.equal(contextReads, 0);
  const h = harness(); let downloads = 0; h.setDownloadHook(async () => { downloads += 1; });
  const worker = jobsModule.createWorker({ db: h.db, cloud: h.cloud, dispatchJob: h.options.dispatchJob, environmentId: 'another-environment' });
  const task = await h.create(); await worker.process(task.taskId);
  assert.equal(downloads, 0); assert.equal(h.db.get('family_copy_tasks', task.taskId).status, 'completed');
});

test('有效空家谱可复制，空文件头像按缺失处理', async () => {
  const empty = harness();
  for (const p of empty.db.all('persons')) await empty.db.collection('persons').doc(p._id).remove();
  for (const r of empty.db.all('relations')) await empty.db.collection('relations').doc(r._id).remove();
  const emptyTask = await empty.create(); await empty.worker.process(emptyTask.taskId);
  const emptyResult = (await empty.api.status({ taskId: emptyTask.taskId })).task;
  assert.equal(emptyResult.status, 'completed'); assert.equal(emptyResult.personCount, 0); assert.equal(emptyResult.relationCount, 0);
  const h = harness(); h.files.set('cloud://fake-env.fake-bucket/source.jpg', Buffer.alloc(0));
  const task = await h.create(); await h.worker.process(task.taskId);
  assert.equal((await h.api.status({ taskId: task.taskId })).task.missingAvatars.length, 1);
});
