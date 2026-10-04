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

test('业务缓存一小时内有效，过期后重新读取', function () {
  const app = createApp();
  const entry = app.getCacheEntry('dashboard', 'family-1');
  entry.data = { stats: {} };
  entry.updatedAt = Date.now() - 60 * 60 * 1000 - 1;
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

test('同一轮强制刷新合并请求，缓存按用户和查询参数隔离', async function () {
  const api = require('../miniprogram/utils/api');
  const originalCall = api.call;
  const requests = [];
  api.call = function (type, payload) {
    requests.push({ type: type, payload: payload });
    return Promise.resolve({ items: [], tags: [] });
  };
  try {
    const app = createApp();
    app.globalData.user = { _id: 'u1' };
    await Promise.all([app.getExamplesList('人物'), app.getExamplesList('人物')]);
    await app.getExamplesList('故事');
    await Promise.all([app.getExamplesList('人物', { force: true }), app.getExamplesList('人物', { force: true })]);
    assert.equal(requests.length, 3);
    app.globalData.user = { _id: 'u2' };
    await app.getExamplesList('人物');
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(function (request) { return request.payload.tag; }), ['人物', '故事', '人物', '人物']);
  } finally { api.call = originalCall; }
});

test('人物完整更新定向更新图谱和详情，待审核不会提前写入', function () {
  const app = createApp();
  app.globalData.user = { _id: 'u1' };
  const graph = app.getCacheEntry('graph', 'f1');
  const detail = app.getCacheEntry('personDetail', 'p1');
  app.updateEntry(graph, { family: { _id: 'f1' }, persons: [{ _id: 'p1', name: '旧名' }], relations: [] });
  app.updateEntry(detail, { person: { _id: 'p1', familyId: 'f1', name: '旧名' }, relatives: [], currentRole: 'admin' });
  // 待审核只返回 pending，不触发 applyPersonUpdate。
  assert.equal(graph.data.persons[0].name, '旧名');
  app.applyPersonUpdate('f1', { _id: 'p1', familyId: 'f1', name: '新名' });
  assert.equal(graph.data.persons[0].name, '新名');
  assert.equal(detail.data.person.name, '新名');
  assert.equal(app.isCacheFresh('graph', 'f1'), true);
  assert.equal(app.isCacheFresh('dashboard', 'f1'), false);
});

test('只拿到偏好结果时不伪造缺少家谱信息的设置缓存', function () {
  const app = createApp();
  app.updatePreference('f1', { nameLayout: 'vertical' });
  assert.equal(app.isCacheFresh('preference', 'f1'), false);
  const entry = app.getCacheEntry('preference', 'f1');
  app.updateEntry(entry, { family: { _id: 'f1', name: '测试家谱' }, preference: { nameLayout: 'horizontal' } });
  app.updatePreference('f1', { nameLayout: 'vertical' });
  assert.equal(entry.data.family.name, '测试家谱');
  assert.equal(entry.data.preference.nameLayout, 'vertical');
});

test('业务缓存只保存在小程序进程内', function () {
  const first = createApp();
  first.updateEntry(first.getCacheEntry('graph', 'f1'), { persons: [] });
  assert.equal(first.isCacheFresh('graph', 'f1'), true);
  const restarted = createApp();
  assert.equal(restarted.isCacheFresh('graph', 'f1'), false);
});

test('登录校验仍按 60 秒刷新，不继承一小时业务缓存', async function () {
  const api = require('../miniprogram/utils/api');
  const originalCall = api.call;
  const previousWx = global.wx;
  let calls = 0;
  api.call = function (type) {
    assert.equal(type, 'auth.login');
    calls += 1;
    return Promise.resolve({ user: { _id: 'u1' }, accountState: 'active' });
  };
  global.wx = { setStorageSync: function () {} };
  try {
    const app = createApp();
    app.globalData.user = { _id: 'u1' };
    app.loginUpdatedAt = Date.now();
    await app.ensureLogin();
    assert.equal(calls, 0);
    app.loginUpdatedAt = Date.now() - 61 * 1000;
    await app.ensureLogin();
    assert.equal(calls, 1);
  } finally {
    api.call = originalCall;
    global.wx = previousWx;
  }
});

test('快速切换人物视角只保存最后一次偏好', async function () {
  const api = require('../miniprogram/utils/api');
  const originalCall = api.call;
  const calls = [];
  api.call = function (type, payload) {
    calls.push({ type: type, payload: payload });
    return Promise.resolve({ preference: payload });
  };
  const app = { updatePreference: function () {} };
  const tree = createPage(loadPage('../miniprogram/pages/tree/index', app));
  try {
    tree.saveGraphPreference({ _id: 'f1' }, 'horizontal', 'perspective', 'p1');
    tree.saveGraphPreference({ _id: 'f1' }, 'horizontal', 'perspective', 'p2');
    assert.equal(calls.length, 0);
    await tree.flushGraphPreference();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'family.setPreference');
    assert.equal(calls[0].payload.personId, 'p2');
    await tree.flushGraphPreference();
    assert.equal(calls.length, 1);
  } finally { api.call = originalCall; }
});

test('没有家谱的账号进入默认示例，家庭页空状态仍复用缓存', async function () {
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
  const redirects = [];
  global.wx = { stopPullDownRefresh: function () {}, redirectTo: function (options) { redirects.push(options.url); options.success(); } };
  const tree = createPage(loadPage('../miniprogram/pages/tree/index', app));
  const members = createPage(loadPage('../miniprogram/pages/members/index', app));

  await tree.loadPage();
  await members.loadDashboard();
  assert.equal(tree.data.loading, true);
  assert.deepEqual(redirects, ['/pages/example/index?entry=default']);
  assert.equal(members.data.loading, false);
  assert.equal(members._hasLoaded, true);
  const callsAfterFirstLoad = app.calls;
  await members.loadDashboard();
  assert.equal(app.calls, callsAfterFirstLoad);
  global.wx = previousWx;
});

test('家庭页切换家谱后留在当前页并复用看板缓存', async function () {
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
  assert.equal(refreshOptions, undefined);
  assert.deepEqual(invalidations, []);
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
