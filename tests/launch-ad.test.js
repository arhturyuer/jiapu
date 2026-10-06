require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const launchAd = require('../miniprogram/utils/launch-ad');
const launchAdLayout = require('../miniprogram/utils/launch-ad-layout');
const adAccess = require('../miniprogram/utils/ad-access');
const commerce = require('../miniprogram/config/commerce');
const api = require('../miniprogram/utils/api');
const previousMemberAdDebug = commerce.memberAdDebugEnabled.staging;
// 开屏回归也会调用人物广告准备，隔离仅用于真机验收的边界诊断。
test.before(function () { commerce.memberAdDebugEnabled.staging = false; });
test.after(function () { commerce.memberAdDebugEnabled.staging = previousMemberAdDebug; });

function fixture(t, options) {
  const config = options || {};
  const previous = { wx: global.wx, getApp: global.getApp, Page: global.Page };
  t.after(function () { Object.assign(global, previous); });
  const visits = [];
  let family = config.family === undefined
    ? { _id: 'free-family', status: 'active', currentRole: 'member', membership: { active: false } }
    : config.family;
  const app = {
    globalData: { environment: config.environment || 'staging' },
    getCurrentFamily: function () { return family; },
    setCurrentFamily: function (next) { family = next; },
    loadFamilies: function (options) {
      assert.equal(options.force, true);
      if (config.reject) return Promise.reject(new Error('fixture unavailable'));
      return config.loading || Promise.resolve(family ? [family] : []);
    }
  };
  global.getApp = function () { return app; };
  global.wx = {
    canIUse: function () { return config.supported !== false; },
    redirectTo: function (options) { visits.push({ kind: 'redirect', options: options }); },
    switchTab: function (options) { visits.push({ kind: 'tab', options: options }); },
    navigateTo: function (options) { visits.push({ kind: 'navigate', options: options }); }
  };
  launchAd.begin(app, config.entry);
  return { app: app, visits: visits };
}

function instance(definition, route) {
  const page = Object.assign({}, definition, { route: route });
  page.data = Object.assign({}, definition.data);
  page.setData = function (patch, callback) {
    Object.assign(page.data, patch);
    if (callback) callback();
  };
  return page;
}

function sourcePage(route) {
  const calls = [];
  const page = instance(launchAd.wrap({
    onLoad: function (query) { calls.push(['load', query]); },
    onShow: function () { calls.push(['show']); },
    onReady: function () { calls.push(['ready']); },
    onHide: function () { calls.push(['hide']); },
    onUnload: function () { calls.push(['unload']); }
  }), route || 'pages/tree/index');
  return { page: page, calls: calls };
}

function splash(app, preserve) {
  if (!preserve) launchAd.begin(app, { path: 'pages/invite/index', query: { token: 'a&b?中文' } });
  let definition;
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/launch-ad/index');
  delete require.cache[modulePath];
  require(modulePath);
  return instance(definition, 'pages/launch-ad/index');
}

test('已验收开屏在 staging/production 配置；所有业务入口显式经过同一启动拦截', function () {
  assert.equal(commerce.resolveLaunch('staging'), 'adunit-84d9de0b742d77e1');
  assert.equal(commerce.resolveLaunch('production'), 'adunit-84d9de0b742d77e1');
  assert.equal(commerce.resolveLaunch('unknown'), '');
  const pages = require('../miniprogram/app.json').pages;
  assert.equal(pages[0], 'pages/launch-ad/index');
  for (const route of pages) {
    const source = fs.readFileSync(path.join(__dirname, '../miniprogram', route + '.js'), 'utf8');
    if (route === 'pages/launch-ad/index') assert.doesNotMatch(source, /Page\(launchAd\.wrap/);
    else assert.match(source, /Page\(launchAd\.wrap\(/, route);
  }
});

test('启用时显示品牌等待页，会员查询前不创建广告；查询完成后原生组件自然排版', async function (t) {
  let resolve;
  const loading = new Promise(function (yes) { resolve = yes; });
  const { app, visits } = fixture(t, { entry: { path: 'pages/launch-ad/index', query: {} }, loading: loading });
  const page = splash(app, true);
  assert.equal(page.data.startupVisible, false);
  const request = page.onLoad();
  assert.equal(page.data.startupVisible, true);
  assert.deepEqual(app._launchAd.target, { path: 'pages/tree/index', query: {} });
  assert.equal(page.data.adVisible, false);
  assert.equal(visits.length, 0);
  resolve([]);
  await request;
  assert.equal(page.data.adVisible, true);
  assert.equal(visits.length, 0);
  page.finish();
  assert.equal(page.data.startupVisible, false);
  assert.equal(visits[0].kind, 'tab');
  assert.equal(visits[0].options.url, '/pages/tree/index');
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/launch-ad/index.wxml'), 'utf8');
  const style = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/launch-ad/index.wxss'), 'utf8');
  const config = require('../miniprogram/pages/launch-ad/index.json');
  assert.equal(config.navigationStyle, 'custom');
  assert.doesNotMatch(template, /scroll-view/);
  assert.match(template, /min-height:\{\{adVisible \? contentHeight : windowHeight\}\}px/);
  assert.match(template, /class="launch-native-ad"/);
  assert.match(style, /\.launch-native-ad\s*\{\s*display:block;\s*width:100%/);
});

test('production 免费开屏结束后恢复邀请参数，会员三种角色直接恢复入口', async function (t) {
  for (const role of ['free', 'admin', 'member', 'viewer']) {
    await t.test(role, async function (s) {
      const family = { _id: 'production-fixture', status: 'active', currentRole: role === 'free' ? 'member' : role,
        membership: { active: role !== 'free', lifetime: role !== 'free' } };
      const { app, visits } = fixture(s, { environment: 'production', family: family,
        entry: { path: 'pages/invite/index', query: { token: 'a&b?中文' } } });
      const page = splash(app, true);
      await page.onLoad();
      assert.equal(page.data.adVisible, role === 'free');
      if (role === 'free') {
        assert.equal(visits.length, 0);
        page.adLoad();
        page.adClose();
      }
      assert.equal(page.data.adVisible, false);
      assert.equal(visits.length, 1);
      assert.equal(visits[0].options.url, '/pages/invite/index?token=a%26b%3F%E4%B8%AD%E6%96%87');
      page.onUnload();
    });
  }
});

test('关闭开屏时即使保留广告 ID 也直接进入首页，不显示品牌或读取广告权益', async function (t) {
  const enabled = commerce.launchAdEnabled.staging;
  t.after(function () { commerce.launchAdEnabled.staging = enabled; });
  commerce.launchAdEnabled.staging = false;
  assert.ok(commerce.launchAdUnits.staging);
  assert.equal(commerce.resolveLaunch('staging'), '');
  const { app, visits } = fixture(t, { entry: { path: 'pages/launch-ad/index' } });
  app.loadFamilies = function () { throw new Error('must not query'); };
  global.wx.getWindowInfo = function () { throw new Error('must not prepare launch layout'); };
  const page = splash(app, true);
  await page.onLoad();
  assert.equal(page.data.startupVisible, false);
  assert.equal(page.data.adVisible, false);
  assert.equal(page._loadTimer, null);
  assert.equal(page._countdownTimer, null);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].kind, 'tab');
  assert.equal(visits[0].options.url, '/pages/tree/index');
  const query = { token: 'a&b', scene: '%2Fencoded' };
  launchAd.begin(app, { path: 'pages/invite/index', query: query });
  const invite = sourcePage('pages/invite/index');
  invite.page.onLoad(query);
  invite.page.onShow();
  assert.deepEqual(invite.calls, [['load', query], ['show']]);
  assert.equal(visits.length, 1);
});

test('开关已开启但 ID 为空时，不显示品牌等待页，直接进入首页', async function (t) {
  const unit = commerce.launchAdUnits.staging;
  t.after(function () { commerce.launchAdUnits.staging = unit; });
  commerce.launchAdUnits.staging = '  ';
  const { app, visits } = fixture(t, { entry: { path: 'pages/launch-ad/index' } });
  app.loadFamilies = function () { throw new Error('must not query'); };
  const page = splash(app, true);
  await page.onLoad();
  assert.equal(page.data.startupVisible, false);
  assert.equal(page.data.adVisible, false);
  assert.equal(visits[0].options.url, '/pages/tree/index');
});

test('广告未加载、无填充和已关闭时均不出现广告操作区，迟到加载也不能重开', async function (t) {
  const { app, visits } = fixture(t);
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/launch-ad/index.wxml'), 'utf8');
  assert.match(template, /class="launch-actions" wx:if="\{\{adVisible && loaded && !returning\}\}"/);
  assert.doesNotMatch(template, /直接进入/);
  for (const action of ['adError', 'adClose']) {
    const page = splash(app);
    const hasActions = function () { return page.data.startupVisible && page.data.adVisible && page.data.loaded && !page.data.returning; };
    await page.onLoad();
    assert.equal(hasActions(), false);
    page[action]();
    page.adLoad();
    assert.equal(hasActions(), false);
    assert.equal(page.data.loaded, false);
    page.onUnload();
  }
  assert.equal(visits.length, 2);
});

test('关闭已显示的开屏先完成视图清理再跳转，重复点击及迟到回调不重复进入', async function (t) {
  const { app, visits } = fixture(t);
  const page = splash(app);
  await page.onLoad();
  page.adLoad();
  assert.equal(page.data.loaded, true);
  const rendered = Object.assign({}, page.data);
  const commits = [];
  page.setData = function (patch, callback) {
    Object.assign(page.data, patch);
    commits.push(function () {
      Object.assign(rendered, patch);
      if (callback) callback();
    });
  };
  page.adClose();
  assert.equal(rendered.adVisible, true, '模拟 setData 尚未提交视图');
  assert.equal(visits.length, 0, '视图清理前不能进入首页');
  page.finish();
  page.adLoad();
  page.adError();
  assert.equal(commits.length, 1);
  commits.shift()();
  assert.equal(rendered.startupVisible, false);
  assert.equal(rendered.adVisible, false);
  assert.equal(rendered.loaded, false);
  assert.equal(visits.length, 1);
});

test('开屏禁用时不等待渲染回调；导航失败的重试不显示广告操作区', async function (t) {
  const enabled = commerce.launchAdEnabled.production;
  t.after(function () { commerce.launchAdEnabled.production = enabled; });
  commerce.launchAdEnabled.production = false;
  const { app, visits } = fixture(t, { environment: 'production', entry: { path: 'pages/launch-ad/index' } });
  const page = splash(app, true);
  let pending;
  page.setData = function (patch, callback) { Object.assign(page.data, patch); pending = callback; };
  await page.onLoad();
  assert.equal(visits.length, 1);
  assert.equal(pending, undefined);
  visits[0].options.fail();
  assert.equal(page.data.retrying, true);
  assert.equal(page.data.adVisible, false);
  assert.equal(page.data.loaded, false);
  page.finish();
  assert.equal(visits.length, 1);
  pending();
  assert.equal(visits.length, 2);
});

test('退出开屏等待视图清理时进入后台，返回后继续目标；卸载后不跳转', async function (t) {
  const { app, visits } = fixture(t);
  for (const unload of [false, true]) {
    const page = splash(app);
    await page.onLoad();
    let commit;
    page.setData = function (patch, callback) { Object.assign(page.data, patch); if (callback) commit = callback; };
    page.finish();
    if (unload) page.onUnload();
    else page.onHide();
    commit();
    assert.equal(visits.length, unload ? 1 : 0);
    if (!unload) page.onShow();
    assert.equal(visits.length, 1);
  }
});

test('目标页跳转失败时保留可重试入口，重试成功后隐藏启动内容', async function (t) {
  const { app, visits } = fixture(t, { entry: { path: 'pages/launch-ad/index' } });
  const page = splash(app, true);
  await page.onLoad();
  page.finish();
  assert.equal(page.data.startupVisible, false);
  visits[0].options.fail();
  assert.equal(page.data.startupVisible, true);
  assert.equal(page.data.retrying, true);
  assert.equal(page.data.returning, false);
  page.finish();
  assert.equal(visits.length, 2);
  assert.equal(visits[1].options.url, '/pages/tree/index');
  assert.equal(page.data.startupVisible, false);
  assert.equal(page.data.retrying, false);
  page.onUnload();
});

test('链接入口立即跳转开屏，不在原业务页等待会员网络请求', function (t) {
  const { app, visits } = fixture(t);
  let reads = 0;
  app.loadFamilies = function () { reads += 1; return new Promise(function () {}); };
  const { page, calls } = sourcePage('pages/invite/index');
  page.onLoad({ token: 'invitation' });
  assert.equal(reads, 0);
  assert.equal(visits[0].options.url, '/pages/launch-ad/index');
  page.onShow();
  page.onReady();
  assert.deepEqual(calls, []);
});

test('staging 尺寸诊断只记录实际节点尺寸，不将原生节点缺失视为完整广告', async function (t) {
  const { app } = fixture(t);
  global.wx.getWindowInfo = function () { return { windowWidth: 366, windowHeight: 809 }; };
  let callback;
  const selectors = [];
  const query = {
    select: function (selector) { selectors.push(selector); return this; },
    boundingClientRect: function () { return this; },
    exec: function (fn) { callback = fn; }
  };
  global.wx.createSelectorQuery = function () { return query; };
  const messages = [];
  t.mock.method(console, 'info', function (label, data) { messages.push({ label: label, data: data }); });
  const page = splash(app);
  await page.onLoad();
  page.inspectLayout();
  assert.deepEqual(selectors, ['.launch-page', '.launch-safe-top', '.launch-content', '.launch-template', '.launch-native-ad', '.launch-actions']);
  callback([null, null, { width: 366, height: 330, top: 80, bottom: 410 }, null, null, null]);
  assert.deepEqual(messages[0].data.window, { width: 366, height: 809 });
  assert.deepEqual(messages[0].data.nodes.content, { width: 366, height: 330, top: 80, bottom: 410 });
  assert.equal(messages[0].data.nodes.nativeAd, null);
  page.onUnload();
});

test('离开开屏后的迟到尺寸查询不输出，production 不输出诊断日志', async function (t) {
  const { app } = fixture(t);
  let callback;
  const query = { select: function () { return this; }, boundingClientRect: function () { return this; }, exec: function (fn) { callback = fn; } };
  global.wx.createSelectorQuery = function () { return query; };
  const messages = [];
  t.mock.method(console, 'info', function (value) { messages.push(value); });
  const page = splash(app);
  await page.onLoad();
  page.inspectLayout();
  page.onHide();
  callback([]);
  assert.equal(messages.length, 0);
  app.globalData.environment = 'production';
  page._hidden = false;
  page.data.adVisible = true;
  page.inspectLayout();
  callback([]);
  assert.equal(messages.length, 0);
  page.onUnload();
});

test('广告区域与底部按钮按真实窗口和安全区分配高度，超高广告仅等比例缩窄', function () {
  const info = { windowWidth: 366, windowHeight: 809, screenHeight: 809, safeArea: { bottom: 775 } };
  const layout = launchAdLayout.fromWindow(info, { bottom: 69 }, 16 / 9);
  assert.equal(layout.safeTop, 77);
  assert.equal(layout.safeBottom, 34);
  assert.equal(layout.contentHeight + layout.safeTop + 232 * 366 / 750 + layout.safeBottom, 809);
  assert.ok(layout.templateWidth < 366);
  assert.ok(layout.templateWidth * 16 / 9 <= layout.contentHeight);
  const short = launchAdLayout.fromWindow(info, { bottom: 69 }, 9 / 16);
  assert.equal(short.templateWidth, 366);
  const unavailable = launchAdLayout.fromWindow({}, null);
  assert.ok(unavailable.contentHeight > 0);
  assert.equal(unavailable.templateWidth, 375);
});

test('广告测量后适配窗口，旋转更新可用高度且不重启倒计时', async function (t) {
  const { app } = fixture(t);
  global.wx.getWindowInfo = function () { return { windowWidth: 366, windowHeight: 809, statusBarHeight: 44 }; };
  let callback;
  const query = { select: function () { return this; }, boundingClientRect: function () { return this; }, exec: function (fn) { callback = fn; } };
  global.wx.createSelectorQuery = function () { return query; };
  t.mock.method(console, 'info', function () {});
  const page = splash(app);
  await page.onLoad();
  page.adLoad();
  const deadline = page._deadline;
  page.inspectLayout();
  callback([null, null, null, null, { width: 366, height: 732, top: 88, bottom: 820 }, null]);
  assert.ok(page.data.templateWidth * 2 <= page.data.contentHeight);
  page.onResize({ size: { windowWidth: 809, windowHeight: 366 } });
  assert.equal(page.data.windowHeight, 366);
  assert.ok(page.data.templateWidth * 2 <= page.data.contentHeight);
  assert.equal(page._deadline, deadline);
  const width = page.data.templateWidth;
  page.onHide();
  callback([null, null, null, null, { width: 200, height: 1000 }, null]);
  assert.equal(page.data.templateWidth, width);
  page.onUnload();
});

test('开屏等待会员查询时跳过，迟到结果不展示广告也不重复跳转', async function (t) {
  let resolve;
  const loading = new Promise(function (yes) { resolve = yes; });
  const { app, visits } = fixture(t, { loading: loading });
  const page = splash(app);
  const request = page.onLoad();
  await Promise.resolve();
  page.finish();
  resolve([]);
  await request;
  assert.equal(page.data.adVisible, false);
  assert.equal(visits.length, 1);
});

test('默认开屏在关闭配置或不支持组件时立即进入目标且不查询会员', async function (t) {
  const enabled = commerce.launchAdEnabled.production;
  t.after(function () { commerce.launchAdEnabled.production = enabled; });
  commerce.launchAdEnabled.production = false;
  const { app, visits } = fixture(t, { environment: 'production', entry: { path: 'pages/launch-ad/index' } });
  app.loadFamilies = function () { throw new Error('must not query'); };
  const page = splash(app, true);
  await page.onLoad();
  assert.equal(page.data.adVisible, false);
  assert.equal(page.data.startupVisible, false);
  assert.equal(visits[0].options.url, '/pages/tree/index');
  assert.equal(visits[0].kind, 'tab');
  app.globalData.environment = 'staging';
  global.wx.canIUse = function () { return false; };
  launchAd.begin(app, { path: 'pages/launch-ad/index' });
  const unsupported = splash(app, true);
  await unsupported.onLoad();
  assert.equal(unsupported.data.adVisible, false);
  assert.equal(unsupported.data.startupVisible, false);
  assert.equal(visits[1].kind, 'tab');
});

test('启动等待期间不执行邀请业务；分享、扫码及提醒参数完整恢复，随后不再拦截', async function (t) {
  const { app, visits } = fixture(t);
  const entries = [
    ['pages/tree/index', {}],
    ['pages/invite/index', { token: 'a&b=中文', scene: '%2Fencoded' }],
    ['pages/example/index', { slug: 'example', personId: 'person-2', source: 'example_poster' }],
    ['pages/notification-entry/index', { familyId: 'family-2' }]
  ];
  for (const [route, query] of entries) {
    launchAd.begin(app, { path: route, query: query });
    visits.length = 0;
    const { page, calls } = sourcePage(route);
    const loading = page.onLoad(query);
    page.onShow();
    page.onReady();
    assert.deepEqual(calls, []);
    await loading;
    assert.equal(visits[0].options.url, '/pages/launch-ad/index');
    page.onHide();
    const launch = splash(app, true);
    await launch.onLoad();
    assert.equal(launch.data.adVisible, true);
    launch.finish();
    assert.equal(visits[1].kind, route === 'pages/tree/index' ? 'tab' : 'redirect');
    if (route !== 'pages/tree/index') {
      const restored = new URL(visits[1].options.url, 'https://fixture.invalid');
      assert.deepEqual(Object.fromEntries(restored.searchParams), query);
    }
    page.onShow();
    assert.deepEqual(calls, [['load', query], ['show'], ['ready']]);
    page.onHide();
    page.onShow();
    assert.deepEqual(calls.slice(-2), [['hide'], ['show']]);
    assert.equal(visits.length, 2);
  }
});

test('销毁的 Tab 页恢复新实例时仍将原始参数交还 onLoad', async function (t) {
  const { app } = fixture(t);
  const query = { personId: 'focus', source: 'shared' };
  const original = sourcePage();
  await original.page.onLoad(query);
  original.page.onUnload();
  launchAd.restore(app);
  const next = sourcePage();
  next.page.onLoad({});
  next.page.onShow();
  assert.deepEqual(next.calls, [['load', query], ['show']]);
});

test('启动刷新沿用有效家谱选择规则，其他会员家谱不影响当前免费家谱', async function (t) {
  const { app, visits } = fixture(t);
  global.wx.getStorageSync = function () { return null; };
  const previousApp = global.App;
  t.after(function () { global.App = previousApp; });
  let definition;
  global.App = function (value) { definition = value; };
  const appPath = require.resolve('../miniprogram/app');
  delete require.cache[appPath];
  require(appPath);
  app.loadFamilies = definition.loadFamilies;
  app.ensureLogin = function () { return Promise.resolve(); };
  app.assertSessionVersion = function () {};
  app.setCurrentFamily = function (family) { this.globalData.currentFamily = family; };
  app.getCurrentFamily = definition.getCurrentFamily;
  const paid = { _id: 'paid', status: 'active', membership: { active: true, lifetime: true } };
  const free = { _id: 'free', status: 'active', membership: { active: false } };
  let families = [paid, free];
  app.loadFamilyPages = function (includeArchived, options) {
    assert.equal(includeArchived, false);
    assert.equal(options.force, true);
    return Promise.resolve({ families: families });
  };
  app.globalData.currentFamily = { _id: 'free', membership: { active: true, lifetime: true } };
  await launchAd.prepare(app);
  assert.equal(app.getCurrentFamily(), free);
  assert.equal(app._launchAd.phase, 'showing');
  assert.equal(visits.length, 0);
  visits.length = 0;
  app.globalData.currentFamily = { _id: 'removed' };
  launchAd.begin(app);
  await launchAd.prepare(app);
  assert.equal(app.getCurrentFamily(), paid);
  assert.equal(visits.length, 0);
  families = [];
  launchAd.begin(app);
  await launchAd.prepare(app);
  assert.equal(app.getCurrentFamily(), null);
  assert.equal(visits.length, 0);
});

test('三种角色的会员、新用户、归档及查询失败均在开屏页跳过广告', async function (t) {
  const { app, visits } = fixture(t);
  const families = ['admin', 'member', 'viewer'].map(function (role) {
    return { _id: 'paid', status: 'active', currentRole: role, membership: { active: true, expiresAt: '2099-01-01' } };
  }).concat([null, { _id: 'archived', status: 'archived', membership: { active: false } }]);
  for (const family of families) {
    app.setCurrentFamily(family);
    const page = splash(app);
    await page.onLoad();
    assert.equal(page.data.adVisible, false);
    assert.equal(app._launchAd.phase, 'finished');
    assert.match(visits.at(-1).options.url, /^\/pages\/invite\/index\?token=/);
  }
  app.loadFamilies = function () { return Promise.reject(new Error('offline')); };
  const page = splash(app);
  await page.onLoad();
  assert.equal(page.data.adVisible, false);
  assert.equal(app._launchAd.phase, 'finished');
  assert.equal(visits.length, families.length + 1);
});

test('会员期限按当前时间判定，未知权益不创建广告', function () {
  const now = new Date('2026-10-04T00:00:00Z').getTime();
  const family = { _id: 'family', status: 'active' };
  assert.equal(adAccess.eligible(family, now), false);
  assert.equal(adAccess.eligible(Object.assign({}, family, { membership: { active: false } }), now), true);
  assert.equal(adAccess.eligible(Object.assign({}, family, { membership: { active: true, expiresAt: '2026-10-03' } }), now), true);
  assert.equal(adAccess.eligible(Object.assign({}, family, { membership: { active: true, expiresAt: '2026-10-05' } }), now), false);
  assert.equal(adAccess.eligible(Object.assign({}, family, { membership: { active: true, lifetime: true } }), now), false);
  assert.equal(adAccess.eligible(Object.assign({}, family, { membership: { active: true, expiresAt: 'bad' } }), now), false);
});

test('未配置或基础库不支持时不刷新家谱且不拦截', function (t) {
  const unit = commerce.launchAdUnits.production;
  t.after(function () { commerce.launchAdUnits.production = unit; });
  commerce.launchAdUnits.production = '';
  const { app, visits } = fixture(t, { supported: false });
  app.loadFamilies = function () { throw new Error('must not refresh'); };
  const first = sourcePage();
  first.page.onLoad({});
  assert.equal(first.calls.length, 1);
  app.globalData.environment = 'production';
  global.wx.canIUse = function () { return true; };
  launchAd.begin(app);
  const second = sourcePage();
  second.page.onLoad({});
  assert.equal(second.calls.length, 1);
  assert.equal(visits.length, 0);
});

test('开屏查询期间进入后台，迟到结果不创建广告；返回直接恢复目标', async function (t) {
  let resolve;
  const loading = new Promise(function (yes) { resolve = yes; });
  const { app, visits } = fixture(t, { loading: loading });
  const page = splash(app);
  const request = page.onLoad();
  await Promise.resolve();
  page.onHide();
  resolve([]);
  await request;
  assert.equal(app._launchAd.phase, 'finished');
  assert.equal(page.data.adVisible, false);
  assert.deepEqual(visits, []);
  page.onShow();
  assert.equal(visits.length, 1);
});

test('开屏跳转失败恢复原页面生命周期', async function (t) {
  fixture(t);
  global.wx.redirectTo = function (options) { options.fail(); };
  const { page, calls } = sourcePage();
  const request = page.onLoad({});
  page.onShow();
  page.onReady();
  await request;
  assert.deepEqual(calls, [['load', {}], ['show'], ['ready']]);
});

test('加载成功后计时五秒，重复加载、跳过和关闭只恢复一次', async function (t) {
  const { app, visits } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
  const page = splash(app);
  await page.onLoad();
  t.mock.timers.tick(2000);
  page.adLoad();
  t.mock.timers.tick(4000);
  assert.equal(visits.length, 0);
  assert.equal(page.data.seconds, 1);
  page.adLoad();
  t.mock.timers.tick(1000);
  page.finish();
  page.adClose();
  page.adLoad();
  assert.equal(visits.length, 1);
  assert.equal(app._launchAd.phase, 'finished');
  assert.equal(page.data.adVisible, false);
});

test('广告超时、错误、关闭或手动跳过均直接进入，迟到回调无效', async function (t) {
  const { app, visits } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const action of ['timeout', 'adError', 'adClose', 'finish']) {
    visits.length = 0;
    const page = splash(app);
    await page.onLoad();
    if (action === 'timeout') t.mock.timers.tick(3000);
    else page[action]();
    page.adLoad();
    t.mock.timers.tick(6000);
    assert.equal(visits.length, 1, action);
    page.onUnload();
  }
});

test('购买入口携带当前家谱，离开停止计时，购买返回后恢复原目标', async function (t) {
  const { app, visits } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
  const page = splash(app);
  await page.onLoad();
  page.adLoad();
  page.openMembership();
  page.openMembership();
  page.adClose();
  page.adError();
  page.finish();
  assert.equal(visits.length, 1);
  assert.equal(visits[0].options.url, '/pages/membership/index?familyId=free-family');
  page.onHide();
  t.mock.timers.tick(10000);
  page.adLoad();
  page.adClose();
  assert.equal(visits.length, 1);
  app.setCurrentFamily({ _id: 'free-family', status: 'active', membership: { active: true, lifetime: true } });
  page.onShow();
  assert.equal(visits.length, 2);
  assert.equal(visits[1].kind, 'redirect');
  assert.equal(page.data.adVisible, false);
});

test('开屏进入后台或卸载后清理计时，返回不重新展示', async function (t) {
  const { app, visits } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const page = splash(app);
  await page.onLoad();
  page.onHide();
  t.mock.timers.tick(10000);
  assert.equal(visits.length, 0);
  page.onShow();
  assert.equal(visits.length, 1);
  const unloaded = splash(app);
  await unloaded.onLoad();
  unloaded.onUnload();
  t.mock.timers.tick(10000);
  unloaded.adError();
  assert.equal(visits.length, 1);
});

test('广告刷新忽略切换家谱、关闭弹框及过期事件；购买返回刷新后会员不展示', async function (t) {
  const { app, visits } = fixture(t);
  const previous = commerce.bannerAdUnits.staging.memberSheet;
  commerce.bannerAdUnits.staging.memberSheet = 'adunit-fixture';
  t.after(function () { commerce.bannerAdUnits.staging.memberSheet = previous; });
  let resolve;
  t.mock.method(api, 'call', function () { return new Promise(function (yes) { resolve = yes; }); });
  const page = instance({ data: { showMemberSheet: true } });
  page.createSelectorQuery = require('./helpers/member-ad-query')();
  const family = app.getCurrentFamily();
  const request = adAccess.refresh(page, app, 'memberSheet', family);
  assert.equal(page.data.memberAdVisible, false);
  app.setCurrentFamily({ _id: 'other-family' });
  resolve({ family: family });
  await request;
  assert.equal(page.data.memberAdVisible, false);
  app.setCurrentFamily(family);
  const closed = adAccess.refresh(page, app, 'memberSheet', family);
  adAccess.hide(page, true);
  resolve({ family: family });
  await closed;
  assert.equal(page.data.memberAdVisible, false);
  const valid = adAccess.refresh(page, app, 'memberSheet', family);
  resolve({ family: family });
  await valid;
  assert.equal(page.data.memberAdVisible, true);
  adAccess.loaded(page, true, { currentTarget: { dataset: { version: page.data.memberAdVersion - 1 } } });
  assert.equal(page.data.memberAdLoaded, false);
  adAccess.openMembership(page, app, true);
  assert.equal(visits.length, 1);
  page.data.showMemberSheet = true;
  const reopened = adAccess.openMember(page, app, family);
  resolve({ family: family });
  await reopened;
  adAccess.loaded(page, true, { currentTarget: { dataset: { version: page.data.memberAdVersion } } });
  adAccess.openMembership(page, app, true);
  assert.equal(visits.length, 2);
  const paid = adAccess.refresh(page, app, 'memberSheet', family);
  resolve({ family: Object.assign({}, family, { membership: { active: true, lifetime: true } }) });
  await paid;
  assert.equal(page.data.memberAdVisible, false);
  const failed = adAccess.refresh(page, app, 'memberSheet', family);
  resolve({});
  await failed;
  assert.equal(page.data.memberAdVisible, false);
});
