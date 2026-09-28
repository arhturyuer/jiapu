const test = require('node:test');
const assert = require('node:assert/strict');
const childRank = require('../miniprogram/utils/child-rank');
const graph = require('../miniprogram/utils/graph-layout');

function person(id, name, gender, birthDate) {
  return { _id: id, name: name, gender: gender, birthDate: birthDate || '', status: 'active' };
}

function relation(id, parentId, childId, options) {
  return Object.assign({ _id: id, type: 'parent_child', fromPersonId: parentId, toPersonId: childId, status: 'active' }, options || {});
}

test('子女按性别分别生成长幼排行', function () {
  const persons = [
    person('parent', '家长', 'male', '1960'),
    person('s1', '甲', 'male', '1980-01-01'),
    person('d1', '乙', 'female', '1981-01-01'),
    person('s2', '丙', 'male', '1982-01-01'),
    person('d2', '丁', 'female', '1983-01-01'),
    person('s3', '戊', 'male', '1984-01-01')
  ];
  const relations = persons.slice(1).map(function (item, index) { return relation('r' + index, 'parent', item._id); });
  const result = childRank.build(persons, relations);
  assert.equal(result.byPerson.s1.childRankLabel, '长子');
  assert.equal(result.byPerson.s2.childRankLabel, '次子');
  assert.equal(result.byPerson.s3.childRankLabel, '三子');
  assert.equal(result.byPerson.d1.childRankLabel, '长女');
  assert.equal(result.byPerson.d2.childRankLabel, '次女');
  assert.equal(childRank.rankLabel('male', 11), '十一子');
});

test('无法区分年龄且未手动排序时长子在长女左侧', function () {
  const cases = [
    { name: '生日均缺失', daughterDate: '', sonDate: '', expected: ['son', 'daughter'] },
    { name: '仅长女有生日', daughterDate: '1990-03-01', sonDate: '', expected: ['son', 'daughter'] },
    { name: '日期精度不足', daughterDate: '1990', sonDate: '1990-03', expected: ['son', 'daughter'] },
    { name: '出生先后明确', daughterDate: '1980-01-01', sonDate: '1990-01-01', expected: ['daughter', 'son'] },
    { name: '已确认长女在前', daughterDate: '', sonDate: '', daughterOrder: 0, sonOrder: 1, expected: ['daughter', 'son'] }
  ];
  cases.forEach(function (scenario) {
    const persons = [
      person('parent', '家长', 'male'),
      person('daughter', '阿女', 'female', scenario.daughterDate),
      person('son', '志子', 'male', scenario.sonDate)
    ];
    const relations = [
      relation('daughter-r', 'parent', 'daughter', { childOrder: scenario.daughterOrder }),
      relation('son-r', 'parent', 'son', { childOrder: scenario.sonOrder })
    ];
    const ranked = childRank.build(persons, relations);
    const layout = graph.layoutGraph(persons, relations, { mode: 'full' });
    const positioned = layout.nodes.filter(function (node) { return node._id !== 'parent'; })
      .sort(function (first, second) { return first.x - second.x; })
      .map(function (node) { return node._id; });
    assert.deepEqual(ranked.parentOrders.parent, scenario.expected, scenario.name + '：排行顺序');
    assert.deepEqual(positioned, scenario.expected, scenario.name + '：家谱横坐标顺序');
    assert.equal(layout.nodes.find(function (node) { return node._id === 'son'; }).childRankLabel, '长子');
    assert.equal(layout.nodes.find(function (node) { return node._id === 'daughter'; }).childRankLabel, '长女');
  });
});

test('明确出生日期优先，日期重叠或缺失时使用手动顺序', function () {
  const parent = person('parent', '家长', 'female', '1960');
  const older = person('older', '早', 'male', '1980-01-01');
  const younger = person('younger', '晚', 'male', '1990-01-01');
  let result = childRank.build([parent, older, younger], [
    relation('older-r', 'parent', 'older', { childOrder: 2 }),
    relation('younger-r', 'parent', 'younger', { childOrder: 0 })
  ]);
  assert.equal(result.byPerson.older.childRankLabel, '长子');
  assert.equal(result.byPerson.younger.childRankLabel, '次子');

  const yearOnly = person('year', '年份', 'male', '1990');
  const monthKnown = person('month', '月份', 'male', '1990-03');
  result = childRank.build([parent, yearOnly, monthKnown], [
    relation('year-r', 'parent', 'year', { childOrder: 2 }),
    relation('month-r', 'parent', 'month', { childOrder: 0 })
  ]);
  assert.equal(result.byPerson.month.childRankLabel, '长子');
  assert.equal(result.byPerson.year.childRankLabel, '次子');
  assert.equal(childRank.canSwap({ person: yearOnly }, { person: monthKnown }), true);
  assert.equal(childRank.canSwap({ person: older }, { person: younger }), false);

  const december = person('december', '十二月', 'male', '1990-12');
  const constrained = childRank.orderChildren([
    { person: yearOnly, relation: { childOrder: 1 } },
    { person: monthKnown, relation: { childOrder: 2 } },
    { person: december, relation: { childOrder: 0 } }
  ]);
  assert.ok(constrained.findIndex(function (item) { return item.person._id === 'month'; })
    < constrained.findIndex(function (item) { return item.person._id === 'december'; }),
  '明确的三月必须位于十二月之前，不受与全年区间重叠的手动顺序干扰');
});

test('缺失日期可人工排序，性别未知不生成排行', function () {
  const persons = [
    person('parent', '家长', 'male'),
    person('a', '甲', 'female'),
    person('b', '乙', 'female'),
    person('unknown', '待确认', 'unknown')
  ];
  const result = childRank.build(persons, [
    relation('a-r', 'parent', 'a', { childOrder: 4 }),
    relation('b-r', 'parent', 'b', { childOrder: 1 }),
    relation('unknown-r', 'parent', 'unknown', { childOrder: 0 })
  ]);
  assert.equal(result.byPerson.b.childRankLabel, '长女');
  assert.equal(result.byPerson.a.childRankLabel, '次女');
  assert.equal(result.byPerson.unknown, undefined);
});

test('未确认性别成员不使默认男女顺序依赖输入顺序', function () {
  const rows = [
    { person: person('daughter', '阿女', 'female'), relation: {} },
    { person: person('unknown', '待确认', 'unknown', '1990'), relation: {} },
    { person: person('son', '志子', 'male'), relation: {} }
  ];
  const orderedIds = function (items) {
    return childRank.orderChildren(items).map(function (item) { return item.person._id; });
  };
  assert.deepEqual(orderedIds(rows), ['son', 'daughter', 'unknown']);
  assert.deepEqual(orderedIds(rows.slice().reverse()), ['son', 'daughter', 'unknown']);
});

test('跨伴侣子女按同一家长连续排行', function () {
  const persons = [
    person('father', '父亲', 'male', '1960'),
    person('mother-a', '配偶甲', 'female', '1962'),
    person('mother-b', '配偶乙', 'female', '1964'),
    person('a', '甲子', 'male', '1980'),
    person('b', '乙子', 'male', '1982'),
    person('c', '丙子', 'male', '1984')
  ];
  const relations = [
    { _id: 'sp-a', type: 'spouse', fromPersonId: 'father', toPersonId: 'mother-a', status: 'active' },
    { _id: 'sp-b', type: 'spouse', fromPersonId: 'father', toPersonId: 'mother-b', status: 'active' },
    relation('fa', 'father', 'a'), relation('ma', 'mother-a', 'a'),
    relation('fb', 'father', 'b'), relation('mb', 'mother-b', 'b'),
    relation('fc', 'father', 'c'), relation('mc', 'mother-a', 'c')
  ];
  const result = childRank.build(persons, relations);
  assert.equal(result.parentRanks.father.a.label, '长子');
  assert.equal(result.parentRanks.father.b.label, '次子');
  assert.equal(result.parentRanks.father.c.label, '三子');
});

test('双亲排行冲突时选择最近调整的父母口径', function () {
  const persons = [
    person('father', '父亲', 'male'), person('mother', '母亲', 'female'),
    person('older', '哥哥', 'male', '1980'), person('target', '目标', 'male', '1990'), person('younger', '弟弟', 'male', '2000')
  ];
  const relations = [
    relation('fo', 'father', 'older'),
    relation('ft', 'father', 'target', { childOrderUpdatedAt: '2025-01-01T00:00:00Z' }),
    relation('mt', 'mother', 'target', { childOrderUpdatedAt: '2026-01-01T00:00:00Z' }),
    relation('my', 'mother', 'younger')
  ];
  const target = childRank.build(persons, relations).byPerson.target;
  assert.equal(target.childRankLabel, '长子');
  assert.equal(target.childRankParentId, 'mother');
  assert.equal(target.childRankConflict, true);
  assert.equal(target.childRankBasisText, '按母亲的子女排行');
});

test('折叠分支不改变可见成员的子女排行', function () {
  const persons = [
    person('parent', '家长', 'male'),
    person('older', '长子', 'male', '1980'),
    person('younger', '次子', 'male', '1990'),
    person('grandchild', '孙辈', 'female', '2010')
  ];
  const relations = [
    relation('r1', 'parent', 'older'), relation('r2', 'parent', 'younger'), relation('r3', 'older', 'grandchild')
  ];
  const layout = graph.layoutGraph(persons, relations, { mode: 'full', collapsedIds: ['older'] });
  assert.equal(layout.nodes.find(function (node) { return node._id === 'younger'; }).childRankLabel, '次子');
});
