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
    familyPages: { active: { data: null, updatedAt: 0, invalidated: false, promise: null }, all: { data: null, updatedAt: 0, invalidated: false, promise: null } },
    graph: {}, dashboard: {}, profile: { data: null, updatedAt: 0, invalidated: false, promise: null }
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

test('没有家谱的账号结束加载并展示空状态，重复切 Tab 不重复请求', async function () {
  const app = {
    globalData: { accountState: 'active' },
    getCurrentFamily: function () { return null; },
    loadFamilies: function () { this.calls = (this.calls || 0) + 1; return Promise.resolve([]); },
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
