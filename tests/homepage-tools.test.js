require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../miniprogram/utils/graph-tools-layout');
const pdfEntry = require('../miniprogram/utils/pdf-entry');
const exportSession = require('../miniprogram/utils/pdf-export-session');

function fixture(t) {
  const previous = { Page: global.Page, getApp: global.getApp, wx: global.wx };
  const app = { globalData: {}, setCurrentFamily() {} };
  let definition;
  global.Page = value => { definition = value; };
  global.getApp = () => app;
  global.wx = { getWindowInfo: () => ({ windowWidth: 375, windowHeight: 667 }), navigateTo() {} };
  const file = require.resolve('../miniprogram/pages/tree/index');
  delete require.cache[file];
  require(file);
  t.after(() => Object.assign(global, previous));
  const page = Object.assign({}, definition, { data: Object.assign({}, definition.data, {
    loading: false, currentFamily: { _id: 'fake-family' }, rawPersons: [{ _id: 'fake-person', name: '虚构家人' }],
    nodes: [{ _id: 'fake-person' }]
  }) });
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  return page;
}

test('取消或重复选择查看方式保留取景，实际切换只调用原模式处理', t => {
  const page = fixture(t), choices = [];
  page.showFullGraph = () => { choices.push('full'); page.data.viewMode = 'full'; };
  page.setPerspective = id => { choices.push(id); page.data.viewMode = 'perspective'; page.data.viewpointId = id; };
  Object.assign(page.data, { graphScale: 1.4, graphX: -100 });
  page.openPerspectiveSheet(); page.selectFullView();
  assert.deepEqual(choices, []);
  page.openPerspectiveSheet(); page.selectPerspective({ currentTarget: { dataset: { id: 'fake-person' } } });
  assert.deepEqual(choices, ['fake-person']);
  page.openPerspectiveSheet(); page.selectPerspective({ currentTarget: { dataset: { id: 'fake-person' } } });
  assert.deepEqual(choices, ['fake-person']);
  page.openPerspectiveSheet(); page.closePerspectiveSheet();
  assert.equal(page.data.viewMode, 'perspective'); assert.equal(page.data.graphScale, 1.4); assert.equal(page.data.graphX, -100);
  page.openPerspectiveSheet(); page.selectFullView();
  assert.deepEqual(choices, ['fake-person', 'full']);
  assert.equal(page.data.showPerspectiveSheet, false);
});

test('搜索取消、切谱及离页后不回写旧成员结果，旧选择事件不生效', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = fixture(t);
  page.openPerspectiveSheet();
  page.filterPerspectives({ detail: { value: '不存在' } });
  page.closePerspectiveSheet();
  t.mock.timers.tick(120);
  assert.equal(page.data.perspectiveResults.length, 1);
  page.openPerspectiveSheet(); page.filterPerspectives({ detail: { value: '不存在' } });
  page.data.currentFamily = { _id: 'different-family' };
  t.mock.timers.tick(120);
  assert.equal(page.data.perspectiveResults.length, 1);
  page.setPerspective = () => assert.fail('旧谱事件不得切换新谱视角');
  page.selectPerspective({ currentTarget: { dataset: { id: 'fake-person' } } });
  page.closeBrowseSheets(); page._pageHidden = true; page.openPerspectiveSheet();
  assert.equal(page.data.showPerspectiveSheet, false);
});

test('搜索只过滤成员，选择全谱不受空搜索结果影响，全图不切换模式', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = fixture(t); page.data.viewMode = 'perspective'; page.data.viewpointId = 'fake-person';
  page.openPerspectiveSheet(); page.filterPerspectives({ detail: { value: '不存在' } }); t.mock.timers.tick(120);
  assert.deepEqual(page.data.perspectiveResults, []);
  let fitted = false;
  page.fitGraph = (id, all) => { fitted = id === '' && all; };
  page.fitWholeGraph();
  assert.equal(fitted, true); assert.equal(page.data.viewMode, 'perspective'); assert.equal(page.data.viewpointId, 'fake-person');
  page.showFullGraph = () => { page.data.viewMode = 'full'; }; page.selectFullView();
  assert.equal(page.data.viewMode, 'full');
});

test('导出复用现有入口，图片防重不影响 PDF，切谱及离页使旧菜单失效', t => {
  const page = fixture(t), formats = [];
  page.generatePoster = () => { formats.push('image'); };
  page.openPdfExport = format => { formats.push(format); };
  page.openPerspectiveSheet(); page.openExportSheet();
  assert.equal(page.data.showPerspectiveSheet, false);
  page.data.posterGenerating = true;
  page.chooseExport({ currentTarget: { dataset: { format: 'image' } } });
  assert.deepEqual(formats, []); assert.equal(page.data.showExportSheet, true);
  page.chooseExport({ currentTarget: { dataset: { format: 'book' } } });
  assert.deepEqual(formats, ['book']); assert.equal(page.data.showExportSheet, false);
  page.data.posterGenerating = false; page.openExportSheet(); page.chooseExport({ currentTarget: { dataset: { format: 'image' } } });
  assert.deepEqual(formats, ['book', 'image']);
  page.openExportSheet(); page.data.currentFamily = { _id: 'other-family' };
  page.chooseExport({ currentTarget: { dataset: { format: 'poster' } } });
  assert.deepEqual(formats, ['book', 'image']);
  page.closeBrowseSheets(); page._pageHidden = true; page.openExportSheet();
  assert.equal(page.data.showExportSheet, false);
});

test('六项工具按可用高度选择最少列数，横屏横排，大屏保留五项', () => {
  assert.equal(tools.layout({ width: 375, height: 500 }).columns, 1);
  assert.equal(tools.layout({ width: 375, height: 200 }).columns, 2);
  assert.equal(tools.layout({ width: 320, height: 140 }).columns, 3);
  const landscape = tools.layout({ width: 844, height: 300 }, { landscape: true, safeLeft: 44, safeRight: 44 });
  assert.equal(landscape.columns, 6); assert.equal(landscape.scroll, false);
  const desktop = tools.layout({ width: 1024, height: 500 }, { largeDevice: true, landscape: true });
  assert.equal(desktop.columns, 1); assert.equal(desktop.height, 5 * 44 + 4 * 6);
});

test('长辈与 200% 字号保持热区，实测字宽撑开按钮，极低窗口滚动且帮助避让', () => {
  for (const width of [320, 375, 430, 600, 1024]) {
    for (const elderMode of [false, true]) {
      for (const scale of [1, 1.25, 1.5, 2]) {
        const result = tools.layout({ width, height: 200 }, { elderMode, bodySize: (elderMode ? 20 : 16) * scale });
        assert.ok(result.width <= width - 24); assert.ok(result.height <= 176);
      }
    }
  }
  const measured = tools.layout({ width: 320, height: 90 }, { elderMode: true, labels: [{ width: 82, height: 54 }] });
  assert.equal(measured.columns, 2); assert.equal(measured.scroll, true);
  assert.match(measured.style, /--graph-tool-width:98px/); assert.match(measured.helpStyle, /display:none/);
});

test('工具使用实测画布和标签尺寸，离页后的测量不回写布局', t => {
  const page = fixture(t); let complete;
  const query = { select() { return this; }, selectAll() { return this; }, boundingClientRect() { return this; }, exec(fn) { complete = fn; } };
  page.createSelectorQuery = () => query;
  page.measureGraphViewport({ windowWidth: 375, windowHeight: 667 }, () => {});
  complete([{ left: 0, top: 160, width: 375, height: 180 }, { width: 50 }, { height: 96 }, [{ width: 30, height: 24 }]]);
  assert.equal(page.data.toolbarHeight, 96); assert.match(page.data.graphToolsStyle, /--graph-tools-columns:2/);
  const previous = page.data.graphToolsStyle;
  page.measureGraphViewport({ windowWidth: 375, windowHeight: 667 }, () => {});
  page._deviceHidden = true;
  complete([{ width: 375, height: 70 }, null, null, [{ width: 80, height: 54 }]]);
  assert.equal(page.data.graphToolsStyle, previous);
  page._deviceHidden = false;
  page.measureGraphViewport({ windowWidth: 375, windowHeight: 667 }, () => {});
  page.data.readingBodySize = 40;
  complete([{ width: 375, height: 90 }, null, { height: 70 }, []]);
  assert.equal(page.data.graphToolsStyle, previous); assert.equal(page.data.toolbarHeight, 96);
});

test('PDF 格式预选兼容旧入口，仍携带完整家谱快照并只创建导航', t => {
  const previous = global.wx, visits = [];
  global.wx = { navigateTo: value => { visits.push(value); }, showToast() {} };
  t.after(() => { global.wx = previous; });
  const page = { data: { currentFamily: { _id: 'fake-family' }, rawPersons: [{ _id: 'fake-person', name: '虚构人物' }], rawRelations: [], contentRevision: 1, nameLayout: 'horizontal', viewMode: 'perspective', collapsedPersonIds: ['fake-person'] } };
  for (const format of [undefined, 'invalid', 'poster', 'book']) {
    pdfEntry.open(page, 'family', format);
    const url = new URL('https://staging.invalid' + visits.at(-1).url);
    assert.equal(url.searchParams.get('format'), format === 'book' ? 'book' : 'poster');
    const snapshot = exportSession.take(url.searchParams.get('session'));
    assert.deepEqual(snapshot.layoutSnapshot.ids, ['fake-person']);
  }
  assert.equal(visits.length, 4);
});

test('离页关闭两个选择面板并取消搜索；小画布兜底不人为扩大到 240px', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = fixture(t);
  page.openPerspectiveSheet(); page.filterPerspectives({ detail: { value: '不存在' } });
  page.onHide(); t.mock.timers.tick(120);
  assert.equal(page.data.showPerspectiveSheet, false); assert.equal(page._perspectiveFilterTimer, null);
  page._deviceHidden = false; page._pageHidden = false;
  page.openExportSheet(); page.onHide();
  assert.equal(page.data.showExportSheet, false); assert.equal(page._exportSheetFamilyId, '');
  page.getWindowSize = () => ({ windowWidth: 320, windowHeight: 350 });
  page.data.navigationHeight = 100; page.data.readingLarge = true; page.data.elderMode = true; page.data.readingBodySize = 40;
  const viewport = page.getGraphViewport();
  assert.ok(viewport.height < 240 && viewport.height > 0);
});
