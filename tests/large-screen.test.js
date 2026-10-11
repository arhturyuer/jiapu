require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../miniprogram/utils/device-layout');
const capabilities = require('../miniprogram/utils/platform-capabilities');
const transfer = require('../miniprogram/utils/file-transfer');
const desktop = require('../miniprogram/utils/graph-desktop');

function platform(t, info, extra) {
  const previous = global.wx;
  global.wx = Object.assign({ getSystemInfoSync: () => info, getWindowInfo: () => info }, extra);
  t.after(() => { global.wx = previous; });
  return global.wx;
}

function instance(definition, data) {
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data, data);
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  return page;
}

function graphPage(t, name) {
  const previousApp = global.getApp, previousPage = global.Page;
  let definition;
  global.getApp = () => ({ globalData: {} });
  global.Page = value => { definition = value; };
  const file = require.resolve('../miniprogram/pages/' + name + '/index');
  delete require.cache[file];
  require(file);
  global.getApp = previousApp; global.Page = previousPage;
  return instance(definition);
}

test('断点使用逻辑窗口宽度，设备类型与横竖屏互不混淆', () => {
  [[320, 'compact'], [375, 'compact'], [430, 'compact'], [599, 'compact'], [600, 'medium'],
    [1023, 'medium'], [1024, 'expanded'], [1920, 'expanded']].forEach(([width, mode]) => {
    const result = layout.fromInfo({ platform: 'windows', windowWidth: width, windowHeight: 720 });
    assert.equal(result.mode, mode);
    assert.equal(result.largeDevice, true);
    assert.equal(result.uiUnit, width >= 600 ? 0.5 : width / 750);
  });
  assert.equal(layout.fromInfo({ model: 'iPad Pro', platform: 'ios', windowWidth: 414 }).largeDevice, true);
  assert.equal(layout.fromInfo({ model: 'iPhone', platform: 'ios', windowWidth: 844, windowHeight: 390 }).largeDevice, false);
  assert.equal(layout.fromInfo({ deviceType: 'pad', windowWidth: 800 }).largeDevice, true);
  assert.equal(layout.fromInfo({ windowWidth: NaN, windowHeight: -1 }).width, 375);
});

test('尺寸读取优先使用窗口 API，同时保留独立设备信息', () => {
  const api = { getDeviceInfo: () => ({ platform: 'mac', model: 'Mac' }), getWindowInfo: () => ({ windowWidth: 600, windowHeight: 400 }) };
  assert.equal(layout.read(api).mode, 'medium');
  assert.equal(layout.read(api).desktop, true);
  assert.equal(layout.read(api, { windowWidth: 599 }).mode, 'compact');
});

test('页面与 page-meta 的重复 resize 合并为最新尺寸，隐藏后取消', t => {
  platform(t, { platform: 'mac', windowWidth: 1024, windowHeight: 700 });
  const jobs = new Map(); let id = 0;
  t.mock.method(global, 'setTimeout', callback => { jobs.set(++id, callback); return id; });
  t.mock.method(global, 'clearTimeout', key => jobs.delete(key));
  const events = [], applied = [];
  const page = instance(layout.wrap({ data: { pageOrientation: 'portrait' },
    onLoad() { events.push('load'); }, onHide() { events.push('hide'); },
    applyPageResize(size) { applied.push(size); } }));
  page.onLoad();
  assert.equal(page.data.pageOrientation, 'auto');
  page.onResize({ size: { windowWidth: 800, windowHeight: 600 } });
  page.onResize({ size: { windowWidth: 1200, windowHeight: 800 } });
  assert.equal(jobs.size, 1);
  const callback = Array.from(jobs.values())[0]; jobs.clear(); callback();
  assert.deepEqual(applied, [{ windowWidth: 1200, windowHeight: 800 }]);
  page.onResize({ size: { windowWidth: 600, windowHeight: 400 } });
  page.onHide(); assert.equal(jobs.size, 0);
  page.onResize({ size: { windowWidth: 1024, windowHeight: 700 } });
  assert.equal(jobs.size, 0); assert.deepEqual(events, ['load', 'hide']);
});

['tree', 'example'].forEach(name => {
  test(name + ' 大屏旋转保留视觉中心、人物与可读比例，不重新布局', t => {
    const info = { platform: 'ios', model: 'iPad', windowWidth: 1024, windowHeight: 768 };
    platform(t, info, { nextTick: callback => callback(), setNavigationBarTitle() {}, showTabBar() {}, hideTabBar() { assert.fail('默认大屏不得隐藏导航'); } });
    const page = graphPage(t, name);
    layout.sync(page);
    page.data.nodes = [{ _id: 'fake' }]; page.data.selectedPersonId = 'fake';
    page._lastLayout = { nodes: page.data.nodes, width: 3000, height: 2000 };
    page._graphViewport = { width: 768, height: 900, left: 0, top: 56, rpxToPx: 768 / 750 };
    page.commitGraphTransform({ x: -150, y: -200, scale: 0.8 });
    const before = page.getGraphTransform(); const old = page.getGraphViewport();
    const logicalX = (old.width / 2 - before.x) / before.scale / old.rpxToPx;
    const logicalY = (old.height / 2 - before.y) / before.scale / old.rpxToPx;
    const rect = { left: 0, top: 56, width: 1024, height: 712 };
    page.createSelectorQuery = () => ({ select() { return this; }, boundingClientRect() { return this; },
      exec(callback) { callback([rect, { width: 100 * 1024 / 750 }]); } });
    page.renderGraph = () => assert.fail('resize 不得重新布局');
    page.applyPageResize({ windowWidth: 1024, windowHeight: 768 });
    const after = page.getGraphTransform(), next = page.getGraphViewport();
    assert.equal(page.data.pageOrientation, 'auto'); assert.equal(page.data.selectedPersonId, 'fake');
    assert.ok(Math.abs((next.width / 2 - after.x) / after.scale / next.rpxToPx - logicalX) < 1e-8);
    assert.ok(Math.abs((next.height / 2 - after.y) / after.scale / next.rpxToPx - logicalY) < 1e-8);
    assert.ok(Math.abs(old.rpxToPx * before.scale - next.rpxToPx * after.scale) < 1e-8);
    page.togglePageOrientation(); assert.equal(page.data.orientationChanging, false);
  });

  test(name + ' 使用渲染器实测 rpx 换算，测量缺失保留可操作兜底', t => {
    platform(t, { windowWidth: 1200, windowHeight: 800 });
    const page = graphPage(t, name);
    let results = [{ left: 12, top: 56, width: 800, height: 600 }, { width: 50 }];
    page.createSelectorQuery = () => ({ select() { return this; }, boundingClientRect() { return this; }, exec(callback) { callback(results); } });
    page.measureGraphViewport({ windowWidth: 1200, windowHeight: 800 }, viewport => {
      assert.equal(viewport.width, 800); assert.equal(viewport.rpxToPx, 0.5);
    });
    results = [];
    page.measureGraphViewport({ windowWidth: 1200, windowHeight: 800 }, viewport => {
      assert.equal(viewport.width, 1200); assert.ok(viewport.height > 0);
    });
  });

  test(name + ' 超宽窗口首次测量即更新缩放下限，姓名保持 16px', t => {
    platform(t, { windowWidth: 1920, windowHeight: 1080 });
    const page = graphPage(t, name);
    page._lastLayout = { nodes: [{ _id: 'fake', x: 80, y: 80 }], width: 1000, height: 900 };
    page.createSelectorQuery = () => ({ select() { return this; }, boundingClientRect() { return this; },
      exec(callback) { callback([{ left: 0, top: 76, width: 1920, height: 1004 }, { width: 256 }]); } });
    page.fitGraph('', true, { initialView: true });
    assert.ok(Math.abs(28 * page.getGraphViewport().rpxToPx * page.getGraphTransform().scale - 16) < 1e-8);
  });
});

test('PC 快捷键在弹层、后台、组合键时无效，离页只移除自身监听', t => {
  let listener; const removed = [], actions = [];
  platform(t, { platform: 'mac' }, { onKeyDown(callback) { listener = callback; }, offKeyDown(callback) { removed.push(callback); } });
  const page = { data: { isDesktop: true, nodes: [{}] }, zoomGraphIn: () => actions.push('+'), zoomGraphOut: () => actions.push('-'), fitWholeGraph: () => actions.push('0') };
  desktop.attach(page);
  listener({ key: '+' }); listener({ key: '-' }); listener({ key: '0' });
  page.data.showMemberSheet = true; listener({ key: '+' }); page.data.showMemberSheet = false;
  listener({ key: '+', ctrlKey: true }); page._deviceHidden = true; listener({ key: '0' });
  assert.deepEqual(actions, ['+', '-', '0']);
  desktop.detach(page); assert.equal(removed.length, 1); assert.equal(removed[0], listener);
});

test('电脑图片选择规整为现有上传协议，手机保留相册和拍摄', async () => {
  let request;
  const desktopApi = { getSystemInfoSync: () => ({ platform: 'windows' }), chooseImage: options => {
    request = options; return Promise.resolve({ tempFiles: [{ path: '/fake/avatar.png', size: 23 }] });
  } };
  assert.deepEqual(await capabilities.chooseImage(desktopApi), { tempFiles: [{ tempFilePath: '/fake/avatar.png', size: 23 }] });
  assert.deepEqual(request.sourceType, ['album']);
  const phoneApi = { chooseMedia: options => { request = options; return Promise.resolve({ tempFiles: [] }); } };
  await capabilities.chooseImage(phoneApi); assert.deepEqual(request.sourceType, ['album', 'camera']);
  await assert.rejects(capabilities.chooseImage({}), /不支持选择照片/);
});

test('磁盘保存区分成功、取消、失败和平台缺失，不请求手机相册权限', async () => {
  const api = { getSystemInfoSync: () => ({ platform: 'windows' }), saveFileToDisk: options => options.success({}) };
  await transfer.saveToDisk('/fake/file.pdf', { wxApi: api });
  api.saveFileToDisk = options => options.fail({ errMsg: 'saveFileToDisk:fail cancel' });
  await assert.rejects(transfer.saveToDisk('/fake/file.pdf', { wxApi: api }), error => transfer.isCancelled(error));
  api.saveFileToDisk = options => options.fail({ errMsg: 'saveFileToDisk:fail unavailable' });
  await assert.rejects(transfer.saveToDisk('/fake/file.pdf', { wxApi: api }), { code: 'SAVE_FAILED' });
  await assert.rejects(transfer.saveToDisk('', { wxApi: api }), { code: 'SAVE_PATH_MISSING' });
  await assert.rejects(transfer.saveToDisk('/fake/file.pdf', { wxApi: {} }), { code: 'SAVE_UNSUPPORTED' });
});

test('添加引导必须有有效手机胶囊，电脑和平板不消耗提醒预算', () => {
  const api = { getSystemInfoSync: () => ({ platform: 'ios', model: 'iPhone' }), getMenuButtonBoundingClientRect: () => ({ left: 270, right: 360, width: 90, height: 32 }) };
  assert.equal(capabilities.canGuide(api), true);
  api.getSystemInfoSync = () => ({ platform: 'mac' }); assert.equal(capabilities.canGuide(api), false);
  api.getSystemInfoSync = () => ({ platform: 'ios', model: 'iPad' }); assert.equal(capabilities.canGuide(api), false);
  api.getSystemInfoSync = () => ({}); api.getMenuButtonBoundingClientRect = () => ({ width: 0 }); assert.equal(capabilities.canGuide(api), false);
});

test('桌面日期选择复用闰年和部分精度规则，取消不提交', t => {
  const previous = global.Component; let definition;
  global.Component = value => { definition = value; };
  const file = require.resolve('../miniprogram/components/person-date-picker/index');
  delete require.cache[file]; require(file); global.Component = previous;
  platform(t, { platform: 'windows' }, { showToast() {} });
  const changes = [];
  const picker = instance(definition.methods, { value: { calendar: 'solar', year: '2000', month: '2', day: '29' }, pickerValue: [] });
  picker.triggerEvent = (name, detail) => changes.push(detail);
  picker.open();
  const year1900 = picker.data.yearOptions.findIndex(item => item.value === '1900');
  picker.chooseDesktopDate({ currentTarget: { dataset: { column: 0 } }, detail: { value: year1900 } });
  assert.equal(picker.data.working.day, ''); assert.equal(picker.data.dayOptions.length, 29);
  picker.chooseDesktopDate({ currentTarget: { dataset: { column: 1 } }, detail: { value: 0 } });
  assert.equal(picker.data.working.month, ''); assert.equal(picker.data.working.precision, 'year');
  picker.close(); assert.equal(changes.length, 0); assert.equal(picker.data.value.day, '29');
  picker.open(); picker.confirm(); assert.equal(changes.length, 1); assert.equal(changes[0].value.day, '29');
});
