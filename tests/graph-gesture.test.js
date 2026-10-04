const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gesturePage = require('../miniprogram/utils/graph-gesture-page');

function harness(config, notify) {
  const sandbox = { module: { exports: {} }, Math: Math };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/wxs/graph-gesture.wxs'), 'utf8'), sandbox);
  const gesture = sandbox.module.exports;
  const state = {};
  const reports = [], paints = [], taps = [];
  const instance = { getState: function () { return state; } };
  const owner = {
    selectComponent: function (selector) {
      return selector === '.graph-viewport' ? instance : { setStyle: function (style) { paints.push(style); } };
    },
    callMethod: function (name, data) {
      if (name === 'onGraphGestureState') { reports.push(data); if (notify) notify(data); }
      else taps.push({ name: name, data: data });
    }
  };
  const initial = Object.assign({ version: 1, x: -120, y: -60, scale: 0.8, left: 20, top: 180, minimum: 0.32, maximum: 1.6 }, config);
  gesture.configure(initial, null, owner, instance);
  function touch(id, x, y) { return { identifier: id, clientX: x + state.left, clientY: y + state.top }; }
  function send(name, touches) { return gesture[name]({ touches: touches || [], changedTouches: [] }, owner); }
  function tap(action) { gesture.tap({ currentTarget: { dataset: { gestureAction: action, id: 'member' } } }, owner); }
  return { gesture: gesture, state: state, reports: reports, paints: paints, taps: taps, owner: owner, instance: instance, initial: initial, touch: touch, send: send, tap: tap };
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' != ' + expected); }
function anchor(state, x, y) { return { x: (x - state.x) / state.scale, y: (y - state.y) / state.scale }; }

[0, 180].forEach(function (top) {
  test('非中心双指缩放保持手指下的内容点，正确扣除视口偏移 top=' + top, function () {
    const h = harness({ top: top });
    const before = anchor(h.state, 100, 90);
    h.send('start', [h.touch(7, 70, 90), h.touch(9, 130, 90)]);
    h.send('move', [h.touch(9, 145, 90), h.touch(7, 55, 90)]);
    near(h.state.scale, 1.2);
    near(h.state.x + before.x * h.state.scale, 100);
    near(h.state.y + before.y * h.state.scale, 90);
  });
});

test('双指缩放与平移同时发生时内容点跟随移动中点', function () {
  const h = harness();
  const before = anchor(h.state, 100, 90);
  h.send('start', [h.touch(1, 70, 90), h.touch(2, 130, 90)]);
  h.send('move', [h.touch(1, 75, 110), h.touch(2, 165, 110)]);
  near(h.state.scale, 1.2);
  near(h.state.x + before.x * h.state.scale, 120);
  near(h.state.y + before.y * h.state.scale, 110);
});

test('上下限处中点仍能平移，反向捏合立即改变比例', function () {
  [1.6, 0.32].forEach(function (limit) {
    const h = harness({ scale: limit });
    const before = anchor(h.state, 100, 100);
    h.send('start', [h.touch(1, 50, 100), h.touch(2, 150, 100)]);
    const distance = limit === 1.6 ? 200 : 50;
    h.send('move', [h.touch(1, 120 - distance / 2, 110), h.touch(2, 120 + distance / 2, 110)]);
    near(h.state.scale, limit);
    near(h.state.x + before.x * limit, 120);
    near(h.state.y + before.y * limit, 110);
    const reverse = limit === 1.6 ? 180 : 60;
    h.send('move', [h.touch(1, 120 - reverse / 2, 110), h.touch(2, 120 + reverse / 2, 110)]);
    near(h.state.scale, limit * reverse / distance);
  });
});

test('手势逐帧仅更新视图，开始与结束各同步一次，结束不回跳', function () {
  const h = harness();
  h.send('start', [h.touch(1, 50, 100), h.touch(2, 150, 100)]);
  for (let i = 1; i <= 100; i++) h.send('move', [h.touch(1, 50 - i / 10, 100), h.touch(2, 150 + i / 10, 100)]);
  assert.equal(h.reports.length, 1);
  assert.equal(h.paints.length, 101);
  const last = { x: h.state.x, y: h.state.y, scale: h.state.scale };
  h.send('end');
  assert.equal(h.reports.length, 2);
  assert.equal(h.reports[1].active, false);
  near(h.reports[1].x, last.x); near(h.reports[1].y, last.y); near(h.reports[1].scale, last.scale);
  assert.equal(h.paints.length, 101);
});

test('单指到双指再回单指以当前画面衔接，不跳位', function () {
  const h = harness();
  h.send('start', [h.touch(1, 50, 100)]);
  h.send('move', [h.touch(1, 70, 110)]);
  near(h.state.x, -100); near(h.state.y, -50);
  h.send('start', [h.touch(1, 70, 110), h.touch(2, 170, 110)]);
  h.send('move', [h.touch(1, 70, 110), h.touch(2, 170, 110)]);
  near(h.state.x, -100); near(h.state.y, -50);
  h.send('end', [h.touch(2, 170, 110)]);
  h.send('move', [h.touch(2, 180, 130)]);
  near(h.state.x, -90); near(h.state.y, -30);
});

test('忽略额外触点，参与触点更换后重新建基准', function () {
  const h = harness();
  h.send('start', [h.touch(1, 50, 100), h.touch(2, 150, 100)]);
  h.send('start', [h.touch(3, 350, 400), h.touch(2, 150, 100), h.touch(1, 50, 100)]);
  h.send('move', [h.touch(3, 300, 300), h.touch(1, 50, 100), h.touch(2, 150, 100)]);
  near(h.state.scale, 0.8); near(h.state.x, -120);
  h.send('end', [h.touch(2, 150, 100), h.touch(3, 300, 300)]);
  const before = { x: h.state.x, y: h.state.y, scale: h.state.scale };
  h.send('move', [h.touch(3, 300, 300), h.touch(2, 150, 100)]);
  near(h.state.x, before.x); near(h.state.scale, before.scale);
});

test('重合触点及取消触摸不产生无效坐标', function () {
  const h = harness();
  h.send('start', [h.touch(1, 100, 100), h.touch(2, 100, 100)]);
  h.send('move', [h.touch(1, 90, 100), h.touch(2, 110, 100)]);
  assert.ok(Number.isFinite(h.state.x) && Number.isFinite(h.state.scale));
  h.send('cancel');
  assert.equal(h.state.active, false);
  assert.equal(h.reports.length, 2);
  h.tap('showPerson'); assert.equal(h.taps.length, 0);
});

test('人物、菜单、展开和空白点击正常；拖动或捏合后不会误点击', function () {
  const h = harness();
  ['showPerson', 'openMemberActions', 'expandBranch', 'clearGraphSelection'].forEach(function (action) {
    h.send('start', [h.touch(1, 100, 100)]); h.send('end'); h.tap(action);
  });
  assert.deepEqual(h.taps.map(function (tap) { return tap.name; }), ['showPerson', 'openMemberActions', 'expandBranch', 'clearGraphSelection']);
  h.send('start', [h.touch(1, 100, 100)]);
  h.send('move', [h.touch(1, 109, 100)]); h.send('move', [h.touch(1, 100, 100)]); h.send('end'); h.tap('showPerson');
  assert.equal(h.taps.length, 4);
  h.send('start', [h.touch(1, 90, 100), h.touch(2, 110, 100)]); h.send('end'); h.tap('expandBranch');
  assert.equal(h.taps.length, 4);
  h.send('start', [h.touch(1, 100, 100)]); h.send('end'); h.tap('showPerson');
  assert.equal(h.taps.length, 5);
});

test('程序取景先同步最新变换并终止手势，抬手不覆盖程序取景', function () {
  const h = harness();
  h.send('start', [h.touch(1, 50, 100)]); h.send('move', [h.touch(1, 80, 120)]);
  h.gesture.snapshot({ id: 10, version: 1 }, null, h.owner, h.instance);
  assert.equal(h.reports[1].requestId, 10); near(h.reports[1].x, -90);
  h.gesture.configure(Object.assign({}, h.initial, { version: 2, x: 40, y: 50 }), h.initial, h.owner, h.instance);
  h.send('move', [h.touch(1, 150, 150)]); h.send('end');
  near(h.state.x, 40); near(h.state.y, 50);
  assert.equal(h.reports.length, 2);
});

function pageHarness() {
  const operations = [], patches = [];
  const definition = gesturePage.wrap({
    data: { graphX: 0, graphY: 0, graphScale: 0.8, graphScaleMin: 0.32 },
    getGraphViewport: function () { return { left: 0, top: 100 }; },
    getGraphTransform: function () { return { x: this._currentGraphX || 0, y: this._currentGraphY || 0, scale: this._currentGraphScale || 0.8 }; },
    commitGraphTransform: function (transform) { this.setData({ graphGestureConfig: gesturePage.config(this, transform) }); },
    fitGraph: function (id) { operations.push({ id: id, x: this.getGraphTransform().x }); this.commitGraphTransform(this.getGraphTransform()); },
    onHide: function () { this._hidden = true; },
    onShow: function () { this._hidden = false; }
  });
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data);
  page.setData = function (patch) { patches.push(patch); Object.assign(page.data, patch); };
  page.commitGraphTransform(page.getGraphTransform());
  return { page: page, operations: operations, patches: patches };
}

test('迟到手势和过期请求不能覆盖当前取景，连续程序操作只执行最新项', function () {
  const h = pageHarness(), page = h.page;
  const version = page._gestureVersion;
  page.onGraphGestureState({ version: version, sequence: 1, active: true, x: -10, y: -20, scale: 0.8 });
  page.fitGraph('old'); const oldId = page.data.graphGestureRequest.id;
  page.fitGraph('new'); const newId = page.data.graphGestureRequest.id;
  page.onGraphGestureState({ version: version, sequence: 2, active: false, requestId: oldId, x: -99, y: -99, scale: 1 });
  assert.equal(page.getGraphTransform().x, -10); assert.equal(h.operations.length, 0);
  page.onGraphGestureState({ version: version, sequence: 3, active: false, requestId: newId, x: -40, y: -30, scale: 1 });
  assert.deepEqual(h.operations, [{ id: 'new', x: -40 }]);
  page.onGraphGestureState({ version: version, sequence: 4, active: false, x: 500, y: 500, scale: 1.5 });
  assert.equal(page.getGraphTransform().x, -40);
});

test('离开页面丢弃待执行操作和回调，返回后重新启用手势', function () {
  const h = pageHarness(), page = h.page, version = page._gestureVersion;
  page.onGraphGestureState({ version: version, sequence: 1, active: true, x: -10, y: -20, scale: 0.8 });
  page.fitGraph('hidden'); const id = page.data.graphGestureRequest.id;
  page.onHide();
  page.onGraphGestureState({ version: version, sequence: 2, requestId: id, active: false, x: 100, y: 100, scale: 1 });
  assert.equal(h.operations.length, 0); assert.equal(page.getGraphTransform().x, -10);
  assert.equal(page.data.graphGestureConfig.disabled, true);
  page.onShow(); assert.equal(page.data.graphGestureConfig.disabled, false);
});

test('两页共用 WXS 手势和左上角变换，保留原生点击语义', function () {
  ['tree', 'example'].forEach(function (name) {
    const base = path.join(__dirname, '../miniprogram/pages', name, 'index');
    const wxml = fs.readFileSync(base + '.wxml', 'utf8'), css = fs.readFileSync(base + '.wxss', 'utf8');
    assert.match(wxml, /src="\.\.\/\.\.\/wxs\/graph-gesture\.wxs"/);
    assert.doesNotMatch(wxml, /<movable-(?:view|area)/);
    assert.match(wxml, /prop="\{\{graphGestureConfig\}\}" change:prop="\{\{graphGesture.configure\}\}"/);
    assert.match(wxml, /request="\{\{graphGestureRequest\}\}" change:request="\{\{graphGesture.snapshot\}\}"/);
    assert.match(wxml, /catchtouchmove="\{\{graphGesture.move\}\}"/);
    assert.match(css, /transform-origin:\s*0 0/);
    assert.match(wxml, /data-gesture-action="showPerson"/);
  });
});


test('隐藏后重启画布不会遗留阻断触摸的状态', function () {
  const h = harness();
  h.send('start', [h.touch(1, 100, 100)]);
  h.gesture.snapshot({ id: 10, version: 1 }, null, h.owner, h.instance);
  assert.equal(h.state.blocked, true);
  h.gesture.configure(Object.assign({}, h.initial, { version: 2, disabled: true }), null, h.owner, h.instance);
  h.gesture.configure(Object.assign({}, h.initial, { version: 3, disabled: false }), null, h.owner, h.instance);
  h.send('start', [h.touch(1, 100, 100)]); h.send('move', [h.touch(1, 120, 100)]); h.send('end');
  near(h.state.x, -100);
});
