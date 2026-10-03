require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadApp(apiCall, badges) {
  const api = require('../miniprogram/utils/api');
  const originalCall = api.call;
  const previousApp = global.App;
  const previousWx = global.wx;
  let definition;
  api.call = apiCall;
  global.App = function (value) { definition = value; };
  global.wx = {
    getStorageSync: function () { return null; },
    setStorageSync: function () {},
    removeStorageSync: function () {},
    setTabBarBadge: function (value) { badges.push(value.text); },
    removeTabBarBadge: function () { badges.push(''); }
  };
  try {
    delete require.cache[require.resolve('../miniprogram/app')];
    require('../miniprogram/app');
    const app = Object.assign({}, definition);
    app.globalData = Object.assign({}, definition.globalData, { user: { _id: 'member-1' }, accountState: 'active' });
    return { app: app, restore: function () { api.call = originalCall; global.App = previousApp; global.wx = previousWx; } };
  } catch (error) {
    api.call = originalCall;
    global.App = previousApp;
    global.wx = previousWx;
    throw error;
  }
}

function loadPage(relativePath, app) {
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  let definition;
  global.getApp = function () { return app; };
  global.Page = function (value) { definition = value; };
  try {
    delete require.cache[require.resolve(relativePath)];
    require(relativePath);
  } finally {
    global.getApp = previousGetApp;
    global.Page = previousPage;
  }
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data);
  page.setData = function (patch) { Object.assign(page.data, patch); };
  return page;
}

test('待审核数量由服务端按当前角色限定并精确计数', async function () {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const body = source.match(/async function changePendingCount\(event\) \{[\s\S]*?\n\}\n\nasync function changeReview/);
  assert.ok(body);
  assert.match(source, /'change\.pendingCount': changePendingCount/);
  const queries = [];
  let role = 'admin';
  const context = {
    getOpenid: function () { return 'openid-1'; },
    requireActiveUser: async function () {},
    requireMembership: async function () { return { membership: { role: role } }; },
    ACTIVE_ROLES: ['admin', 'member', 'viewer'],
    userId: function () { return 'member-1'; },
    db: { collection: function () { return { where: function (where) {
      queries.push(where);
      return { count: async function () { return { total: 123 }; } };
    } }; } }
  };
  vm.createContext(context);
  vm.runInContext(body[0].replace(/\n\nasync function changeReview$/, ''), context);
  assert.equal((await context.changePendingCount({ familyId: 'family-1' })).count, 123);
  assert.equal(queries[0].createdBy, undefined);
  role = 'member';
  assert.equal((await context.changePendingCount({ familyId: 'family-1' })).count, 123);
  assert.equal(queries[1].createdBy, 'member-1');
  role = 'viewer';
  assert.equal((await context.changePendingCount({ familyId: 'family-1' })).count, 0);
  assert.equal(queries.length, 2);
  context.requireMembership = async function () { throw new Error('NO_FAMILY_ACCESS'); };
  await assert.rejects(context.changePendingCount({ familyId: 'family-2' }), /NO_FAMILY_ACCESS/);
});

test('家庭角标显示当前家谱数量、99+ 和零值，并合并同一请求', async function () {
  const badges = [];
  const requests = [];
  const setup = loadApp(function (type, payload) {
    assert.equal(type, 'change.pendingCount');
    return new Promise(function (resolve) { requests.push({ familyId: payload.familyId, resolve: resolve }); });
  }, badges);
  try {
    const app = setup.app;
    app.setCurrentFamily({ _id: 'family-1', status: 'active' });
    const first = app.refreshPendingBadge();
    assert.equal(requests.length, 1);
    requests[0].resolve({ count: 101 });
    await first;
    assert.equal(badges.at(-1), '99+');
    const zero = app.refreshPendingBadge({ force: true });
    requests[1].resolve({ count: 0 });
    await zero;
    assert.equal(badges.at(-1), '');
  } finally { setup.restore(); }
});

test('切换家谱后旧响应不能覆盖新角标，退出清除角标', async function () {
  const badges = [];
  const requests = [];
  const setup = loadApp(function (type, payload) {
    return new Promise(function (resolve) { requests.push({ familyId: payload.familyId, resolve: resolve }); });
  }, badges);
  try {
    const app = setup.app;
    app.setCurrentFamily({ _id: 'family-1', status: 'active' });
    const oldRequest = requests[0];
    app.setCurrentFamily({ _id: 'family-2', status: 'active' });
    assert.equal(requests[1].familyId, 'family-2');
    requests[1].resolve({ count: 2 });
    await app._pendingBadgeRequest.promise;
    oldRequest.resolve({ count: 8 });
    await Promise.resolve();
    assert.equal(badges.at(-1), '2');
    app.clearLocalData();
    assert.equal(badges.at(-1), '');
  } finally { setup.restore(); }
});

test('我的申请分享独立于家谱邀请与普通发现分享', function () {
  const app = { getCurrentFamily: function () { return null; } };
  const page = loadPage('../miniprogram/pages/members/index', app);
  page.data.currentFamily = { _id: 'family 1', name: '测试家谱' };
  page.data.currentRole = 'member';
  page.data.pendingChanges = [{ _id: 'request-1' }];
  const reminder = page.onShareAppMessage({ from: 'button', target: { dataset: { shareKind: 'review-reminder' } } });
  assert.equal(reminder.path, '/pages/change-list/index?familyId=family%201&review=1');
  assert.match(reminder.title, /请管理员处理/);
  assert.equal(reminder.imageUrl, undefined);
  page.data.currentRole = 'admin';
  const fallback = page.onShareAppMessage({ from: 'button', target: { dataset: { shareKind: 'review-reminder' } } });
  assert.notEqual(fallback.path, reminder.path);
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.wxml'), 'utf8');
  assert.match(template, /currentRole === 'member'[^>]*open-type="share" data-share-kind="review-reminder"/);
});

test('提醒链接只让管理员进入待处理列表', async function () {
  const api = require('../miniprogram/utils/api');
  const originalCall = api.call;
  const family = { _id: 'family-1', currentRole: 'member' };
  let selected = null;
  let forceRead = false;
  const page = loadPage('../miniprogram/pages/change-list/index', {
    loadFamilies: async function (options) { forceRead = Boolean(options && options.force); return [family]; },
    setCurrentFamily: function (value) { selected = value; }
  });
  api.call = async function () { return { items: [], hasMore: false }; };
  try {
    page.onLoad({ familyId: 'family-1', review: '1' });
    await page.loadPage();
    assert.equal(forceRead, true);
    assert.match(page.data.error, /仅这份家谱的管理员/);
    assert.equal(selected, null);
    family.currentRole = 'admin';
    await page.loadPage();
    assert.equal(page.data.error, '');
    assert.equal(page.data.activeStatus, 'pending');
    assert.equal(selected._id, 'family-1');
    page.setData({ familyId: 'other-family' });
    await page.loadPage();
    assert.match(page.data.error, /无法访问这份家谱/);
  } finally { api.call = originalCall; }
});
