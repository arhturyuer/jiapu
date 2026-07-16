const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const graph = require('../miniprogram/utils/graph-layout');

function person(id, name, birthDate, gender) {
  return { _id: id, name: name, birthDate: birthDate || '', gender: gender || 'unknown', status: 'active' };
}

function relation(id, type, fromPersonId, toPersonId) {
  return { _id: id, type: type, fromPersonId: fromPersonId, toPersonId: toPersonId, status: 'active' };
}

test('成员按代分组且伴侣在组内保持相邻', function () {
  const persons = [
    person('g1', '祖父', '1940-01-01', 'male'),
    person('g2', '祖母', '1942-01-01', 'female'),
    person('p1', '父亲', '1970-01-01', 'male'),
    person('p2', '母亲', '1972-01-01', 'female'),
    person('c1', '孩子', '2000-01-01')
  ];
  const relations = [
    relation('s1', 'spouse', 'g1', 'g2'),
    relation('r1', 'parent_child', 'g1', 'p1'),
    relation('s2', 'spouse', 'p1', 'p2'),
    relation('r2', 'parent_child', 'p1', 'c1')
  ];
  const result = graph.groupPersonsByGeneration(persons, relations);
  assert.deepEqual(result.groups.map(function (group) { return group.label; }), ['第一代', '第二代', '第三代']);
  assert.deepEqual(result.groups[0].persons.map(function (item) { return item._id; }), ['g1', 'g2']);
  assert.deepEqual(result.groups[1].persons.map(function (item) { return item._id; }), ['p1', 'p2']);
  assert.equal(result.generationByPerson.c1, 3);
});

test('断开的次要分支、孤立成员和循环关系归入辈分待确认', function () {
  const persons = [
    person('a1', '主谱长辈', '1940-01-01'),
    person('a2', '主谱成员', '1970-01-01'),
    person('a3', '主谱晚辈', '2000-01-01'),
    person('b1', '断开长辈', '1950-01-01'),
    person('b2', '断开晚辈', '1980-01-01'),
    person('x1', '孤立成员', '1990-01-01')
  ];
  const relations = [
    relation('a12', 'parent_child', 'a1', 'a2'),
    relation('a23', 'parent_child', 'a2', 'a3'),
    relation('b12', 'parent_child', 'b1', 'b2')
  ];
  const result = graph.groupPersonsByGeneration(persons, relations);
  const unresolved = result.groups.find(function (group) { return group.key === 'unresolved'; });
  assert.ok(unresolved);
  assert.deepEqual(new Set(unresolved.persons.map(function (item) { return item._id; })), new Set(['b1', 'b2', 'x1']));

  const cycle = graph.groupPersonsByGeneration(
    [person('c1', '循环一'), person('c2', '循环二')],
    [relation('c12', 'parent_child', 'c1', 'c2'), relation('c21', 'parent_child', 'c2', 'c1')]
  );
  assert.deepEqual(cycle.groups.map(function (group) { return group.key; }), ['unresolved']);
});

test('出生日期、姓名和固定 ID 形成稳定排序并支持 500 人', function () {
  const sameName = graph.groupPersonsByGeneration([
    person('root', '长辈', '1950-01-01'),
    person('b', '同名', '1980-01-01'),
    person('a', '同名', '1980-01-01')
  ], [
    relation('r1', 'parent_child', 'root', 'b'),
    relation('r2', 'parent_child', 'root', 'a')
  ]);
  assert.deepEqual(sameName.groups[1].persons.map(function (item) { return item._id; }), ['a', 'b']);
  assert.deepEqual(graph.sortPersonsByName([
    person('b', '同名'),
    person('a', '同名')
  ]).map(function (item) { return item._id; }), ['a', 'b']);

  const persons = [];
  const relations = [];
  for (let index = 0; index < 500; index += 1) {
    persons.push(person('p' + index, '成员' + index, String(1900 + index).slice(0, 4) + '-01-01'));
    if (index > 0) relations.push(relation('r' + index, 'parent_child', 'p' + (index - 1), 'p' + index));
  }
  const large = graph.groupPersonsByGeneration(persons, relations);
  assert.equal(large.orderedPersons.length, 500);
  assert.equal(large.groups.length, 500);
});

test('graph.get 返回资料缺失项摘要且成员页提供三种视图', function () {
  const root = path.resolve(__dirname, '..');
  const apiSource = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const pageSource = fs.readFileSync(path.join(root, 'miniprogram/pages/person-list/index.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/person-list/index.wxml'), 'utf8');
  assert.match(apiSource, /profileMissingFields:\s*profileMissingFields\(person\)/);
  assert.match(apiSource, /fields\.push\('story'\)/);
  assert.match(pageSource, /groupPersonsByGeneration/);
  assert.match(pageSource, /sortPersonsByName/);
  assert.match(pageSource, /profileMissingFields\.length/);
  assert.match(pageSource, /label:\s*'按辈分'/);
  assert.match(pageSource, /label:\s*'按姓名'/);
  assert.match(pageSource, /label:\s*'资料待补'/);
  assert.match(template, /bindtap="switchView"/);
});

test('成员页切换视图、搜索和资料完整空状态保持一致', function () {
  const originalGetApp = global.getApp;
  const originalPage = global.Page;
  let definition;
  global.getApp = function () { return { setCurrentFamily: function () {}, openFullGraph: function () {} }; };
  global.Page = function (value) { definition = value; };
  const pagePath = require.resolve('../miniprogram/pages/person-list/index.js');
  delete require.cache[pagePath];
  require(pagePath);
  global.getApp = originalGetApp;
  global.Page = originalPage;

  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData: function (patch, callback) {
      Object.assign(this.data, patch);
      if (callback) callback();
    }
  });
  const persons = [
    Object.assign(person('p1', '长辈', '1950-01-01'), { profileMissingFields: [], metaText: '1950 年出生', missingText: '待补：' }),
    Object.assign(person('p2', '孩子', '1980-01-01'), { profileMissingFields: ['avatar', 'story'], metaText: '1980 年出生', missingText: '待补：头像、简介或籍贯' })
  ];
  const relations = [relation('r1', 'parent_child', 'p1', 'p2')];
  page.buildViews(persons, relations);
  assert.deepEqual(page.data.generationSections.map(function (section) { return section.label; }), ['第一代', '第二代']);

  page.switchView({ currentTarget: { dataset: { mode: 'missing' } } });
  assert.deepEqual(page.data.displayedPersons.map(function (item) { return item._id; }), ['p2']);
  page.switchView({ currentTarget: { dataset: { mode: 'name' } } });
  page.inputKeyword({ detail: { value: '孩子' } });
  assert.equal(page.data.searching, true);
  assert.deepEqual(page.data.displayedPersons.map(function (item) { return item._id; }), ['p2']);

  page.clearKeyword();
  page.switchView({ currentTarget: { dataset: { mode: 'missing' } } });
  page.buildViews([persons[0]], []);
  assert.equal(page.data.showEmpty, true);
});
