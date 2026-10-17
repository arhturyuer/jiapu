require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const guide = require('../miniprogram/utils/my-miniprogram-guide');
const api = require('../miniprogram/utils/api');
const fs = require('node:fs');
const path = require('node:path');
const shareCard = require('../miniprogram/utils/share-card');

const WEEK = 7 * 24 * 60 * 60 * 1000;

function scheduler() {
  let now = 1000;
  let nextId = 0;
  const jobs = new Map();
  function schedule(callback, delay, repeat) {
    const id = ++nextId;
    jobs.set(id, { callback: callback, at: now + delay, repeat: repeat });
    return id;
  }
  return {
    now: function () { return now; },
    setTimeout: function (callback, delay) { return schedule(callback, delay, 0); },
    clearTimeout: function (id) { jobs.delete(id); },
    setInterval: function (callback, delay) { return schedule(callback, delay, delay); },
    clearInterval: function (id) { jobs.delete(id); },
    advance: function (duration) {
      const end = now + duration;
      while (true) {
        const entry = Array.from(jobs.entries()).filter(function (item) { return item[1].at <= end; })
          .sort(function (a, b) { return a[1].at - b[1].at || a[0] - b[0]; })[0];
        if (!entry) break;
        now = entry[1].at;
        if (entry[1].repeat) entry[1].at += entry[1].repeat;
        else jobs.delete(entry[0]);
        entry[1].callback();
      }
      now = end;
    },
    count: function () { return jobs.size; }
  };
}

function fixture(t) {
  const clock = scheduler();
  const storage = new Map();
  const checks = [];
  const modals = [];
  const platform = {
    getStorageSync: function (key) { return storage.get(key); },
    setStorageSync: function (key, value) { storage.set(key, value); },
    getWindowInfo: function () { return { windowWidth: 375, statusBarHeight: 44 }; },
    getMenuButtonBoundingClientRect: function () { return { left: 278, right: 365, top: 44, width: 87, height: 32, bottom: 76 }; },
    checkIsAddedToMyMiniProgram: function (options) { checks.push(options); options.success({ added: false }); },
    showModal: function (options) { modals.push(options); },
    showToast: function () {}, switchTab: function () {}, removeStorageSync: function (key) { storage.delete(key); }
  };
  t.mock.method(global, 'setTimeout', clock.setTimeout);
  t.mock.method(global, 'clearTimeout', clock.clearTimeout);
  t.mock.method(global, 'setInterval', clock.setInterval);
  t.mock.method(global, 'clearInterval', clock.clearInterval);
  t.mock.method(Date, 'now', clock.now);
  const previousWx = global.wx;
  global.wx = platform;
  t.after(function () { global.wx = previousWx; });
  const app = { globalData: { environment: 'staging', user: { _id: 'fake-user' }, loggedIn: true } };
  let refreshed = 0;
  const page = {
    data: { loading: false, loadError: '', nodes: [{ _id: 'fake-person' }], currentFamily: { _id: 'fake-family' }, topAdVisible: true },
    setData: function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); },
    refreshTreeAd: function () { refreshed += 1; return Promise.resolve(); }
  };
  const runtime = Object.assign({ wx: platform }, clock);
  const key = guide.scope(app);
  page._myMiniProgramGraphScope = key;
  page._myMiniProgramGraphFamilyId = 'fake-family';
  return { clock: clock, platform: platform, app: app, page: page, storage: storage, checks: checks, modals: modals,
    register: function () { if (!storage.has(key)) storage.set(key, { pendingFamilyId: 'fake-family', shownCount: 0, lastShownAt: 0, added: false }); },
    setFamily: function (id) { page.data.currentFamily = { _id: id }; page._myMiniProgramGraphFamilyId = id; page._myMiniProgramGraphScope = guide.scope(app); },
    start: function () { return guide.create(page, app, runtime); },
    record: function () { return storage.get(key); }, refreshed: function () { return refreshed; } };
}

test('实际展示后计次，15 秒前不显示，8 秒后消失并恢复顶部规则', function (t) {
  const f = fixture(t);
  f.register();
  const controller = f.start();
  f.clock.advance(14999);
  assert.equal(f.page.data.showMyMiniProgramGuide, undefined);
  assert.equal(f.record().shownCount, 0);
  f.clock.advance(1);
  assert.equal(f.page.data.showMyMiniProgramGuide, true);
  assert.equal(f.record().shownCount, 1);
  assert.equal(f.checks.length, 1);
  f.clock.advance(7999);
  assert.equal(f.page.data.showMyMiniProgramGuide, true);
  f.clock.advance(1);
  assert.equal(f.page.data.showMyMiniProgramGuide, false);
  assert.equal(f.refreshed(), 1);
  assert.equal(f.clock.count(), 0);
  controller.stop(false);
});

test('提前离开不消耗次数，返回任意真实家谱重新浏览后可显示首次提示', function (t) {
  const f = fixture(t);
  f.register();
  const first = f.start();
  f.clock.advance(14000);
  first.stop(false);
  assert.equal(f.record().shownCount, 0);
  f.setFamily('other-family');
  const second = f.start();
  f.clock.advance(14999);
  assert.equal(f.checks.length, 0);
  f.clock.advance(1);
  assert.equal(f.record().shownCount, 1);
  second.dismiss();
  assert.equal(f.record().added, false);
});

test('7 天边界前不提醒，满 7 天任意真实家谱可提醒，总共最多两次', function (t) {
  const f = fixture(t);
  f.register();
  const first = f.start();
  f.clock.advance(15000);
  first.dismiss();
  f.clock.advance(WEEK - 1);
  const early = f.start();
  assert.equal(f.clock.count(), 0);
  early.stop(false);
  f.clock.advance(1);
  f.setFamily('other-family');
  const second = f.start();
  f.clock.advance(15000);
  assert.equal(f.record().shownCount, 2);
  second.dismiss();
  f.clock.advance(WEEK);
  f.register();
  f.start();
  assert.equal(f.clock.count(), 0);
  assert.equal(f.checks.length, 2);
});

test('首次教学、所有操作弹框、手势、横屏、清屏、加载和空图均重新计时', function (t) {
  const states = [
    ['_myMiniProgramTourActive', true], ['_myMiniProgramNotificationsActive', true], ['_graphGestureActive', true], ['_gesturePending', {}],
    ['showMemberSheet', true], ['showFamilySheet', true], ['showPerspectiveSheet', true],
    ['showChildOrderSheet', true], ['showShareSheet', true], ['showExportSheet', true], ['isLandscape', true], ['isCleanScreen', true],
    ['orientationChanging', true], ['posterGenerating', true], ['loading', true], ['loadError', 'fake-error'],
    ['accountPending', true], ['graphRendering', true], ['nodes', []]
  ];
  const f = fixture(t);
  f.register();
  const controller = f.start();
  states.forEach(function (state) {
    f.clock.advance(14000);
    const target = state[0][0] === '_' ? f.page : f.page.data;
    const old = target[state[0]];
    target[state[0]] = state[1];
    controller.sync();
    f.clock.advance(2000);
    assert.equal(f.record().shownCount, 0, state[0]);
    target[state[0]] = old;
    controller.sync();
  });
  f.clock.advance(15000);
  assert.equal(f.record().shownCount, 1);
  controller.dismiss();
});

test('已添加取消待提醒；未支持、失败、抛错、超时均静默跳过且不计次', function (t) {
  const f = fixture(t);
  f.register();
  const behaviors = [undefined, function (o) { o.fail({}); }, function () { throw new Error('fake'); }, function () {}];
  behaviors.forEach(function (behavior) {
    f.platform.checkIsAddedToMyMiniProgram = behavior;
    const controller = f.start();
    f.clock.advance(18000);
    assert.equal(f.record().shownCount, 0);
    assert.equal(f.page.data.showMyMiniProgramGuide, undefined);
    assert.equal(f.clock.count(), 0);
    controller.stop(false);
  });
  f.platform.checkIsAddedToMyMiniProgram = function (o) { o.success({ added: true }); };
  f.start();
  f.clock.advance(15000);
  assert.equal(f.record().added, true);
  assert.equal(f.record().pendingFamilyId, '');
  assert.equal(f.record().shownCount, 0);
  f.register();
  f.start();
  assert.equal(f.clock.count(), 0);
});

test('首次添加后第二次提醒前查到已添加，取消后续提醒', function (t) {
  const f = fixture(t);
  f.register();
  const first = f.start();
  f.clock.advance(15000);
  first.dismiss();
  f.clock.advance(WEEK);
  f.platform.checkIsAddedToMyMiniProgram = function (o) { o.success({ added: true }); };
  f.start();
  f.clock.advance(15000);
  assert.equal(f.record().shownCount, 1);
  assert.equal(f.record().added, true);
  assert.equal(f.page.data.showMyMiniProgramGuide, false);
});

test('切换账户、切换家谱、离页和查询超时后的回调不能显示或计次', function (t) {
  const f = fixture(t);
  f.register();
  const cases = [
    function (c) { c.stop(false); },
    function (c) { f.page.data.currentFamily = { _id: 'other-family' }; c.sync(); },
    function (c) { f.app.globalData.user = { _id: 'other-user' }; c.sync(); },
    function () { f.clock.advance(3000); }
  ];
  cases.forEach(function (change) {
    f.app.globalData.user = { _id: 'fake-user' };
    f.page.data.currentFamily = { _id: 'fake-family' };
    let query;
    f.platform.checkIsAddedToMyMiniProgram = function (o) { query = o; };
    const controller = f.start();
    f.clock.advance(15000);
    change(controller);
    query.success({ added: false });
    f.clock.advance(0);
    assert.equal(f.record().shownCount, 0);
    assert.notEqual(f.page.data.showMyMiniProgramGuide, true);
    controller.stop(false);
  });
});

test('视图提交之前离页不计次；展示后进入弹框立即隐藏', function (t) {
  const f = fixture(t);
  f.register();
  let render;
  f.page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) render = callback; };
  const controller = f.start();
  f.clock.advance(15000);
  f.clock.advance(1000);
  assert.equal(f.checks.length, 1);
  controller.stop(false);
  render();
  assert.equal(f.record().shownCount, 0);
  f.page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  const second = f.start();
  f.clock.advance(15000);
  f.page.data.showMemberSheet = true;
  second.sync();
  assert.equal(f.page.data.showMyMiniProgramGuide, false);
  assert.equal(f.record().shownCount, 1);
  assert.equal(f.clock.count(), 0);
});

test('不会重新打开用户已关闭的顶部广告，展示时销毁旧广告实例', function (t) {
  const f = fixture(t);
  f.register();
  f.page.data.topAdVisible = false;
  const first = f.start();
  f.clock.advance(15000);
  first.dismiss();
  assert.equal(f.refreshed(), 0);
  f.storage.clear();
  f.register();
  f.page.data.topAdVisible = true;
  let destroyed = 0;
  f.page.dismissTopAd = function () { destroyed += 1; f.page.data.topAdVisible = false; };
  const second = f.start();
  f.clock.advance(15000);
  assert.equal(destroyed, 1);
  second.dismiss();
  assert.equal(f.refreshed(), 1);
});

test('旧视图回调不隐藏新控制器的气泡，渲染期间切谱不计次', function (t) {
  const f = fixture(t);
  f.register();
  let oldRender;
  f.page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) oldRender = callback; };
  const old = f.start();
  f.clock.advance(15000);
  old.stop(false);
  const callback = oldRender;
  f.page.setData = function (patch, done) { Object.assign(this.data, patch); if (done) done(); };
  const current = f.start();
  f.clock.advance(15000);
  callback();
  assert.equal(f.page.data.showMyMiniProgramGuide, true);
  assert.equal(f.record().shownCount, 1);
  current.dismiss();
  f.storage.clear();
  f.register();
  f.page.setData = function (patch, done) { Object.assign(this.data, patch); if (done) oldRender = done; };
  const third = f.start();
  f.clock.advance(15000);
  f.page.data.currentFamily = { _id: 'other-family' };
  oldRender();
  assert.equal(f.record().shownCount, 0);
  assert.equal(f.page.data.showMyMiniProgramGuide, false);
  third.stop(false);
});

test('记录按环境和账户隔离，手动步骤不计次，存储失败不抛错', function (t) {
  const f = fixture(t);
  const first = f.start();
  f.clock.advance(15000);
  first.dismiss();
  f.app.globalData.environment = 'other-fixture-env';
  f.start();
  assert.equal(f.clock.count(), 0);
  f.app.globalData.environment = 'staging';
  f.app.globalData.user = { _id: 'other-user' };
  f.start();
  assert.equal(f.clock.count(), 0);
  guide.showManual(f.page);
  assert.equal(f.page.data.showMyMiniProgramGuide, true);
  assert.equal(f.modals.length, 0);
  guide.dismissManual(f.page);
  assert.equal(f.record().shownCount, 1);
  f.platform.getStorageSync = function () { throw new Error('fake-storage'); };
  assert.doesNotThrow(function () { f.start(); });
});

test('气泡在页面顶部，不重复叠加原生导航高度；窄屏和无效菜单坐标有兜底', function (t) {
  const f = fixture(t);
  const placed = guide.placement(f.platform);
  assert.match(placed.myMiniProgramGuideStyle, /top:12px/);
  assert.match(placed.myMiniProgramGuideArrowStyle, /left:240.75px/);
  f.platform.getWindowInfo = function () { return { windowWidth: 280 }; };
  f.platform.getMenuButtonBoundingClientRect = function () { return { left: 0, width: 0 }; };
  assert.match(guide.placement(f.platform).myMiniProgramGuideStyle, /width:248px/);
});

test('无历史提醒记录的老用户无需创建或加入，三种角色均在浏览后提醒', function (t) {
  const f = fixture(t);
  ['admin', 'member', 'viewer'].forEach(function (role) {
    f.storage.clear();
    f.page.data.currentRole = role;
    const controller = f.start();
    assert.equal(f.record().shownCount, 0);
    f.clock.advance(14999);
    assert.notEqual(f.page.data.showMyMiniProgramGuide, true);
    f.clock.advance(1);
    assert.equal(f.page.data.showMyMiniProgramGuide, true, role);
    assert.equal(f.record().shownCount, 1);
    controller.dismiss();
  });
});

test('加载或身份未确认、无有效家谱时不初始化，确认后才计时', function (t) {
  const f = fixture(t);
  f.page.data.loading = true;
  const controller = f.start();
  f.clock.advance(20000);
  assert.equal(f.record(), undefined);
  f.page.data.loading = false;
  f.app.globalData.loggedIn = false;
  controller.sync();
  assert.equal(f.record(), undefined);
  f.app.globalData.loggedIn = true;
  f.page.data.currentFamily = null;
  controller.sync();
  assert.equal(f.record(), undefined);
  f.setFamily('fake-family');
  f.page._myMiniProgramGraphScope = '';
  controller.sync();
  assert.equal(f.record(), undefined);
  f.setFamily('fake-family');
  controller.sync();
  f.clock.advance(14999);
  assert.equal(f.record().shownCount, 0);
  f.clock.advance(1);
  assert.equal(f.record().shownCount, 1);
  controller.dismiss();
});

test('升级保留次数和时间，旧首次绑定家谱不再限制其他家谱', function (t) {
  const f = fixture(t);
  const saved = { shownCount: 1, lastShownAt: f.clock.now(), pendingFamilyId: 'old-family', added: false };
  f.storage.set(guide.scope(f.app), saved);
  f.start();
  assert.deepEqual(f.record(), saved);
  assert.equal(f.clock.count(), 0);
  f.storage.set(guide.scope(f.app), Object.assign({}, saved, { shownCount: 2 }));
  f.clock.advance(WEEK);
  f.start();
  assert.equal(f.record().shownCount, 2);
  assert.equal(f.record().lastShownAt, saved.lastShownAt);
  assert.equal(f.clock.count(), 0);
  f.storage.set(guide.scope(f.app), Object.assign({}, saved, { shownCount: 0 }));
  f.setFamily('other-family');
  const controller = f.start();
  f.clock.advance(15000);
  assert.equal(f.record().shownCount, 1);
  controller.dismiss();
});

test('我的页同组顺序为关于、分享、添加，入口只出现一次且冷静期隐藏', function () {
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.equal((template.match(/bindtap="showMyMiniProgramHelp"/g) || []).length, 1);
  const account = template.match(/<block wx:else>([\s\S]*?)<\/block>/)[1];
  assert.match(account, /关于有谱[\s\S]*分享有谱[\s\S]*bindtap="showMyMiniProgramHelp"/);
  assert.match(account, /setting-share-row[^\n]+\n\s*<view[^>]*class="setting-row" bindtap="showMyMiniProgramHelp"/);
  const help = template.slice(template.indexOf('<template is="readingHelpEntry"'));
  const helpEntry = template.match(/<template name="readingHelpEntry">([\s\S]*?)<\/template>/)[1];
  assert.doesNotMatch(helpEntry, /showMyMiniProgramHelp/);
  assert.doesNotMatch(help, /showMyMiniProgramHelp/);
});

function loadPage(name, app) {
  let definition;
  const beforeApp = global.getApp;
  const beforePage = global.Page;
  global.getApp = function () { return app; };
  global.Page = function (value) { definition = value; };
  try {
    const target = require.resolve('../miniprogram/pages/' + name + '/index');
    delete require.cache[target];
    require(target);
  } finally { global.getApp = beforeApp; global.Page = beforePage; }
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) });
  page.setData = function (patch, callback) { Object.assign(page.data, patch); if (callback) callback(); };
  return page;
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test('真实家谱首次登录和异步图谱加载完成后启动老用户引导', async function (t) {
  const f = fixture(t);
  f.app.globalData.user = null;
  f.app.globalData.loggedIn = false;
  f.app.consumePendingView = function () { return null; };
  f.app.isCacheFresh = function () { return false; };
  f.app.getCurrentFamily = function () { return { _id: 'fake-family' }; };
  f.app.setCurrentFamily = function () {};
  let familiesReady;
  let graphReady;
  f.app.loadFamilies = function () { return new Promise(function (resolve) { familiesReady = resolve; }); };
  f.app.getGraph = function () { return new Promise(function (resolve) { graphReady = resolve; }); };
  t.mock.method(api, 'getMediaUrls', function () { return Promise.resolve({}); });
  t.mock.method(shareCard, 'createAndRender', function () { return Promise.resolve({}); });
  const page = loadPage('tree', f.app);
  page.loadNotificationTemplates = function () {};
  page.refreshTreeAd = function () { return Promise.resolve(); };
  page.preloadMemberAd = function () { return Promise.resolve(); };
  page.renderGraph = function () { this.setData({ nodes: this.data.rawPersons }); };
  page.onShow();
  f.clock.advance(20000);
  assert.equal(f.record(), undefined);
  f.app.globalData.user = { _id: 'fake-user' };
  f.app.globalData.loggedIn = true;
  familiesReady([{ _id: 'fake-family' }]);
  await flush();
  f.clock.advance(20000);
  assert.equal(f.record(), undefined);
  graphReady({ family: { _id: 'fake-family' }, currentRole: 'viewer', persons: [{ _id: 'fake-person', name: '虚构成员' }], relations: [] });
  await flush();
  f.clock.advance(14999);
  assert.equal(f.record().shownCount, 0);
  f.clock.advance(1);
  assert.equal(page.data.showMyMiniProgramGuide, true);
  page.onUnload();
});

test('真实家谱刷新失败保留旧画面时，不用旧图谱初始化老用户引导', async function (t) {
  const f = fixture(t);
  f.app.consumePendingView = function () { return null; };
  f.app.isCacheFresh = function () { return false; };
  f.app.getCurrentFamily = function () { return { _id: 'fake-family' }; };
  f.app.loadFamilies = function () { return Promise.reject(new Error('fake-loading-failure')); };
  t.mock.method(console, 'error', function () {});
  t.mock.method(console, 'warn', function () {});
  const page = loadPage('tree', f.app);
  page._hasLoaded = true;
  page._myMiniProgramGraphScope = guide.scope(f.app);
  page._myMiniProgramGraphFamilyId = 'fake-family';
  page.setData({ loading: false, currentFamily: { _id: 'fake-family' }, nodes: [{ _id: 'fake-person' }] });
  page.loadNotificationTemplates = function () {};
  page.refreshTreeAd = function () { return Promise.resolve(); };
  page.preloadMemberAd = function () { return Promise.resolve(); };
  page.onShow();
  await flush();
  assert.equal(page.data.nodes.length, 1);
  f.clock.advance(20000);
  assert.equal(f.record(), undefined);
  assert.equal(page.data.showMyMiniProgramGuide, false);
  page.onUnload();
});

test('真实家谱页生命周期和人物操作立即撤下气泡，离页后不恢复广告', function (t) {
  const f = fixture(t);
  f.register();
  f.app.consumePendingView = function () { return null; };
  const page = loadPage('tree', f.app);
  page.setData({ loading: false, currentFamily: { _id: 'fake-family' }, nodes: [{ _id: 'fake-person' }] });
  f.app.getCurrentFamily = function () { return { _id: 'fake-family' }; };
  f.app.isCacheFresh = function () { return true; };
  page._hasLoaded = true;
  page.preloadMemberAd = function () { return Promise.resolve(); };
  page.loadNotificationTemplates = function () {};
  page.refreshTreeAd = function () { return Promise.resolve(); };
  page.onShow();
  f.clock.advance(15000);
  assert.equal(page.data.showMyMiniProgramGuide, true);
  page.openFamilySheet();
  assert.equal(page.data.showMyMiniProgramGuide, false);
  assert.equal(f.record().shownCount, 1);
  page.onHide();
  f.clock.advance(30000);
  assert.equal(f.clock.count(), 0);
  assert.equal(page.data.showMyMiniProgramGuide, false);
  page.onShow();
  f.clock.advance(20000);
  assert.equal(page.data.showMyMiniProgramGuide, false);
  page.onUnload();
});

test('真实我的页入口立即显示同款气泡，不弹模态框、不计次数', function (t) {
  const f = fixture(t);
  const page = loadPage('profile', f.app);
  page.showMyMiniProgramHelp();
  assert.equal(page.data.showMyMiniProgramGuide, true);
  assert.equal(f.modals.length, 0);
  assert.equal(f.checks.length, 0);
  assert.match(page.data.myMiniProgramGuideStyle, /top:12px/);
  assert.equal(f.record(), undefined);
  f.register();
  page.showMyMiniProgramHelp();
  assert.equal(f.record().shownCount, 0);
  page.dismissMyMiniProgramGuide();
  assert.equal(page.data.showMyMiniProgramGuide, false);
});

test('我的页手动气泡 8 秒消失，重复点击重新计时，不受主动次数上限影响', function (t) {
  const f = fixture(t);
  f.storage.set(guide.scope(f.app), { shownCount: 2, lastShownAt: f.clock.now(), added: true });
  const saved = Object.assign({}, f.record());
  const page = loadPage('profile', f.app);
  page.showMyMiniProgramHelp();
  f.clock.advance(7000);
  page.showMyMiniProgramHelp();
  f.clock.advance(1000);
  assert.equal(page.data.showMyMiniProgramGuide, true);
  f.clock.advance(6999);
  assert.equal(page.data.showMyMiniProgramGuide, true);
  f.clock.advance(1);
  assert.equal(page.data.showMyMiniProgramGuide, false);
  assert.equal(f.clock.count(), 0);
  assert.deepEqual(f.record(), saved);
  assert.equal(f.checks.length, 0);
  assert.equal(f.modals.length, 0);
});

test('我的页隐藏和卸载清理手动引导，离页后旧视图回调不恢复气泡', function (t) {
  const f = fixture(t);
  const page = loadPage('profile', f.app);
  page.showMyMiniProgramHelp();
  page.onHide();
  assert.equal(page.data.showMyMiniProgramGuide, false);
  assert.equal(f.clock.count(), 0);
  page.showMyMiniProgramHelp();
  assert.equal(page.data.showMyMiniProgramGuide, false);
  page._feedbackHidden = false;
  let pending;
  page.setData = function (patch, done) { Object.assign(this.data, patch); if (done) pending = done; };
  page.showMyMiniProgramHelp();
  page.onUnload();
  pending();
  f.clock.advance(9000);
  assert.equal(page.data.showMyMiniProgramGuide, false);
  assert.equal(f.clock.count(), 0);
});

test('两页共用气泡模板和样式，关闭事件均可执行，文字和按钮分栏', function (t) {
  const f = fixture(t);
  const shared = fs.readFileSync(path.join(__dirname, '../miniprogram/templates/my-miniprogram-guide.wxml'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../miniprogram/styles/my-miniprogram-guide.wxss'), 'utf8');
  const header = shared.match(/<view class="my-miniprogram-guide-header">([\s\S]*?)<\/view>/)[1];
  assert.match(header, /my-miniprogram-guide-title[\s\S]*my-miniprogram-guide-close/);
  assert.match(styles, /my-miniprogram-guide-header\s*\{[^}]*display:\s*flex/);
  const closeStyle = styles.match(/button\.my-miniprogram-guide-close\s*\{([^}]*)\}/)[1];
  assert.match(closeStyle, /position:\s*static/);
  assert.match(closeStyle, /flex:\s*0 0 44px/);
  ['tree', 'profile'].forEach(function (name) {
    const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/' + name + '/index.wxml'), 'utf8');
    const pageStyle = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/' + name + '/index.wxss'), 'utf8');
    assert.match(template, /<import src="\.\.\/\.\.\/templates\/my-miniprogram-guide.wxml"/);
    assert.match(template, /<template is="myMiniProgramGuide"/);
    assert.match(pageStyle, /@import "\.\.\/\.\.\/styles\/my-miniprogram-guide.wxss"/);
    const page = loadPage(name, f.app);
    assert.equal(typeof page.stopEvent, 'function');
    assert.equal(typeof page.dismissMyMiniProgramGuide, 'function');
  });
});

test('首次教学尚未显示离开后，缓存返回仍显示教学，关闭后才开始引导计时', async function (t) {
  const f = fixture(t);
  f.register();
  f.storage.set('youpu_new_family_tour_fake-family', true);
  f.app.consumePendingView = function () { return null; };
  f.app.getCurrentFamily = function () { return { _id: 'fake-family' }; };
  f.app.isCacheFresh = function () { return true; };
  const page = loadPage('tree', f.app);
  page._hasLoaded = true;
  page.setData({ loading: false, currentFamily: { _id: 'fake-family' }, nodes: [{ _id: 'fake-person' }] });
  page.refreshTreeAd = function () { return Promise.resolve(); };
  page.preloadMemberAd = function () { return Promise.resolve(); };
  page.loadNotificationTemplates = function () {};
  page.onShow();
  f.clock.advance(200);
  page.onHide();
  f.clock.advance(1000);
  assert.equal(f.modals.length, 0);
  assert.equal(f.storage.get('youpu_new_family_tour_fake-family'), true);
  page.onShow();
  f.clock.advance(280);
  assert.equal(f.modals[0].title, '这是你的第一张家谱');
  f.clock.advance(20000);
  assert.equal(f.record().shownCount, 0);
  f.modals[0].complete();
  f.clock.advance(250);
  f.clock.advance(15000);
  assert.equal(page.data.showMyMiniProgramGuide, true);
  page.onUnload();
});

test('创建路由不预先登记，成功或失败均由真实家谱加载统一判断', async function (t) {
  const f = fixture(t);
  f.app.setCurrentFamily = function () {};
  f.app.invalidateCache = function () {};
  let resolve;
  t.mock.method(api, 'call', function () { return new Promise(function (done) { resolve = done; }); });
  const page = loadPage('create-family', f.app);
  page.setData({ familyName: '虚构家谱', startName: '虚构成员', startGender: 'male' });
  page.createFamily();
  assert.equal(f.record(), undefined);
  resolve({ family: { _id: 'fake-family' } });
  await flush();
  assert.equal(f.record(), undefined);
  f.storage.clear();
  page.createFamily();
  f.app.globalData.user = { _id: 'other-user' };
  resolve({ family: { _id: 'fake-family' } });
  await flush();
  assert.equal(f.storage.has(guide.scope(f.app)), false);
  f.app.globalData.user = { _id: 'fake-user' };
  t.mock.method(api, 'call', function () { return Promise.reject(new Error('fake-failure')); });
  page.createFamily();
  await flush();
  assert.equal(f.record(), undefined);
});

test('邀请路由不预先登记，首次加入和已加入用户进入真实家谱统一判断', async function (t) {
  const f = fixture(t);
  f.app.ensureLogin = function () { return Promise.resolve(); };
  f.app.openFullGraph = function () {};
  let joined = true;
  let fail = false;
  t.mock.method(api, 'call', function () {
    return fail ? Promise.reject(new Error('fake-failure')) : Promise.resolve({ alreadyJoined: joined, family: { _id: 'fake-family', name: '虚构家谱' } });
  });
  const page = loadPage('invite', f.app);
  page.acceptInvite();
  await flush();
  assert.equal(f.record(), undefined);
  page.loadPreview();
  await flush();
  assert.equal(f.record(), undefined);
  fail = true;
  page.acceptInvite();
  await flush();
  assert.equal(f.record(), undefined);
  fail = false;
  joined = false;
  page.acceptInvite();
  await flush();
  assert.equal(f.record(), undefined);
});
