const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../miniprogram/utils/graph-layout');

test('500 人家谱可以完整布局、切换视角并折叠分支', function () {
  const persons = [];
  const relations = [];
  for (let index = 0; index < 500; index += 1) {
    persons.push({ _id: 'p' + index, name: '成员' + index, gender: index % 2 ? 'male' : 'female', status: 'active' });
    if (index > 0) {
      relations.push({
        _id: 'r' + index,
        type: 'parent_child',
        fromPersonId: 'p' + Math.floor((index - 1) / 2),
        toPersonId: 'p' + index,
        status: 'active'
      });
    }
  }
  const started = Date.now();
  const full = graph.layoutGraph(persons, relations, { mode: 'full', viewpointId: '' });
  const elapsed = Date.now() - started;
  assert.equal(full.nodes.length, 500);
  assert.ok(full.lines.length >= 499);
  assert.ok(elapsed < 1000, '纯布局耗时应小于 1 秒，实际 ' + elapsed + 'ms');

  const perspective = graph.layoutGraph(persons, relations, { mode: 'perspective', viewpointId: 'p42' });
  assert.equal(perspective.nodes.find(function (item) { return item._id === 'p42'; }).isViewpoint, true);

  const collapsed = graph.layoutGraph(persons, relations, { mode: 'full', collapsedIds: ['p1'] });
  assert.ok(collapsed.hiddenCount > 0);
  assert.equal(collapsed.nodes.length + collapsed.hiddenCount, 500);

  const suggested = graph.suggestCollapsedIds(persons, relations, { limit: 36 });
  const optimized = graph.layoutGraph(persons, relations, { mode: 'full', collapsedIds: suggested });
  assert.ok(suggested.length > 0, '大家谱应建议收起深层分支');
  assert.ok(optimized.nodes.length <= 36, '智能收起后应控制首屏成员数量');
});

test('单一大家庭也会降级收起顶层分支，避免一次渲染数百节点', function () {
  const persons = [{ _id: 'root', name: '长辈', gender: 'male', status: 'active' }];
  const relations = [];
  for (let index = 0; index < 200; index += 1) {
    persons.push({ _id: 'child-' + index, name: '成员' + index, gender: 'female', status: 'active' });
    relations.push({
      _id: 'relation-' + index,
      type: 'parent_child',
      fromPersonId: 'root',
      toPersonId: 'child-' + index,
      status: 'active'
    });
  }
  const collapsedIds = graph.suggestCollapsedIds(persons, relations, { limit: 36 });
  const optimized = graph.layoutGraph(persons, relations, { mode: 'full', collapsedIds: collapsedIds });
  assert.ok(collapsedIds.includes('root'));
  assert.ok(optimized.nodes.length <= 36);
  assert.equal(optimized.hiddenCount, 200);
});

test('多子女家庭最多为 12 条子女路径播放流光，其余保持静态高亮', function () {
  const persons = [
    { _id: 'father', name: '父亲', gender: 'male', status: 'active' },
    { _id: 'mother', name: '母亲', gender: 'female', status: 'active' }
  ];
  const relations = [
    { _id: 'spouse', type: 'spouse', fromPersonId: 'father', toPersonId: 'mother', status: 'active' }
  ];
  for (let index = 0; index < 15; index += 1) {
    const childId = 'child-' + index;
    persons.push({ _id: childId, name: '孩子' + index, gender: 'female', status: 'active' });
    relations.push({
      _id: 'father-' + index,
      type: 'parent_child',
      fromPersonId: 'father',
      toPersonId: childId,
      status: 'active'
    });
    relations.push({
      _id: 'mother-' + index,
      type: 'parent_child',
      fromPersonId: 'mother',
      toPersonId: childId,
      status: 'active'
    });
  }
  const selected = graph.layoutGraph(persons, relations, { mode: 'full', selectedPersonId: 'father' });
  const drops = selected.lines.filter(function (line) {
    return line.isFlow && line.flowRole === 'child-drop';
  });
  assert.equal(drops.length, 15);
  assert.equal(drops.filter(function (line) { return line.isAnimatedFlow; }).length, 12);
  assert.equal(drops.filter(function (line) { return !line.isAnimatedFlow; }).length, 3);
});
