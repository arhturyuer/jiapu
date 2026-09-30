require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const serverDate = require('../cloudfunctions/youpuUserApi/person-date');
const domain = require('../cloudfunctions/youpuUserApi/domain');
const clientDate = require('../miniprogram/utils/person-date');
const lifeStatus = require('../miniprogram/utils/member-life-status');
const childRank = require('../miniprogram/utils/child-rank');
const kinship = require('../miniprogram/utils/kinship');

function info(calendar, precision, year, month, day, isLeapMonth) {
  return { calendar: calendar, precision: precision, year: year, month: month || null, day: day || null, isLeapMonth: Boolean(isLeapMonth) };
}

test('公历与农历三种精度保留原值并生成可比较区间', function () {
  assert.deepEqual(serverDate.normalizeInfo(info('solar', 'year', 1980)).range, { start: '1980-01-01', end: '1980-12-31' });
  assert.deepEqual(serverDate.normalizeInfo(info('solar', 'month', 2000, 2)).range, { start: '2000-02-01', end: '2000-02-29' });
  assert.deepEqual(serverDate.normalizeInfo(info('solar', 'day', 2000, 2, 29)).range, { start: '2000-02-29', end: '2000-02-29' });
  assert.deepEqual(serverDate.normalizeInfo(info('lunar', 'year', 2023)).range, { start: '2023-01-22', end: '2024-02-09' });
  assert.deepEqual(serverDate.normalizeInfo(info('lunar', 'month', 2023, 2, null, true)).range, { start: '2023-03-22', end: '2023-04-19' });
  assert.deepEqual(serverDate.normalizeInfo(info('lunar', 'day', 2023, 2, 1, true)).range, { start: '2023-03-22', end: '2023-03-22' });
});

test('无效日期被拒绝，无法可靠换算的早期农历仍保留', function () {
  assert.ok(serverDate.normalizeInfo(info('solar', 'day', 1900, 2, 29)).error);
  assert.ok(serverDate.normalizeInfo(info('lunar', 'month', 2023, 3, null, true)).error);
  assert.ok(serverDate.normalizeInfo(info('lunar', 'day', 2023, 2, 30, true)).error);
  const early = serverDate.normalizeInfo(info('lunar', 'month', 1700, 8));
  assert.equal(early.error, '');
  assert.equal(early.range, null);
  assert.equal(clientDate.display({ birthDateInfo: early.info }, 'birth'), '农历 1700年8月');
  assert.ok(clientDate.toInfo({ calendar: 'solar', precision: 'day', year: '1900', month: '2', day: '29' }).error);
});

test('混合历法仅在区间可分离时确定长幼，生卒冲突只拒绝确定错误', function () {
  const lunar = serverDate.normalizeInfo(info('lunar', 'day', 2023, 2, 1, true));
  const a = { birthDateInfo: lunar.info, birthDateRange: lunar.range };
  const b = { birthDate: '2023-04-01' };
  assert.equal(childRank.comparableDateOrder(a, b), -1);
  assert.equal(kinship.ageOrder(b, a), 'older');
  const partial = serverDate.normalizeInfo(info('lunar', 'year', 2023));
  assert.equal(childRank.comparableDateOrder({ birthDateInfo: partial.info, birthDateRange: partial.range }, b), 0);
  assert.equal(serverDate.definitelyDeathBeforeBirth({ birthDate: '2000', deathDate: '1999' }), true);
  assert.equal(serverDate.definitelyDeathBeforeBirth({ birthDate: '2000', deathDate: '2000-01' }), false);
});

test('日期弹框的年、月、日“无”形成可保存精度，取消不修改原值', function () {
  let definition;
  const oldComponent = global.Component;
  global.Component = function (value) { definition = value; };
  delete require.cache[require.resolve('../miniprogram/components/person-date-picker/index')];
  require('../miniprogram/components/person-date-picker/index');
  global.Component = oldComponent;
  const changes = [];
  const picker = Object.assign({}, definition.methods, {
    data: Object.assign({}, definition.data, { value: clientDate.emptyDraft() }),
    setData: function (patch) {
      Object.keys(patch).forEach(function (key) {
        if (key.indexOf('.') < 0) this.data[key] = patch[key];
        else this.data[key.split('.')[0]][key.split('.')[1]] = patch[key];
      }, this);
    },
    triggerEvent: function (name, detail) { changes.push({ name: name, detail: detail }); }
  });
  picker.open();
  assert.equal(picker.data.yearOptions[0].value, '');
  assert.equal(picker.data.yearOptions[1].value, String(new Date().getFullYear()));
  assert.equal(picker.data.yearOptions[picker.data.yearOptions.length - 1].value, '1');
  assert.equal(picker.data.yearOptions.some(function (item) { return Number(item.value) > new Date().getFullYear(); }), false);
  const year1900 = picker.data.yearOptions.findIndex(function (item) { return item.value === '1900'; });
  picker.chooseDate({ detail: { value: [year1900, 5, 12] } });
  assert.equal(clientDate.displayDraft(picker.data.working), '公历 1900年5月12日');
  picker.close();
  assert.equal(changes.length, 0);
  picker.open();
  picker.chooseDate({ detail: { value: [year1900, 5, 12] } });
  picker.chooseDate({ detail: { value: [year1900, 0, 12] } });
  picker.confirm();
  assert.equal(changes[0].detail.value.precision, 'year');
  assert.equal(changes[0].detail.value.day, '');
  picker.open();
  picker.chooseDate({ detail: { value: [0, 5, 12] } });
  picker.confirm();
  assert.equal(clientDate.toInfo(changes[1].detail.value).info, null);
  picker.open();
  picker.chooseCalendar({ currentTarget: { dataset: { calendar: 'lunar' } } });
  const year2023 = picker.data.yearOptions.findIndex(function (item) { return item.value === '2023'; });
  picker.chooseDate({ detail: { value: [year2023, 2, 1] } });
  picker.toggleLeapMonth();
  picker.confirm();
  assert.equal(clientDate.displayDraft(changes[2].detail.value), '农历 2023年闰2月1日');
  assert.equal(changes[2].detail.value.isLeapMonth, true);
});

function chain(count) {
  const persons = Array.from({ length: count }, function (_, index) { return { _id: 'p' + index, name: '成员' + index, gender: 'male' }; });
  const relations = Array.from({ length: count - 1 }, function (_, index) { return { type: 'parent_child', fromPersonId: 'p' + index, toPersonId: 'p' + (index + 1) }; });
  return { persons: persons, relations: relations };
}

test('满80岁的后代使整条新增祖先链默认已故', function () {
  const graph = chain(3);
  graph.persons[2].birthDate = '1940';
  const today = new Date(2026, 8, 29);
  assert.equal(lifeStatus.defaultStatus(graph.persons, graph.relations, 'p0', 'father', today), 'deceased');
  assert.equal(lifeStatus.defaultStatus(graph.persons, graph.relations, 'p0', 'spouse', today), 'living');
  graph.persons[2].birthDate = '1946';
  assert.equal(lifeStatus.defaultStatus(graph.persons, graph.relations, 'p0', 'father', today), 'living');
});

test('最年轻一代往上恰好六代默认已故，不足六代仍健在', function () {
  const six = chain(6);
  const five = chain(5);
  assert.equal(lifeStatus.defaultStatus(six.persons, six.relations, 'p0', 'father'), 'deceased');
  assert.equal(lifeStatus.defaultStatus(five.persons, five.relations, 'p0', 'father'), 'living');
  assert.equal(lifeStatus.defaultStatus(six.persons, six.relations, 'missing', 'father'), 'living');
  const unrelated = chain(8);
  unrelated.persons.forEach(function (person) { person._id = 'other-' + person._id; });
  unrelated.relations.forEach(function (relation) {
    relation.fromPersonId = 'other-' + relation.fromPersonId;
    relation.toPersonId = 'other-' + relation.toPersonId;
  });
  assert.equal(lifeStatus.defaultStatus(five.persons.concat(unrelated.persons),
    five.relations.concat(unrelated.relations), 'p0', 'father'), 'living');
});

test('成员手动选择状态后不被关系切换的默认值覆盖', function () {
  let definition;
  const oldPage = global.Page, oldGetApp = global.getApp;
  global.Page = function (value) { definition = value; };
  global.getApp = function () { return {}; };
  delete require.cache[require.resolve('../miniprogram/pages/add-member/index')];
  require('../miniprogram/pages/add-member/index');
  global.Page = oldPage;
  global.getApp = oldGetApp;
  const graph = chain(6);
  const page = Object.assign({}, definition, {
    data: Object.assign({}, definition.data, { anchorId: 'p0', relationType: 'father' }),
    _graphPersons: graph.persons, _graphRelations: graph.relations,
    setData: function (patch) { Object.assign(this.data, patch); }
  });
  page.refreshDefaultLifeStatus();
  assert.equal(page.data.lifeStatus, 'deceased');
  page.chooseLifeStatus({ currentTarget: { dataset: { status: 'living' } } });
  page.data.relationType = 'mother';
  page.refreshDefaultLifeStatus();
  assert.equal(page.data.lifeStatus, 'living');
  assert.equal(page.data.deathDraft.year, '');
});

test('人物接口兼容旧公历请求，新增农历字段与状态清理按白名单处理', function () {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const start = source.indexOf('function normalizePersonDateFields(');
  const end = source.indexOf('\nasync function requireOwnedMedia(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    personDate: serverDate, cleanDate: domain.cleanDate, cleanText: domain.cleanText,
    cleanGender: function (value) { return value || 'unknown'; },
    cleanLifeStatus: function (value) { return value || 'unknown'; },
    assert: function (condition, code, message) { if (!condition) throw Object.assign(new Error(message), { code: code }); }
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.normalizePerson = normalizePerson; this.normalizePersonChanges = normalizePersonChanges;', context);
  const old = context.normalizePerson({ name: '旧成员', gender: 'male', birthDate: '1980-03' });
  assert.equal(old.birthDate, '1980-03');
  assert.equal(old.birthDateInfo, null);
  assert.equal(old.birthDateRange.start, '1980-03-01');
  const renormalizedOld = context.normalizePerson(old);
  assert.equal(renormalizedOld.birthDate, '1980-03');
  assert.equal(renormalizedOld.birthDateRange.start, '1980-03-01');
  const newPerson = context.normalizePerson({ name: '农历成员', gender: 'female', lifeStatus: 'deceased',
    birthDateInfo: info('lunar', 'day', 2023, 2, 1, true), deathDateInfo: info('solar', 'year', 2025) });
  assert.equal(newPerson.birthDate, '');
  assert.equal(newPerson.birthDateRange.start, '2023-03-22');
  assert.equal(newPerson.deathDate, '2025');
  assert.equal(context.normalizePersonChanges({ bio: '新简介' }).birthDateInfo, undefined);
  const legacyEdit = context.normalizePersonChanges({ birthDate: '1982' });
  assert.equal(legacyEdit.birthDate, '1982');
  assert.equal(legacyEdit.birthDateInfo, null);
  const living = context.normalizePersonChanges({ lifeStatus: 'living' });
  assert.equal(living.deathDate, '');
  assert.equal(living.deathDateInfo, null);
  assert.throws(function () {
    context.normalizePerson({ name: '冲突成员', gender: 'male', lifeStatus: 'deceased', birthDate: '2000', deathDate: '1999' });
  }, { code: 'PERSON_DEATH_BEFORE_BIRTH' });
});
