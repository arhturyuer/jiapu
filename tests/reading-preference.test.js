require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const graph = require('../miniprogram/utils/graph-layout');
const viewport = require('../miniprogram/utils/graph-viewport');
const readingGraph = require('../miniprogram/utils/reading-graph');

function fixture(t, stored, options) {
  const previous = global.wx;
  let value = stored;
  const config = options || {};
  global.wx = { getStorageSync: function () { if (config.failRead) throw new Error('read'); return value; },
    setStorageSync: function (_, next) { if (config.failWrite) throw new Error('write'); value = next; },
    getAppBaseInfo: function () { if (config.failInfo) throw new Error('info'); return { fontSizeScaleFactor: config.factor }; } };
  const modulePath = require.resolve('../miniprogram/utils/reading-preference');
  delete require.cache[modulePath];
  const reading = require(modulePath);
  reading.refresh();
  t.after(function () { global.wx = previous; });
  return { reading: reading, config: config, value: function () { return value; } };
}

test('首次使用和异常本机配置回退，未推断年龄或家谱设置', function (t) {
  const { reading } = fixture(t, { elderMode: 'true', fontScale: 99 });
  assert.deepEqual(reading.get(), { elderMode: false, fontScale: 'system' });
  assert.equal(reading.snapshot().bodySize, 16);
  assert.equal(reading.snapshot().contentScale, 1);
});

test('跟随微信刷新，手动覆盖，不发生根字号和倍率重复放大', function (t) {
  const { reading, config } = fixture(t, null, { factor: 1.5 });
  assert.equal(reading.snapshot().bodySize, 24);
  reading.save({ elderMode: true });
  assert.equal(reading.snapshot().bodySize, 30);
  reading.save({ fontScale: 2 });
  config.factor = 1.8;
  reading.refresh();
  assert.equal(reading.snapshot().bodySize, 40);
  assert.equal(reading.snapshot().contentScale, 2.5);
  reading.save({ elderMode: false });
  assert.equal(reading.snapshot().bodySize, 32);
  assert.equal(reading.get().fontScale, 2);
  reading.reset();
  assert.deepEqual(reading.get(), { elderMode: false, fontScale: 'system' });
  assert.equal(reading.snapshot().bodySize, 28.8);
});

test('存储失败仍在本次运行生效并报告未持久化，恢复读取失败可使用手动字号', function (t) {
  const { reading } = fixture(t, null, { failRead: true, failWrite: true, failInfo: true });
  assert.equal(reading.save({ elderMode: true, fontScale: 2 }).persisted, false);
  assert.equal(reading.snapshot().bodySize, 40);
  assert.match(reading.snapshot().readingStyle, /--reading-target:60px/);
  assert.match(reading.snapshot().readingStyle, /--reading-small:36px/);
});

test('接口缺失或无效倍率不影响字号选择', function (t) {
  const { reading, config } = fixture(t, null);
  for (const factor of [0, -1, NaN, Infinity, undefined]) {
    config.factor = factor;
    reading.refresh();
    assert.equal(reading.snapshot().bodySize, 16);
  }
  delete global.wx.getAppBaseInfo;
  reading.refresh();
  reading.save({ fontScale: 1.25 });
  assert.equal(reading.snapshot().bodySize, 20);
});

test('字号和长辈模式独立：所有手动档在关闭后仍生效，只有开启时启用长辈布局', function (t) {
  const { reading, config } = fixture(t, null, { factor: 0.8 });
  for (const fontScale of [1, 1.25, 1.5, 2]) {
    reading.save({ elderMode: true, fontScale: fontScale });
    assert.equal(reading.snapshot().bodySize, 20 * fontScale);
    assert.equal(reading.snapshot().readingLarge, true);
    reading.save({ elderMode: false });
    assert.equal(reading.snapshot().bodySize, 16 * fontScale);
    assert.equal(reading.snapshot().readingLarge, fontScale > 1);
    assert.equal(reading.get().fontScale, fontScale);
  }
  reading.save({ elderMode: true, fontScale: 'system' });
  assert.equal(reading.snapshot().readingLarge, true, '微信缩小字号不关闭已开启的长辈布局');
  reading.save({ elderMode: false });
  config.factor = 1;
  reading.refresh();
  assert.equal(reading.snapshot().readingLarge, false);
});

test('页面隐藏停止订阅，返回只更新阅读状态，不改草稿或家谱偏好', function (t) {
  const { reading } = fixture(t, null);
  const page = { data: { name: '草稿姓名', nameLayout: 'vertical', showGenderColors: false }, changes: 0,
    setData: function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); },
    onReadingChange: function () { this.changes++; } };
  reading.attach(page);
  reading.save({ elderMode: true });
  assert.equal(page.data.readingBodySize, 20);
  reading.detach(page);
  reading.save({ fontScale: 2 });
  assert.equal(page.data.readingBodySize, 20);
  reading.attach(page);
  assert.equal(page.data.readingBodySize, 40);
  assert.equal(page.data.name, '草稿姓名');
  assert.equal(page.data.nameLayout, 'vertical');
  assert.equal(page.data.showGenderColors, false);
  reading.detach(page);
});

const persons = [{ _id: 'father', name: '父亲', gender: 'male' }, { _id: 'mother', name: '母亲', gender: 'female' },
  { _id: 'child', name: '长姓名测试成员', gender: 'female' }];
const relations = [{ _id: 'spouse', type: 'spouse', fromPersonId: 'father', toPersonId: 'mother' },
  { _id: 'parent', type: 'parent_child', fromPersonId: 'father', toPersonId: 'child' },
  { _id: 'parent2', type: 'parent_child', fromPersonId: 'mother', toPersonId: 'child' }];

test('默认布局与所有旧调用一致，缩放只改变几何，不改关系或导出默认', function () {
  for (const nameLayout of ['horizontal', 'vertical']) {
    const original = graph.layoutGraph(persons, relations, { nameLayout: nameLayout });
    assert.deepEqual(graph.layoutGraph(persons, relations, { nameLayout: nameLayout, contentScale: 1 }), original);
    assert.deepEqual(graph.layoutGraph(persons, relations, { nameLayout: nameLayout, contentScale: NaN }), original);
    for (const factor of [1.25, 1.5, 2, 2.5]) {
      const scaled = graph.layoutGraph(persons, relations, { nameLayout: nameLayout, contentScale: factor });
      assert.equal(scaled.nodeWidth, original.nodeWidth * factor);
      assert.equal(scaled.nodeHeight, original.nodeHeight * factor);
      scaled.lines.forEach(function (line, i) {
        assert.deepEqual(line.relationIds, original.lines[i].relationIds);
        assert.equal(line.x1, original.lines[i].x1 * factor);
        assert.equal(line.y2, original.lines[i].y2 * factor);
        assert.equal(line.angle, original.lines[i].angle);
      });
      assert.deepEqual(graph.layoutGraph(persons, relations, { nameLayout: nameLayout }), original, '导出无参数调用仍使用默认布局');
    }
  }
});

test('小屏到大屏首次及看清姓名使用实际图谱字号，200%长辈姓名达到40px', function () {
  const layout = graph.layoutGraph(persons, relations, { contentScale: 2.5 });
  for (const width of [320, 375, 430, 600, 1024]) {
    const screen = { width: width, height: 500, rpxToPx: width / 750 };
    const result = viewport.initialTransform(layout, screen, { initialNameSize: 40, nodeNameRpx: 70 });
    assert.ok(Math.abs(70 * screen.rpxToPx * result.scale - 40) < 1e-9);
  }
});

test('字号变化保持选中人物的屏幕位置和缩放，未选中时选择最近人物', function () {
  const old = graph.layoutGraph(persons, relations);
  const page = { data: { rawPersons: persons, rawRelations: relations, viewMode: 'full', viewpointId: '', selectedPersonId: 'child', graphContentScale: 2.5 },
    _lastLayout: old, getGraphViewport: function () { return { width: 375, height: 500, rpxToPx: 0.5 }; },
    getGraphTransform: function () { return this.transform; }, transform: { x: -100, y: -80, scale: 1.1 },
    renderGraph: function () { this._lastLayout = graph.layoutGraph(persons, relations, { contentScale: 2.5 }); },
    commitGraphTransform: function (value) { this.transform = value; } };
  const before = readingGraph.anchor(page);
  readingGraph.changed.call(page, { contentScale: 1 }, { contentScale: 2.5 });
  const after = readingGraph.anchor(page);
  assert.equal(after.id, before.id);
  assert.equal(after.scale, before.scale);
  assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
  page.data.selectedPersonId = '';
  assert.ok(persons.some(function (person) { return person._id === readingGraph.anchor(page).id; }));
});

test('所有注册页面可获得阅读样式，保留广告配置与独立导出调用', function () {
  const root = path.resolve(__dirname, '../miniprogram');
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'app.json'))).pages;
  for (const page of pages) assert.match(fs.readFileSync(path.join(root, page + '.wxml'), 'utf8'), /reading-root[\s\S]*readingStyle/, page);
  assert.match(fs.readFileSync(path.join(root, 'utils/tree-poster-flow.js'), 'utf8'), /graphLayout.layoutGraph/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'utils/tree-poster-flow.js'), 'utf8'), /graphContentScale|contentScale|reading/);
  for (const page of ['tree', 'example']) {
    const template = fs.readFileSync(path.join(root, 'pages', page, 'index.wxml'), 'utf8');
    if (page === 'tree') {
      assert.match(template, /class="graph-controls"[^>]*wx:if="\{\{nodes.length > 0\}\}"/);
      assert.doesNotMatch(template, /reading-graph-tools/);
    } else {
      assert.match(template, /graphToolsStyle/);
      assert.doesNotMatch(template, /reading-graph-tools/);
    }
    assert.match(template, /item.isAnimatedFlow && !elderMode/);
    assert.match(template, /memberAdMounted/);
  }
});

test('迟到的图谱测量不覆盖新的字号或切谱后的布局', function () {
  const callbacks = [];
  const screen = { width: 375, height: 500, rpxToPx: 0.5 };
  const page = { data: { rawPersons: persons, viewMode: 'full', viewpointId: '', selectedPersonId: 'child', graphContentScale: 1.25 },
    _lastLayout: graph.layoutGraph(persons, relations), commits: 0,
    getGraphViewport: function () { return screen; }, getWindowSize: function () { return { windowWidth: 375, windowHeight: 500 }; },
    getGraphTransform: function () { return { x: 0, y: 0, scale: 1 }; }, createSelectorQuery: function () {},
    measureGraphViewport: function (_, callback) { callbacks.push(callback); },
    renderGraph: function () { this._lastLayout = graph.layoutGraph(persons, relations, { contentScale: this.data.graphContentScale }); },
    commitGraphTransform: function () { this.commits++; } };
  readingGraph.changed.call(page, { contentScale: 1 }, { contentScale: 1.25 });
  page.data.graphContentScale = 1.5;
  readingGraph.changed.call(page, { contentScale: 1.25 }, { contentScale: 1.5 });
  callbacks[0](screen);
  assert.equal(page.commits, 0);
  callbacks[1](screen);
  assert.equal(page.commits, 1);
  page.data.graphContentScale = 2;
  readingGraph.changed.call(page, { contentScale: 1.5 }, { contentScale: 2 });
  page._lastLayout = graph.layoutGraph([{ _id: 'another-family', name: '虚构家人' }], []);
  callbacks[2](screen);
  assert.equal(page.commits, 1);
});

test('大字底栏按实际高度留白，避免将页面宽度换算成错误的正文空间', async function (t) {
  const { reading } = fixture(t);
  let height = 230;
  const page = { route: 'pages/add-member/index', data: {}, setData: function (patch) { Object.assign(this.data, patch); },
    createSelectorQuery: function () {
      const query = { select: function () { return query; }, boundingClientRect: function () { return query; },
        exec: function (callback) { callback([{ height: height }, null]); } };
      return query;
    } };
  reading.measureDock(page);
  await new Promise(function (resolve) { setTimeout(resolve, 10); });
  assert.equal(page.data.readingDockStyle, '--reading-dock-space:254px;');
  height = 340;
  page.route = 'pages/family-profile/index';
  reading.watchDock(page);
  page.setData({ editing: true });
  reading.measureDock(page);
  await new Promise(function (resolve) { setTimeout(resolve, 10); });
  assert.equal(page.data.readingDockStyle, '--reading-dock-space:364px;');
  reading.detach(page);
});
