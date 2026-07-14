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
  assert.equal(full.lines.length, 499);
  assert.ok(elapsed < 1000, '纯布局耗时应小于 1 秒，实际 ' + elapsed + 'ms');

  const perspective = graph.layoutGraph(persons, relations, { mode: 'perspective', viewpointId: 'p42' });
  assert.equal(perspective.nodes.find(function (item) { return item._id === 'p42'; }).isViewpoint, true);

  const collapsed = graph.layoutGraph(persons, relations, { mode: 'full', collapsedIds: ['p1'] });
  assert.ok(collapsed.hiddenCount > 0);
  assert.equal(collapsed.nodes.length + collapsed.hiddenCount, 500);
});
