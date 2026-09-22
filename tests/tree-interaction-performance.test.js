require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const shareCard = require('../miniprogram/utils/share-card');

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

function createPage() {
  const definition = loadTreePage();
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

function loadExamplePage() {
  let definition = null;
  const previousPage = global.Page;
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/example/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.Page = previousPage;
  return definition;
}

function createExamplePage(data) {
  const page = Object.assign({}, loadExamplePage());
  page.data = Object.assign({}, page.data, data);
  page.setData = function (patch, callback) {
    Object.assign(page.data, patch);
    if (callback) callback();
  };
  return page;
}

test('拖动和捏合过程中只记录原生视口状态，不同步 setData', function () {
  const instance = createPage();
  instance.page.onGraphChange({ detail: { x: -123.45, y: 67.89, source: 'touch' } });
  instance.page.onGraphScale({ detail: { scale: 0.73 } });
  assert.equal(instance.setDataCalls.length, 0);
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
  page.data.selectedPerson = page.data.rawPersons[0];
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
