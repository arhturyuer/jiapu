require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/api');
const shareCard = require('../miniprogram/utils/share-card');

function pageAt(name, app) {
  let definition;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  if (!app.getCurrentFamily) app.getCurrentFamily = function () { return null; };
  global.getApp = function () { return app; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/' + name + '/index');
  delete require.cache[modulePath];
  try { require(modulePath); } finally {
    global.getApp = previousGetApp;
    global.Page = previousPage;
  }
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.patches = [];
  page.setData = function (patch, callback) {
    this.patches.push(patch);
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  return page;
}

function environment(t) {
  require('../miniprogram/utils/growth').enter({ scene: 1001 });
  const previousWx = global.wx;
  const visits = [];
  global.wx = {
    getStorageSync: function () { return ''; },
    setStorageSync: function () {},
    setNavigationBarTitle: function () {},
    getWindowInfo: function () { return { windowWidth: 375, windowHeight: 667 }; },
    navigateTo: function (value) { visits.push(value); },
    redirectTo: function (value) { visits.push(value); if (value.success) value.success(); },
    navigateBack: function (value) { visits.push({ back: true }); if (value && value.success) value.success(); },
    switchTab: function (value) { visits.push(value); },
    showToast: function () {}
  };
  t.after(function () { global.wx = previousWx; });
  t.mock.method(shareCard, 'createAndRender', function (page, canvas, options) { return Promise.resolve(shareCard.create(options)); });
  t.mock.method(api, 'call', function () { return Promise.resolve({}); });
  return visits;
}

function fixture(slug, options) {
  return { example: Object.assign({
    slug: slug, title: slug, publishedVersion: 1,
    persons: [{ _id: slug + '-parent', name: '测试长辈', gender: 'male' }, { _id: slug + '-child', name: '测试晚辈', gender: 'female' }],
    relations: [{ _id: slug + '-relation', type: 'parent_child', fromPersonId: slug + '-parent', toPersonId: slug + '-child' }]
  }, options || {}) };
}

function exampleApp() {
  return {
    getExamplesList: function () { return Promise.resolve({ items: [{ slug: 'first' }, { slug: 'second' }] }); },
    getExample: function (slug) { return Promise.resolve(fixture(slug)); }
  };
}

function familyApp(family, state) {
  return {
    globalData: { accountState: state || 'active' },
    isCacheFresh: function () { return true; },
    loadFamilies: function () { return Promise.resolve(family ? [family] : []); },
    getCurrentFamily: function () { return family; },
    setCurrentFamily: function () {},
    getGraph: function () { return Promise.resolve({ family: family, persons: [], relations: [], currentRole: 'admin' }); }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (yes, no) { resolve = yes; reject = no; });
  return { promise: promise, resolve: resolve, reject: reject };
}

function settle() { return new Promise(function (resolve) { setImmediate(resolve); }); }

['example-reading', 'example-person-detail'].forEach(function (entry) {
  test(entry + ' 的人物原生链接能加载与家谱图入口相同的资料', async function (t) {
    const visits = environment(t);
    const app = exampleApp();
    const content = fixture('first').example;
    const template = require('node:fs').readFileSync(require('node:path').join(__dirname, '../miniprogram/pages/' + entry + '/index.wxml'), 'utf8');
    const target = template.match(/<navigator\b[^>]*url="(\/pages\/example-person-detail\/index[^\"]*)"/);
    assert.ok(target, '保留可收录的人物 navigator');
    const values = { slug: content.slug, 'item._id': content.persons[1]._id, 'item.person._id': content.persons[1]._id };
    // WXML 属性中的静态文本直接拼接；HTML 实体不会替换为查询分隔符。
    const url = target[1].replace(/{{([^}]+)}}/g, function (_, key) { return values[key]; });
    const options = Object.fromEntries(new URL(url, 'https://fixture.invalid').searchParams);
    assert.deepEqual(options, { slug: content.slug, id: content.persons[1]._id });
    const graph = pageAt('example', app);
    graph.data.slug = content.slug;
    graph.data.selectedPerson = content.persons[1];
    graph.openMemberDetail();
    assert.equal(url, visits[0].url);
    const detail = pageAt('example-person-detail', app);
    detail.onLoad(options);
    await detail.onShow();
    assert.equal(detail.data.loading, false);
    assert.equal(detail.data.error, '');
    assert.equal(detail.data.person._id, content.persons[1]._id);
    assert.equal(detail.data.relatives[0].person._id, content.persons[0]._id);
    assert.equal(detail.data.relatives[0].label, '父亲');
  });
});

test('示例与家庭页保留原导航文案，方向和清屏不改写标题', function (t) {
  environment(t);
  const title = '有谱家谱·微信云开发·安全可靠';
  ['example', 'members'].forEach(function (name) {
    const config = require('../miniprogram/pages/' + name + '/index.json');
    assert.equal(config.navigationBarTitleText, title);
    assert.equal(config.navigationStyle, 'custom');
    const template = require('node:fs').readFileSync(require('node:path').join(__dirname, '../miniprogram/pages/' + name + '/index.wxml'), 'utf8');
    assert.ok(template.includes('page-navigation title="' + title + '"'));
  });
  const titles = [];
  global.wx.setNavigationBarTitle = function (options) { titles.push(options.title); };
  const page = pageAt('example', {});
  global.wx.nextTick = function (callback) { callback(); };
  page.measureGraphViewport = function (_, callback) { callback({ width: 375, height: 450, rpxToPx: 0.5 }); };
  [null, { title: '第一份示例' }, { name: '第二份示例' }].forEach(function (example) {
    page.data.example = example;
    [false, true].forEach(function (landscape) {
      [false, true].forEach(function (cleanScreen) {
        page.data.isCleanScreen = cleanScreen;
        page.applyPageResize({ windowWidth: landscape ? 667 : 375, windowHeight: landscape ? 375 : 667 });
        assert.equal(titles.length, 0);
      });
    });
  });
});

test('用户家谱加载和刷新名称后同步导航标题，横竖屏与清屏保持当前名称', async function (t) {
  environment(t);
  const titles = [];
  global.wx.setNavigationBarTitle = function (options) { titles.push(options.title); };
  const family = { _id: 'family-title', name: '测试家谱' };
  const page = pageAt('tree', familyApp(family));
  await page.loadPage();
  assert.equal(page.data.currentFamily.name, '测试家谱');
  const template = require('node:fs').readFileSync(require('node:path').join(__dirname, '../miniprogram/pages/tree/index.wxml'), 'utf8');
  assert.ok(template.includes("page-navigation title=\"{{currentFamily.name || '有谱'}}\""));
  family.name = '已更新家谱名';
  await page.loadPage(null, { force: true });
  [false, true].forEach(function (landscape) {
    [false, true].forEach(function (cleanScreen) {
      page.data.isCleanScreen = cleanScreen;
      page.syncPageChrome(landscape);
      assert.equal(page.data.currentFamily.name, '已更新家谱名');
      assert.equal(titles.length, 0);
    });
  });
  page.data.currentFamily = null;
  page.syncPageChrome(false);
  assert.equal(page.data.currentFamily, null);
  assert.equal(titles.length, 0);
});

test('窄屏和宽屏首次显示均保留清晰姓名、头像及辅助资料', function (t) {
  environment(t);
  ['tree', 'example'].forEach(function (name) {
    [320, 430, 844].forEach(function (width) {
      const page = pageAt(name, {});
      page.getWindowSize = function () { return { windowWidth: width, windowHeight: 1000 }; };
      page._lastLayout = { width: 12000, height: 8000, nodes: [{ _id: 'root', x: 80, y: 80 }] };
      page.fitGraph('', true, { initialView: true });
      assert.ok(Math.abs(page.data.graphScale * width / 750 * 28 - 16) < 1e-9);
      assert.equal(page.data.graphZoomClass, 'zoom-detail');
    });
  });
});

test('横屏后的缩放和整体适配使用已测量画布，不受旧竖屏窗口信息影响', function (t) {
  environment(t);
  ['tree', 'example'].forEach(function (name) {
    const page = pageAt(name, {});
    const landscape = { width: 809, height: 338, rpxToPx: 809 / 750, windowWidth: 809 };
    page._graphViewport = landscape;
    page._lastLayout = { width: 1500, height: 1200, nodes: [{ _id: 'root', x: 80, y: 80 }] };
    page.data.graphScaleMin = 0.16 * 750 / 809;
    assert.equal(page.getGraphViewport(), landscape);
    page.fitGraph('', true, { initialView: true });
    assert.ok(Math.abs(page.data.graphScale * landscape.rpxToPx * 28 - 16) < 1e-9);
    page.fitWholeGraph();
    assert.ok(Math.abs(page.data.graphY + page._lastLayout.height * landscape.rpxToPx * page.data.graphScale / 2 - landscape.height / 2) < 1e-9);
    const center = (landscape.width / 2 - page.data.graphX) / page.data.graphScale;
    page.zoomGraphIn();
    assert.ok(Math.abs((landscape.width / 2 - page.data.graphX) / page.data.graphScale - center) < 1e-9);
  });
});

test('真实与示例家谱首次加载采用相同可读大小，整体适配仍可主动使用', async function (t) {
  environment(t);
  t.mock.method(api, 'getMediaUrls', function () { return Promise.resolve({}); });
  const content = fixture('large').example;
  for (let i = 0; i < 70; i += 1) content.persons.push({ _id: 'extra-' + i, name: '测试成员' + i, gender: 'male' });
  const app = familyApp({ _id: 'family', name: '测试家谱' });
  app.getGraph = function () { return Promise.resolve({ family: app.getCurrentFamily(), persons: content.persons, relations: content.relations, preference: { autoCollapseEnabled: false } }); };
  const real = pageAt('tree', app);
  await real.loadPage();
  const samples = exampleApp();
  samples.getExample = function () { return Promise.resolve({ example: content }); };
  const example = pageAt('example', samples);
  await example.onLoad({ slug: 'large' });
  [real, example].forEach(function (page) {
    assert.ok(Math.abs(page.data.graphScale * 0.5 * 28 - 16) < 1e-9);
    assert.equal(page.data.graphZoomClass, 'zoom-detail');
    const initial = page.data.graphScale;
    page.fitWholeGraph();
    assert.ok(page.data.graphScale < initial);
    page.showFullGraph();
    assert.ok(Math.abs(page.data.graphScale - initial) < 1e-9);
  });
  await example.switchExample('other');
  assert.ok(Math.abs(example.data.graphScale * 0.5 * 28 - 16) < 1e-9);
});

test('同一家谱后台刷新保留手动取景，指定分享视角重新以可读大小进入', async function (t) {
  environment(t);
  t.mock.method(api, 'getMediaUrls', function () { return Promise.resolve({}); });
  const content = fixture('real').example;
  const app = familyApp({ _id: 'family', name: '测试家谱' });
  app.getGraph = function () { return Promise.resolve({ family: app.getCurrentFamily(), persons: content.persons, relations: content.relations }); };
  const page = pageAt('tree', app);
  await page.loadPage();
  const manual = { scale: 0.73, x: -123, y: -45 };
  page.commitGraphTransform(manual);
  await page.loadPage(null, { force: true });
  assert.deepEqual(page.getGraphTransform(), manual);
  await page.loadPage({ mode: 'perspective', personId: 'real-child' });
  assert.equal(page.data.viewpointId, 'real-child');
  assert.ok(Math.abs(page.data.graphScale * 0.5 * 28 - 16) < 1e-9);
  const node = page.data.nodes.find(function (item) { return item._id === 'real-child'; });
  const pixels = page.data.graphScale * 0.5;
  assert.ok(Math.abs(page.data.graphX + (node.x + page._lastLayout.nodeWidth / 2) * pixels - page.getGraphViewport().width / 2) < 1e-9);
});

test('无家谱用户保持加载并替换为默认示例入口，已有空列表缓存也不跳过', async function (t) {
  const visits = environment(t);
  const page = pageAt('tree', familyApp(null));
  page._hasLoaded = true;
  page.data.loading = false;
  await page.loadPage();
  assert.equal(visits[0].url, '/pages/example/index?entry=default');
  assert.equal(page.data.loading, true);
  assert.ok(page.patches.every(function (patch) { return patch.loading !== false; }));
});

test('已有家谱正常加载，注销冷静期展示账户状态而不跳转', async function (t) {
  const visits = environment(t);
  t.mock.method(api, 'getMediaUrls', function () { return Promise.resolve({}); });
  const page = pageAt('tree', familyApp({ _id: 'family', name: '测试家谱' }));
  await page.loadPage();
  assert.equal(page.data.currentFamily._id, 'family');
  assert.equal(page.data.loading, false);
  const pending = pageAt('tree', familyApp(null, 'pending_delete'));
  await pending.loadPage();
  assert.equal(pending.data.accountPending, true);
  assert.equal(visits.length, 0);
});

test('首页导航失败可重试，离开首页后的迟到家庭响应不触发跳转', async function (t) {
  const visits = environment(t);
  t.mock.method(global.wx, 'redirectTo', function (value) { value.fail(); });
  const page = pageAt('tree', familyApp(null));
  await page.loadPage();
  assert.equal(page.data.loading, false);
  assert.match(page.data.loadError, /请重试/);
  const read = deferred();
  const app = familyApp(null);
  app.loadFamilies = function () { return read.promise; };
  const hidden = pageAt('tree', app);
  const loading = hidden.loadPage();
  hidden.onHide();
  read.resolve([]);
  await loading;
  assert.equal(visits.length, 0);
});

test('默认入口取服务端列表第一项并直接绘图，无首次遮罩', async function (t) {
  environment(t);
  const app = exampleApp();
  const calls = [];
  app.getExamplesList = function (tag) { calls.push(tag); return Promise.resolve({ items: [{ slug: 'second' }, { slug: 'first' }] }); };
  const page = pageAt('example', app);
  await page.onLoad({ entry: 'default' });
  assert.deepEqual(calls, ['']);
  assert.equal(page.data.example.slug, 'second');
  assert.equal(page.data.nodes.length, 2);
  assert.equal(page.data.showTour, undefined);
  assert.equal(page.data.viewMode, 'full');
  assert.match(page.data.shareCard.path, /slug=second/);
  assert.equal(page.data.isDefaultEntry, true);
});

test('默认首屏先记录曝光，加载中可创建，失败可重试且不登录或请求广告', async function (t) {
  const visits = environment(t); const calls = []; const pending = deferred();
  const adAccess = require('../miniprogram/utils/ad-access');
  t.mock.method(adAccess, 'preloadMember', () => { throw new Error('默认入口不能预加载广告'); });
  t.mock.method(adAccess, 'openMember', () => { throw new Error('默认入口不能打开广告'); });
  t.mock.method(adAccess, 'reserveMemberSpace', () => { throw new Error('默认入口不能预留广告'); });
  t.mock.method(api, 'call', async (type, payload) => { calls.push({ type, payload }); return {}; });
  const app = exampleApp(); app.getExamplesList = () => pending.promise;
  app.ensureLogin = () => { throw new Error('公开示例不能登录'); };
  const page = pageAt('example', app); const loading = page.onLoad({ entry: 'default' });
  await settle();
  assert.equal(page.data.loading, true);
  assert.equal(calls[0].payload.event, 'landing'); assert.equal(calls[0].payload.entryType, 'default_example');
  await page.createFamily();
  assert.match(visits[0].url, /^\/pages\/create-family\/index\?/);
  assert.ok(calls.some(call => call.payload.event === 'create_click' && call.payload.slug === ''));
  pending.resolve({ items: [] }); await loading; await settle();
  assert.match(page.data.error, /目前没有/);
  assert.ok(calls.some(call => call.payload.event === 'load_error'));
  assert.ok(!calls.some(call => call.payload.event === 'example'));
  app.getExamplesList = () => Promise.resolve({ items: [{ slug: 'recovered' }] });
  await page.retryExample(); await settle();
  assert.equal(page.data.slug, 'recovered'); assert.equal(page.data.nodes.length, 2);
  page.showPerson({ currentTarget: { dataset: { id: 'recovered-parent' } } });
  assert.equal(page.data.showMemberSheet, false, '普通模式第一次点击仅选中');
  assert.equal(page.data.selectedPersonId, 'recovered-parent');
  page.showPerson({ currentTarget: { dataset: { id: 'recovered-parent' } } });
  assert.equal(page.data.showMemberSheet, true); assert.equal(page.data.memberAdReserved, false);
  await page.preloadMemberAd();
  assert.ok(calls.some(call => call.payload.event === 'example' && call.payload.entryType === 'default_example'));
});

test('默认与明确入口共用原人物交互，长辈保留单次点击和统一菜单，切谱保留免广告标识', async function (t) {
  environment(t); const page = pageAt('example', exampleApp());
  await page.onLoad({ entry: 'default' });
  page.data.elderMode = true;
  page.showPerson({ currentTarget: { dataset: { id: 'first-child' } } });
  assert.equal(page.data.showMemberSheet, true, '长辈仍单次打开人物卡');
  page.closeMemberSheet();
  page.openPerspectiveSheet(); assert.equal(page.data.showPerspectiveSheet, true);
  page.openExportSheet();
  assert.equal(page.data.showPerspectiveSheet, false); assert.equal(page.data.showExportSheet, true);
  await page.switchExample('second');
  assert.equal(page.data.isDefaultEntry, true); assert.equal(page.data.slug, 'second');
  const shared = pageAt('example', exampleApp()); await shared.onLoad({ entry: 'default', slug: 'shared' });
  assert.equal(shared.data.isDefaultEntry, false);
  shared.showPerson({ currentTarget: { dataset: { id: 'shared-child' } } });
  assert.equal(shared.data.showMemberSheet, false);
  assert.equal(shared.data.selectedPersonId, 'shared-child');
  shared.showPerson({ currentTarget: { dataset: { id: 'shared-child' } } });
  assert.equal(shared.data.showMemberSheet, true);
});

test('显式分享覆盖默认入口，图片 scene 保留人物视角且打开仅记一次', async function (t) {
  environment(t);
  const app = exampleApp();
  app.getExamplesList = function () { return Promise.resolve({ items: [{ slug: 'first' }] }); };
  const page = pageAt('example', app);
  await page.onLoad({ entry: 'default', slug: 'shared', source: 'example_share' });
  assert.equal(page.data.slug, 'shared');
  const calls = [];
  t.mock.method(api, 'call', function (type, payload) {
    calls.push({ type: type, payload: payload });
    return Promise.resolve(type === 'public.examples.resolvePoster' ? { slug: 'poster', viewPersonId: 'poster-child' } : {});
  });
  const poster = pageAt('example', app);
  await poster.onLoad({ entry: 'default', slug: 'ignored', scene: 'encoded%20scene' });
  assert.equal(poster.data.example.slug, 'poster');
  assert.equal(poster.data.viewMode, 'perspective');
  assert.equal(poster.data.viewpointId, 'poster-child');
  assert.ok(Math.abs(poster.data.graphScale * 0.5 * 28 - 16) < 1e-9);
  await poster.loadExample();
  assert.equal(calls.filter(function (item) { return item.type === 'share.record' && item.payload.stage === 'opened'; }).length, 0);
  assert.equal(calls.filter(item => item.type === 'public.share.record' && item.payload.stage === 'opened').length, 1);
  assert.ok(calls.some(item => item.type === 'growth.record' && item.payload.event === 'example'));
  assert.equal(calls[0].payload.scene, 'encoded scene');
});

test('选择模式返回原示例并重置视角弹层，取消保留原图且分享来源不丢失', async function (t) {
  const visits = environment(t);
  const page = pageAt('example', exampleApp());
  await page.onLoad({ slug: 'first', source: 'share_menu' });
  page.setPerspective('first-child');
  page.data.showMemberSheet = true;
  page.syncPageOrientationSoon = function () {};
  page.openExamples();
  const navigation = visits[0];
  assert.equal(navigation.url, '/pages/examples/index?select=1&source=share_menu');
  page.onHide();
  page.onShow();
  assert.equal(page.data.slug, 'first');
  assert.equal(page.data.viewpointId, 'first-child');
  page.onHide();
  const list = pageAt('examples', {});
  list.loadExamples = function () {};
  list.onLoad({ select: '1', source: 'share_menu' });
  list.getOpenerEventChannel = function () { return { emit: function (name, data) { navigation.events[name](data); } }; };
  list.openExample({ currentTarget: { dataset: { slug: 'second' } } });
  assert.deepEqual(visits[1], { back: true });
  page.onShow();
  await settle();
  assert.equal(page.data.slug, 'second');
  assert.equal(page.data.viewMode, 'full');
  assert.equal(page.data.selectedPerson, null);
  assert.equal(page.data.showMemberSheet, false);
  assert.match(page.data.shareCard.path, /slug=second/);
  await page.createFamily();
  assert.equal(visits[2].url, '/pages/create-family/index?source=share_menu&opened=1&example=second');
  const normalList = pageAt('examples', {});
  normalList.openExample({ currentTarget: { dataset: { slug: 'third' } } });
  assert.equal(visits[3].url, '/pages/example/index?slug=third');
});

test('空列表与失败可重试，失效的分享示例不改为第一份，创建入口可用', async function (t) {
  const visits = environment(t);
  const app = exampleApp();
  let attempt = 0;
  app.getExamplesList = function () { attempt += 1; return Promise.resolve({ items: attempt === 1 ? [] : [{ slug: 'first' }] }); };
  const page = pageAt('example', app);
  await page.onLoad({ entry: 'default' });
  assert.match(page.data.error, /没有可体验/);
  await page.createFamily();
  assert.match(visits[0].url, /^\/pages\/create-family\/index/);
  await page.loadExample();
  assert.equal(page.data.slug, 'first');
  assert.equal(page.data.error, '');
  app.getExamplesList = function () { throw new Error('不应默认回退'); };
  app.getExample = function () { return Promise.reject({ code: 'EXAMPLE_NOT_FOUND' }); };
  const shared = pageAt('example', app);
  await shared.onLoad({ slug: 'removed' });
  assert.equal(shared.data.loading, false);
  assert.equal(shared.data.slug, 'removed');
  assert.match(shared.data.error, /暂时不可用/);
  shared.openExamples();
  assert.equal(visits[1].url, '/pages/examples/index?select=1');
  app.getExample = function (slug) { return Promise.resolve(fixture(slug)); };
  await shared.loadExample();
  assert.equal(shared.data.error, '');
});

test('快速切换时旧响应及旧分享卡不覆盖当前示例，离开页面不更新图谱', async function (t) {
  environment(t);
  const old = deferred();
  const app = exampleApp();
  app.getExample = function (slug) { return slug === 'old' ? old.promise : Promise.resolve(fixture(slug)); };
  const page = pageAt('example', app);
  const loadingOld = page.onLoad({ slug: 'old' });
  await settle();
  page.data.slug = 'new';
  await page.loadExample();
  old.resolve(fixture('old'));
  await loadingOld;
  assert.equal(page.data.example.slug, 'new');
  const card = deferred();
  t.mock.method(shareCard, 'createAndRender', function () { return card.promise; });
  const renderingCard = page.prepareExampleShare();
  page.data.slug = 'newest';
  page._loadRequestId += 1;
  card.resolve({ path: 'old-card' });
  await renderingCard;
  assert.match(page.data.shareCard.path, /slug=new/);
  const late = deferred();
  app.getExample = function () { return late.promise; };
  const loadingLate = page.loadExample();
  await settle();
  page.onUnload();
  const count = page.patches.length;
  late.resolve(fixture('late'));
  await loadingLate;
  assert.equal(page.patches.length, count);
});

test('选择示例采用该示例发布默认值，隐藏期间的读取会在返回后重试', async function (t) {
  environment(t);
  const read = deferred();
  const app = exampleApp();
  let count = 0;
  app.getExample = function () {
    count += 1;
    return count === 1 ? read.promise : Promise.resolve(fixture('first', { defaultDisplayPreference: { nameLayout: 'vertical', autoCollapseEnabled: false } }));
  };
  const page = pageAt('example', app);
  page.syncPageOrientationSoon = function () {};
  const initial = page.onLoad({ slug: 'first' });
  await settle();
  page.onHide();
  read.resolve(fixture('old'));
  await initial;
  assert.equal(page.data.example, null);
  page.onShow();
  await settle();
  assert.equal(page.data.example.slug, 'first');
  assert.equal(page.data.nameLayout, 'vertical');
  assert.equal(page.data.autoCollapseEnabled, false);
});

test('从示例创建沿用现有表单，成功后进入真实家谱而非再次跳示例', async function (t) {
  const visits = environment(t);
  const app = familyApp(null);
  let family = null;
  app.setCurrentFamily = function (value) { family = value; };
  app.getCurrentFamily = function () { return family; };
  app.loadFamilies = function () { return Promise.resolve(family ? [family] : []); };
  app.getGraph = function () { return Promise.resolve({ family: family, persons: [], relations: [], currentRole: 'admin' }); };
  app.invalidateCache = function () {};
  t.mock.method(api, 'getMediaUrls', function () { return Promise.resolve({}); });
  t.mock.method(api, 'call', function (type, input) {
    assert.equal(type, 'family.create');
    assert.equal(input.startPerson.name, '虚构测试成员');
    assert.equal(input.example, undefined);
    return Promise.resolve({ family: { _id: 'created', name: input.name } });
  });
  t.mock.method(global, 'setTimeout', function (callback) { callback(); return 0; });
  const create = pageAt('create-family', app);
  create.onLoad({ source: 'example', example: 'first' });
  Object.assign(create.data, { familyName: '虚构测试家谱', startName: '虚构测试成员', startGender: 'male' });
  create.createFamily();
  await settle();
  assert.equal(visits[0].url, '/pages/tree/index');
  const tree = pageAt('tree', app);
  await tree.loadPage();
  assert.equal(tree.data.currentFamily._id, 'created');
  assert.equal(visits.length, 1);
});

test('分享人物视角在视口测量期间离开页面后仍可恢复，损坏 scene 不回退默认示例', async function (t) {
  environment(t);
  const app = exampleApp();
  const page = pageAt('example', app);
  let completeMeasure;
  page.createSelectorQuery = function () {};
  page.measureGraphViewport = function (size, callback) { completeMeasure = callback; };
  page.syncPageOrientationSoon = function () {};
  await page.onLoad({ slug: 'first', personId: 'first-child' });
  assert.equal(page._renderPending, true);
  page.onHide();
  completeMeasure({ width: 375, height: 450, rpxToPx: 0.5, windowWidth: 375 });
  assert.equal(page.data.nodes.length, 0);
  page.onShow();
  await settle();
  completeMeasure({ width: 375, height: 450, rpxToPx: 0.5, windowWidth: 375 });
  assert.equal(page.data.viewpointId, 'first-child');
  assert.equal(page.data.viewMode, 'perspective');
  assert.equal(page._renderPending, false);
  app.getExamplesList = function () { throw new Error('损坏的 scene 不应回退默认入口'); };
  const malformed = pageAt('example', app);
  await malformed.onLoad({ entry: 'default', scene: '%' });
  assert.equal(malformed.data.example, null);
  assert.equal(malformed.data.error, '缺少示例家谱信息');
});

test('名称标签保持后台顺序和当前选中项，同页切换立即重置并采用新偏好', async function (t) {
  const visits = environment(t);
  const app = exampleApp();
  let reads = 0;
  app.getExamplesList = function () { return Promise.resolve({ items: [{ slug: 'first', title: '第一家谱' }, { slug: 'second', title: '第二家谱' }] }); };
  app.getExample = function (slug) { reads += 1; return Promise.resolve(fixture(slug, { defaultDisplayPreference: { nameLayout: slug === 'second' ? 'vertical' : 'horizontal' } })); };
  const page = pageAt('example', app);
  await page.onLoad({ slug: 'second', personId: 'second-child' });
  assert.deepEqual(page.data.exampleTabs.map(function (item) { return item.title; }), ['第一家谱', '第二家谱']);
  assert.equal(page.data.selectedExampleTabId, 'example-tab-1');
  assert.equal(page.data.viewpointId, 'second-child');
  await page.selectExampleTab({ currentTarget: { dataset: { slug: 'second' } } });
  assert.equal(reads, 1);
  const perspectiveShare = page.onShareAppMessage();
  assert.equal(perspectiveShare.path, '/pages/example/index?slug=second&source=example_share&personId=second-child');
  assert.equal(perspectiveShare.title, page.data.shareCard.title);
  assert.ok(perspectiveShare.imageUrl);
  assert.equal(page.data.showShareSheet, undefined);
  const loading = page.selectExampleTab({ currentTarget: { dataset: { slug: 'first' } } });
  assert.equal(page.data.showShareSheet, undefined);
  assert.equal(page.data.viewpointId, '');
  assert.equal(page.data.selectedExampleTabId, 'example-tab-0');
  await loading;
  assert.equal(page.data.example.slug, 'first');
  assert.equal(page.data.nameLayout, 'horizontal');
  assert.equal(page.onShareAppMessage().path, '/pages/example/index?slug=first&source=example_share');
  assert.equal(visits.length, 0);
});

test('分享详情不等待标签列表，列表失败可重试且不会覆盖当前示例', async function (t) {
  environment(t);
  const list = deferred();
  const app = exampleApp();
  app.getExamplesList = function () { return list.promise; };
  const page = pageAt('example', app);
  await page.onLoad({ slug: 'shared', personId: 'shared-child' });
  assert.equal(page.data.example.slug, 'shared');
  assert.equal(page.data.exampleTabs[0].slug, 'shared');
  list.reject(new Error('offline'));
  await settle();
  assert.match(page.data.tabsError, /重试/);
  app.getExamplesList = function () { return Promise.resolve({ items: [{ slug: 'first', title: '第一家谱' }, { slug: 'shared', title: '分享家谱' }] }); };
  await page.retryExampleTabs();
  assert.equal(page.data.tabsError, '');
  assert.equal(page.data.selectedExampleTabId, 'example-tab-1');
  assert.equal(page.data.viewpointId, 'shared-child');
  assert.equal(page.data.slug, 'shared');
});

test('标签列表迟到响应不能覆盖刷新或卸载后的状态，快速点击只显示最后选择', async function (t) {
  environment(t);
  const initial = deferred();
  const oldGraph = deferred();
  const app = exampleApp();
  app.getExamplesList = function () { return initial.promise; };
  app.getExample = function (slug) { return slug === 'old' ? oldGraph.promise : Promise.resolve(fixture(slug)); };
  const page = pageAt('example', app);
  await page.onLoad({ slug: 'first' });
  app.getExamplesList = function () { return Promise.resolve({ items: [{ slug: 'first' }, { slug: 'last' }] }); };
  await page.retryExampleTabs();
  const old = page.switchExample('old');
  await settle();
  await page.switchExample('last');
  initial.resolve({ items: [{ slug: 'obsolete' }] });
  oldGraph.resolve(fixture('old'));
  await old;
  await settle();
  assert.deepEqual(page.data.exampleTabs.map(function (item) { return item.slug; }), ['first', 'last']);
  assert.equal(page.data.example.slug, 'last');
  assert.equal(page.data.selectedExampleTabId, 'example-tab-1');
  const late = deferred();
  app.getExamplesList = function () { return late.promise; };
  const reading = page.retryExampleTabs();
  await settle();
  page.onUnload();
  const count = page.patches.length;
  late.resolve({ items: [{ slug: 'gone' }] });
  await reading;
  assert.equal(page.patches.length, count);
});

test('加载期间从列表选择当前示例会恢复读取，取消和重复选择不会丢失已加载视角', async function (t) {
  environment(t);
  const old = deferred();
  const app = exampleApp();
  let reads = 0;
  app.getExample = function (slug) { reads += 1; return reads === 1 ? old.promise : Promise.resolve(fixture(slug)); };
  const page = pageAt('example', app);
  page.syncPageOrientationSoon = function () {};
  const initial = page.onLoad({ slug: 'first', personId: 'first-child' });
  await settle();
  page.onHide();
  page._pendingExampleSlug = 'first';
  page.onShow();
  await settle();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.example.slug, 'first');
  assert.equal(page.data.viewMode, 'full');
  old.resolve(fixture('first'));
  await initial;
  page.setPerspective('first-child');
  page.onHide();
  page._pendingExampleSlug = 'first';
  page.onShow();
  assert.equal(page.data.viewpointId, 'first-child');
  assert.equal(reads, 2);
});

test('示例查看方式取消和重复选择保留取景，全图不改变人物视角', async t => {
  environment(t);
  const page = pageAt('example', exampleApp());
  await page.onLoad({ entry: 'default' });
  page.setPerspective('first-child');
  page.commitGraphTransform({ scale: 1.5, x: -80, y: -90 });
  const original = page.getGraphTransform();
  page.openPerspectiveSheet(); page.closePerspectiveSheet();
  page.openPerspectiveSheet(); page.selectPerspective({ currentTarget: { dataset: { id: 'first-child' } } });
  assert.deepEqual(page.getGraphTransform(), original);
  assert.equal(page.data.viewpointId, 'first-child');
  page.fitWholeGraph();
  assert.equal(page.data.viewMode, 'perspective');
  assert.equal(page.data.viewpointId, 'first-child');
  page.openPerspectiveSheet(); page.selectFullView();
  assert.equal(page.data.viewMode, 'full');
  const full = page.getGraphTransform();
  page.openPerspectiveSheet(); page.selectFullView();
  assert.deepEqual(page.getGraphTransform(), full);
});

test('示例搜索关闭、切换和离页后不更新旧结果，旧选择不作用于新示例', async t => {
  environment(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = pageAt('example', exampleApp());
  await page.onLoad({ slug: 'first' });
  page.openPerspectiveSheet(); page.filterPerspectives({ detail: { value: '不存在' } });
  page.closePerspectiveSheet(); t.mock.timers.tick(120);
  assert.equal(page.data.perspectiveResults.length, 2);
  page.openPerspectiveSheet(); page.filterPerspectives({ detail: { value: '不存在' } });
  await page.switchExample('second'); t.mock.timers.tick(120);
  assert.equal(page.data.perspectiveResults[0]._id, 'second-parent');
  page.selectPerspective({ currentTarget: { dataset: { id: 'first-parent' } } });
  assert.equal(page.data.viewMode, 'full');
  page.openPerspectiveSheet(); page.filterPerspectives({ detail: { value: '不存在' } });
  page.onHide(); t.mock.timers.tick(120);
  assert.equal(page._perspectiveFilterTimer, null);
  assert.equal(page.data.showPerspectiveSheet, false);
  page.openPerspectiveSheet(); assert.equal(page.data.showPerspectiveSheet, false);
});

test('示例导出支持图片和两种 PDF，生成防重及旧菜单隔离保持有效', async t => {
  const visits = environment(t);
  const page = pageAt('example', exampleApp());
  await page.onLoad({ slug: 'first' });
  let images = 0; page.generatePoster = () => { images++; };
  page.openPerspectiveSheet(); page.openExportSheet();
  assert.equal(page.data.showPerspectiveSheet, false);
  page.data.posterGenerating = true;
  page.chooseExport({ currentTarget: { dataset: { format: 'image' } } });
  assert.equal(images, 0); assert.equal(page.data.showExportSheet, true);
  page.chooseExport({ currentTarget: { dataset: { format: 'book' } } });
  assert.match(visits.at(-1).url, /source=example&slug=first.*&format=book$/);
  page.openExportSheet(); page.chooseExport({ currentTarget: { dataset: { format: 'poster' } } });
  assert.match(visits.at(-1).url, /source=example&slug=first.*&format=poster$/);
  page.data.posterGenerating = false;
  page.openExportSheet(); page.chooseExport({ currentTarget: { dataset: { format: 'image' } } });
  assert.equal(images, 1); assert.equal(page.data.showExportSheet, false);
  page.openExportSheet(); await page.switchExample('second');
  const count = visits.length;
  page.chooseExport({ currentTarget: { dataset: { format: 'book' } } });
  assert.equal(visits.length, count);
  page.openExportSheet(); page.onHide();
  assert.equal(page.data.showExportSheet, false);
});

test('加载失败期间浏览菜单和示例转发不可用，创建与切换入口仍可操作', async t => {
  const visits = environment(t), app = exampleApp();
  app.getExample = () => Promise.reject({ code: 'EXAMPLE_NOT_FOUND' });
  const page = pageAt('example', app);
  await page.onLoad({ slug: 'missing' });
  page.openPerspectiveSheet(); page.openExportSheet();
  assert.equal(page.data.showPerspectiveSheet, false); assert.equal(page.data.showExportSheet, false);
  assert.equal(page.onShareAppMessage().path, '/pages/share-intro/index?source=share_menu');
  await page.createFamily(); page.openExamples();
  assert.match(visits[0].url, /^\/pages\/create-family\/index/);
  assert.match(visits[1].url, /^\/pages\/examples\/index\?select=1/);
});

test('实际画布测量扣除底栏，工具避让并忽略切谱、字号和离页后的迟到结果', async t => {
  environment(t);
  const page = pageAt('example', exampleApp()); await page.onLoad({ slug: 'first' });
  let complete;
  page.createSelectorQuery = () => ({ select() { return this; }, selectAll() { return this; }, boundingClientRect() { return this; }, exec(fn) { complete = fn; } });
  const measured = [{ left: 0, top: 220, width: 375, height: 170 }, { width: 50 }, { height: 156 }, { height: 136 }, [{ width: 30, height: 24 }]];
  let viewport;
  page.measureGraphViewport(page.getWindowSize(), value => { viewport = value; }); complete(measured);
  assert.equal(viewport.height, 170); assert.equal(page.data.headerHeight, 156); assert.equal(page.data.footerHeight, 136);
  assert.match(page.data.graphToolsStyle, /--graph-tools-columns:2/);
  for (const mutate of [() => { page.data.slug = 'other'; }, () => { page.data.readingBodySize = 32; }, () => { page._hidden = true; }]) {
    page.data.slug = 'first'; page.data.readingBodySize = 16; page._hidden = false;
    page.measureGraphViewport(page.getWindowSize(), () => assert.fail('旧测量不得回写'));
    mutate(); complete(measured);
  }
});

test('横屏底栏仍预留高度，清屏恢复完整画布且极小窗口不扩大兜底高度', async t => {
  environment(t); const page = pageAt('example', exampleApp()); await page.onLoad({ slug: 'first' });
  const portrait = { windowWidth: 320, windowHeight: 568, screenHeight: 568, safeArea: { bottom: 548 } };
  page.data.navigationHeight = 64; page.data.headerHeight = 150; page.data.footerHeight = 120;
  let viewport = page.fallbackGraphViewport(portrait);
  assert.equal(viewport.top, 214); assert.equal(viewport.height, 214);
  const landscape = { windowWidth: 568, windowHeight: 320 };
  viewport = page.fallbackGraphViewport(landscape);
  assert.equal(viewport.top, 64); assert.equal(viewport.height, 136);
  page.data.isCleanScreen = true;
  viewport = page.fallbackGraphViewport(landscape);
  assert.equal(viewport.height, 256);
  page.data.isCleanScreen = false; page.data.headerHeight = 250; page.data.footerHeight = 240;
  assert.equal(page.fallbackGraphViewport({ windowWidth: 320, windowHeight: 400 }).height, 1);
});

test('示例原生分享保留当前人物视角，迟到回调和加载失败不记录旧示例发送', async t => {
  environment(t); const calls = [];
  t.mock.method(api, 'call', (type, payload) => { calls.push({ type, payload }); return Promise.resolve({}); });
  const page = pageAt('example', exampleApp()); await page.onLoad({ slug: 'first' });
  page.setPerspective('first-child');
  const share = page.onShareAppMessage();
  assert.match(share.path, /slug=first.*personId=first-child$/);
  share.success();
  assert.equal(calls.filter(value => value.payload.stage === 'sent').length, 1);
  await page.switchExample('second'); share.success();
  assert.equal(calls.filter(value => value.payload.stage === 'sent').length, 1);
  assert.ok(!calls.some(value => /^invite\./.test(value.type)));
});

test('首屏图谱渲染后测量真实工具文字宽度，不按空节点尺寸固定', async t => {
  environment(t); const page = pageAt('example', exampleApp());
  let graphMeasures = 0;
  page.createSelectorQuery = () => {
    const selectors = [];
    return { select(value) { selectors.push(value); return this; }, selectAll(value) { selectors.push(value); return this; }, boundingClientRect() { return this; }, exec(callback) {
      if (selectors[0] !== '.graph-viewport') return callback([]);
      graphMeasures++;
      callback([{ left: 0, top: 220, width: 375, height: 240 }, { width: 50 }, { height: 156 }, { height: 110 }, page.data.nodes.length ? [{ width: 90, height: 40 }] : []]);
    } };
  };
  await page.onLoad({ slug: 'first' });
  assert.ok(graphMeasures >= 2);
  assert.match(page.data.graphToolsStyle, /--graph-tool-width:106px/);
  assert.ok(page.data.graphScale > 0);
});
