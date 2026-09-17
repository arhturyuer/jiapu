require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadTreePage() {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return {}; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/tree/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  return definition;
}

function createPage() {
  const page = Object.assign({}, loadTreePage());
  const setDataCalls = [];
  page.data = {
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
    graphZoomClass: 'zoom-detail'
  };
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
    viewMode: 'perspective',
    viewpointId: 'person-1'
  });
  const previousWx = global.wx;
  const visits = [];
  global.wx = {
    navigateTo: function (options) { visits.push(options.url); },
    getStorageSync: function (key) {
      if (key === 'youpu_example_display_preference_example-1') {
        return { nameLayout: 'vertical', showChildRankBadge: false, showGenderBadge: false, showGenderColors: false };
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
        statePatch: { nameLayout: 'vertical', showChildRankBadge: false, showGenderBadge: false, showGenderColors: false }
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
    showGenderColors: true
  });
  assert.equal(page.data.nameLayout, 'vertical');
  assert.equal(page.data.nodes[0].verticalName, '张\n建\n国');
  assert.match(page.data.nodes[0].style, /width:88rpx/);
  assert.ok(page.data.lines.length > 0);
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
