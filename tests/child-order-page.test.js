const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/api');

function loadPage(app) {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return app; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/tree/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data, {
    currentFamily: { _id: 'family' },
    canEdit: true,
    currentRole: 'admin',
    relationRevision: 7,
    collapsedPersonIds: [],
    selectedPerson: { _id: 'parent', name: '家长', gender: 'male' },
    rawPersons: [
      { _id: 'parent', name: '家长', gender: 'male' },
      { _id: 'a', name: '甲', gender: 'male' },
      { _id: 'b', name: '乙', gender: 'male' }
    ],
    rawRelations: [
      { _id: 'ra', type: 'parent_child', fromPersonId: 'parent', toPersonId: 'a', childOrder: 0 },
      { _id: 'rb', type: 'parent_child', fromPersonId: 'parent', toPersonId: 'b', childOrder: 1 }
    ]
  });
  page.setData = function (patch, callback) { Object.assign(page.data, patch); if (callback) callback(); };
  return page;
}

test('排序面板只允许不能由日期确定的子女互换，并提交完整版本化顺序', async function () {
  const app = { invalidateFamilyData: function () {} };
  const page = loadPage(app);
  const previousWx = global.wx;
  const previousCall = api.call;
  const toasts = [];
  global.wx = { showToast: function (options) { toasts.push(options); } };
  let request = null;
  api.call = function (type, payload) {
    request = { type: type, payload: payload };
    return Promise.resolve({ pending: true });
  };
  try {
    page.openChildOrderSheet();
    assert.equal(page.data.showChildOrderSheet, true);
    assert.deepEqual(page.data.childOrderItems.map(function (item) { return item.rankLabel; }), ['长子', '次子']);
    assert.equal(page.data.childOrderItems[0].canMoveDown, true);
    page.moveChildOrder({ currentTarget: { dataset: { id: 'a', direction: 'down' } } });
    assert.deepEqual(page._childOrderIds, ['b', 'a']);
    assert.deepEqual(page.data.childOrderItems.map(function (item) { return item.rankLabel; }), ['长子', '次子']);
    assert.equal(page.data.childOrderDirty, true);
    await page.saveChildOrder();
    assert.equal(request.type, 'relation.reorderChildren');
    assert.deepEqual(request.payload, {
      familyId: 'family', parentPersonId: 'parent', orderedChildIds: ['b', 'a'], relationRevision: 7
    });
    assert.equal(page.data.showChildOrderSheet, false);
    assert.equal(toasts.at(-1).title, '已提交管理员审核');

    page.data.rawPersons[1].birthDate = '1980-01-01';
    page.data.rawPersons[2].birthDate = '1990-01-01';
    page.data.selectedPerson = { _id: 'parent', name: '家长', gender: 'male' };
    page.openChildOrderSheet();
    assert.equal(page.data.childOrderItems[0].canMoveDown, false);
    assert.equal(page.data.childOrderItems[1].canMoveUp, false);
  } finally {
    api.call = previousCall;
    global.wx = previousWx;
  }
});
