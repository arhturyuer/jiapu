require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const memberActions = require('../miniprogram/utils/member-actions');
const commerceConfig = require('../miniprogram/config/commerce');
const shareCard = require('../miniprogram/utils/share-card');
const api = require('../miniprogram/utils/api');
const memberQuery = require('./helpers/member-ad-query');
const previousMemberAdDebug = commerceConfig.memberAdDebugEnabled.staging;
// 页面回归使用业务布局查询，不启用真机验收的额外边界诊断。
test.before(function () { commerceConfig.memberAdDebugEnabled.staging = false; });
test.after(function () { commerceConfig.memberAdDebugEnabled.staging = previousMemberAdDebug; });

function topAdFixture(t) {
  let family = { _id: 'free-family', status: 'active', currentRole: 'viewer', membership: { active: false } };
  const visits = [];
  const previousWx = global.wx;
  t.after(function () { global.wx = previousWx; });
  global.wx = { createSelectorQuery: memberQuery(), canIUse: function () { return true; }, navigateTo: function (options) { visits.push(options.url); } };
  const app = {
    globalData: { environment: 'staging' },
    getCurrentFamily: function () { return family; },
    setCurrentFamily: function (value) { family = value; },
    applyFamilyUpdate: function (value) { family = value; },
    invalidateFamilyData: function () {},
    isCacheFresh: function () { return true; }
  };
  const page = createPage(app).page;
  page.data.currentFamily = family;
  page.data.loading = false;
  const calls = [];
  t.mock.method(api, 'call', function (action, payload) {
    calls.push({ action: action, familyId: payload.familyId });
    return Promise.resolve({ family: family });
  });
  return { app: app, page: page, calls: calls, visits: visits };
}

test('家谱顶部邀请引导优先，不请求广告；关闭引导后加载并进入当前家庭会员', async function (t) {
  const { page, calls, visits } = topAdFixture(t);
  page.data.showShareReminder = true;
  await page.refreshTreeAd();
  assert.equal(page.data.topAdVisible, false);
  assert.equal(calls.length, 0);
  await page.dismissShareReminder();
  assert.equal(page.data.showShareReminder, false);
  assert.equal(page.data.topAdVisible, true);
  assert.equal(page.data.topAdUnitId, 'adunit-48f60f50925b53d9');
  page.openTopAdMembership();
  assert.equal(visits.length, 0);
  page.adLoad({ currentTarget: { dataset: { version: page.data.topAdVersion } } });
  page.openTopAdMembership();
  assert.deepEqual(visits, ['/pages/membership/index?familyId=free-family']);
  const closedEvent = { currentTarget: { dataset: { version: page.data.topAdVersion } } };
  page.dismissTopAd();
  assert.equal(page.data.topAdVisible, false);
  assert.equal(page.data.topAdLoaded, false);
  page.adLoad(closedEvent);
  page.openTopAdMembership();
  assert.equal(page.data.topAdLoaded, false);
  assert.equal(visits.length, 1);
  await page.refreshTreeAd();
  assert.equal(page.data.topAdVisible, true);
  page.adClose({ currentTarget: { dataset: { version: page.data.topAdVersion } } });
  assert.equal(page.data.topAdVisible, false);
});

test('顶部广告按当前家谱权益刷新，会员返回、无家谱、未知权益和请求失败隐藏', async function (t) {
  const { app, page } = topAdFixture(t);
  page._hasLoaded = true;
  await page.loadPage();
  assert.equal(page.data.topAdVisible, true);
  for (const membership of [{ active: true, lifetime: true }, { active: true, expiresAt: '2999-01-01' }, {}]) {
    app.setCurrentFamily(Object.assign({}, page.data.currentFamily, { membership: membership }));
    await page.loadPage();
    assert.equal(page.data.topAdVisible, false);
  }
  app.setCurrentFamily(Object.assign({}, page.data.currentFamily, { membership: { active: false } }));
  await page.refreshTreeAd();
  assert.equal(page.data.topAdVisible, true);
  page.adError({ currentTarget: { dataset: { version: page.data.topAdVersion } } });
  assert.equal(page.data.topAdVisible, false);
  t.mock.method(api, 'call', function () { return Promise.reject(new Error('fixture unavailable')); });
  await page.refreshTreeAd();
  assert.equal(page.data.topAdVisible, false);
  page.data.currentFamily = null;
  await page.refreshTreeAd();
  assert.equal(page.data.topAdVisible, false);
});

test('production 顶部广告邀请优先，免费展示且会员三种角色隐藏', async function (t) {
  const { app, page, calls } = topAdFixture(t);
  app.globalData.environment = 'production';
  page.data.showShareReminder = true;
  await page.refreshTreeAd();
  assert.equal(page.data.topAdVisible, false);
  assert.equal(calls.length, 0);
  page.data.showShareReminder = false;
  await page.refreshTreeAd();
  assert.equal(page.data.topAdVisible, true);
  assert.equal(page.data.topAdUnitId, 'adunit-48f60f50925b53d9');
  for (const role of ['admin', 'member', 'viewer']) {
    const family = Object.assign({}, app.getCurrentFamily(), { currentRole: role,
      membership: { active: true, lifetime: true } });
    app.setCurrentFamily(family);
    page.data.currentFamily = family;
    await page.refreshTreeAd();
    assert.equal(page.data.topAdVisible, false);
  }
});

test('顶部广告未启用环境、基础库不支持及注销冷静期不读取会员或创建广告', async function (t) {
  const unit = commerceConfig.bannerAdUnits.production.treeTop;
  t.after(function () { commerceConfig.bannerAdUnits.production.treeTop = unit; });
  commerceConfig.bannerAdUnits.production.treeTop = '';
  const { app, page, calls } = topAdFixture(t);
  for (const environment of ['production', 'unknown']) {
    app.globalData.environment = environment;
    await page.refreshTreeAd();
    assert.equal(page.data.topAdVisible, false);
  }
  app.globalData.environment = 'staging';
  global.wx.canIUse = function () { return false; };
  await page.refreshTreeAd();
  assert.equal(page.data.topAdVisible, false);
  global.wx.canIUse = function () { return true; };
  app.globalData.accountState = 'pending_delete';
  await page.refreshTreeAd();
  assert.equal(page.data.topAdVisible, false);
  assert.equal(calls.length, 0);
});

test('顶部广告迟到结果不会覆盖邀请引导、切谱或离页，旧组件事件不影响新广告', async function (t) {
  const { app, page } = topAdFixture(t);
  let resolve;
  t.mock.method(api, 'call', function () { return new Promise(function (yes) { resolve = yes; }); });
  const family = page.data.currentFamily;
  for (const invalidate of [
    function () { page.data.showShareReminder = true; },
    function () { app.setCurrentFamily(Object.assign({}, family, { _id: 'other' })); },
    function () { page.onHide(); }
  ]) {
    page.data.showShareReminder = false;
    page._adPageHidden = false;
    app.setCurrentFamily(family);
    const pending = page.refreshTreeAd();
    invalidate();
    resolve({ family: family });
    await pending;
    assert.equal(page.data.topAdVisible, false);
  }
  page._adPageHidden = false;
  const pending = page.refreshTreeAd();
  resolve({ family: family });
  await pending;
  const stale = { currentTarget: { dataset: { version: page.data.topAdVersion - 1 } } };
  page.adLoad(stale);
  page.adError(stale);
  assert.equal(page.data.topAdVisible, true);
  assert.equal(page.data.topAdLoaded, false);
});

test('顶部与人物弹框广告分别处理事件，顶部模板与邀请互斥且清屏横屏不渲染', async function (t) {
  const { page } = topAdFixture(t);
  const previousUnit = commerceConfig.bannerAdUnits.staging.memberSheet;
  commerceConfig.bannerAdUnits.staging.memberSheet = 'adunit-test-member';
  t.after(function () { commerceConfig.bannerAdUnits.staging.memberSheet = previousUnit; });
  await page.refreshTreeAd();
  const topEvent = { currentTarget: { dataset: { version: page.data.topAdVersion } } };
  await page.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
  page.closeMemberSheet();
  page.adLoad(topEvent);
  assert.equal(page.data.topAdLoaded, true);
  assert.equal(page.data.memberAdReserved, false);
  assert.equal(page.data.memberAdVisible, false, '关闭人物弹框销毁原生广告，禁止隐藏视频');
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/tree/index.wxml'), 'utf8');
  assert.match(template, /tree-share-reminder" wx:if="\{\{showShareReminder\}\}"[\s\S]*?<view class="tree-top-ad" wx:elif="\{\{topAdVisible && !isCleanScreen && !isLandscape\}\}"/);
  assert.match(template, /<ad-custom[^>]*bindload="adLoad"[^>]*binderror="adError"[^>]*bindclose="adClose"/);
  assert.match(template, /tree-top-ad-actions" wx:if="\{\{topAdLoaded\}\}"[\s\S]*tree-top-ad-close"[^>]*aria-label="关闭广告"[^>]*bindtap="dismissTopAd"[\s\S]*<icon type="cancel"[\s\S]*tree-top-ad-membership" bindtap="openTopAdMembership">开通会员，全家人免广告/);
});

function loadTreePage(app) {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return app || {}; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/tree/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  return definition;
}

function createPage(app) {
  const definition = loadTreePage(app);
  const page = Object.assign({}, definition);
  const setDataCalls = [];
  page.data = Object.assign({}, definition.data, {
    rawPersons: [
      { _id: 'parent', name: '长辈', gender: 'male' },
      { _id: 'child', name: '晚辈', gender: 'female' }
    ],
    rawRelations: [
      { _id: 'relation', type: 'parent_child', fromPersonId: 'parent', toPersonId: 'child' }
    ],
    collapsedPersonIds: [],
    selectedPersonId: '',
    graphScale: 1,
    graphScaleMin: 0.32,
    graphX: 0,
    graphY: 0,
    graphZoomClass: 'zoom-detail',
    autoCollapseEnabled: true
  });
  page.setData = function (patch, callback) {
    setDataCalls.push(patch);
    Object.assign(page.data, patch);
    if (callback) callback();
  };
  return { page: page, setDataCalls: setDataCalls };
}

function loadExamplePage(app) {
  let definition = null;
  const previousPage = global.Page;
  const previousGetApp = global.getApp;
  global.getApp = function () { return app || { getExample: function (slug) { return api.call('examples.get', { slug: slug }); } }; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/example/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.Page = previousPage;
  global.getApp = previousGetApp;
  return definition;
}

function createExamplePage(data, app) {
  const page = Object.assign({}, loadExamplePage(app));
  page.data = Object.assign({}, page.data, data);
  page.setData = function (patch, callback) {
    Object.assign(page.data, patch);
    if (callback) callback();
  };
  return page;
}

test('手势开始只记录视口，结束仅提交标量变换、不重新绘制节点', function () {
  const instance = createPage();
  instance.page.commitGraphTransform({ x: 0, y: 0, scale: 1 });
  instance.setDataCalls.length = 0;
  const version = instance.page._gestureVersion;
  instance.page.onGraphGestureState({ version: version, sequence: 1, active: true, x: 0, y: 0, scale: 1 });
  assert.equal(instance.setDataCalls.length, 0);
  instance.page.onGraphGestureState({ version: version, sequence: 2, active: false, x: -123.45, y: 67.89, scale: 0.73 });
  assert.equal(instance.setDataCalls.length, 1);
  assert.equal(instance.setDataCalls[0].nodes, undefined);
  assert.equal(instance.page._currentGraphX, -123.45);
  assert.equal(instance.page._currentGraphY, 67.89);
  assert.equal(instance.page._currentGraphScale, 0.73);
  instance.page.onUnload();
});

test('重绘图谱一次提交完整节点和关系，不先清空再分批追加', function () {
  const instance = createPage();
  instance.page.renderGraph('full', '', { preserveViewport: true });
  assert.equal(instance.setDataCalls.length, 1);
  assert.equal(instance.setDataCalls[0].nodes.length, 2);
  assert.ok(instance.setDataCalls[0].lines.length > 0);
  assert.equal(instance.setDataCalls[0].graphRendering, false);
  assert.equal(instance.setDataCalls[0].renderedCount, 2);
});

test('补录亲属返回后定位原操作人物，人物失效时恢复默认取景', function () {
  const instance = createPage(), page = instance.page;
  const previousWx = global.wx;
  const visits = [];
  global.wx = { navigateTo: function (options) { visits.push(options.url); } };
  page.data.currentFamily = { _id: 'family' };
  page.data.canEdit = true;
  page.data.selectedPerson = page.decorateSelectedPerson(page.data.rawPersons[0]);
  try {
    page.chooseRelation({ currentTarget: { dataset: { type: 'father' } } });
    assert.deepEqual(page._relationReturnFocus, { familyId: 'family', personId: 'parent' });
    assert.match(visits[0], /anchorId=parent.*relationType=father/);
    const fits = [];
    page.fitGraph = function (id, all) { fits.push([id, all]); };
    page.renderGraph('full', '', { focusPersonId: 'parent' });
    assert.deepEqual(fits.pop(), ['parent', false]);
    page.renderGraph('full', '', { focusPersonId: 'deleted' });
    assert.deepEqual(fits.pop(), ['', true]);
  } finally {
    global.wx = previousWx;
  }
});

test('成员弹框根据有效亲子关系展示后代操作与可添加方向', function () {
  const people = [
    { _id: 'father', gender: 'male' }, { _id: 'mother', gender: 'female' },
    { _id: 'unknown', gender: 'unknown' }, { _id: 'member', gender: 'female' },
    { _id: 'child', gender: 'male' }
  ];
  const relations = [
    { type: 'parent_child', fromPersonId: 'father', toPersonId: 'member', status: 'active' },
    { type: 'parent_child', fromPersonId: 'unknown', toPersonId: 'member', status: 'active' },
    { type: 'parent_child', fromPersonId: 'member', toPersonId: 'child', status: 'active' },
    { type: 'parent_child', fromPersonId: 'mother', toPersonId: 'member', status: 'deleted' }
  ];
  const state = memberActions.describe(people[3], people, relations);
  assert.equal(state.hasChildren, true);
  assert.equal(state.childCount, 1);
  assert.deepEqual(state.relationOptions.map(function (item) { return item.label; }), ['母亲', '丈夫', '儿子', '女儿', '兄弟姐妹']);
  const withoutChildren = memberActions.describe(people[4], people, relations);
  assert.equal(withoutChildren.hasChildren, false);
  assert.deepEqual(withoutChildren.relationOptions.map(function (item) { return item.label; }), ['父亲', '妻子', '儿子', '女儿', '兄弟姐妹']);
  const unknown = memberActions.describe({ _id: 'unknown-gender', gender: 'unknown' }, people, []);
  assert.equal(unknown.relationOptions.length, 6);
  assert.equal(unknown.relationOptions[2].label, '配偶');
  const unknownParent = memberActions.describe(people[3], people, [relations[1]]);
  assert.deepEqual(unknownParent.relationOptions.slice(0, 2).map(function (item) { return item.label; }), ['父亲', '母亲']);
  const bothParents = memberActions.describe(people[3], people, [relations[0], Object.assign({}, relations[3], { status: 'active' })]);
  assert.deepEqual(bothParents.relationOptions.map(function (item) { return item.key; }), ['spouse', 'son', 'daughter', 'sibling']);
});

test('真实与示例成员弹框直接展示亲属方向，资料只保留查看入口', function () {
  const tree = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/tree/index.wxml'), 'utf8');
  const example = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/example/index.wxml'), 'utf8');
  for (const template of [tree, example]) {
    assert.match(template, /bindtap="toggleSelectedBranch" wx:if="\{\{selectedPerson\.hasChildren\}\}"/);
    assert.match(template, /wx:for="\{\{selectedPerson\.relationOptions\}\}"/);
    assert.match(template, /bindtap="openMemberDetail"/);
    assert.doesNotMatch(template, /bindtap="openEditMember"/);
    assert.match(template, /<ad-custom class="member-sheet-ad /);
  }
  assert.doesNotMatch(tree, /showRelationSheet/);
  assert.match(example, /data-type="\{\{item\.key\}\}" bindtap="explainCreate"/);
});

test('真实成员方向点击进入已有添加页，已隐藏方向不可触发', function () {
  const instance = createPage(), page = instance.page;
  const previousWx = global.wx;
  const visits = [];
  global.wx = { navigateTo: function (options) { visits.push(options.url); } };
  page.data.currentFamily = { _id: 'family' };
  page.data.canEdit = true;
  page.data.selectedPerson = page.decorateSelectedPerson(page.data.rawPersons[1]);
  try {
    page.chooseRelation({ currentTarget: { dataset: { type: 'father' } } });
    assert.equal(visits.length, 0);
    page.chooseRelation({ currentTarget: { dataset: { type: 'mother' } } });
    assert.match(visits[0], /anchorId=child.*relationType=mother/);
  } finally {
    global.wx = previousWx;
  }
});

test('成员弹框广告刷新会员后才加载，真实与示例共用购买入口', async function (t) {
  const previousUnit = commerceConfig.bannerAdUnits.staging.memberSheet;
  const previousGetApp = global.getApp;
  const previousWx = global.wx;
  t.after(function () {
    commerceConfig.bannerAdUnits.staging.memberSheet = previousUnit;
    global.getApp = previousGetApp;
    global.wx = previousWx;
  });
  let family = { _id: 'family', status: 'active', membership: { active: false } };
  const app = { globalData: { environment: 'staging' }, getCurrentFamily: function () { return family; } };
  const page = createPage(app).page;
  page.data.currentFamily = family;
  const example = createExamplePage({ rawPersons: page.data.rawPersons, rawRelations: page.data.rawRelations }, app);
  global.getApp = function () { return app; };
  const visits = [];
  global.wx = { createSelectorQuery: memberQuery(), navigateTo: function (options) { visits.push(options.url); } };
  t.mock.method(api, 'call', function (action, payload) {
    assert.equal(action, 'membership.status');
    assert.equal(payload.familyId, 'family');
    return Promise.resolve({ family: family });
  });
  for (const item of [page, example]) {
    const loading = item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    assert.equal(item.data.memberAdVisible, false);
    assert.equal(item.data.memberAdReserved, false);
    await loading;
    assert.equal(item.data.memberAdVisible, true);
    assert.equal(item.data.memberAdUnitId, 'adunit-f0e7fed2bde51c0c');
    assert.equal(item.data.memberAdLoaded, false);
    item.openAdMembership();
    assert.equal(visits.length, item === page ? 1 : 3);
    await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    item.showMemberAd({ currentTarget: { dataset: { version: item.data.memberAdVersion } } });
    assert.equal(item.data.memberAdLoaded, true);
    assert.equal(item.data.memberAdReserved, true);
    item.openAdMembership();
    await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    const loadedEvent = { currentTarget: { dataset: { version: item.data.memberAdVersion } } };
    item.closeMemberAd(loadedEvent);
    assert.equal(item.data.memberAdVisible, false);
    assert.equal(item.data.memberAdReserved, true);
    item.showMemberAd(loadedEvent);
    assert.equal(item.data.memberAdLoaded, false);
    await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    item.closeMemberAd(loadedEvent);
    assert.equal(item.data.memberAdVisible, true);
    item.hideMemberAd({ currentTarget: { dataset: { version: item.data.memberAdVersion } } });
    assert.equal(item.data.memberAdVisible, false);
    family = Object.assign({}, family, { membership: { active: true, lifetime: true } });
    await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    assert.equal(item.data.memberAdVisible, false);
    assert.equal(item.data.memberAdReserved, false);
    family = Object.assign({}, family, { membership: { active: false } });
  }
  assert.deepEqual(visits, Array(4).fill('/pages/membership/index?familyId=family'));
  family = null;
  await example.openMemberActions({ currentTarget: { dataset: { id: 'child' } } });
  assert.equal(example.data.memberAdVisible, false);
  assert.equal(example.data.selectedPerson.hasChildren, false);
});

test('人物原生模板广告在未启用环境、不支持组件及注销冷静期不查询权益', async function (t) {
  const { app, page, calls } = topAdFixture(t);
  const example = createExamplePage({ rawPersons: page.data.rawPersons, rawRelations: page.data.rawRelations }, app);
  const previousGetApp = global.getApp;
  const previousProductionUnit = commerceConfig.bannerAdUnits.production.memberSheet;
  commerceConfig.bannerAdUnits.production.memberSheet = '';
  t.after(function () {
    global.getApp = previousGetApp;
    commerceConfig.bannerAdUnits.production.memberSheet = previousProductionUnit;
  });
  global.getApp = function () { return app; };
  for (const item of [page, example]) {
    for (const environment of ['production', 'unknown']) {
      app.globalData.environment = environment;
      await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
      assert.equal(item.data.memberAdVisible, false);
      assert.equal(item.data.memberAdReserved, false);
    }
    app.globalData.environment = 'staging';
    global.wx.canIUse = function () { return false; };
    await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    assert.equal(item.data.memberAdVisible, false);
    assert.equal(item.data.memberAdReserved, false);
    global.wx.canIUse = function () { return true; };
    app.globalData.accountState = 'pending_delete';
    await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    assert.equal(item.data.memberAdVisible, false);
    assert.equal(item.data.memberAdReserved, false);
    app.globalData.accountState = '';
  }
  assert.equal(calls.length, 0);
});

test('真实与示例提前预加载数据，可见时创建广告，关闭/重复打开不保留隐藏实例', async function (t) {
  const { app, page, calls } = topAdFixture(t);
  const example = createExamplePage({ loading: false, example: { slug: 'fixture' }, rawPersons: page.data.rawPersons, rawRelations: page.data.rawRelations }, app);
  const previousGetApp = global.getApp;
  t.after(function () { global.getApp = previousGetApp; });
  global.getApp = function () { return app; };
  const preloads = [];
  global.wx.preloadAd = function (units) {
    assert.equal(page.data.memberAdVisible, false);
    assert.equal(example.data.memberAdVisible, false);
    preloads.push(units);
  };
  for (const item of [page, example]) {
    const count = calls.length;
    await item.preloadMemberAd();
    assert.equal(calls.length, count + 1);
    assert.equal(item.data.showMemberSheet, false);
    assert.equal(item.data.memberAdReserved, false);
    assert.equal(item.data.memberAdVisible, false);
    assert.ok(['sizing', 'waiting-visible'].includes(item.data.memberAdPreloadState));
    assert.equal(item._memberAdCache.dataPreloadState, 'requested');
    let oldVersion = item.data.memberAdVersion;
    item.showMemberAd({ currentTarget: { dataset: { version: oldVersion } } });
    assert.equal(item.data.memberAdLoaded, false);
    for (const id of ['parent', 'child']) {
      await item.openMemberActions({ currentTarget: { dataset: { id: id } } });
      assert.equal(calls.length, count + 1, '重新打开复用会员权益');
      assert.equal(item.data.memberAdVisible, true);
      assert.equal(item.data.memberAdWidth, 320);
      const version = item.data.memberAdVersion;
      item.showMemberAd({ currentTarget: { dataset: { version: version } } });
      assert.equal(item.data.memberAdLoaded, true);
      item.closeMemberSheet();
      assert.ok(item.data.memberAdVersion > version, '关闭使旧组件事件失效');
      assert.equal(item.data.memberAdVisible, false);
      assert.equal(item.data.memberAdLoaded, false);
      assert.equal(item.data.memberAdReserved, false);
      item.showMemberAd({ currentTarget: { dataset: { version: version } } });
      item.hideMemberAd({ currentTarget: { dataset: { version: version } } });
      assert.ok(['sizing', 'waiting-visible'].includes(item.data.memberAdPreloadState));
      oldVersion = version;
    }
    await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    assert.ok(item.data.memberAdVersion > oldVersion);
    const version = item.data.memberAdVersion;
    await item.openMemberActions({ currentTarget: { dataset: { id: 'child' } } });
    assert.equal(item.data.memberAdVersion, version, '同一可见弹框内保持同宽组件');
    item.dismissMemberAd();
    assert.equal(item.data.showMemberSheet, true);
    assert.equal(item.data.memberAdReserved, false);
    assert.equal(item.data.memberAdVisible, false);
    await item.openMemberActions({ currentTarget: { dataset: { id: 'child' } } });
    assert.equal(item.data.memberAdReserved, true);
    assert.equal(item.data.memberAdVisible, true);
    assert.ok(item.data.memberAdVersion > version);
    assert.equal(calls.length, count + 1);
    item.closeMemberSheet();
  }
  assert.deepEqual(preloads, [[{ unitId: 'adunit-f0e7fed2bde51c0c', type: 'custom' }]], '两页共享 SDK 广告位注册，不重复预加载');
  const styles = fs.readFileSync(path.join(__dirname, '../miniprogram/app.wxss'), 'utf8');
  assert.match(styles, /\.member-sheet-ad-header\s*\{[^}]*min-height:64rpx/);
  assert.match(styles, /\.member-sheet-ad-slot\s*\{[^}]*min-height:200rpx/);
  assert.doesNotMatch(styles, /member-sheet-mask\.is-preloading|member-sheet-ad-placement\.is-hidden/);
});

test('快速点击立即开弹框，未知权益不显示模块；确认免费后加载前可购买', async function (t) {
  const { app, page, visits } = topAdFixture(t);
  const example = createExamplePage({ loading: false, example: { slug: 'fixture' }, rawPersons: page.data.rawPersons, rawRelations: page.data.rawRelations }, app);
  const previousGetApp = global.getApp;
  t.after(function () { global.getApp = previousGetApp; });
  global.getApp = function () { return app; };
  let resolve;
  let count = 0;
  t.mock.method(api, 'call', function () { count += 1; return new Promise(function (yes) { resolve = yes; }); });
  const family = app.getCurrentFamily();
  for (const item of [page, example]) {
    const initial = visits.length;
    const previousCount = count;
    const preparing = item.preloadMemberAd();
    const request = item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    assert.equal(item.data.showMemberSheet, true);
    assert.equal(item.data.memberAdReserved, false);
    assert.equal(item.data.memberAdVisible, false);
    item.openAdMembership();
    assert.equal(visits.length, initial);
    item.closeMemberSheet();
    resolve({ family: family });
    await Promise.all([preparing, request]);
    assert.equal(item.data.memberAdWidth, 320);
    assert.equal(item.data.memberAdMounted, false);
    await item.openMemberActions({ currentTarget: { dataset: { id: 'child' } } });
    assert.equal(item.data.memberAdReserved, true);
    assert.equal(item.data.memberAdVisible, true);
    assert.equal(count, previousCount + 1);
    app.setCurrentFamily(Object.assign({}, family, { _id: 'other' }));
    item.openAdMembership();
    assert.equal(visits.length, initial, '切谱后旧模块不能购买');
    app.setCurrentFamily(family);
    item.openAdMembership();
    assert.equal(visits.length, initial + 1);
    assert.equal(item.data.memberAdMounted, false);
    assert.equal(item.data.showMemberSheet, false);
  }
});

test('真实与示例通过折叠分支或重绘关闭人物弹框时同步销毁广告', async function (t) {
  const { app, page } = topAdFixture(t);
  const example = createExamplePage({ loading: false, example: { slug: 'fixture' }, rawPersons: page.data.rawPersons, rawRelations: page.data.rawRelations }, app);
  for (const item of [page, example]) {
    await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    const version = item.data.memberAdVersion;
    item.toggleSelectedBranch();
    assert.equal(item.data.showMemberSheet, false);
    assert.equal(item.data.memberAdVisible, false);
    assert.equal(item.data.memberAdReserved, false);
    item.showMemberAd({ currentTarget: { dataset: { version: version } } });
    assert.equal(item.data.memberAdLoaded, false);
  }
});

test('示例亲属方向只提示创建家谱', function () {
  const page = createExamplePage();
  const previousWx = global.wx;
  let prompt = null;
  global.wx = { showModal: function (options) { prompt = options; } };
  try {
    page.explainCreate();
    assert.equal(prompt.title, '在自己的家谱中继续');
    assert.equal(prompt.confirmText, '去创建');
  } finally {
    global.wx = previousWx;
  }
});

test('家谱显示设置入口替代横竖排快捷切换', function () {
  const instance = createPage();
  instance.page.data.currentFamily = { _id: 'family-1' };
  const previousWx = global.wx;
  let target = '';
  global.wx = { navigateTo: function (options) { target = options.url; } };
  try {
    instance.page.openDisplaySettings();
    assert.equal(target, '/pages/display-settings/index?familyId=family-1');
  } finally {
    global.wx = previousWx;
  }
});

test('示例家谱设置入口携带示例标识，返回后保持取景刷新显示偏好', function () {
  const page = Object.assign({}, loadExamplePage());
  page.data = Object.assign({}, page.data, {
    slug: 'legacy-example-1',
    example: { slug: 'example-1' },
    nameLayout: 'horizontal',
    showChildRankBadge: true,
    showGenderBadge: true,
    showGenderColors: true,
    autoCollapseEnabled: true,
    viewMode: 'perspective',
    viewpointId: 'person-1'
  });
  const previousWx = global.wx;
  const visits = [];
  global.wx = {
    navigateTo: function (options) { visits.push(options.url); },
    getStorageSync: function (key) {
      if (key === 'youpu_example_display_preference_example-1') {
        return { nameLayout: 'vertical', showChildRankBadge: false, showGenderBadge: false, showGenderColors: false, autoCollapseEnabled: true };
      }
      return '';
    }
  };
  try {
    let renderOptions = null;
    page.renderGraph = function (mode, viewpointId, options) { renderOptions = { mode: mode, viewpointId: viewpointId, options: options }; };
    page.openDisplaySettings();
    assert.equal(visits[0], '/pages/display-settings/index?exampleSlug=example-1');
    page.applyDisplayPreference();
    assert.deepEqual(renderOptions, {
      mode: 'perspective',
      viewpointId: 'person-1',
      options: {
        preserveViewport: true,
        nameLayout: 'vertical',
        collapsedPersonIds: [],
        statePatch: { nameLayout: 'vertical', showChildRankBadge: false, showGenderBadge: false, showGenderColors: false, autoCollapseEnabled: true, collapsedPersonIds: [] }
      }
    });
  } finally {
    global.wx = previousWx;
  }
});

test('示例返回设置页后会重排画布，即使页面状态已提前更新', function () {
  const page = createExamplePage({
    slug: 'example-1',
    example: { slug: 'example-1' },
    nameLayout: 'vertical',
    showChildRankBadge: true,
    showGenderBadge: true,
    showGenderColors: true,
    autoCollapseEnabled: true,
    viewMode: 'full',
    viewpointId: '',
    rawPersons: [
      { _id: 'parent', name: '张建国', gender: 'male' },
      { _id: 'child', name: '张小雨', gender: 'female' }
    ],
    rawRelations: [
      { _id: 'parent-child', type: 'parent_child', fromPersonId: 'parent', toPersonId: 'child' }
    ],
    collapsedPersonIds: [],
    selectedPersonId: '',
    graphScale: 1,
    graphScaleMin: 0.32,
    graphX: 0,
    graphY: 0,
    graphZoomClass: 'zoom-detail'
  });
  // Simulate a page whose data was updated while hidden but whose last canvas
  // still has the horizontal-card layout.
  page._lastLayout = { nodes: [{ _id: 'parent', style: 'width:168rpx;' }] };
  page.applyDisplayPreference({
    nameLayout: 'vertical',
    showChildRankBadge: true,
    showGenderBadge: true,
    showGenderColors: true,
    autoCollapseEnabled: true
  });
  assert.equal(page.data.nameLayout, 'vertical');
  assert.equal(page.data.nodes[0].verticalName, '张\n建\n国');
  assert.match(page.data.nodes[0].style, /width:88rpx/);
  assert.ok(page.data.lines.length > 0);
});

function largeGraph(count) {
  const persons = [];
  const relations = [];
  for (let index = 0; index < count; index += 1) {
    persons.push({ _id: 'p' + index, name: '成员' + index, gender: index % 2 ? 'male' : 'female', status: 'active' });
    if (index > 0) {
      relations.push({
        _id: 'r' + index,
        type: 'parent_child',
        fromPersonId: 'p' + Math.floor((index - 1) / 2),
        toPersonId: 'p' + index,
        status: 'active'
      });
    }
  }
  return { persons: persons, relations: relations };
}

test('真实家谱关闭智能收起后渲染 500 人，重新开启后恢复首屏收起', async function () {
  const graph = largeGraph(500);
  const family = { _id: 'family-large', name: '大型测试家谱', currentRole: 'admin', personCount: 500 };
  let preference = { autoCollapseEnabled: false };
  const app = {
    globalData: { accountState: 'active', user: {} },
    isCacheFresh: function () { return false; },
    getCurrentFamily: function () { return family; },
    loadFamilies: function () { return Promise.resolve([family]); },
    getGraph: function () {
      return Promise.resolve({
        family: family,
        currentRole: 'admin',
        persons: graph.persons,
        relations: graph.relations,
        preference: preference
      });
    },
    setCurrentFamily: function () {}
  };
  const definition = loadTreePage(app);
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function (patch, callback) { Object.assign(page.data, patch); if (callback) callback(); };
  page.syncPageChrome = function () {};
  page.fitGraph = function () {};
  const previousWx = global.wx;
  const previousCreateAndRender = shareCard.createAndRender;
  global.wx = Object.assign({}, previousWx, {
    getStorageSync: function () { return ''; },
    removeStorageSync: function () {}
  });
  shareCard.createAndRender = function () { return Promise.resolve({}); };
  try {
    await page.loadPage(null, { force: true });
    assert.equal(page.data.autoCollapseEnabled, false);
    assert.deepEqual(page.data.collapsedPersonIds, []);
    assert.equal(page.data.nodes.length, 500);

    preference = { autoCollapseEnabled: true };
    await page.loadPage(null, { force: true });
    assert.equal(page.data.autoCollapseEnabled, true);
    assert.ok(page.data.collapsedPersonIds.length > 0);
    assert.ok(page.data.nodes.length <= 36);
  } finally {
    global.wx = previousWx;
    shareCard.createAndRender = previousCreateAndRender;
  }
});

test('关闭智能收起后超大家谱只展开指定分支，不重新自动折叠', function () {
  const graph = largeGraph(100);
  const instance = createPage();
  const page = instance.page;
  page.data.rawPersons = graph.persons;
  page.data.rawRelations = graph.relations;
  page.data.collapsedPersonIds = ['p0'];
  page.data.autoCollapseEnabled = false;
  let options = null;
  page.renderGraph = function (mode, viewpointId, value) { options = value; };
  page.expandBranch({ currentTarget: { dataset: { id: 'p0' } } });
  assert.deepEqual(options.collapsedPersonIds, []);

  page.data.autoCollapseEnabled = true;
  page.expandBranch({ currentTarget: { dataset: { id: 'p0' } } });
  assert.ok(options.collapsedPersonIds.length > 0);
  assert.ok(!options.collapsedPersonIds.includes('p0'));
});

test('示例家谱关闭智能收起时全展开，重新开启时保护当前视角', function () {
  const graph = largeGraph(100);
  const page = createExamplePage({
    example: { slug: 'large-example' },
    rawPersons: graph.persons,
    rawRelations: graph.relations,
    collapsedPersonIds: ['p0'],
    autoCollapseEnabled: true,
    viewMode: 'perspective',
    viewpointId: 'p42',
    nameLayout: 'horizontal'
  });
  page.fitGraph = function () {};
  page.applyDisplayPreference({ autoCollapseEnabled: false });
  assert.equal(page.data.autoCollapseEnabled, false);
  assert.deepEqual(page.data.collapsedPersonIds, []);
  assert.equal(page.data.nodes.length, 100);

  page.applyDisplayPreference({ autoCollapseEnabled: true });
  assert.equal(page.data.autoCollapseEnabled, true);
  assert.ok(page.data.collapsedPersonIds.length > 0);
  assert.ok(page.data.nodes.some(function (person) { return person._id === 'p42'; }));
});

test('200 人示例新发布默认关闭智能收起时忽略旧版本本地开关', async function () {
  const previousWx = global.wx;
  const previousCall = api.call;
  const graph = largeGraph(200);
  const page = createExamplePage({ slug: 'example-200' });
  page.syncPageChrome = function () {};
  page.fitGraph = function () {};
  page.prepareExampleShare = function () {};
  global.wx = {
    getStorageSync: function (key) {
      return key === 'youpu_example_display_preference_example-200'
        ? { autoCollapseEnabled: true }
        : true;
    }
  };
  api.call = function (type) {
    assert.equal(type, 'examples.get');
    return Promise.resolve({ example: {
      slug: 'example-200', title: '虚构示例', publishedVersion: 2,
      defaultDisplayPreference: { autoCollapseEnabled: false },
      persons: graph.persons, relations: graph.relations
    } });
  };
  try {
    await page.loadExample();
    assert.equal(page.data.autoCollapseEnabled, false);
    assert.deepEqual(page.data.collapsedPersonIds, []);
    assert.equal(page.data.nodes.length, 200);
  } finally {
    global.wx = previousWx;
    api.call = previousCall;
  }
});

test('方向流光只使用 transform 和 opacity，不触发布局属性动画', function () {
  const pageRoot = path.join(__dirname, '../miniprogram/pages/tree');
  const wxss = fs.readFileSync(path.join(pageRoot, 'index.wxss'), 'utf8');
  const wxml = fs.readFileSync(path.join(pageRoot, 'index.wxml'), 'utf8');
  const animationStart = wxss.indexOf('.flow-runner');
  const animationEnd = wxss.indexOf('.family-junction');
  const animationStyles = wxss.slice(animationStart, animationEnd);
  assert.ok(animationStart >= 0 && animationEnd > animationStart);
  assert.match(animationStyles, /animation-duration:\s*2\.4s/);
  assert.match(animationStyles, /transform:\s*scaleX/);
  assert.match(animationStyles, /opacity:/);
  assert.doesNotMatch(animationStyles, /(?:^|[;{])\s*(?:left|top)\s*:/m);
  assert.match(wxml, /class="flow-runner flow-step-\{\{item\.flowStep\}\}"/);
  assert.match(wxml, /wx:if="\{\{item\.isAnimatedFlow\}\}"/);
});

['tree', 'example'].forEach(function (pageName) {
  function cleanScreenPage(landscape) {
    const page = pageName === 'tree' ? createPage().page : createExamplePage({});
    const nodes = [{ _id: 'test-member' }];
    page.data.nodes = nodes;
    page.data.currentFamily = { name: '测试家谱' };
    page.data.example = { title: '测试示例' };
    page.data.isLandscape = Boolean(landscape);
    page.data.pageOrientation = landscape ? 'landscape' : 'portrait';
    page._lastLayout = { nodes: nodes };
    const chrome = [];
    global.wx = {
      getWindowInfo: function () {
        return { windowWidth: landscape ? 667 : 375, windowHeight: landscape ? 375 : (pageName === 'tree' && !page.data.isCleanScreen ? 617 : 667) };
      },
      nextTick: function (callback) { callback(); },
      hideTabBar: function () { chrome.push('hide'); },
      showTabBar: function () { chrome.push('show'); },
      setNavigationBarTitle: function (options) { chrome.push(options.title); }
    };
    page.createSelectorQuery = function () {
      return {
        select: function () { return this; }, boundingClientRect: function () { return this; },
        exec: function (callback) {
          const size = landscape ? { windowWidth: 667, windowHeight: 375 } : wx.getWindowInfo();
          const top = landscape || page.data.isCleanScreen ? 0 : (pageName === 'tree' ? 56 : 177);
          callback([{ left: 0, top: top, width: size.windowWidth, height: size.windowHeight - top }]);
        }
      };
    };
    page.measureGraphViewport(wx.getWindowInfo(), function (viewport) { page._graphViewport = viewport; });
    page.commitGraphTransform({ scale: 0.6, x: -90, y: -130 });
    return { page: page, chrome: chrome, nodes: nodes };
  }
  function logicalCenter(page) {
    const viewport = page.getGraphViewport(), transform = page.getGraphTransform();
    return [(viewport.width / 2 - transform.x) / transform.scale / viewport.rpxToPx,
      (viewport.height / 2 - transform.y) / transform.scale / viewport.rpxToPx];
  }
  function assertCenter(page, expected) {
    logicalCenter(page).forEach(function (value, index) { assert.ok(Math.abs(value - expected[index]) < 1e-8); });
  }

  test(pageName + ' 清屏往返扩展画布，保留缩放、中心、人物视角和原节点', function () {
    const previousWx = global.wx;
    try {
      [false, true].forEach(function (landscape) {
        const h = cleanScreenPage(landscape), page = h.page;
        page.data.viewMode = 'perspective'; page.data.viewpointId = 'test-member';
        const before = page.getGraphViewport(), center = logicalCenter(page);
        page.toggleCleanScreen();
        assert.equal(page.data.isCleanScreen, true);
        assert.equal(page.getGraphViewport().top, 0);
        assert.equal(page.getGraphViewport().height, wx.getWindowInfo().windowHeight);
        assert.equal(page.getGraphTransform().scale, 0.6);
        assertCenter(page, center);
        assert.equal(page.data.graphGestureConfig.top, 0);
        page.toggleCleanScreen();
        assert.equal(page.data.isCleanScreen, false);
        assert.equal(page.getGraphViewport().height, before.height);
        assertCenter(page, center);
        assert.equal(page.data.graphGestureConfig.top, before.top);
        assert.equal(page.data.viewMode, 'perspective');
        assert.equal(page.data.viewpointId, 'test-member');
        assert.equal(page.data.nodes, h.nodes);
        if (pageName === 'tree') assert.equal(h.chrome[h.chrome.length - 1], landscape ? 'hide' : 'show');
      });
    } finally { global.wx = previousWx; }
  });

  test(pageName + ' 清屏先同步活动手势的最新变换，离页恢复页面控件', function () {
    const previousWx = global.wx;
    try {
      const h = cleanScreenPage(false), page = h.page, version = page._gestureVersion;
      page.onGraphGestureState({ version: version, sequence: 1, active: true, x: -90, y: -130, scale: 0.6 });
      page.toggleCleanScreen();
      assert.equal(page.data.isCleanScreen, false);
      const id = page.data.graphGestureRequest.id;
      const viewport = page.getGraphViewport();
      const center = [(viewport.width / 2 + 120) / 0.9 / viewport.rpxToPx,
        (viewport.height / 2 + 170) / 0.9 / viewport.rpxToPx];
      page.onGraphGestureState({ version: version, sequence: 2, requestId: id, active: false, x: -120, y: -170, scale: 0.9 });
      assert.equal(page.data.isCleanScreen, true);
      assertCenter(page, center);
      assert.equal(page.getGraphTransform().scale, 0.9);
      page.onHide();
      assert.equal(page.data.isCleanScreen, false);
      assert.equal(page.data.pageOrientation, 'portrait');
      assert.equal(page.data.graphGestureConfig.disabled, true);
      if (pageName === 'tree') assert.equal(h.chrome[h.chrome.length - 1], 'show');
      // Unload also restores chrome when onHide was not called first.
      page.data.isCleanScreen = true;
      page.onUnload();
      assert.equal(page.data.isCleanScreen, false);
      if (pageName === 'tree') assert.equal(h.chrome[h.chrome.length - 1], 'show');
    } finally { global.wx = previousWx; }
  });

  test(pageName + ' 横屏系统窗口信息迟到时清屏不切回竖屏', function () {
    const previousWx = global.wx;
    try {
      const page = cleanScreenPage(true).page;
      wx.getWindowInfo = function () { return { windowWidth: 375, windowHeight: 667 }; };
      const center = logicalCenter(page);
      page.toggleCleanScreen();
      assert.equal(page.data.pageOrientation, 'landscape');
      assert.equal(page.data.isLandscape, true);
      assert.equal(page.getGraphViewport().rpxToPx, 667 / 750);
      assertCenter(page, center);
      page.toggleCleanScreen();
      assert.equal(page.data.pageOrientation, 'landscape');
      assert.equal(page.data.isCleanScreen, false);
      assertCenter(page, center);
    } finally { global.wx = previousWx; }
  });

  test(pageName + ' 方向切换中和空图不进入清屏', function () {
    const previousWx = global.wx;
    try {
      const page = cleanScreenPage(false).page;
      page.data.orientationChanging = true; page.toggleCleanScreen();
      assert.equal(page.data.isCleanScreen, false);
      page.data.orientationChanging = false; page.data.nodes = []; page.toggleCleanScreen();
      assert.equal(page.data.isCleanScreen, false);
    } finally { global.wx = previousWx; }
  });
});

test('通过平台验收的真实与示例弹框关闭保留就绪实例，换人物重开不闪隐藏模块', async function (t) {
  const { app, page } = topAdFixture(t);
  const previousReuse = commerceConfig.memberAdReusePlatforms.staging.ios;
  const previousGetApp = global.getApp;
  t.after(function () {
    commerceConfig.memberAdReusePlatforms.staging.ios = previousReuse;
    global.getApp = previousGetApp;
  });
  commerceConfig.memberAdReusePlatforms.staging.ios = true;
  global.wx.getDeviceInfo = function () { return { platform: 'ios' }; };
  global.getApp = function () { return app; };
  const example = createExamplePage({ loading: false, example: { slug: 'fixture' }, rawPersons: page.data.rawPersons, rawRelations: page.data.rawRelations }, app);
  for (const item of [page, example]) {
    await item.preloadMemberAd();
    assert.equal(item.data.memberAdWidth, 320);
    await item.openMemberActions({ currentTarget: { dataset: { id: 'parent' } } });
    const version = item.data.memberAdVersion;
    item.showMemberAd({ currentTarget: { dataset: { version: version } } });
    item.closeMemberSheet();
    assert.equal(item.data.memberAdMounted, true);
    assert.equal(item.data.memberAdLoaded, true);
    assert.equal(item.data.memberAdVisible, false);
    const setData = item.setData;
    const patches = [];
    item.setData = function (patch, callback) { patches.push(patch); setData.call(this, patch, callback); };
    await item.openMemberActions({ currentTarget: { dataset: { id: 'child' } } });
    assert.equal(item.data.selectedPersonId, 'child');
    assert.equal(item.data.memberAdLoaded, true);
    assert.equal(item.data.memberAdVersion, version);
    assert.equal(item.data.memberAdReserved, true);
    assert.equal(patches.some(function (patch) { return patch.memberAdReserved === false; }), false);
    item.onHide();
    assert.equal(item.data.memberAdMounted, false, '离页始终清理实例');
  }
});
