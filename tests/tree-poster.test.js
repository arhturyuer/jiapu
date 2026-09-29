require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const graph = require(path.join(root, 'miniprogram/utils/graph-layout.js'));
const poster = require(path.join(root, 'miniprogram/utils/tree-poster.js'));
const posterInvite = require(path.join(root, 'miniprogram/utils/poster-invite.js'));
const posterSession = require(path.join(root, 'miniprogram/utils/poster-session.js'));
const treePosterFlow = require(path.join(root, 'miniprogram/utils/tree-poster-flow.js'));

function loadPage(relativePath) {
  let definition = null;
  const previousPage = global.Page;
  const previousGetApp = global.getApp;
  if (typeof global.getApp !== 'function') global.getApp = function () { return {}; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve(relativePath);
  delete require.cache[modulePath];
  require(modulePath);
  global.Page = previousPage;
  global.getApp = previousGetApp;
  return definition;
}

function createPage(definition, data) {
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data, data || {});
  page.setData = function (patch) { Object.assign(page.data, patch); };
  return page;
}

function flushPromises() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function binaryLayout(count) {
  const persons = [];
  const relations = [];
  for (let index = 0; index < count; index += 1) {
    const id = 'p' + String(index).padStart(3, '0');
    persons.push({ _id: id, name: '成员' + index, gender: index % 2 ? 'male' : 'female', status: 'active' });
    if (index > 0) {
      relations.push({
        _id: 'r' + index,
        type: 'parent_child',
        fromPersonId: 'p' + String(Math.floor((index - 1) / 2)).padStart(3, '0'),
        toPersonId: id,
        status: 'active'
      });
    }
  }
  return graph.layoutGraph(persons, relations, { mode: 'full', nameLayout: 'horizontal' });
}

test('高清图片尺寸遵守目标清晰度和设备上限', function () {
  const regular = poster.calculateSize(binaryLayout(36));
  assert.ok(regular.scale <= poster.TARGET_SCALE);
  assert.ok(regular.scale >= poster.MIN_SCALE);
  assert.ok(regular.width <= poster.MAX_SIDE);
  assert.ok(regular.height <= poster.MAX_SIDE);
  assert.ok(regular.width * regular.height <= poster.MAX_PIXELS);

  const expanded = poster.calculateSize(binaryLayout(80));
  assert.ok(expanded.scale >= poster.MIN_SCALE);
  assert.throws(function () { poster.calculateSize(binaryLayout(200)); }, function (error) {
    return error.code === 'POSTER_TOO_LARGE' && /收起部分分支/.test(error.message);
  });
});

test('布局连线提供海报绘制所需的稳定几何坐标', function () {
  const layout = binaryLayout(3);
  assert.ok(layout.lines.length > 0);
  layout.lines.forEach(function (line) {
    ['x1', 'y1', 'x2', 'y2', 'length', 'angle'].forEach(function (field) {
      assert.equal(Number.isFinite(line[field]), true, field + ' 应为数字');
    });
  });
});

test('海报绘制包含家谱标题、当前视图、品牌和扫码文案', function () {
  const source = fs.readFileSync(path.join(root, 'miniprogram/utils/tree-poster.js'), 'utf8');
  const calls = [];
  const images = [];
  const context = {
    font: '',
    beginPath: function () {}, moveTo: function () {}, lineTo: function () {}, arcTo: function () {}, closePath: function () {},
    arc: function () {}, fill: function () {}, stroke: function () {}, fillRect: function () {}, clip: function () {},
    save: function () {}, restore: function () {}, drawImage: function () { images.push(Array.from(arguments)); },
    measureText: function (value) { return { width: String(value).length * 20 }; },
    fillText: function (value, x, y) { calls.push({ value: String(value), x: x, y: y }); }
  };
  const layout = graph.layoutGraph([
    { _id: 'p1', name: '张建国', initial: '张', gender: 'male', status: 'active' }
  ], [], { mode: 'full', nameLayout: 'horizontal' });
  const size = poster.calculateSize(layout);
  poster.draw(context, layout, size, {}, { width: 430, height: 430 }, {
    familyName: '张氏家谱', viewMode: 'full', viewLabel: '当前视图：完整家谱',
    showGenderColors: true, showGenderBadge: false, showChildRankBadge: false
  });
  assert.ok(calls.some(function (item) { return item.value === '张氏家谱'; }));
  assert.ok(calls.some(function (item) { return item.value === '当前视图：完整家谱'; }));
  const brand = calls.find(function (item) { return item.value === '由有谱家谱生成'; });
  const scan = calls.find(function (item) { return item.value === '扫码查看详情'; });
  assert.ok(brand && scan);
  assert.ok(!calls.some(function (item) { return item.value === '把一家人的关系清楚地保存下来'; }));
  assert.ok(calls.some(function (item) { return item.value === '张建国'; }));
  assert.equal(images.length, 1);
  assert.ok(images[0][1] > size.logicalWidth / 2, '小程序码应在顶部右侧');
  assert.ok(images[0][2] < size.graphY, '小程序码不能占用家谱图或底部区域');
  assert.ok(brand.x < images[0][1] && scan.x < images[0][1], '两行文案应位于小程序码左侧');
  assert.equal(size.logicalHeight - size.graphY - size.graphHeight, 64, '底部只保留页面安全边距');
  assert.ok(poster.TITLE_FONT_SIZE >= poster.PERSON_NAME_FONT_SIZE * 3, '家谱标题应明显大于人物姓名');
  assert.doesNotMatch(source, /ctx\.font = ['"]650\s/, 'Canvas 不应使用兼容性不稳定的 650 字重');
  assert.match(source, /ctx\.font = 'bold ' \+ TITLE_FONT_SIZE/);
});

test('长期图片邀请缓存按用户、家谱和人物视角隔离', function () {
  const base = { ownerId: 'u1', familyId: 'f1', viewMode: 'full', viewPersonId: '' };
  assert.notEqual(posterInvite.cacheKey(base), posterInvite.cacheKey(Object.assign({}, base, { ownerId: 'u2' })));
  assert.notEqual(posterInvite.cacheKey(base), posterInvite.cacheKey(Object.assign({}, base, { viewMode: 'perspective', viewPersonId: 'p1' })));
});

test('真实与示例家谱共用一键生成和两个底部操作', function () {
  const treeScript = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.js'), 'utf8');
  const exampleScript = fs.readFileSync(path.join(root, 'miniprogram/pages/example/index.js'), 'utf8');
  const flowScript = fs.readFileSync(path.join(root, 'miniprogram/utils/tree-poster-flow.js'), 'utf8');
  const inviteUtility = fs.readFileSync(path.join(root, 'miniprogram/utils/poster-invite.js'), 'utf8');
  const treeTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.wxml'), 'utf8');
  const exampleTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/example/index.wxml'), 'utf8');
  const previewTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/poster-preview/index.wxml'), 'utf8');
  const previewScript = fs.readFileSync(path.join(root, 'miniprogram/pages/poster-preview/index.js'), 'utf8');
  assert.match(treeTemplate, /bindtap="openDisplaySettings">设置<\/view>[\s\S]*bindtap="generatePoster">图片<\/view>/);
  assert.match(exampleTemplate, /bindtap="openDisplaySettings">设置<\/view><view[^>]*bindtap="generatePoster">图片<\/view>/);
  assert.doesNotMatch(treeTemplate, /currentRole[^>]*generatePoster/);
  assert.match(inviteUtility, /api\.call\('invite\.createPoster'/);
  assert.match(treeScript, /treePosterFlow\.generate\(this/);
  assert.match(exampleScript, /treePosterFlow\.generate\(this/);
  assert.match(flowScript, /treePoster\.render/);
  assert.match(flowScript, /pages\/poster-preview\/index/);
  assert.match(flowScript, /entrancePath: value\.entrancePath/);
  assert.match(treeScript, /onHide:[\s\S]*treePosterFlow\.cancel\(this\)/);
  assert.match(exampleScript, /onHide:[\s\S]*treePosterFlow\.cancel\(this\)/);
  assert.equal((previewTemplate.match(/class="[^"]*preview-button/g) || []).length, 2, '预览底部只保留两个主操作');
  assert.match(previewTemplate, />发送给好友<\/button>/);
  assert.match(previewTemplate, />保存图片<\/button>/);
  assert.match(previewTemplate, /open-type="openSetting" bindopensetting="onMiniProgramSetting"/);
  assert.match(previewScript, /privacy\.ensurePrivacyAuthorized\(\)[\s\S]*saveToAlbum\(\)/);
  assert.match(previewScript, /wx\.getAppAuthorizeSetting\(\)/);
  assert.match(previewScript, /wx\.openAppAuthorizeSetting\(/);
  assert.match(previewScript, /wx\.authorize\([\s\S]*scope: 'scope\.writePhotosAlbum'/, '首次保存应显式申请小程序相册权限');
  assert.match(previewScript, /Object\.assign\(\{ stage: 'sent' \}, self\.data\.sharePayload\)/);
});

test('图片消息入口保留真实家谱邀请和示例人物视角', function () {
  const previousGetApp = global.getApp;
  const originalGenerate = treePosterFlow.generate;
  let options;
  global.getApp = function () { return { globalData: { user: { _id: 'test-user' } } }; };
  treePosterFlow.generate = function (page, value) { options = value; };
  try {
    const tree = createPage(loadPage('../miniprogram/pages/tree/index'), {
      currentFamily: { _id: 'family-1', name: '测试家谱' },
      nodes: [{ _id: 'person-1' }]
    });
    tree.generatePoster();
    assert.equal(options.entrancePath({ token: 'invite+token/1' }), '/pages/invite/index?token=invite%2Btoken%2F1');

    const example = createPage(loadPage('../miniprogram/pages/example/index'), {
      example: { title: '示例家谱' }, slug: 'example-1', nodes: [{ _id: 'person-1' }],
      viewMode: 'perspective', viewpointId: 'person/1'
    });
    example.generatePoster();
    assert.equal(options.entrancePath(), '/pages/example/index?slug=example-1&source=example_poster&personId=person%2F1');
    example.data.viewMode = 'full';
    assert.equal(options.entrancePath(), '/pages/example/index?slug=example-1&source=example_poster');
  } finally {
    treePosterFlow.generate = originalGenerate;
    global.getApp = previousGetApp;
  }
});

test('分享图片使用业务入口，旧图片冷启动时返回家谱', function () {
  const previousWx = global.wx;
  const previousGetCurrentPages = global.getCurrentPages;
  const calls = [];
  global.wx = {
    showShareImageMenu: function (options) { calls.push(options); },
    navigateBack: function () { calls.push('navigateBack'); },
    switchTab: function (options) { calls.push(options.url); }
  };
  try {
    const preview = createPage(loadPage('../miniprogram/pages/poster-preview/index'));
    posterSession.set({ filePath: '/tmp/poster.png', entrancePath: '/pages/invite/index?token=test-token' });
    preview.onLoad();
    preview.shareImage();
    assert.equal(calls[0].path, '/tmp/poster.png');
    assert.equal(calls[0].needShowEntrance, true);
    assert.equal(calls[0].entrancePath, '/pages/invite/index?token=test-token');
    assert.equal(posterSession.take(), null, '预览会话只供本地页面读取一次');

    const coldStart = createPage(loadPage('../miniprogram/pages/poster-preview/index'));
    coldStart.onLoad();
    assert.match(coldStart.data.error, /图片已经失效/);
    global.getCurrentPages = function () { return [coldStart]; };
    coldStart.goBack();
    assert.equal(calls[1], '/pages/tree/index');
    global.getCurrentPages = function () { return [preview, coldStart]; };
    coldStart.goBack();
    assert.equal(calls[2], 'navigateBack');
  } finally {
    posterSession.clear();
    global.wx = previousWx;
    global.getCurrentPages = previousGetCurrentPages;
  }
});

test('示例家谱图片码保留全谱或人物视角', function () {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const examplePage = fs.readFileSync(path.join(root, 'miniprogram/pages/example/index.js'), 'utf8');
  assert.match(source, /function examplePosterScene[\s\S]*'e' \+ hash\(slug, 20\) \+ mode \+ personHash/);
  assert.match(source, /async function examplesGetMiniCode[\s\S]*page: 'pages\/example\/index'/);
  assert.match(source, /async function examplesResolvePoster[\s\S]*\^e\[0-9a-f\]\{20\}\[fp\]\[0-9a-f\]\{10\}\$/);
  assert.match(source, /'examples\.getMiniCode': examplesGetMiniCode/);
  assert.match(source, /'examples\.resolvePoster': examplesResolvePoster/);
  assert.match(examplePage, /options\.scene[\s\S]*api\.call\('examples\.resolvePoster'/);
  assert.match(examplePage, /_shareSource = 'example_poster'/);
});

test('首次保存先申请小程序相册权限再调用官方保存接口', async function () {
  const previousWx = global.wx;
  const calls = [];
  global.wx = {
    getSetting: function (options) { options.success({ authSetting: {} }); },
    authorize: function (options) { calls.push(options.scope); options.success(); },
    saveImageToPhotosAlbum: function (options) { calls.push(options.filePath); options.success(); },
    showToast: function (options) { calls.push(options.title); }
  };
  try {
    const page = createPage(loadPage('../miniprogram/pages/poster-preview/index'), { filePath: '/tmp/poster.png' });
    page.saveImage();
    await flushPromises();
    await flushPromises();
    assert.deepEqual(calls, ['scope.writePhotosAlbum', '/tmp/poster.png', '图片已保存']);
    assert.equal(page.data.saving, false);
  } finally {
    global.wx = previousWx;
  }
});

test('隐私保护指引未同意时不误导到系统权限设置', async function () {
  const previousWx = global.wx;
  const calls = [];
  global.wx = {
    getPrivacySetting: function (options) { options.success({ needAuthorization: true }); },
    requirePrivacyAuthorize: function (options) { options.fail({ errMsg: 'requirePrivacyAuthorize:fail privacy permission is not authorized' }); },
    saveImageToPhotosAlbum: function () { calls.push('save'); },
    showToast: function (options) { calls.push(options.title); }
  };
  try {
    const page = createPage(loadPage('../miniprogram/pages/poster-preview/index'), { filePath: '/tmp/poster.png' });
    page.saveImage();
    await flushPromises();
    await flushPromises();
    assert.deepEqual(calls, ['同意隐私保护指引后才能保存']);
    assert.equal(page.data.permissionGuide, '');
    assert.equal(page.data.saving, false);
  } finally {
    global.wx = previousWx;
  }
});

test('getSetting 返回 false 时仍先实际申请相册权限并继续保存', async function () {
  const previousWx = global.wx;
  const calls = [];
  global.wx = {
    getSetting: function (options) { options.success({ authSetting: { 'scope.writePhotosAlbum': false } }); },
    authorize: function (options) { calls.push(options.scope); options.success(); },
    saveImageToPhotosAlbum: function (options) {
      calls.push(options.filePath);
      options.success();
    },
    showToast: function (options) { calls.push(options.title); }
  };
  try {
    const page = createPage(loadPage('../miniprogram/pages/poster-preview/index'), { filePath: '/tmp/poster.png' });
    page.saveImage();
    await flushPromises();
    await flushPromises();
    assert.equal(page.data.permissionGuide, '');
    assert.deepEqual(calls, ['scope.writePhotosAlbum', '/tmp/poster.png', '图片已保存']);
    assert.equal(page.data.saving, false);
  } finally {
    global.wx = previousWx;
  }
});

test('实际申请相册权限被拒绝后才展示小程序设置入口', async function () {
  const previousWx = global.wx;
  global.wx = {
    getSetting: function (options) { options.success({ authSetting: { 'scope.writePhotosAlbum': false } }); },
    authorize: function (options) { options.fail({ errMsg: 'authorize:fail auth deny' }); },
    saveImageToPhotosAlbum: function () { assert.fail('权限申请失败时不应保存'); },
    showToast: function () {}
  };
  try {
    const page = createPage(loadPage('../miniprogram/pages/poster-preview/index'), { filePath: '/tmp/poster.png' });
    page.saveImage();
    await flushPromises();
    await flushPromises();
    assert.equal(page.data.permissionGuide, 'miniprogram');
    assert.equal(page.data.saving, false);
  } finally {
    global.wx = previousWx;
  }
});

test('微信系统相册权限被拒绝时打开宿主授权页并返回后重试', async function () {
  const previousWx = global.wx;
  const calls = [];
  let saveCount = 0;
  let albumState = 'denied';
  global.wx = {
    getSetting: function (options) { options.success({ authSetting: { 'scope.writePhotosAlbum': true } }); },
    getAppAuthorizeSetting: function () { return { albumAuthorized: albumState }; },
    openAppAuthorizeSetting: function (options) { calls.push('openAppAuthorizeSetting'); if (options.success) options.success({}); },
    saveImageToPhotosAlbum: function (options) {
      saveCount += 1;
      calls.push(options.filePath);
      if (saveCount === 1) options.fail({ errMsg: 'saveImageToPhotosAlbum:fail system permission denied' });
      else options.success();
    },
    showToast: function (options) { calls.push(options.title); }
  };
  try {
    const page = createPage(loadPage('../miniprogram/pages/poster-preview/index'), { filePath: '/tmp/poster.png' });
    page.saveImage();
    await flushPromises();
    await flushPromises();
    assert.equal(page.data.permissionGuide, 'system');
    page.openSystemAlbumSetting();
    assert.equal(page._resumeAlbumSave, true);
    albumState = 'authorized';
    page.onShow();
    await flushPromises();
    await flushPromises();
    assert.deepEqual(calls, ['/tmp/poster.png', 'openAppAuthorizeSetting', '/tmp/poster.png', '图片已保存']);
    assert.equal(page.data.saving, false);
  } finally {
    global.wx = previousWx;
  }
});

test('小程序与微信相册权限均已开启时保存失败不再误报系统权限', async function () {
  const previousWx = global.wx;
  const calls = [];
  global.wx = {
    getSetting: function (options) { options.success({ authSetting: { 'scope.writePhotosAlbum': true } }); },
    getAppAuthorizeSetting: function () { return { albumAuthorized: 'authorized' }; },
    saveImageToPhotosAlbum: function (options) {
      options.fail({ errMsg: 'saveImageToPhotosAlbum:fail permission denied by file provider' });
    },
    showToast: function (options) { calls.push(options.title); }
  };
  try {
    const page = createPage(loadPage('../miniprogram/pages/poster-preview/index'), { filePath: '/tmp/poster.png' });
    page.saveImage();
    await flushPromises();
    await flushPromises();
    assert.equal(page.data.permissionGuide, '');
    assert.deepEqual(calls, ['图片保存失败，请重试']);
    assert.equal(page.data.saving, false);
  } finally {
    global.wx = previousWx;
  }
});

test('服务端强制图片邀请为长期仅查看并保留普通邀请默认值', function () {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/config.json'), 'utf8'));
  const invitePage = fs.readFileSync(path.join(root, 'miniprogram/pages/invite/index.js'), 'utf8');
  assert.match(source, /async function inviteCreatePoster/);
  assert.match(source, /requireMembership\(event\.familyId, ACTIVE_ROLES/);
  assert.match(source, /role: 'viewer',[\s\S]*purpose: 'poster'[\s\S]*maxUses: null,[\s\S]*expiresAt: null/);
  assert.match(source, /async function inviteGetMiniCode/);
  assert.match(source, /wxacode\.getUnlimited\([\s\S]*isHyaline: true/);
  assert.match(source, /invitation\.purpose === 'poster'[\s\S]*\? 'viewer'/);
  assert.match(source, /purpose: 'direct'/);
  assert.match(source, /Number\(event\.expiresInDays\) \|\| 30/);
  assert.match(source, /Number\(event\.maxUses\) \|\| 50/);
  assert.ok(config.permissions.openapi.includes('wxacode.getUnlimited'));
  assert.match(invitePage, /options\.token \|\| options\.scene/);
});
