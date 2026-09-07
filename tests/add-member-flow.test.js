const test = require('node:test');
const assert = require('node:assert/strict');

function loadPage() {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return { invalidateFamilyData: function () {} }; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/add-member/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  return definition;
}

function createPage(overrides) {
  const definition = loadPage();
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data, {
    familyId: 'family', anchorId: 'anchor', anchorName: '爸爸', relationType: 'son', relationLabel: '儿子',
    loadingContext: false, selectedSharedParentIds: [], selectedSharedChildIds: []
  }, overrides || {});
  page.setData = function (patch, callback) { Object.assign(page.data, patch); if (callback) callback(); };
  page._drafts = { new: {}, existing: {} };
  return page;
}

const persons = [
  { _id: 'anchor', name: '爸爸', gender: 'male' },
  { _id: 'mother', name: '妈妈', gender: 'female' },
  { _id: 'other', name: '另一位伴侣', gender: 'female' },
  { _id: 'father', name: '爷爷', gender: 'male' },
  { _id: 'child', name: '孩子', gender: 'male' }
];

test('添加子女时唯一伴侣默认成为另一位父母，多伴侣时不预选', function () {
  const page = createPage();
  page._graphPersons = persons;
  page._graphRelations = [{ type: 'spouse', fromPersonId: 'anchor', toPersonId: 'mother' }];
  page.refreshRelationChoices(true);
  assert.equal(page.data.coParentId, 'mother');

  page._graphRelations.push({ type: 'spouse', fromPersonId: 'anchor', toPersonId: 'other' });
  page.setData({ coParentId: '' });
  page.refreshRelationChoices(true);
  assert.equal(page.data.coParentId, '');
});

test('兄弟姐妹必须选择中心成员已有的共同父母', function () {
  const page = createPage({ relationType: 'sibling', relationLabel: '兄弟姐妹', name: '叔叔' });
  page._graphPersons = persons;
  page._graphRelations = [];
  page.refreshRelationChoices(true);
  assert.equal(page.data.siblingBlocked, true);
  assert.equal(page.canSubmit(), false);

  page._graphRelations = [{ type: 'parent_child', fromPersonId: 'father', toPersonId: 'anchor' }];
  page.refreshRelationChoices(true);
  assert.equal(page.data.siblingBlocked, false);
  page.toggleMulti({ currentTarget: { dataset: { field: 'selectedSharedParentIds', id: 'father' } } });
  assert.equal(page.canSubmit(), true);
  assert.deepEqual(page.requestPayload().sharedParentIds, ['father']);
});

test('添加关系请求携带附带关系且固定称谓锁定性别', function () {
  const page = createPage({ coParentId: 'mother', name: '孩子', gender: 'male' });
  assert.equal(page.requestPayload().coParentId, 'mother');
  page.chooseGender({ currentTarget: { dataset: { gender: 'female' } } });
  assert.equal(page.data.gender, 'male');
  page.chooseRelation({ currentTarget: { dataset: { type: 'daughter' } } });
  assert.equal(page.data.gender, 'female');
});

test('搜索和新建已有模式切换不会制造未保存提醒，并保留草稿', function () {
  const page = createPage({ name: '小明', hasUnsavedChanges: false });
  page._graphPersons = persons;
  page._graphRelations = [];
  page._existingCandidates = persons;
  page.filterExisting({ detail: { value: '妈' } });
  assert.equal(page.data.hasUnsavedChanges, false);
  page.chooseEntryMode({ currentTarget: { dataset: { mode: 'existing' } } });
  page.chooseEntryMode({ currentTarget: { dataset: { mode: 'new' } } });
  assert.equal(page.data.name, '小明');
  assert.equal(page.data.hasUnsavedChanges, false);
});
