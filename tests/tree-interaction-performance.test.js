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
