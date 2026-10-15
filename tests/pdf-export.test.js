const test = require('node:test');
const assert = require('node:assert/strict');
const apiModule = require('../cloudfunctions/youpuUserApi/pdf-export');
const jobsModule = require('../cloudfunctions/youpuJobs/pdf-export');
const renderer = require('../cloudfunctions/youpuJobs/pdf/render');
const { inflateSync } = require('node:zlib');
const { createDatabase } = require('./helpers/family-copy-db');
const layoutSnapshot = require('../miniprogram/utils/pdf-layout-snapshot');
const CODE_BASE64 = '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAB4AFADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnQCabdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf//Z';
function check(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
function harness(role = 'viewer', render, posterCode) {
  const db = createDatabase(); const files = new Map(); let actor = 'actor'; const calls = [];
  db.now = new Date();
  db.put('users', actor, { status: 'active' });
  db.put('families', 'family', { name: '虚构家谱', status: 'active', proLifetime: true, contentRevision: 0 });
  db.put('family_memberships', 'member', { familyId: 'family', userId: actor, role, status: 'active' });
  db.put('persons', 'p1', { familyId: 'family', name: '成员甲', status: 'active', bio: '完整简介' });
  db.put('persons', 'p2', { familyId: 'family', name: '成员乙', status: 'active' });
  db.put('relations', 'r1', { familyId: 'family', type: 'parent_child', fromPersonId: 'p1', toPersonId: 'p2', status: 'active' });
  const cloud = {
    uploadFile: async ({ cloudPath, fileContent }) => { files.set(cloudPath, fileContent); return { fileID: cloudPath }; },
    deleteFile: async ({ fileList }) => { fileList.forEach(id => files.delete(id)); return {}; },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(id => ({ tempFileURL: 'https://staging.invalid/' + id })) })
  };
  const service = apiModule.createService({ db, cloud, posterCode: posterCode || (async () => ({ base64: CODE_BASE64 })), assert: check, getOpenid: () => actor,
    requireActiveUser: async () => { const user = db.get('users', actor); check(user && user.status === 'active', 'ACCOUNT_UNAVAILABLE'); return user; },
    requireMembership: async (id, roles, scope) => {
      const family = (await scope.collection('families').doc(id).get()).data;
      const member = (await scope.collection('family_memberships').doc('member').get()).data;
      check(family && family.status === 'active' && member && member.userId === actor && member.familyId === id && member.status === 'active' && roles.includes(member.role), 'NO_PERMISSION');
      return { family, membership: member };
    }, entitlement: family => ({ active: jobsModule.membershipActive(family) }),
    dispatchJob: async (action, taskId) => calls.push({ action, taskId }),
    mutate: async (type, event, openid, callback) => db.runTransaction(async tx => {
      const key = actor + ':' + event.requestId;
      const prior = (await tx.collection('idempotency_records').doc(key).get()).data;
      if (prior) return prior.result;
      const result = await callback(tx);
      await tx.collection('idempotency_records').doc(key).set({ data: { result } }); return result;
    })
  });
  const worker = jobsModule.createWorker({ db, cloud, render: render || (async data => ({ bytes: Buffer.from('%PDF-test'), personCount: data.persons.length, relationCount: data.relations.length, pageCount: 1 })) });
  const input = { source: 'family', familyId: 'family', format: 'poster', requestId: 'first', display: {} };
  return { db, files, service, worker, input, calls, actor: value => { actor = value; } };
}
function attachSnapshot(h) {
  const data = jobsModule.normalize({ persons: h.db.all('persons'), relations: h.db.all('relations') }, 500);
  h.input.layoutSnapshot = layoutSnapshot.create(data.persons, data.relations, 'horizontal', 0);
}
test('v1 与 v2 压缩快照任务均可创建和执行，压缩元数据不能冒充版本', async () => {
  for (const version of [1, 2]) {
    const h = harness();
    const data = jobsModule.normalize({ persons: h.db.all('persons'), relations: h.db.all('relations') }, 500);
    h.input.layoutSnapshot = layoutSnapshot.create(data.persons, data.relations, 'horizontal', 0, version);
    const task = await h.service.create(h.input);
    const saved = h.db.get('export_tasks', task.taskId).layoutSnapshot;
    assert.equal(saved.version, version);
    assert.equal(jobsModule.unpackLayout(saved).version, version);
    assert.equal((await h.worker.process(task.taskId)).completed, true);
    assert.throws(() => jobsModule.unpackLayout({ ...saved, version: version === 1 ? 2 : 1 }), { code: 'PDF_LAYOUT_INVALID' });
  }
});
test('新版完整快照参与幂等与私有任务保存，公共状态不泄露快照', async () => {
  const h = harness('viewer', async data => {
    assert.deepEqual(data.posterLayout.nodes.map(n => n._id), h.input.layoutSnapshot.ids);
    return { bytes: Buffer.from('%PDF'), personCount: data.persons.length, relationCount: data.relations.length, pageCount: 1 };
  });
  attachSnapshot(h);
  const first = await h.service.create(h.input); const duplicate = await h.service.create(h.input);
  assert.equal(first.taskId, duplicate.taskId); assert.equal(first.layoutSnapshot, undefined);
  assert.deepEqual(jobsModule.unpackLayout(h.db.get('export_tasks', first.taskId).layoutSnapshot), h.input.layoutSnapshot);
  assert.equal((await h.worker.process(first.taskId)).completed, true);
  assert.equal((await h.service.status({ taskId: first.taskId })).task.layoutSnapshot, undefined);
  h.db.put('families', 'family', { ...h.db.get('families', 'family'), contentRevision: 1 });
  assert.equal((await h.service.create(h.input)).taskId, first.taskId, '已完成任务幂等重发仍返回原文件');
  await assert.rejects(h.service.create({ ...h.input, layoutSnapshot: { ...h.input.layoutSnapshot, sourceRevision: 1 } }), { code: 'PDF_REQUEST_CHANGED' });
});
test('创建前快照不匹配不计额度，执行与免费重试均拒绝旧资料版本', async () => {
  const h = harness(); attachSnapshot(h);
  const corrupt = structuredClone(h.input); corrupt.layoutSnapshot.nodes.pop();
  await assert.rejects(h.service.create(corrupt), { code: 'PDF_LAYOUT_INVALID' });
  assert.equal(h.db.get('users', 'actor').pdfCount, undefined);
  const task = await h.service.create(h.input);
  h.db.put('families', 'family', { ...h.db.get('families', 'family'), contentRevision: 1 });
  assert.equal((await h.worker.process(task.taskId)).code, 'PDF_GRAPH_CHANGED');
  await assert.rejects(h.service.create({ ...h.input, retryTaskId: task.taskId, requestId: 'retry' }), { code: 'PDF_GRAPH_CHANGED' });
  assert.equal(h.db.get('users', 'actor').pdfCount, 1);
});
test('新版快照在绘制或上传期间资料改变时不得保留成品', async () => {
  const h = harness('viewer', async () => {
    h.db.put('families', 'family', { ...h.db.get('families', 'family'), contentRevision: 1 });
    return { bytes: Buffer.from('%PDF'), pageCount: 1 };
  });
  attachSnapshot(h); const task = await h.service.create(h.input);
  assert.equal((await h.worker.process(task.taskId)).code, 'PDF_GRAPH_CHANGED'); assert.equal(h.files.size, 0);
  const h2 = harness(); attachSnapshot(h2); const task2 = await h2.service.create(h2.input);
  const worker = jobsModule.createWorker({ db: h2.db, cloud: {
    uploadFile: async () => { h2.files.set('file', true); h2.db.put('families', 'family', { ...h2.db.get('families', 'family'), contentRevision: 1 }); return { fileID: 'file' }; },
    deleteFile: async () => h2.files.clear()
  }, render: async () => ({ bytes: Buffer.from('%PDF'), pageCount: 1 }) });
  assert.equal((await worker.process(task2.taskId)).code, 'PDF_GRAPH_CHANGED'); assert.equal(h2.files.size, 0);
});
test('新版公开示例沿用客户端投影，旧任务仍沿用兼容路径', async () => {
  const h = harness();
  const content = { persons: [{ _id: 'a', name: '  示例人物  ', gender: 'male', avatarAssetId: 'private' }, { _id: 'b', name: '子女', gender: 'male' }], relations: [{ _id: 'r', type: 'parent_child', fromPersonId: 'a', toPersonId: 'b', childOrder: 9 }] };
  h.db.put('example_templates', 'example', { slug: 'example', status: 'published', publishedVersion: 2, publishedContent: content });
  const projection = require('../cloudfunctions/youpuUserApi/pdf-graph-source').exampleGraph(content);
  const layout = layoutSnapshot.create(projection.persons, projection.relations, 'horizontal', 2);
  const task = await h.service.create({ source: 'example', slug: 'example', format: 'poster', requestId: 'example', layoutSnapshot: layout });
  const data = await h.worker.snapshot(h.db.get('export_tasks', task.taskId));
  assert.equal(data.persons[0].name, '示例人物'); assert.equal(data.persons[0].avatarAssetId, ''); assert.equal(data.relations[0].childOrder, null);
  assert.equal((await h.worker.process(task.taskId)).completed, true);
});
test('有效头像经真实解码嵌入横排矢量 PDF，非法与跨谱头像不下载', async () => {
  const h = harness();
  const { createImageProcessor } = require('../cloudfunctions/youpuJobs/pdf/avatar');
  const sharp = require('node:module').createRequire(require('node:path').resolve(__dirname, '../cloudfunctions/youpuJobs/pdf/render.js'))('sharp');
  const jpeg = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#DB304D' } }).jpeg().toBuffer();
  h.db.put('persons', 'p1', { ...h.db.get('persons', 'p1'), avatarAssetId: 'valid' });
  h.db.put('persons', 'p2', { ...h.db.get('persons', 'p2'), avatarAssetId: 'foreign' });
  h.db.put('media_assets', 'valid', { familyId: 'family', status: 'active', moderationStatus: 'approved', fileId: 'photo.jpg', size: jpeg.length });
  h.db.put('media_assets', 'foreign', { familyId: 'other', status: 'active', moderationStatus: 'approved', fileId: 'other.jpg' });
  const downloaded = [];
  const cloud = { downloadFile: async ({ fileID }) => { downloaded.push(fileID); return { fileContent: jpeg }; }, uploadFile: async ({ fileContent }) => { h.files.set('pdf', fileContent); return { fileID: 'pdf' }; } };
  const worker = jobsModule.createWorker({ db: h.db, cloud, render: renderer.render, imageProcessor: createImageProcessor() });
  const task = await h.service.create(h.input);
  assert.equal((await worker.process(task.taskId)).completed, true);
  assert.deepEqual(downloaded, ['photo.jpg']);
  assert.equal(h.db.get('export_tasks', task.taskId).unavailableMediaCount, 1);
  assert.equal((h.files.get('pdf').toString('latin1').match(/\/Subtype \/Image/g) || []).length, 2);
});
test('照片处理运行时缺失必须报错，不静默生成缺照片文件', () => {
  const { createImageProcessor } = require('../cloudfunctions/youpuJobs/pdf/avatar');
  assert.throws(() => createImageProcessor(() => { throw new Error('native module missing'); }), { code: 'PDF_AVATAR_RUNTIME_UNAVAILABLE' });
});
for (const role of ['admin', 'member', 'viewer']) test('PDF 会员 ' + role + ' 完整生成并允许重复领取', async () => {
  const h = harness(role); const task = await h.service.create(h.input);
  assert.equal(task.status, 'pending'); assert.equal(h.calls[0].action, 'task.pdf-export');
  const both = await Promise.all([h.worker.process(task.taskId), h.worker.process(task.taskId)]);
  assert.equal(both.filter(r => r.completed).length, 1); assert.equal(h.files.size, 1);
  const result = (await h.service.status({ taskId: task.taskId })).task;
  assert.equal(result.personCount, 2); assert.equal(result.relationCount, 1);
  assert.equal(result.fileId, undefined);
  assert.deepEqual(await h.service.downloadUrl({ taskId: task.taskId }), await h.service.downloadUrl({ taskId: task.taskId }));
});
test('PDF 并发、每日额度与幂等按实际任务原子计次', async () => {
  const h = harness(); const tasks = await Promise.all([h.service.create(h.input), h.service.create(h.input)]);
  assert.equal(tasks[0].taskId, tasks[1].taskId); assert.equal(h.db.get('users', 'actor').pdfCount, 1);
  await assert.rejects(h.service.create({ ...h.input, requestId: 'second' }), { code: 'PDF_IN_PROGRESS' });
  await h.worker.process(tasks[0].taskId);
  for (let index = 2; index <= 20; index += 1) {
    const task = await h.service.create({ ...h.input, requestId: 'daily-' + index });
    await h.worker.process(task.taskId);
  }
  assert.equal(h.db.get('users', 'actor').pdfCount, 20);
  const duplicate = await h.service.create(h.input);
  assert.equal(duplicate.taskId, tasks[0].taskId);
  assert.equal(h.db.get('users', 'actor').pdfCount, 20);
  await assert.rejects(h.service.create({ ...h.input, requestId: 'twenty-first' }), { code: 'PDF_DAILY_LIMIT' });
  await h.db.collection('users').doc('actor').update({ data: { pdfDay: '2000-01-01' } });
  await h.service.create({ ...h.input, requestId: 'next-day' });
  assert.equal(h.db.get('users', 'actor').pdfCount, 1);
});
test('PDF 失败重试同一任务不重复计次，参数变化拒绝', async () => {
  const h = harness(); const task = await h.service.create(h.input);
  await h.db.collection('export_tasks').doc(task.taskId).update({ data: { status: 'failed', createdAt: new Date() } });
  const retry = await h.service.create({ ...h.input, retryTaskId: task.taskId, requestId: 'retry' });
  assert.equal(retry.taskId, task.taskId); assert.equal(h.db.get('users', 'actor').pdfCount, 1);
  await assert.rejects(h.service.create({ ...h.input, requestId: 'first', format: 'book' }), { code: 'PDF_REQUEST_CHANGED' });
});
test('PDF 真实家谱会员与任务所有者、过期链接均由服务端验证', async () => {
  const h = harness(); h.db.put('families', 'family', { status: 'active' });
  await assert.rejects(h.service.create(h.input), { code: 'MEMBERSHIP_REQUIRED' });
  h.db.put('families', 'family', { status: 'active', proLifetime: true });
  const task = await h.service.create(h.input); await h.worker.process(task.taskId);
  h.db.put('users', 'other', { status: 'active' }); h.actor('other');
  await assert.rejects(h.service.downloadUrl({ taskId: task.taskId }), { code: 'PDF_NOT_FOUND' }); h.actor('actor');
  await h.db.collection('export_tasks').doc(task.taskId).update({ data: { expiresAt: new Date(0) } });
  await assert.rejects(h.service.downloadUrl({ taskId: task.taskId }), { code: 'PDF_EXPIRED' });
});
test('PDF 执行中权限撤销不保留成品，输出快照只包含允许字段', async () => {
  let h;
  h = harness('viewer', async data => {
    assert.equal(data.persons[0].bio, '完整简介'); assert.equal(data.persons[0].familyId, undefined);
    await h.db.collection('family_memberships').doc('member').update({ data: { status: 'left' } });
    return { bytes: Buffer.from('%PDF'), pageCount: 1 };
  });
  const task = await h.service.create(h.input); const result = await h.worker.process(task.taskId);
  assert.equal(result.code, 'PDF_ACCESS_CHANGED'); assert.equal(h.files.size, 0);
});
test('PDF 版本变化重新读取快照，持续修改时明确失败', async () => {
  const h = harness(); const task = await h.service.create(h.input); let n = 0;
  h.db.queryHook = async name => { if (name === 'persons') h.db.put('families', 'family', { name: '虚构家谱', status: 'active', proLifetime: true, contentRevision: ++n }); };
  await assert.rejects(h.worker.snapshot(h.db.get('export_tasks', task.taskId)), { code: 'PDF_GRAPH_CHANGED' });
});
test('PDF 已发布示例免费，草稿与下架示例不可导出', async () => {
  const h = harness(); h.db.put('example_templates', 'demo', { slug: 'demo', status: 'published', title: '公开示例', publishedContent: { persons: [{ _id: 'demo1', name: '示例人物' }], relations: [] } });
  const task = await h.service.create({ source: 'example', slug: 'demo', format: 'book', requestId: 'example' });
  assert.equal((await h.worker.process(task.taskId)).completed, true);
  await h.db.collection('example_templates').doc('demo').update({ data: { status: 'draft' } });
  await assert.rejects(h.service.downloadUrl({ taskId: task.taskId }), { code: 'EXAMPLE_NOT_FOUND' });
});
test('PDF 待启动超时按本次重试时间计算，事务内重新核对', async () => {
  const h = harness();
  const task = await h.service.create(h.input);
  await h.db.collection('export_tasks').doc(task.taskId).update({ data: { createdAt: new Date(Date.now() - 3600000), updatedAt: new Date() } });
  assert.equal((await h.worker.maintenance()).failed, 0);
  assert.equal(h.db.get('export_tasks', task.taskId).status, 'pending');
  await h.db.collection('export_tasks').doc(task.taskId).update({ data: { updatedAt: new Date(Date.now() - 3600000) } });
  const transaction = h.db.runTransaction;
  h.db.runTransaction = callback => {
    h.db.put('export_tasks', task.taskId, { ...h.db.get('export_tasks', task.taskId), updatedAt: new Date() });
    return transaction(callback);
  };
  assert.equal((await h.worker.maintenance()).failed, 0);
  h.db.runTransaction = transaction;
  await h.db.collection('export_tasks').doc(task.taskId).update({ data: { updatedAt: new Date(Date.now() - 3600000) } });
  assert.equal((await h.worker.maintenance()).failed, 1);
  assert.equal(h.db.get('export_tasks', task.taskId).status, 'failed');
});
function fixture(count, shape) {
  const persons = []; const relations = [];
  for (let i = 0; i < count; i += 1) {
    persons.push({ _id: 'p' + i, name: '成员' + i, gender: i % 2 ? 'male' : 'female', bio: i ? '' : '完整简介'.repeat(125), birthDateInfo: { year: 1980, calendar: 'lunar', precision: 'year' } });
    if (i && shape !== 'isolated') relations.push({ _id: 'r' + i, type: 'parent_child', fromPersonId: 'p' + (shape === 'wide' ? 0 : shape === 'deep' ? i - 1 : Math.floor((i - 1) / 2)), toPersonId: 'p' + i });
  }
  return { name: '虚构测试家谱', description: '完整介绍', exportedAt: '2026-10-07T00:00:00Z', persons, relations };
}
test('矢量竖排姓名的全部汉字实际绘制在同一中心线上且行距均匀', async () => {
  for (const name of ['王国安', '吴雅芳', '赵会弟', '曹小飞', '邓婉蓉', '赵冰', '欧阳长姓名完整验证']) {
    const data = fixture(1, 'binary'); data.persons[0].name = name;
    const result = await renderer.render(data, 'poster', { nameLayout: 'vertical' }, {});
    const streams = [];
    for (const match of result.bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      streams.push(inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'));
    }
    const content = streams.find(stream => stream.includes('\nBT\n'));
    assert.ok(content);
    const positions = [...content.matchAll(/BT\n1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\n\/F\d+ ([\d.]+) Tf/g)].slice(-Array.from(name).length);
    assert.equal(positions.length, Array.from(name).length);
    const xs = positions.map(p => Number(p[1]));
    assert.ok(Math.max(...xs) - Math.min(...xs) < 0.001, name + ' 竖排偏移');
    const ys = positions.map(p => Number(p[2]));
    const step = ys[0] - ys[1];
    assert.ok(step > 0);
    for (let i = 2; i < ys.length; i += 1) assert.ok(Math.abs(ys[i - 1] - ys[i] - step) < 0.001);
    assert.equal(result.pageCount, 1);
  }
});
for (const [count, shape] of [[1, 'binary'], [36, 'binary'], [80, 'binary'], [200, 'binary'], [500, 'binary'], [500, 'wide'], [500, 'deep'], [500, 'isolated']]) test('矢量全谱完整导出 ' + count + ' 人 ' + shape, async () => {
  const data = fixture(count, shape); const result = await renderer.render(data, 'poster', { nameLayout: count === 80 ? 'vertical' : 'horizontal' }, {});
  assert.equal(result.pageCount, 1);
  assert.equal((result.bytes.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
  assert.equal(result.personCount, count); assert.equal(result.relationCount, data.relations.length);
  assert.match(result.bytes.toString('latin1'), /\/Subtype \/Type0/); assert.doesNotMatch(result.bytes.toString('latin1'), /\/Subtype \/Image/);
});
test('A4 500 人谱书完整生成，所有关系均进入世系图且资料编号唯一', async () => {
  const data = fixture(500, 'binary'); data.relations.push({ _id: 'spouse', type: 'spouse', fromPersonId: 'p1', toPersonId: 'p2' });
  const model = renderer.bookModel(data);
  assert.equal(model.ids.size, 500); assert.equal(model.edges.size, 499);
  assert.ok(model.sections.every(section => section.children.length <= 8));
  const result = await renderer.render(data, 'book', {}, {});
  assert.equal(result.personCount, 500); assert.ok(result.pageCount > 250);
  assert.match(result.bytes.toString('latin1'), /\/MediaBox \[0 0 595.28 841.89\]/);
  assert.match(result.bytes.toString('latin1'), /\/Outlines/);
});
test('PDF 不支持的字符明确失败，空谱不生成空文件', async () => {
  const data = fixture(1, 'binary'); data.persons[0].name = '字符\u{10ffff}';
  await assert.rejects(renderer.render(data, 'book', {}, {}), { code: 'PDF_FONT_MISSING_GLYPH' });
  await assert.rejects(renderer.render(fixture(0, 'binary'), 'poster', {}, {}), { code: 'PDF_EMPTY' });
});


test('PDF 小程序码准备失败不派发，原任务重试不额外计次且私密码不公开', async () => {
  let calls = 0;
  const h = harness('viewer', undefined, async () => { if (++calls === 1) throw new Error('WX unavailable'); return { base64: CODE_BASE64, invitationId: 'permanent' }; });
  const failed = await h.service.create(h.input);
  assert.equal(failed.status, 'failed'); assert.equal(failed.failureCode, 'PDF_MINI_CODE_FAILED'); assert.equal(h.calls.length, 0);
  const retried = await h.service.create({ ...h.input, requestId: 'code-retry', retryTaskId: failed.taskId });
  assert.equal(retried.status, 'pending'); assert.equal(h.db.get('users', 'actor').pdfCount, 1);
  assert.equal(retried.miniCodeBase64, undefined); assert.equal(retried.miniCodeInvitationId, undefined);
  assert.equal(h.db.get('export_tasks', failed.taskId).miniCodeInvitationId, 'permanent');
  assert.equal((await h.worker.process(failed.taskId)).completed, true);
});
test('PDF 未准备好小程序码的任务不能被领取，恢复状态后才派发', async () => {
  const h = harness(); const task = await h.service.create(h.input);
  await h.db.collection('export_tasks').doc(task.taskId).update({ data: { miniCodeBase64: '' } });
  assert.equal((await h.worker.process(task.taskId)).skipped, true);
  assert.equal((await h.service.status({ taskId: task.taskId })).task.status, 'pending');
  assert.equal((await h.worker.process(task.taskId)).completed, true);
});
test('PDF 小程序码返回非法图像时明确失败，谱书不生成分享邀请', async () => {
  const h = harness('viewer', undefined, async () => ({ base64: Buffer.from('not-image').toString('base64') }));
  assert.equal((await h.service.create(h.input)).failureCode, 'PDF_MINI_CODE_FAILED');
  const book = await h.service.create({ ...h.input, requestId: 'book-without-code', format: 'book' });
  assert.equal(book.status, 'pending'); assert.equal(h.db.get('export_tasks', book.taskId).miniCodeRequired, false);
});

test('并发准备小程序码时，迟到失败不能覆盖已成功的同一任务', async () => {
  let rejectFirst; let n = 0;
  const h = harness('viewer', undefined, () => ++n === 1 ? new Promise((resolve, reject) => { rejectFirst = reject; }) : Promise.resolve({ base64: CODE_BASE64 }));
  const first = h.service.create(h.input);
  while (!rejectFirst) await new Promise(resolve => setImmediate(resolve));
  const second = await h.service.create(h.input);
  rejectFirst(new Error('late code request failed'));
  assert.equal((await first).status, 'pending'); assert.equal(second.status, 'pending');
  assert.equal(h.db.get('users', 'actor').pdfCount, 1);
  assert.equal((await h.worker.process(second.taskId)).completed, true);
});

test('v3 双行和双列实际以 28 字号绘制，传统列顺序正确且默认头像嵌入', async () => {
  const PDFDocument = require('node:module').createRequire(require('node:path').resolve(__dirname, '../cloudfunctions/youpuJobs/pdf/render.js'))('pdfkit');
  const original = PDFDocument.prototype.text;
  const drawn = [];
  PDFDocument.prototype.text = function (value, x, y, options) {
    drawn.push({ value, x, y, size: this._fontSize, options });
    return original.call(this, value, x, y, options);
  };
  try {
    const data = fixture(1, 'binary'); data.persons[0].name = '一二三四五六七八九十甲';
    for (const nameLayout of ['horizontal', 'vertical']) {
      drawn.length = 0;
      data.posterLayout = layoutSnapshot.restore(layoutSnapshot.create(data.persons, [], nameLayout, 0), data.persons, [], 0, nameLayout);
      const result = await renderer.render(data, 'poster', { nameLayout, showAvatar: true, emptyAvatarStyle: 'default' }, {});
      const names = drawn.filter(row => row.size === 28);
      if (nameLayout === 'horizontal') {
        assert.deepEqual(names.map(row => row.value), ['一二三四五', '六七八九…']);
        assert.equal(names[1].y - names[0].y, 30);
        assert.ok(result.bytes.toString('latin1').includes('/Subtype /Image'));
      } else {
        assert.deepEqual(names.map(row => row.value), ['一', '二', '三', '四', '五', '六', '七', '…']);
        assert.ok(names[0].x > names[4].x);
        assert.equal(names[1].y - names[0].y, 32);
        assert.equal(names[0].y, names[4].y);
      }
    }
  } finally { PDFDocument.prototype.text = original; }
});
test('隐藏头像与竖排大图跳过照片下载和缺失计数，谱书仍处理照片', async () => {
  for (const mode of ['hidden', 'vertical', 'book']) {
    const h = harness(); h.db.put('persons', 'p1', { ...h.db.get('persons', 'p1'), avatarAssetId: 'missing' });
    h.input.display = { showAvatar: false, nameLayout: mode === 'vertical' ? 'vertical' : 'horizontal' };
    h.input.format = mode === 'book' ? 'book' : 'poster';
    const created = await h.service.create(h.input);
    assert.equal((await h.worker.process(created.taskId)).completed, true);
    assert.equal(h.db.get('export_tasks', created.taskId).unavailableMediaCount, mode === 'book' ? 1 : 0);
  }
});
