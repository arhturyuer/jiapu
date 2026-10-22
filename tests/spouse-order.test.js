require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const order = require('../miniprogram/utils/spouse-order');
const graph = require('../miniprogram/utils/graph-layout');
const snapshot = require('../miniprogram/utils/pdf-layout-snapshot');
const source = require('../cloudfunctions/youpuUserApi/pdf-graph-source');
const { bookModel } = require('../cloudfunctions/youpuJobs/pdf/book-model');
const { runtime } = require('./helpers/counting-runtime');
const { createDatabase } = require('./helpers/membership-db');
const actor = 'fixture-actor';
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const userId = 'u_' + hash(actor); const membershipId = 'fm_' + hash('family:' + actor);
function fixture(count = 3) {
  const persons = [{ _id: 'self', name: '本人', gender: 'male', status: 'active' }];
  const relations = [];
  for (let i = 0; i < count; i++) {
    persons.push({ _id: 'wife' + i, name: '配偶' + i, gender: 'female', status: 'active' });
    relations.push({ _id: 'edge' + i, type: 'spouse', fromPersonId: 'self', toPersonId: 'wife' + i, status: 'active' });
  }
  return { persons, relations };
}
function withOrder(data, anchor, ids) {
  const changes = order.proposal(data.persons, data.relations, anchor, ids);
  return { ...data, persons: data.persons.map(p => ({ ...p, ...(changes.has(p._id) ? { spouseDisplayOrder: changes.get(p._id) } : {}) })) };
}
function xs(data, options = {}) { return graph.layoutGraph(data.persons, data.relations, { mode: 'full', ...options }).nodes.sort((a, b) => a.x - b.x).map(p => p._id); }
function service(role = 'admin', data = fixture()) {
  const db = createDatabase();
  db.put('users', userId, { status: 'active' });
  db.put('families', 'family', { status: 'active', relationRevision: 0, contentRevision: 0, personCount: data.persons.length, relationCount: data.relations.length });
  db.put('family_memberships', membershipId, { familyId: 'family', userId, role, status: 'active' });
  data.persons.forEach(p => db.put('persons', p._id, { ...p, familyId: 'family' }));
  data.relations.forEach(r => db.put('relations', r._id, { ...r, familyId: 'family' }));
  const h = runtime('cloudfunctions/youpuUserApi', db);
  let key = 0;
  return { db, call: input => h.call({ requestId: 'spouse-' + ++key, ...input }), reorder: (ids, personId = 'self', extra = {}) => h.call({ type: 'relation.reorderSpouses', requestId: 'spouse-' + ++key, familyId: 'family', personId, orderedPersonIds: ids, relationRevision: db.get('families', 'family').relationRevision, ...extra }) };
}

test('本人可处于首、中、末位；横竖姓名与输入顺序均保持手动顺序', () => {
  for (const ids of [['self', 'wife2', 'wife0', 'wife1'], ['wife2', 'self', 'wife0', 'wife1'], ['wife2', 'wife0', 'wife1', 'self']]) {
    const data = withOrder(fixture(), 'self', ids);
    for (const nameLayout of ['horizontal', 'vertical']) {
      assert.deepEqual(xs(data, { nameLayout }), ids);
      assert.deepEqual(xs({ persons: data.persons.slice().reverse(), relations: data.relations.slice().reverse() }, { nameLayout }), ids);
      assert.deepEqual(graph.groupPersonsByGeneration(data.persons, data.relations).orderedPersons.map(p => p._id), ids);
    }
  }
});

test('单配偶双方入口反向保存同一组顺序；复杂分组冲突拒绝且不修改原对象', () => {
  const first = withOrder(fixture(1), 'self', ['wife0', 'self']);
  const second = withOrder(first, 'wife0', ['self', 'wife0']);
  assert.deepEqual(xs(first), ['wife0', 'self']); assert.deepEqual(xs(second), ['self', 'wife0']);
  const data = fixture(2);
  data.relations.push({ _id: 'third', type: 'spouse', fromPersonId: 'wife0', toPersonId: 'wife1' });
  const saved = withOrder(data, 'self', ['self', 'wife0', 'wife1']);
  // Add a fourth member to distinguish the overlapping editor's member set.
  saved.persons.push({ _id: 'fourth', name: '第四人' });
  saved.relations.push({ _id: 'fourth-edge', type: 'spouse', fromPersonId: 'wife0', toPersonId: 'fourth' });
  const before = structuredClone(saved);
  assert.throws(() => order.proposal(saved.persons, saved.relations, 'wife0', ['wife1', 'wife0', 'self', 'fourth']), { code: 'SPOUSE_ORDER_CONFLICT' });
  assert.deepEqual(saved, before);
});

test('图片布局和PDF三版本快照回放、资料投影、谱书夫妻卡片顺序一致', () => {
  const data = withOrder(fixture(1), 'self', ['wife0', 'self']);
  const projected = { persons: data.persons.map(source.familyPerson), relations: data.relations.map(source.familyRelation) };
  assert.deepEqual(xs(projected), ['wife0', 'self']);
  const book = bookModel(projected);
  assert.deepEqual(book.units[0].parents, ['wife0', 'self']);
  for (const version of [1, 2, 3]) {
    const value = snapshot.create(projected.persons, projected.relations, 'horizontal', 0, version);
    const restored = snapshot.restore(value, projected.persons, projected.relations, 0, 'horizontal');
    assert.deepEqual(restored.nodes.sort((a, b) => a.x - b.x).map(p => p._id), ['wife0', 'self']);
  }
});

test('真实路由保存、版本失效、字段白名单及图谱和详情读取', async () => {
  const h = service(); const ids = ['wife2', 'self', 'wife0', 'wife1'];
  const result = await h.reorder(ids); assert.equal(result.success, true, result.message);
  assert.deepEqual(h.db.get('persons', 'self').spouseDisplayOrder, ids);
  assert.equal(h.db.get('families', 'family').relationRevision, 1);
  assert.equal(h.db.get('families', 'family').contentRevision, 1);
  assert.equal((await h.reorder(ids, 'self', { relationRevision: 0 })).code, 'GRAPH_CHANGED');
  const loaded = await h.call({ type: 'graph.get', familyId: 'family' });
  assert.equal(loaded.success, true, loaded.message);
  assert.deepEqual(xs(loaded.data), ids);
  const detail = await h.call({ type: 'person.get', personId: 'self' });
  assert.equal(detail.success, true, detail.message);
  assert.deepEqual(Array.from(detail.data.relatives, r => r.person._id), ids.filter(id => id !== 'self'));
  const update = await h.call({ type: 'person.update', personId: 'self', data: { bio: '虚构简介', spouseDisplayOrder: ['self'] } });
  assert.equal(update.success, true, update.message);
  assert.deepEqual(h.db.get('persons', 'self').spouseDisplayOrder, ids);
});

test('权限、缺本人、重复、跨谱、缺版本和零配偶拒绝且不写排序', async () => {
  for (const [role, ids, extra, code] of [
    ['viewer', ['self', 'wife0', 'wife1', 'wife2'], {}, 'NO_PERMISSION'],
    ['admin', ['wife0', 'wife1', 'wife2'], {}, 'GRAPH_CHANGED'],
    ['admin', ['self', 'wife0', 'wife0', 'wife2'], {}, 'INVALID_SPOUSE_ORDER'],
    ['admin', ['self', 'wife0', 'wife1', 'foreign'], {}, 'GRAPH_CHANGED'],
    ['admin', ['self', 'wife0', 'wife1', 'wife2'], { relationRevision: null }, 'GRAPH_REVISION_REQUIRED']
  ]) {
    const h = service(role); const result = await h.reorder(ids, 'self', extra);
    assert.equal(result.code, code, JSON.stringify(result)); assert.equal(h.db.get('families', 'family').relationRevision, 0);
  }
  assert.equal((await service('admin', fixture(0)).reorder(['self'])).code, 'SPOUSE_ORDER_NOT_NEEDED');
});

test('普通成员审核通过才生效，过期申请拒绝、拒绝审核保留原序', async () => {
  for (const mode of ['approve', 'stale', 'reject']) {
    const h = service('member', fixture(1)); const result = await h.reorder(['wife0', 'self']);
    assert.equal(result.success, true, result.message); assert.equal(result.data.pending, true);
    assert.equal(h.db.get('persons', 'self').spouseDisplayOrder, undefined);
    const membership = h.db.get('family_memberships', membershipId); h.db.put('family_memberships', membershipId, { ...membership, role: 'admin' });
    if (mode === 'stale') h.db.put('families', 'family', { ...h.db.get('families', 'family'), relationRevision: 1 });
    const reviewed = await h.call({ type: 'change.review', changeRequestId: result.data.requestId, decision: mode === 'reject' ? 'reject' : 'approve' });
    assert.equal(reviewed.success, mode !== 'stale', JSON.stringify(reviewed));
    assert.deepEqual(h.db.get('persons', 'self').spouseDisplayOrder, mode === 'approve' ? ['wife0', 'self'] : undefined);
  }
});

test('已排序后新增追加，删除配偶保留剩余顺序且删除本人清理反向设置', async () => {
  const h = service('admin', fixture(1)); assert.equal((await h.reorder(['wife0', 'self'])).success, true);
  const added = await h.call({ type: 'person.createRelated', familyId: 'family', anchorPersonId: 'self', relationType: 'spouse', person: { name: '新配偶', gender: 'female' } });
  assert.equal(added.success, true, added.message);
  const newId = added.data.person._id;
  assert.deepEqual(h.db.get('persons', 'self').spouseDisplayOrder, ['wife0', 'self', newId]);
  const deleted = await h.call({ type: 'person.delete', personId: newId });
  assert.equal(deleted.success, true, deleted.message);
  assert.deepEqual(h.db.get('persons', 'self').spouseDisplayOrder, ['wife0', 'self']);
});

test('顺序事务失败完整回滚，同一幂等键重试仅更新一次', async () => {
  const h = service('admin', fixture(1));
  h.db.writeHook = async name => { if (name === 'audit_logs') throw new Error('fixture failure'); };
  const extra = { requestId: 'same', relationRevision: 0 };
  assert.equal((await h.reorder(['wife0', 'self'], 'self', extra)).success, false);
  assert.equal(h.db.get('persons', 'self').spouseDisplayOrder, undefined);
  h.db.writeHook = null;
  assert.equal((await h.reorder(['wife0', 'self'], 'self', extra)).success, true);
  assert.equal((await h.reorder(['wife0', 'self'], 'self', extra)).success, true);
  assert.equal(h.db.get('families', 'family').relationRevision, 1);
});

test('并发夫妻排序仅一份版本可提交，冲突写入保留已有顺序', async () => {
  const h = service('admin', fixture(1));
  const results = await Promise.all([
    h.reorder(['wife0', 'self'], 'self', { requestId: 'left', relationRevision: 0 }),
    h.reorder(['self', 'wife0'], 'wife0', { requestId: 'right', relationRevision: 0 })
  ]);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(results.filter(r => r.code === 'GRAPH_CHANGED').length, 1);
  assert.equal(h.db.get('families', 'family').relationRevision, 1);
  const data = withOrder(fixture(2), 'self', ['self', 'wife0', 'wife1']);
  const conflict = service('admin', data); const before = structuredClone(conflict.db.get('persons', 'self'));
  assert.equal((await conflict.reorder(['wife0', 'self'], 'wife0')).code, 'SPOUSE_ORDER_CONFLICT');
  conflict.db.put('families', 'family', { ...conflict.db.get('families', 'family'), relationRevision: 1 });
  assert.equal((await conflict.reorder(['wife0', 'self'], 'wife0', { relationRevision: 0 })).code, 'GRAPH_CHANGED');
  assert.deepEqual(conflict.db.get('persons', 'self'), before);
});

test('有其他亲属路径时移除夫妻关系，清理双方排序而保留子女关系', async () => {
  const data = withOrder(fixture(1), 'self', ['wife0', 'self']);
  data.persons.push({ _id: 'child', name: '虚构子女', gender: 'male', status: 'active' });
  for (const parent of ['self', 'wife0']) data.relations.push({ _id: parent + '-child', type: 'parent_child', fromPersonId: parent, toPersonId: 'child', status: 'active' });
  const h = service('admin', data);
  const result = await h.call({ type: 'relation.remove', relationId: 'edge0' });
  assert.equal(result.success, true, result.message);
  assert.deepEqual(h.db.get('persons', 'self').spouseDisplayOrder, ['self']);
  assert.equal(h.db.all('relations').filter(r => r.status === 'active').length, 2);
});

test('两位、四位和八位配偶的长姓名及人物视角保留所选完整顺序', () => {
  for (const count of [2, 4, 8]) {
    let data = fixture(count); data.persons[1].name = '欧阳长名字';
    const ids = data.persons.map(p => p._id).reverse(); data = withOrder(data, 'self', ids);
    for (const nameLayout of ['horizontal', 'vertical']) {
      assert.deepEqual(xs(data, { mode: 'perspective', viewpointId: 'self', nameLayout, collapsedIds: ['self'] }), ids);
    }
  }
});

test('本人位于两端或中间时祖先与各配偶子女归属保持，快照可完整恢复', () => {
  for (const ids of [['self', 'wife1', 'wife0'], ['wife1', 'self', 'wife0'], ['wife1', 'wife0', 'self']]) {
    let data = fixture(2);
    data.persons.push({ _id: 'grand', name: '虚构长辈', gender: 'male' });
    data.relations.push({ _id: 'grand-self', type: 'parent_child', fromPersonId: 'grand', toPersonId: 'self' });
    for (let i = 0; i < 2; i++) {
      const id = 'child' + i; data.persons.push({ _id: id, name: '虚构子女' + i, gender: 'male' });
      for (const parent of ['self', 'wife' + i]) data.relations.push({ _id: parent + '-' + id, type: 'parent_child', fromPersonId: parent, toPersonId: id });
    }
    data = withOrder(data, 'self', ids);
    for (const nameLayout of ['horizontal', 'vertical']) {
      const value = snapshot.create(data.persons, data.relations, nameLayout, 1);
      const restored = snapshot.restore(value, data.persons, data.relations, 1, nameLayout);
      assert.deepEqual(restored.nodes.filter(p => ids.includes(p._id)).sort((a, b) => a.x - b.x).map(p => p._id), ids);
      for (let i = 0; i < 2; i++) {
        const drop = restored.lines.find(line => line.lineRole === 'drop' && line.relationIds.includes('wife' + i + '-child' + i));
        assert.ok(drop && drop.familyKey.includes('wife' + i));
      }
    }
  }
});
