require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadApp() {
  let definition = null;
  const previousApp = global.App;
  const previousWx = global.wx;
  global.App = function (value) { definition = value; };
  global.wx = {
    getStorageSync: function () { return null; },
    setStorageSync: function () {},
    removeStorageSync: function () {}
  };
  const modulePath = require.resolve('../miniprogram/app');
  delete require.cache[modulePath];
  require(modulePath);
  global.App = previousApp;
  global.wx = previousWx;
  return definition;
}

function createApp() {
  const definition = loadApp();
  const app = Object.assign({}, definition);
  app.globalData = Object.assign({}, definition.globalData);
  app.dataCache = {
    familyPages: { active: { data: null, updatedAt: 0, invalidated: false, promise: null, version: 0, promiseVersion: -1 }, all: { data: null, updatedAt: 0, invalidated: false, promise: null, version: 0, promiseVersion: -1 } },
    graph: {}, dashboard: {}, profile: { data: null, updatedAt: 0, invalidated: false, promise: null, version: 0, promiseVersion: -1 }
  };
  return app;
}

function loadPage(relativePath, app) {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return app; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve(relativePath);
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  return definition;
}

function createPage(definition) {
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data);
  page.setData = function (patch, callback) {
    Object.assign(page.data, patch);
    if (callback) callback();
  };
  return page;
}

test('图谱缓存命中、并发请求去重，强制刷新和写入失效会重新请求', async function () {
  const api = require('../miniprogram/utils/api');
  const originalCall = api.call;
  let calls = 0;
  let resolveRequest;
  api.call = function () {
    calls += 1;
    return new Promise(function (resolve) { resolveRequest = resolve; });
  };
  const app = createApp();

  const first = app.getGraph('family-1');
  const concurrent = app.getGraph('family-1');
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveRequest({ family: { _id: 'family-1' }, persons: [], relations: [] });
  assert.deepEqual(await first, await concurrent);

  await app.getGraph('family-1');
  assert.equal(calls, 1);
  const forced = app.getGraph('family-1', { force: true });
  await Promise.resolve();
  assert.equal(calls, 2);
  resolveRequest({ family: { _id: 'family-1' }, persons: [{ _id: 'new' }], relations: [] });
  await forced;

  app.invalidateFamilyData('family-1');
  const afterWrite = app.getGraph('family-1');
  await Promise.resolve();
  assert.equal(calls, 3);
  resolveRequest({ family: { _id: 'family-1' }, persons: [{ _id: 'fresh' }], relations: [] });
  await afterWrite;
  api.call = originalCall;
});

test('缓存超过 60 秒后不再视为新鲜数据', function () {
  const app = createApp();
  const entry = app.getCacheEntry('dashboard', 'family-1');
  entry.data = { stats: {} };
  entry.updatedAt = Date.now() - 60001;
  assert.equal(app.isCacheFresh('dashboard', 'family-1'), false);
  entry.updatedAt = Date.now();
  assert.equal(app.isCacheFresh('dashboard', 'family-1'), true);
});

test('写操作失效后，先发出的图谱请求不会回写旧数据', async function () {
  const api = require('../miniprogram/utils/api');
  const originalCall = api.call;
  const requests = [];
  api.call = function () {
    return new Promise(function (resolve) { requests.push(resolve); });
  };
  const app = createApp();

  const staleRequest = app.getGraph('family-1');
  await Promise.resolve();
  app.invalidateFamilyData('family-1');
  const freshRequest = app.getGraph('family-1');
  await Promise.resolve();
  assert.equal(requests.length, 2);

  requests[0]({ family: { _id: 'family-1' }, persons: [{ _id: 'stale' }], relations: [] });
  requests[1]({ family: { _id: 'family-1' }, persons: [{ _id: 'fresh' }], relations: [] });
  const fresh = await freshRequest;
  const stale = await staleRequest;
  assert.equal(fresh.persons[0]._id, 'fresh');
  assert.equal(stale.persons[0]._id, 'fresh');
  assert.equal(app.getCacheEntry('graph', 'family-1').data.persons[0]._id, 'fresh');
  api.call = originalCall;
});

test('强制刷新会隔离已在途读取并只保留刷新结果', async function () {
  const api = require('../miniprogram/utils/api');
  const originalCall = api.call;
  const requests = [];
  api.call = function () {
    return new Promise(function (resolve) { requests.push(resolve); });
  };
  const app = createApp();

  const initial = app.getDashboard('family-1');
  await Promise.resolve();
  const forced = app.getDashboard('family-1', { force: true });
  await Promise.resolve();
  assert.equal(requests.length, 2);
  requests[0]({ stats: { personCount: 1 } });
  requests[1]({ stats: { personCount: 2 } });
  assert.equal((await initial).stats.personCount, 2);
  assert.equal((await forced).stats.personCount, 2);
  assert.equal(app.getCacheEntry('dashboard', 'family-1').data.stats.personCount, 2);
  api.call = originalCall;
});

test('没有家谱的账号结束加载并展示空状态，重复切 Tab 不重复请求', async function () {
  const app = {
    globalData: { accountState: 'active' },
    getCurrentFamily: function () { return null; },
    loadFamilies: function () { this.calls = (this.calls || 0) + 1; return Promise.resolve([]); },
    ensureLogin: function () { return Promise.resolve({ accountState: 'active' }); },
    loadFamilyPages: function () { this.calls = (this.calls || 0) + 1; return Promise.resolve({ families: [] }); },
    setCurrentFamily: function () {},
    isCacheFresh: function () { return this.calls > 0; },
    consumePendingView: function () { return null; }
  };
  const previousWx = global.wx;
  global.wx = { stopPullDownRefresh: function () {} };
  const tree = createPage(loadPage('../miniprogram/pages/tree/index', app));
  const members = createPage(loadPage('../miniprogram/pages/members/index', app));

  await tree.loadPage();
  await members.loadDashboard();
  assert.equal(tree.data.loading, false);
  assert.equal(members.data.loading, false);
  assert.equal(tree._hasLoaded, true);
  assert.equal(members._hasLoaded, true);
  const callsAfterFirstLoad = app.calls;
  await tree.loadPage();
  await members.loadDashboard();
  assert.equal(app.calls, callsAfterFirstLoad);
  global.wx = previousWx;
});

test('家庭页切换家谱后留在当前页并强制刷新看板', async function () {
  const first = { _id: 'family-1', name: '第一份家谱' };
  const second = { _id: 'family-2', name: '第二份家谱' };
  const invalidations = [];
  const stored = [];
  const app = {
    globalData: { accountState: 'active', environment: 'staging' },
    getCurrentFamily: function () { return this.currentFamily || first; },
    setCurrentFamily: function (family) { this.currentFamily = family; },
    invalidateCache: function (options) { invalidations.push(options); }
  };
  const previousWx = global.wx;
  global.wx = { setStorageSync: function (key, value) { stored.push([key, value]); } };
  const members = createPage(loadPage('../miniprogram/pages/members/index', app));
  members.data.familyList = [first, second];
  members.data.currentFamily = first;
  members.data.showFamilySheet = true;
  let refreshOptions = null;
  members.loadDashboard = function (options) { refreshOptions = options; return Promise.resolve(); };

  members.switchFamily({ currentTarget: { dataset: { id: second._id } } });

  assert.equal(app.currentFamily._id, second._id);
  assert.equal(members.data.currentFamily._id, second._id);
  assert.equal(members.data.showFamilySheet, false);
  assert.deepEqual(refreshOptions, { force: true });
  assert.deepEqual(invalidations, [{ profile: true }]);
  assert.deepEqual(stored, [['youpu_pending_view', { mode: 'full', personId: '' }]]);
  global.wx = previousWx;
});

test('没有家谱的活跃账号仍可加载我的个人资料', async function () {
  const app = {
    globalData: {
      user: { _id: 'user-1', nickName: '小明', avatarAssetId: '' },
      accountState: 'active', deletion: null, environment: 'staging'
    },
    getCurrentFamily: function () { return null; },
    isCacheFresh: function () { return false; },
    ensureLogin: function () { return Promise.resolve({ accountState: 'active' }); },
    getProfileData: function (loader) { return loader(); }
  };
  const previousWx = global.wx;
  global.wx = {
    getStorageSync: function () { return {}; },
    setStorageSync: function () {},
    removeStorageSync: function () {}
  };
  const profile = createPage(loadPage('../miniprogram/pages/profile/index', app));

  await profile.loadPage();

  assert.equal(profile.data.loading, false);
  assert.equal(profile.data.accountState, 'active');
  assert.equal(profile.data.nickName, '小明');
  assert.equal(profile.data.adVisible, false);
  global.wx = previousWx;
});
