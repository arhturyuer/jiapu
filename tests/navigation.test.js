require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const geometry = require('../miniprogram/utils/navigation-layout');
const navigationPage = require('../miniprogram/utils/navigation-page');
const fs = require('node:fs');
const path = require('node:path');

function capsule(width, status) {
  return { left: width - 97, right: width - 10, top: status + 6, bottom: status + 38, width: 87, height: 32 };
}

test('标题使用胶囊左侧全部空间，返回按钮和安全区分别预留', () => {
  [320, 375, 430, 600, 1024].forEach(width => {
    const menu = capsule(width, 47);
    const info = { windowWidth: width, statusBarHeight: 47, safeArea: { left: 0, right: width } };
    const plain = geometry.layout(info, menu);
    assert.equal(plain.titleLeft, 12);
    assert.equal(width - plain.right, menu.left - 8);
    assert.equal(plain.titleWidth, menu.left - 8 - plain.titleLeft);
    assert.equal(plain.height, 91);
    const aligned = geometry.layout(info, menu, { pageGutter: true });
    assert.equal(aligned.titleLeft, width >= 600 ? 16 : width * 32 / 750);
    assert.equal(width - aligned.right, menu.left - 8);
    assert.ok(Math.abs(aligned.titleWidth - (menu.left - 8 - aligned.titleLeft)) < 1e-9);
    const back = geometry.layout(info, menu, { back: true });
    assert.equal(back.titleLeft, 60);
    assert.equal(back.right, plain.right);
    assert.equal(back.titleWidth, plain.titleWidth - 48);
    assert.ok(width - back.right - back.titleLeft > 0);
  });
  const horizontal = geometry.layout({ windowWidth: 844, statusBarHeight: 0, safeArea: { left: 44, right: 800 } }, capsule(844, 0));
  assert.equal(horizontal.titleLeft, 56);
  assert.equal(horizontal.status, 0);
  const alignedHorizontal = geometry.layout({ windowWidth: 844, statusBarHeight: 0, safeArea: { left: 44, right: 800 } }, capsule(844, 0), { pageGutter: true });
  assert.equal(alignedHorizontal.titleLeft, 60);
  assert.equal(alignedHorizontal.titleWidth, capsule(844, 0).left - 8 - 60);
});

test('标准到 200% 及长辈字体保持原字号，导航增高容纳单行文字', () => {
  [false, true].forEach(elderMode => {
    [1, 1.15, 1.25, 1.5, 2].forEach(scale => {
      const bodySize = 16 * (elderMode ? 1.25 : 1) * scale;
      const value = geometry.layout({ windowWidth: 320, statusBarHeight: 20 }, capsule(320, 20), { bodySize, elderMode });
      assert.equal(value.fontSize, bodySize * 17 / 16);
      assert.ok(value.rowHeight >= value.fontSize * 1.4 + 16);
      assert.ok(value.rowHeight >= (elderMode ? 60 : 44));
      assert.ok(value.height >= 64);
    });
  });
});

test('胶囊缺失、异常或超出窗口时保守预留，缺失窗口信息也有有限尺寸', () => {
  [undefined, {}, { ...capsule(375, 20), left: NaN }, capsule(1200, 20), { ...capsule(375, 20), top: -1 }].forEach(menu => {
    const result = geometry.layout({ windowWidth: 375, statusBarHeight: 20 }, menu);
    assert.equal(result.right, 108);
    assert.equal(result.titleLeft, 12);
    assert.ok(Number.isFinite(result.height));
  });
  assert.equal(geometry.layout().height, 64);
});

function component(t) {
  const previous = { Component: global.Component, wx: global.wx, getCurrentPages: global.getCurrentPages };
  let definition;
  global.Component = value => { definition = value; };
  const file = require.resolve('../miniprogram/components/page-navigation/index');
  delete require.cache[file];
  require(file);
  t.after(() => Object.assign(global, previous));
  const value = Object.assign({}, definition.methods, { data: Object.assign({}, definition.data, { back: false }), events: [] });
  value.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  value.triggerEvent = function (name, detail) { this.events.push({ name, detail }); };
  return { value, definition };
}

test('导航尺寸变化才通知页面，隐藏或销毁后不回写，返回和直达首页分流', t => {
  const { value, definition } = component(t);
  let size = { windowWidth: 375, windowHeight: 800, statusBarHeight: 47 };
  let stack = [{}, {}];
  const visited = [];
  global.getCurrentPages = () => stack;
  global.wx = {
    getStorageSync: () => ({}), getAppBaseInfo: () => ({}),
    getWindowInfo: () => size, getMenuButtonBoundingClientRect: () => capsule(size.windowWidth, size.statusBarHeight),
    navigateBack: options => visited.push(options), switchTab: options => visited.push(options)
  };
  definition.lifetimes.attached.call(value);
  assert.equal(value.data.height, 91);
  assert.equal(value.events.at(-1).detail.height, 91);
  const count = value.events.length;
  value.updateLayout();
  assert.equal(value.events.length, count);
  value.data.pageGutter = true;
  value.updateLayout();
  assert.ok(value.data.titleStyle.includes('left:16px'));
  value.data.pageGutter = false;
  value.data.back = true;
  value.updateLayout();
  assert.ok(value.data.titleStyle.includes('left:60px'));
  value.goBack();
  assert.equal(visited.at(-1).delta, 1);
  visited.at(-1).fail();
  assert.equal(visited.at(-1).url, '/pages/tree/index');
  stack = [{}];
  value.goBack();
  assert.equal(visited.at(-1).url, '/pages/tree/index');
  size = { windowWidth: 844, windowHeight: 375, statusBarHeight: 0 };
  definition.pageLifetimes.resize.call(value, { size });
  assert.equal(value.data.height, 44);
  definition.pageLifetimes.hide.call(value);
  const hiddenCount = value.events.length;
  value.updateLayout({ windowWidth: 320 });
  assert.equal(value.events.length, hiddenCount);
  definition.lifetimes.detached.call(value);
});

test('导航高度同步只触发一次现有图谱重测，保留缩放并忽略离页回调', () => {
  const sizes = [];
  const page = { data: { navigationHeight: 64, graphScale: 1.6, graphX: -100 },
    setData(patch, callback) { Object.assign(this.data, patch); callback(); },
    applyPageResize() {}, onResize(event) { sizes.push(event.size); }, getWindowSize() { return { windowWidth: 375, windowHeight: 800 }; } };
  const event = { detail: { height: 91, size: { windowWidth: 844, windowHeight: 375 } } };
  navigationPage.changed.call(page, event);
  navigationPage.changed.call(page, event);
  assert.deepEqual(sizes, [event.detail.size]);
  assert.equal(page.data.graphScale, 1.6);
  assert.equal(page.data.graphX, -100);
  page._deviceHidden = true;
  navigationPage.changed.call(page, { detail: { height: 44 } });
  assert.equal(sizes.length, 1);
  assert.equal(page.data.navigationHeight, 91);
});

test('示例、认识有谱和修谱指南按页面栈返回，直接打开使用统一首页图标', t => {
  const { value, definition } = component(t);
  const visited = [];
  let stack = [{}];
  global.getCurrentPages = () => stack;
  global.wx = { getStorageSync: () => ({}), getAppBaseInfo: () => ({}),
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 800, statusBarHeight: 47 }),
    navigateBack: options => visited.push({ type: 'back', ...options }),
    switchTab: options => visited.push({ type: 'home', ...options }) };
  const read = file => fs.readFileSync(path.resolve(__dirname, '../miniprogram', file), 'utf8');
  for (const name of ['example', 'share-intro', 'guides']) {
    const template = read('pages/' + name + '/index.wxml');
    assert.match(template, /<page-navigation\b[^>]*\bback\b/);
    assert.doesNotMatch(template, /<page-navigation\b[^>]*\bhome\b/);
    value.data.back = true;
    value.data.home = false;
    for (const depth of [1, 2, 3]) {
      stack = Array.from({ length: depth }, () => ({}));
      definition.lifetimes.attached.call(value);
      assert.equal(value.data.canGoBack, depth > 1);
      value.goBack();
      assert.equal(visited.at(-1).type, depth > 1 ? 'back' : 'home');
      if (depth > 1) assert.equal(visited.at(-1).delta, 1);
      else assert.equal(visited.at(-1).url, '/pages/tree/index');
      definition.pageLifetimes.hide.call(value);
    }
  }
  const navigation = read('components/page-navigation/index.wxml');
  assert.doesNotMatch(navigation, /⌂/);
  assert.match(navigation, /wx:if="\{\{home \|\| !canGoBack\}\}" class="navigation-home-icon" src="\/images\/icons\/navigation-home.svg"/);
  assert.match(navigation, /<view wx:else class="navigation-back-icon"/);
});

test('可点击长短标题都显式占满胶囊前安全宽度，覆盖原生按钮固定宽度和自动居中', t => {
  const { value } = component(t);
  const info = { windowWidth: 414, windowHeight: 896, statusBarHeight: 47 };
  global.wx = { getWindowInfo: () => info, getMenuButtonBoundingClientRect: () => capsule(414, 47) };
  value._attached = true;
  Object.assign(value.data, { titleSwitchable: true, pageGutter: true });
  for (const title of ['短标题', '虚构家谱长名称'.repeat(6)]) {
    value.data.title = title;
    value.updateLayout();
    const style = Object.fromEntries(value.data.titleStyle.split(';').filter(Boolean).map(item => item.split(':')));
    assert.equal(parseFloat(style.left), 414 * 32 / 750);
    assert.ok(Math.abs(parseFloat(style.left) + parseFloat(style.width) - (capsule(414, 47).left - 8)) < 1e-9);
    assert.ok(parseFloat(style.width) > 184, '标题宽度不能退回原生按钮的 184px');
  }
  const template = fs.readFileSync(path.resolve(__dirname, '../miniprogram/components/page-navigation/index.wxml'), 'utf8');
  const buttonStyle = template.match(/class="navigation-title navigation-title-switch" style="([^"]+)"/)[1];
  assert.match(buttonStyle, /\{\{titleStyle\}\}/);
  assert.match(buttonStyle, /margin:0;padding:0;/);
  assert.match(buttonStyle, /position:absolute;display:flex;/);
});

test('导航标题切换默认关闭，仅可交互且可见的组件发送事件', t => {
  const { value, definition } = component(t);
  assert.equal(definition.properties.titleSwitchable.value, false);
  value._attached = true;
  value.switchTitle();
  assert.deepEqual(value.events, []);
  value.data.titleSwitchable = true;
  value.switchTitle();
  assert.deepEqual(value.events, [{ name: 'titleswitch', detail: undefined }]);
  value._deviceHidden = true;
  value.switchTitle();
  value._deviceHidden = false;
  value._attached = false;
  value.switchTitle();
  assert.equal(value.events.length, 1);
});

function treePage(t) {
  const previous = { Page: global.Page, getApp: global.getApp };
  const app = { globalData: {}, setCurrentFamily(family) { this.currentFamily = family; } };
  let page;
  global.getApp = () => app;
  global.Page = definition => { page = Object.assign({}, definition, { data: Object.assign({}, definition.data) }); };
  const file = require.resolve('../miniprogram/pages/tree/index');
  delete require.cache[file];
  require(file);
  Object.assign(global, previous);
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  return { page, app };
}

test('家谱标题在无数据、加载、错误和注销时不打开选择器，横屏与清屏仍可打开', t => {
  const { page } = treePage(t);
  const ready = { currentFamily: { _id: 'fictional-family' }, loading: false, loadError: '', accountPending: false, showFamilySheet: false };
  for (const blocked of [{ currentFamily: null }, { loading: true }, { loadError: '虚构加载失败' }, { accountPending: true }]) {
    Object.assign(page.data, ready, blocked);
    page.openFamilySheet();
    assert.equal(page.data.showFamilySheet, false);
  }
  for (const isLandscape of [false, true]) {
    for (const isCleanScreen of [false, true]) {
      Object.assign(page.data, ready, { isLandscape, isCleanScreen, graphScale: 1.7, graphX: -123, graphY: 45 });
      page.openFamilySheet();
      assert.equal(page.data.showFamilySheet, true);
      page.closeFamilySheet();
      assert.equal(page.data.showFamilySheet, false);
      assert.equal(page.data.graphScale, 1.7);
      assert.equal(page.data.graphX, -123);
      assert.equal(page.data.graphY, 45);
      assert.equal(page.data.isLandscape, isLandscape);
      assert.equal(page.data.isCleanScreen, isCleanScreen);
    }
  }
});

test('从标题切谱保留横屏清屏，重置人物视角并加载新谱，首页邀请从完整家谱进入', t => {
  const { page, app } = treePage(t);
  const family = { _id: 'fictional-next-family', name: '虚构长家谱名称'.repeat(5) };
  let flushed = 0;
  const loads = [], invitations = [];
  page.flushGraphPreference = () => { flushed++; };
  page.loadPage = pending => { loads.push(pending); page.setData({ currentFamily: app.currentFamily }); };
  page.openShareSheet = (...args) => { invitations.push(args); };
  for (const isLandscape of [false, true]) {
    for (const isCleanScreen of [false, true]) {
      Object.assign(page.data, { familyList: [family], isLandscape, isCleanScreen, showFamilySheet: true,
        viewMode: 'perspective', viewpointId: 'fictional-person', viewpointName: '虚构家人', selectedPersonId: 'fictional-person', collapsedPersonIds: ['fictional-person'] });
      page.startShare();
      assert.deepEqual(invitations.at(-1), ['full']);
      page.switchFamily({ currentTarget: { dataset: { id: family._id } } });
      assert.equal(app.currentFamily, family);
      assert.equal(page.data.currentFamily.name, family.name);
      assert.equal(page.data.showFamilySheet, false);
      assert.equal(page.data.viewMode, 'full');
      assert.equal(page.data.viewpointId, '');
      assert.equal(page.data.viewpointName, '');
      assert.equal(page.data.selectedPersonId, '');
      assert.deepEqual(page.data.collapsedPersonIds, []);
      assert.deepEqual(loads.at(-1), { mode: 'full', personId: '' });
      assert.equal(page.data.isLandscape, isLandscape);
      assert.equal(page.data.isCleanScreen, isCleanScreen);
    }
  }
  assert.equal(flushed, 4);
});

test('首页仅在标题启用切谱，操作区与示例分享保持各自契约', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../miniprogram', file), 'utf8');
  const tree = read('pages/tree/index.wxml');
  assert.match(tree, /title-switchable="\{\{currentFamily && !loading && !loadError && !accountPending\}\}" bindtitleswitch="openFamilySheet"/);
  assert.equal((tree.match(/bindtitleswitch="openFamilySheet"/g) || []).length, 1);
  assert.doesNotMatch(tree, /class="family-switch"/);
  assert.match(tree, /class="family-option-copy"[\s\S]*class="family-option-name">\{\{item.name\}\}/);
  assert.match(tree, /bindtap="startShare"><text[^>]*>邀请家人<\/text><\/view>/);
  const navigation = read('components/page-navigation/index.wxml');
  assert.match(navigation, /wx:if="\{\{titleSwitchable\}\}"[\s\S]*bindtap="switchTitle"[\s\S]*aria-label="\{\{title \+ '，切换家谱'\}\}"/);
  assert.match(navigation, /<text wx:else class="navigation-title"/);
  for (const name of ['example', 'members']) assert.doesNotMatch(read('pages/' + name + '/index.wxml'), /title-switchable|bindtitleswitch/);
  assert.match(read('pages/members/index.wxml'), /<page-navigation\b[^>]*\bpage-gutter\b[^>]*bindlayout="onNavigationLayout"/);
  assert.match(read('pages/example/index.wxml'), /open-type="share"[^>]*><text[^>]*>邀请家人<\/text><\/button>/);
});

for (const name of ['tree', 'example']) {
  test(name + ' 图谱测量缺失时仍扣除导航，清屏与普通模式的手势坐标一致', t => {
    const previous = { wx: global.wx, getApp: global.getApp, Page: global.Page };
    let page;
    global.getApp = () => ({ globalData: {} });
    global.Page = definition => { page = Object.assign({}, definition, { data: Object.assign({}, definition.data) }); };
    global.wx = { getWindowInfo: () => ({ windowWidth: 375, windowHeight: 800 }),
      createSelectorQuery: () => ({ select() { return this; }, boundingClientRect() { return this; }, exec(callback) { callback([]); } }) };
    const file = require.resolve('../miniprogram/pages/' + name + '/index');
    delete require.cache[file];
    require(file);
    t.after(() => Object.assign(global, previous));
    page.setData = function (patch) { Object.assign(this.data, patch); };
    page.data.navigationHeight = 91;
    const toolbar = name === 'tree' ? 64 : page.data.headerHeight;
    const footer = name === 'tree' ? 0 : page.data.footerHeight;
    [false, true].forEach(clean => {
      page.data.isCleanScreen = clean;
      const reserved = clean ? 0 : toolbar;
      const viewport = page.getGraphViewport();
      assert.equal(viewport.top, 91 + reserved);
      assert.equal(viewport.height, 800 - 91 - reserved - (clean ? 0 : footer));
      page.measureGraphViewport(wx.getWindowInfo(), measured => {
        assert.equal(measured.top, viewport.top);
        assert.equal(measured.height, viewport.height);
      });
    });
  });
}

test('首页模式默认关闭，分享直达及应用内多页栈均直达家谱并阻止重复点击', t => {
  const { value, definition } = component(t);
  assert.equal(definition.properties.home.value, false);
  value._attached = true;
  const visits = [];
  global.wx = { switchTab: options => visits.push(options) };
  value.goHome();
  assert.equal(visits.length, 0);
  for (const stack of [[{}], [{}, {}, {}]]) {
    global.getCurrentPages = () => stack;
    value._homeNavigation = null;
    value.data.home = true;
    value.data.back = true;
    value.updateLayout();
    assert.ok(value.data.titleStyle.includes('left:60px'));
    const before = visits.length;
    value.goHome();
    value.goHome();
    assert.equal(visits.length, before + 1);
    assert.equal(visits.at(-1).url, '/pages/tree/index');
    assert.equal(value.data.homeNavigating, true);
  }
});

test('首页导航失败提示并恢复，隐藏与重新显示后的旧失败回调不干扰新跳转', t => {
  const { value, definition } = component(t);
  value._attached = true;
  value.data.home = true;
  const visits = [], notices = [];
  global.wx = { switchTab: options => visits.push(options), showToast: options => notices.push(options) };
  value.goHome();
  visits[0].fail();
  assert.equal(value.data.homeNavigating, false);
  assert.deepEqual(notices, [{ title: '暂时无法返回，请重试', icon: 'none' }]);
  value.goHome();
  assert.equal(visits.length, 2);
  definition.pageLifetimes.hide.call(value);
  visits[1].fail();
  value.goHome();
  assert.equal(notices.length, 1);
  assert.equal(visits.length, 2);
  definition.pageLifetimes.show.call(value);
  assert.equal(value.data.homeNavigating, false);
  value.goHome();
  visits[1].fail();
  assert.equal(visits.length, 3);
  assert.equal(value.data.homeNavigating, true);
  assert.equal(notices.length, 1);
  definition.lifetimes.detached.call(value);
  visits[2].fail();
  assert.equal(notices.length, 1);
});

test('首页导航同步异常也能恢复重试，长辈首页按钮与标题预留 60px 热区', t => {
  const { value } = component(t);
  value._attached = true;
  Object.assign(value.data, { home: true, elderMode: true, readingBodySize: 40 });
  const notices = [];
  global.wx = { switchTab: () => { throw new Error('fixture'); }, showToast: options => notices.push(options) };
  value.updateLayout();
  assert.ok(value.data.backStyle.includes('width:60px;height:60px'));
  assert.ok(value.data.titleStyle.includes('left:76px'));
  value.goHome();
  value.goHome();
  assert.equal(notices.length, 2);
  assert.equal(value.data.homeNavigating, false);
});
