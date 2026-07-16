const test = require('node:test');
const assert = require('node:assert/strict');

function loadMemberDetailPage() {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () {
    return {
      globalData: { familyList: [] },
      getCurrentFamily: function () { return null; },
      openPerspective: function () {}
    };
  };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/member-detail/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  return definition;
}

function createPage(overrides) {
  const page = Object.assign({}, loadMemberDetailPage());
  page.data = Object.assign({}, page.data, {
    person: { _id: 'person', name: '赵红弟' },
    relatives: [
      { relationId: 'r1', label: '父亲', person: { _id: 'relative-1', name: '赵大哥' } },
      { relationId: 'r2', label: '父亲', person: { _id: 'relative-2', name: '赵二哥' } }
    ]
  }, overrides || {});
  page.setData = function (patch, callback) {
    Object.assign(page.data, patch);
    if (callback) callback();
  };
  return page;
}

function touchEvent(relationId, x, y, changed) {
  const point = { clientX: x, clientY: y };
  return {
    currentTarget: { dataset: { relationId: relationId } },
    touches: changed ? [] : [point],
    changedTouches: changed ? [point] : []
  };
}

test('管理员左滑时只展开一条关系且垂直滑动不触发', function () {
  const page = createPage({ isAdmin: true });
  page.onRelationTouchStart(touchEvent('r1', 200, 40));
  page.onRelationTouchMove(touchEvent('r1', 130, 44));
  page.onRelationTouchEnd(touchEvent('r1', 130, 44, true));
  assert.equal(page.data.openRelationId, 'r1');

  page.onRelationTouchStart(touchEvent('r2', 200, 40));
  page.onRelationTouchMove(touchEvent('r2', 120, 42));
  page.onRelationTouchEnd(touchEvent('r2', 120, 42, true));
  assert.equal(page.data.openRelationId, 'r2');

  page.onRelationTouchStart(touchEvent('r1', 200, 40));
  page.onRelationTouchMove(touchEvent('r1', 194, 110));
  page.onRelationTouchEnd(touchEvent('r1', 194, 110, true));
  assert.equal(page.data.openRelationId, 'r2');
});

test('普通成员不能通过手势展开移除入口', function () {
  const page = createPage({ isAdmin: false });
  page.onRelationTouchStart(touchEvent('r1', 200, 40));
  page.onRelationTouchMove(touchEvent('r1', 100, 42));
  page.onRelationTouchEnd(touchEvent('r1', 100, 42, true));
  assert.equal(page.data.openRelationId, '');
});

test('已展开关系行点击时先收起而不跳转', function () {
  const page = createPage({ isAdmin: true, openRelationId: 'r1' });
  const previousWx = global.wx;
  let navigations = 0;
  global.wx = { navigateTo: function () { navigations += 1; } };
  page.openRelative({ currentTarget: { dataset: { id: 'relative-1' } } });
  global.wx = previousWx;
  assert.equal(page.data.openRelationId, '');
  assert.equal(navigations, 0);
});

test('取消确认不会调用关系移除接口', async function () {
  const page = createPage({ isAdmin: true, openRelationId: 'r1' });
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const previousWx = global.wx;
  let calls = 0;
  api.call = function () { calls += 1; return Promise.resolve({}); };
  global.wx = { showModal: function () { return Promise.resolve({ confirm: false }); } };
  await page.removeRelation({ currentTarget: { dataset: { relationId: 'r1' } } });
  api.call = previousCall;
  global.wx = previousWx;
  assert.equal(calls, 0);
  assert.equal(page.data.openRelationId, 'r1');
});

test('移除成功后关闭操作行并刷新详情', async function () {
  const page = createPage({ isAdmin: true, openRelationId: 'r1' });
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const previousWx = global.wx;
  let refreshed = 0;
  let toast = '';
  api.call = function (type, payload) {
    assert.equal(type, 'relation.remove');
    assert.deepEqual(payload, { relationId: 'r1' });
    return Promise.resolve({ removed: true, relationId: 'r1' });
  };
  page.loadPerson = function () { refreshed += 1; return Promise.resolve(); };
  global.wx = {
    showModal: function () { return Promise.resolve({ confirm: true }); },
    showToast: function (options) { toast = options.title; }
  };
  await page.removeRelation({ currentTarget: { dataset: { relationId: 'r1' } } });
  api.call = previousCall;
  global.wx = previousWx;
  assert.equal(page.data.openRelationId, '');
  assert.equal(page.data.removingRelationId, '');
  assert.equal(refreshed, 1);
  assert.equal(toast, '关系已移除');
});

test('会造成断裂时展示明确提示并保留操作行', async function () {
  const page = createPage({ isAdmin: true, openRelationId: 'r1' });
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const previousWx = global.wx;
  const modals = [];
  const error = new Error('关系会断裂');
  error.code = 'RELATION_DISCONNECTS_GRAPH';
  api.call = function () { return Promise.reject(error); };
  global.wx = {
    showModal: function (options) {
      modals.push(options);
      return Promise.resolve({ confirm: modals.length === 1 });
    },
    showToast: function () {}
  };
  await page.removeRelation({ currentTarget: { dataset: { relationId: 'r1' } } });
  api.call = previousCall;
  global.wx = previousWx;
  assert.equal(page.data.openRelationId, 'r1');
  assert.equal(page.data.removingRelationId, '');
  assert.equal(modals.length, 2);
  assert.match(modals[1].content, /请先建立正确关系/);
});
