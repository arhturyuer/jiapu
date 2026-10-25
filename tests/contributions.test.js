require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runtime } = require('./helpers/counting-runtime');
const { createDatabase } = require('./helpers/membership-db');
const contributions = require('../cloudfunctions/youpuUserApi/contributions');
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const uid = actor => 'u_' + hash(actor);
function fixture(role = 'admin') {
  const db = createDatabase();
  db.now = new Date('2026-10-23T02:00:00Z');
  const actor = 'fixture-actor';
  db.put('users', uid(actor), { nickName: '小王', status: 'active' });
  db.put('families', 'family', { name: '王氏家谱', description: '', status: 'active', personCount: 2, relationCount: 0, relationRevision: 0, contentRevision: 0 });
  db.put('family_memberships', 'fm_' + hash('family:' + actor), { familyId: 'family', userId: uid(actor), displayName: '小王', role, status: 'active' });
  db.put('persons', 'p1', { familyId: 'family', name: '王五', gender: 'male', lifeStatus: 'deceased', birthDate: '', status: 'active' });
  db.put('persons', 'p2', { familyId: 'family', name: '王六', gender: 'female', lifeStatus: 'deceased', birthDate: '', status: 'active' });
  const server = runtime('cloudfunctions/youpuUserApi', db);
  let id = 0;
  return { db, actor, call: async input => {
    const result = await server.call({ familyId: 'family', requestId: 'contribution-' + ++id, ...input });
    return JSON.parse(JSON.stringify(result));
  }, changeRole(value) { const key = 'fm_' + hash('family:' + actor); db.put('family_memberships', key, { ...db.get('family_memberships', key), role: value }); } };
}
async function ok(h, type, data = {}) { const result = await h.call({ type, ...data }); assert.equal(result.success, true, result.message); return result.data; }

test('逐字段记录补充、修改、清空、头像及农历闰月，保存多字段仅一条', async () => {
  const h = fixture();
  const date = { calendar: 'lunar', precision: 'day', year: 1932, month: 8, day: 8, isLeapMonth: false };
  await ok(h, 'person.update', { personId: 'p1', data: { birthDateInfo: date, bio: '家族记忆' } });
  let data = await ok(h, 'contribution.list', { personId: 'p1' });
  assert.equal(data.items.length, 1);
  assert.deepEqual(data.items[0].changes.map(c => c.label), ['出生时间', '人物简介']);
  assert.equal(data.items[0].changes[0].before, '不详');
  assert.equal(data.items[0].changes[0].after, '农历 1932年8月8日');
  await ok(h, 'person.update', { personId: 'p1', data: { birthDateInfo: null, bio: '' } });
  data = await ok(h, 'contribution.list');
  assert.equal(data.items.length, 2);
  assert.ok(data.items.some(item => item.changes.some(c => c.before === '家族记忆' && c.after === '不详')));
  const scope = {};
  contributions.person(scope, { _id: 'p', name: '测试', avatarAssetId: 'private-old-address' }, { _id: 'p', name: '测试', avatarAssetId: 'private-new-address', birthDateInfo: { ...date, isLeapMonth: true } });
  const draft = contributions.take(scope);
  assert.equal(draft.changes.find(c => c.field === 'avatarAssetId').description, '更换头像');
  assert.ok(draft.changes.some(c => c.after === '农历 1932年闰8月8日'));
  assert.doesNotMatch(JSON.stringify(draft), /private-/);
});

test('无变化保存不新增贡献；同幂等键仅一条，审计失败回滚资料和记录', async () => {
  const h = fixture();
  await ok(h, 'person.update', { personId: 'p1', data: { name: '王五' } });
  await ok(h, 'family.update', { name: '王氏家谱', description: '' });
  assert.equal((await ok(h, 'contribution.list')).items.length, 0);
  const input = { type: 'person.update', requestId: 'same-request', personId: 'p1', data: { bio: '只写一次' } };
  await h.call(input); await h.call(input);
  assert.equal((await ok(h, 'contribution.list')).items.length, 1);
  h.db.writeHook = (name) => { if (name === 'audit_logs') throw new Error('simulated audit failure'); };
  const failed = await h.call({ type: 'person.update', personId: 'p1', data: { bio: '应回滚' } });
  assert.equal(failed.success, false);
  assert.equal(h.db.get('persons', 'p1').bio, '只写一次');
  h.db.writeHook = null;
  assert.equal((await ok(h, 'contribution.list')).items.length, 1);
});

test('审核通过归提交人，记录事务生效前值并附审核人；待审核与拒绝不计入', async () => {
  const h = fixture('member');
  const pending = await ok(h, 'person.update', { personId: 'p1', data: { bio: '申请内容' } });
  assert.equal((await ok(h, 'contribution.list')).items.length, 0);
  h.changeRole('admin');
  h.db.put('users', 'requester', { status: 'active' });
  const request = h.db.get('change_requests', pending.requestId);
  h.db.put('change_requests', pending.requestId, { ...request, createdBy: 'requester', requesterName: '小雨' });
  await ok(h, 'person.update', { personId: 'p1', data: { bio: '管理员先补充' } });
  await ok(h, 'change.review', { changeRequestId: pending.requestId, decision: 'approve' });
  const rows = (await ok(h, 'contribution.list')).items;
  const approved = rows.find(row => row.authorName === '小雨');
  assert.equal(approved.reviewerName, '小王');
  assert.equal(approved.changes[0].before, '管理员先补充');
  assert.equal(approved.changes[0].after, '申请内容');
  assert.doesNotMatch(JSON.stringify(rows), /requester|fixture-actor|authorId|reviewerId|requestId/);
  h.changeRole('member');
  const rejected = await ok(h, 'person.update', { personId: 'p1', data: { bio: '拒绝内容' } });
  h.changeRole('admin');
  await ok(h, 'change.review', { changeRequestId: rejected.requestId, decision: 'reject' });
  assert.equal((await ok(h, 'contribution.list')).items.length, 2);
});

test('创建家谱初始人物和关系归创建者，新增关系关联两端，删除关联所有邻居', async () => {
  const h = fixture();
  const created = await ok(h, 'family.create', { name: '虚构新家谱', description: '测试', startPerson: { name: '起始人物', gender: 'male' }, relatives: { fatherName: '父亲', motherName: '母亲', parentsAreSpouses: true } });
  const familyId = created.family._id;
  const records = await ok(h, 'contribution.list', { familyId });
  assert.equal(records.items.length, 1);
  assert.equal(records.items[0].authorName, '小王');
  assert.ok(records.items[0].changes.some(c => c.after === '父亲与母亲为配偶' || c.after === '母亲与父亲为配偶'));
  const persons = h.db.all('persons').filter(p => p.familyId === familyId);
  for (const person of persons) assert.equal((await ok(h, 'contribution.summary', { familyId, personId: person._id })).count, 1);
  const added = await ok(h, 'person.createRelated', { anchorPersonId: 'p1', relationType: 'son', person: { name: '新增子女', gender: 'male' } });
  assert.equal((await ok(h, 'contribution.list', { personId: 'p1' })).items.length, 1);
  assert.equal((await ok(h, 'contribution.list', { personId: added.person._id })).items.length, 1);
  await ok(h, 'person.delete', { personId: added.person._id });
  assert.equal((await ok(h, 'contribution.list', { personId: 'p1' })).items.length, 2);
});

test('所有当前角色免费读完整记录，跨谱、退出、未登录和非法参数拒绝', async () => {
  const h = fixture();
  await ok(h, 'person.update', { personId: 'p1', data: { bio: '公开给谱内成员' } });
  for (const role of ['admin', 'member', 'viewer']) {
    h.changeRole(role);
    assert.equal((await ok(h, 'contribution.list')).items.length, 1);
    assert.equal((await ok(h, 'contribution.summary')).count, 1);
  }
  h.db.put('persons', 'other', { familyId: 'other-family', status: 'active' });
  assert.equal((await h.call({ type: 'contribution.list', personId: 'other' })).code, 'CROSS_FAMILY_RELATION');
  assert.equal((await h.call({ type: 'contribution.list', authorKey: '$ne' })).code, 'INVALID_CONTRIBUTION_QUERY');
  assert.equal((await h.call({ type: 'contribution.list', cursor: 'bad' })).code, 'INVALID_CONTRIBUTION_CURSOR');
  const memberKey = 'fm_' + hash('family:' + h.actor);
  h.db.put('family_memberships', memberKey, { ...h.db.get('family_memberships', memberKey), status: 'left' });
  assert.equal((await h.call({ type: 'contribution.list' })).code, 'NO_FAMILY_ACCESS');
  assert.equal((await runtime('cloudfunctions/youpuUserApi', h.db, { actor: '' }).call({ type: 'contribution.list', familyId: 'family' })).success, false);
  assert.equal((await h.call({ type: 'public.contribution.list' })).code, 'UNKNOWN_ACTION');
});

test('同时间跨页无遗漏重复，旧摘要、同名身份、最新署名及精确编写者筛选', async () => {
  const h = fixture('viewer');
  for (let i = 0; i < 135; i++) h.db.put('audit_logs', 'legacy-' + String(i).padStart(3, '0'), { familyId: 'family', actorId: i % 2 ? 'one' : 'two', actorName: '同名家人', action: i % 5 ? 'person.update' : 'invite.create', objectType: 'person', objectId: 'p1', summary: '早期摘要', createdAt: h.db.now });
  h.db.put('audit_logs', 'newest', { familyId: 'family', actorId: 'one', actorName: '改名家人', action: 'person.update', objectType: 'person', objectId: 'p1', summary: '最新摘要', createdAt: new Date(h.db.now.getTime() + 1) });
  const summary = await ok(h, 'contribution.summary', { personId: 'p1' });
  assert.equal(summary.count, 2);
  assert.equal(summary.authors[0].name, '改名家人');
  const seen = [];
  let cursor = '';
  do {
    const data = await ok(h, 'contribution.list', { personId: 'p1', cursor });
    assert.ok(data.items.every(row => row.legacy && row.changes.length === 0));
    seen.push(...data.items.map(row => row._id));
    cursor = data.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 109);
  assert.equal(new Set(seen).size, seen.length);
  const filtered = await ok(h, 'contribution.list', { authorKey: summary.authors[0].key });
  assert.ok(filtered.items.every(row => row.authorKey === summary.authors[0].key));
});

test('旧审核记录仅在关联已通过申请可确认时归属，注销身份不展示旧名字', async () => {
  const h = fixture();
  h.db.put('users', 'old-requester', { status: 'deleted' });
  h.db.put('change_requests', 'old-request', { familyId: 'family', type: 'update_person', status: 'approved', createdBy: 'old-requester', requesterName: '应匿名姓名', payload: { personId: 'p1' } });
  for (const id of ['old-request', 'missing']) h.db.put('audit_logs', id, { familyId: 'family', actorId: uid(h.actor), actorName: '小王', action: 'change.approve', objectId: id, objectType: 'change_request', summary: '通过修改申请', createdAt: h.db.now });
  const data = await ok(h, 'contribution.list', { personId: 'p1' });
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].authorName, '已注销用户');
  assert.equal(data.items[0].reviewerName, '小王');
  assert.doesNotMatch(JSON.stringify(data), /应匿名姓名|old-requester/);
});

test('夫妻排序与子女排序保存可读前后值，相关人物都能读取；不变顺序不增加贡献', async () => {
  const h = fixture();
  await ok(h, 'relation.linkExisting', { anchorPersonId: 'p1', relatedPersonId: 'p2', relationType: 'spouse' });
  const linked = await ok(h, 'contribution.list', { personId: 'p2' });
  assert.equal(linked.items[0].changes[0].label, '亲属关系');
  await ok(h, 'relation.reorderSpouses', { personId: 'p1', orderedPersonIds: ['p2', 'p1'], relationRevision: h.db.get('families', 'family').relationRevision });
  assert.ok((await ok(h, 'contribution.list', { personId: 'p2' })).items.some(row => row.changes.some(change => change.after === '王六、王五')));
  const previous = (await ok(h, 'contribution.list')).items.length;
  await ok(h, 'relation.reorderSpouses', { personId: 'p1', orderedPersonIds: ['p2', 'p1'], relationRevision: h.db.get('families', 'family').relationRevision });
  assert.equal((await ok(h, 'contribution.list')).items.length, previous);
  const children = [];
  for (const name of ['甲', '乙']) children.push((await ok(h, 'person.createRelated', { anchorPersonId: 'p1', relationType: 'son', person: { name, gender: 'male' } })).person._id);
  const rank = require('../cloudfunctions/youpuUserApi/pdf-shared/child-rank');
  const persons = h.db.all('persons'), relations = h.db.all('relations');
  const before = rank.editorOrder(rank.build(persons, relations), 'p1');
  await ok(h, 'relation.reorderChildren', { parentPersonId: 'p1', orderedChildIds: before.slice().reverse(), relationRevision: h.db.get('families', 'family').relationRevision });
  for (const personId of ['p1', ...children]) assert.ok((await ok(h, 'contribution.list', { personId })).items.some(row => row.changes.some(change => change.label === '子女排行')));
});

test('审核人在注销后不再披露旧名字；旧申请与新匿名记录按同一身份去重', async () => {
  const h = fixture();
  h.db.put('users', 'deleted-source', { status: 'deleted', anonymousActorId: 'deleted_anon' });
  h.db.put('change_requests', 'approved-old', { familyId: 'family', type: 'update_person', status: 'approved', createdBy: 'deleted-source', requesterName: '旧姓名', payload: { personId: 'p1' } });
  h.db.put('audit_logs', 'old', { familyId: 'family', action: 'change.approve', objectId: 'approved-old', actorId: 'reviewer', actorName: '审核旧姓名', createdAt: h.db.now });
  h.db.put('users', 'reviewer', { status: 'deleted' });
  h.db.put('audit_logs', 'new', { familyId: 'family', action: 'person.update', contributionVersion: 1, contribution: { authorId: 'deleted_anon', authorName: '已注销用户', personIds: ['p1'], changes: [] }, createdAt: h.db.now });
  assert.equal((await ok(h, 'contribution.summary')).count, 1);
  const list = await ok(h, 'contribution.list');
  assert.ok(list.items.some(item => item.reviewerName === '已注销用户'));
  assert.doesNotMatch(JSON.stringify(list), /审核旧姓名|旧姓名/);
});

test('staging 验收工具拒绝 production；临时探针在目标或凭据不符时不读写数据库', async () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const vm = require('node:vm');
  const result = spawnSync(process.execPath, ['deployment/verify-contributions-staging.mjs'], { encoding: 'utf8', env: { ...process.env, DEPLOYMENT_TARGET: 'production' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /只允许独立 staging/);
  for (const options of [{ expected: 'fixture-staging', actual: 'foreign', secret: 'right' }, { expected: 'fixture-staging', actual: 'fixture-staging', secret: 'wrong' }, { expected: 'cloud1-d5gs5yj4l283d9c6d', actual: 'cloud1-d5gs5yj4l283d9c6d', secret: 'right' }]) {
    let operations = 0;
    const cloud = { init() {}, database: () => ({ collection: () => { operations++; throw new Error('must not access database'); } }), getWXContext: () => ({ ENV: options.actual }) };
    const context = { exports: {}, require: name => name === 'wx-server-sdk' ? cloud : require(name), process: { env: { PROBE_ENV: options.expected, SCF_NAMESPACE: options.actual, PROBE_SECRET: 'right', PROBE_RUN: 'fixture' } }, __dirname: __dirname, Buffer };
    vm.runInNewContext(fs.readFileSync('deployment/contribution-staging-probe.js', 'utf8'), context);
    await assert.rejects(context.exports.main({ action: 'cleanup', run: 'fixture', secret: options.secret }), /PROBE_ENV|PROBE_AUTH/);
    assert.equal(operations, 0);
  }
});

test('完整家庭备份导出字段前后值与审核姓名，旧记录留空且不导出内部身份', async () => {
  const fs = require('node:fs'); const vm = require('node:vm');
  const source = fs.readFileSync('cloudfunctions/youpuJobs/index.js', 'utf8');
  const history = [
    { actorName: '审核人', action: 'change.approve', summary: '通过修改申请', contribution: { authorId: 'private-author', authorName: '小王', reviewerId: 'private-reviewer', reviewerName: '小雨', changes: [{ objectName: '王五', label: '人物简介', before: '旧简介', after: '新简介，含标点\n含换行' }] } },
    { actorName: '早期家人', action: 'person.update', summary: '早期摘要' }
  ];
  const context = { Buffer, Date, maybeGet: async () => ({ name: '虚构家谱', status: 'active' }), listAllForExport: async name => name === 'audit_logs' ? history : [] };
  vm.runInNewContext(source.slice(source.indexOf('function csvCell('), source.indexOf('function safeFileName(')) + source.slice(source.indexOf('async function familyBackupDataset('), source.indexOf('async function buildFamilyBackup(')), context);
  const dataset = await context.familyBackupDataset({ familyId: 'family' });
  const csv = dataset.baseEntries.find(entry => entry.name === '完整变更历史.csv').content.toString('utf8');
  for (const text of ['编写详情', '小王', '小雨', '旧简介', '新简介', '早期摘要']) assert.ok(csv.includes(text));
  assert.doesNotMatch(csv, /private-author|private-reviewer/);
});
