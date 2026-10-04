require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../miniprogram/utils/api');
const domain = require('../cloudfunctions/youpuUserApi/domain');
const graph = require('../miniprogram/utils/graph-layout');

function createPage() {
  let definition;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  try {
    global.getApp = function () { return {}; };
    global.Page = function (value) { definition = value; };
    const modulePath = require.resolve('../miniprogram/pages/create-family/index');
    delete require.cache[modulePath];
    require(modulePath);
  } finally {
    global.getApp = previousGetApp;
    global.Page = previousPage;
  }
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function (patch) { Object.assign(page.data, patch); };
  page.onLoad({});
  return page;
}

function input(page, field, value) {
  page.inputField({ currentTarget: { dataset: { field: field } }, detail: { value: value } });
}

test('首次创建的双亲夫妻选项默认选中，仅非空双亲显示', function () {
  const page = createPage();
  assert.equal(page.data.parentsAreSpouses, true);
  assert.equal(page.data.hasBothParents, false);
  input(page, 'fatherName', ' 测试父亲 ');
  input(page, 'motherName', '  ');
  assert.equal(page.data.hasBothParents, false);
  input(page, 'motherName', ' 测试母亲 ');
  assert.equal(page.data.hasBothParents, true);
  assert.equal(page.data.parentsAreSpouses, true);
});

test('取消后往返步骤、改名和清空重填均保留选择，新创建恢复默认', function () {
  const page = createPage();
  page.setData({ step: 2, startName: '测试成员', startGender: 'male' });
  input(page, 'fatherName', '测试父亲');
  input(page, 'motherName', '测试母亲');
  page.chooseParentsAreSpouses({ detail: { value: [] } });
  page.nextStep();
  page.previousStep();
  page.previousStep();
  page.nextStep();
  input(page, 'fatherName', '改名父亲');
  input(page, 'motherName', '');
  assert.equal(page.data.hasBothParents, false);
  input(page, 'motherName', '重新填写母亲');
  assert.equal(page.data.hasBothParents, true);
  assert.equal(page.data.parentsAreSpouses, false);
  page.chooseParentsAreSpouses({ detail: { value: ['parentsAreSpouses'] } });
  assert.equal(page.data.parentsAreSpouses, true);
  assert.equal(createPage().data.parentsAreSpouses, true);
});

test('创建请求提交实际夫妻选择和清洗后的姓名，失败后保留选择', async function (t) {
  const previousCall = api.call;
  const previousWx = global.wx;
  const requests = [];
  t.after(function () { api.call = previousCall; global.wx = previousWx; });
  global.wx = { showToast: function () {} };
  api.call = function (type, payload) {
    requests.push({ type: type, payload: payload });
    return Promise.reject(new Error('测试失败'));
  };
  const page = createPage();
  page.setData({ startName: '测试成员', startGender: 'male', familyName: '测试家谱' });
  input(page, 'fatherName', ' 测试父亲 ');
  input(page, 'motherName', ' 测试母亲 ');
  page.createFamily();
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(requests[0].type, 'family.create');
  assert.equal(requests[0].payload.relatives.parentsAreSpouses, true);
  assert.equal(requests[0].payload.relatives.fatherName, '测试父亲');
  assert.equal(requests[0].payload.relatives.motherName, '测试母亲');
  page.chooseParentsAreSpouses({ detail: { value: [] } });
  page.createFamily();
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(requests[1].payload.relatives.parentsAreSpouses, false);
  assert.equal(page.data.parentsAreSpouses, false);
  assert.equal(page.data.submitting, false);
});

function loadFamilyCreate() {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const records = { persons: new Map(), relations: new Map(), families: new Map() };
  const transaction = {
    collection: function (name) {
      return {
        add: async function (value) {
          records[name].set('family-test', value.data);
          return { _id: 'family-test' };
        },
        doc: function (id) {
          return {
            set: async function (value) { if (records[name]) records[name].set(id, value.data); },
            update: async function (value) { Object.assign(records[name].get(id), value.data); }
          };
        }
      };
    }
  };
  const context = {
    getOpenid: function () { return 'fake-openid'; },
    requireActiveUser: async function () { return { _id: 'fake-user' }; },
    cleanText: domain.cleanText,
    cleanGender: function (value) { return value; },
    normalizePerson: function (value) { return value; },
    assertKnownGender: function (value) { assert.ok(['male', 'female'].includes(value)); },
    assert: function (value, code) { assert.ok(value, code); },
    requireOwnedMedia: async function () {},
    moderateText: async function () {},
    mutate: async function (action, event, openid, callback) { return callback(transaction); },
    db: { serverDate: function () { return 'fake-date'; } },
    membershipId: function () { return 'fake-membership'; },
    userId: function () { return 'fake-user'; },
    relationId: function (familyId, type, from, to) { return [familyId, type, from, to].join(':'); },
    mustGet: async function (tx, collection, id) { assert.equal(tx, transaction); return records[collection].get(id); },
    maybeGet: async function (tx, collection, id) { return records[collection].get(id); },
    documentData: function (value) { return value; },
    createPersonTx: async function (tx, familyId, value) {
      assert.equal(tx, transaction);
      const person = Object.assign({}, value, { _id: 'person-' + records.persons.size, familyId: familyId, status: 'active' });
      records.persons.set(person._id, person);
      return person;
    },
    createRelatedTx: async function (tx, familyId, anchorId, type, value, openid) {
      const person = await context.createPersonTx(tx, familyId, value);
      const relation = domain.relationDefinition(anchorId, person._id, type);
      await context.createRelationTx(tx, familyId, relation.type, relation.fromId, relation.toId, openid);
      return { person: person, relationCount: 1 };
    },
    audit: async function () {},
    analytics: { firstConversion: async function () {} }
  };
  const relationStart = source.indexOf('async function createRelationTx(');
  const relationEnd = source.indexOf('\nfunction existingRelationDefinition(', relationStart);
  const start = source.indexOf('async function familyCreate(');
  const end = source.indexOf('\nasync function familyList(', start);
  assert.ok(relationStart >= 0 && relationEnd > relationStart && start >= 0 && end > start);
  vm.runInNewContext(source.slice(relationStart, relationEnd) + '\n' + source.slice(start, end), context);
  return { run: context.familyCreate, records: records };
}

test('服务端只在明确勾选且双亲齐全时创建夫妻关系，数量和版本准确', async function (t) {
  const scenarios = [
    { label: '双亲默认勾选', relatives: { fatherName: '测试父亲', motherName: '测试母亲', parentsAreSpouses: true }, persons: 3, relations: 3, spouses: 1 },
    { label: '包含第一位成员伴侣', relatives: { fatherName: '测试父亲', motherName: '测试母亲', parentsAreSpouses: true, spouseName: '测试伴侣', spouseGender: 'female' }, persons: 4, relations: 4, spouses: 2 },
    { label: '取消勾选', relatives: { fatherName: '测试父亲', motherName: '测试母亲', parentsAreSpouses: false }, persons: 3, relations: 2, spouses: 0 },
    { label: '旧客户端未传字段', relatives: { fatherName: '测试父亲', motherName: '测试母亲' }, persons: 3, relations: 2, spouses: 0 },
    { label: '字符串不视为勾选', relatives: { fatherName: '测试父亲', motherName: '测试母亲', parentsAreSpouses: 'true' }, persons: 3, relations: 2, spouses: 0 },
    { label: '仅父亲', relatives: { fatherName: '测试父亲', parentsAreSpouses: true }, persons: 2, relations: 1, spouses: 0 },
    { label: '仅母亲', relatives: { motherName: '测试母亲', parentsAreSpouses: true }, persons: 2, relations: 1, spouses: 0 },
    { label: '空白母亲', relatives: { fatherName: '测试父亲', motherName: '  ', parentsAreSpouses: true }, persons: 2, relations: 1, spouses: 0 },
    { label: '空白双亲', relatives: { fatherName: '  ', motherName: '  ', parentsAreSpouses: true }, persons: 1, relations: 0, spouses: 0 }
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.label, async function () {
      const harness = loadFamilyCreate();
      const result = await harness.run({ name: '测试家谱', startPerson: { name: '测试成员', gender: 'male' }, relatives: scenario.relatives });
      assert.equal(result.family._id, 'family-test');
      const family = harness.records.families.get(result.family._id);
      const persons = Array.from(harness.records.persons.values());
      const relations = Array.from(harness.records.relations.values());
      assert.equal(persons.length, scenario.persons);
      assert.equal(family.personCount, scenario.persons);
      assert.equal(relations.length, scenario.relations);
      assert.equal(family.relationCount, scenario.relations);
      assert.equal(family.relationRevision, scenario.relations);
      assert.equal(relations.filter(function (r) { return r.type === 'spouse'; }).length, scenario.spouses);
      assert.equal(relations.filter(function (r) { return r.type === 'parent_child'; }).length, persons.filter(function (p) { return p.name === '测试父亲' || p.name === '测试母亲'; }).length);
      if (scenario.relatives.parentsAreSpouses === true && scenario.persons >= 3) {
        const parents = persons.filter(function (p) { return p.name === '测试父亲' || p.name === '测试母亲'; });
        const ids = parents.map(function (p) { return p._id; }).sort();
        const edge = relations.find(function (r) { return r.type === 'spouse' && r.fromPersonId === ids[0] && r.toPersonId === ids[1]; });
        assert.ok(edge);
        const layout = graph.layoutGraph(persons, relations, { mode: 'full' });
        assert.ok(layout.lines.some(function (line) { return line.relationIds.includes(edge._id) && line.lineRole === 'spouse'; }));
      }
    });
  }
});
