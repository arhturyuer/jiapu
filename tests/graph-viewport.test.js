const test = require('node:test');
const assert = require('node:assert/strict');
const viewport = require('../miniprogram/utils/graph-viewport');

const graph = {
  width: 1500,
  height: 1200,
  nodes: [{ _id: 'focus', x: 600, y: 420 }]
};
const screen = { width: 375, height: 600, rpxToPx: 0.5 };

test('首屏姓名大小与家谱规模、屏幕宽度及横竖屏无关', function () {
  const layouts = [
    { width: 328, height: 324, nodes: [{ _id: 'single', x: 80, y: 80 }] },
    { width: 24000, height: 16000, nodes: [{ _id: 'root', x: 80, y: 80 }] }
  ];
  [320, 375, 430, 750, 844].forEach(function (width) {
    const target = { width: width, height: width > 430 ? 300 : 520, rpxToPx: width / 750 };
    layouts.forEach(function (layout) {
      const result = viewport.initialTransform(layout, target, { currentScale: 0.32 });
      assert.ok(Math.abs(28 * target.rpxToPx * result.scale - 16) < 1e-9);
      assert.equal(viewport.zoomClassForScale(result.scale * target.rpxToPx / 0.5), 'zoom-detail');
    });
  });
});

test('较大家谱首屏优先定位人数密集的新一代中间，不停在祖先或空白处', function () {
  const layout = { width: 12000, height: 8000, nodes: [
    { _id: 'root', x: 4600, y: 80 },
    { _id: 'parent', x: 4600, y: 360 },
    { _id: 'child-a', x: 4200, y: 920 },
    { _id: 'child-b', x: 4400, y: 920 },
    { _id: 'child-c', x: 4600, y: 920 },
    { _id: 'child-d', x: 4800, y: 920 },
    { _id: 'child-e', x: 5000, y: 920 }
  ] };
  const result = viewport.initialTransform(layout, screen);
  const pixels = screen.rpxToPx * result.scale;
  assert.ok(Math.abs(result.x + (4600 + 84) * pixels - screen.width / 2) < 1e-9);
  assert.ok(Math.abs(result.y + (920 + 82) * pixels - screen.height / 2) < 1e-9);
  const reordered = viewport.initialTransform(Object.assign({}, layout, { nodes: layout.nodes.slice().reverse() }), screen);
  assert.deepEqual(reordered, result);
  assert.ok(viewport.fitTransform(layout, screen, { fitAll: true }).scale < result.scale);
});

test('人数相当时选择有效关系更丰富的区域，重复和已删除关系不增加权重', function () {
  const layout = { width: 10000, height: 4000, nodes: [
    { _id: 'a', x: 800, y: 360 }, { _id: 'b', x: 1000, y: 360 }, { _id: 'c', x: 1200, y: 360 },
    { _id: 'd', x: 4800, y: 360 }, { _id: 'e', x: 5000, y: 360 }, { _id: 'f', x: 5200, y: 360 }
  ] };
  const relations = [
    { type: 'spouse', fromPersonId: 'a', toPersonId: 'b' },
    { type: 'spouse', fromPersonId: 'b', toPersonId: 'a' },
    { type: 'spouse', fromPersonId: 'a', toPersonId: 'b' },
    { type: 'spouse', fromPersonId: 'b', toPersonId: 'c', status: 'deleted' },
    { type: 'parent_child', fromPersonId: 'b', toPersonId: 'hidden' },
    { type: 'spouse', fromPersonId: 'd', toPersonId: 'e' },
    { type: 'spouse', fromPersonId: 'e', toPersonId: 'f' }
  ];
  const result = viewport.initialTransform(layout, screen, { relations: relations });
  const pixels = result.scale * screen.rpxToPx;
  assert.ok(Math.abs(result.x + (5000 + 84) * pixels - screen.width / 2) < 1e-9);
  assert.deepEqual(result, viewport.initialTransform(Object.assign({}, layout, { nodes: layout.nodes.slice().reverse() }), screen, { relations: relations.slice().reverse() }));
  const explicit = viewport.initialTransform(layout, screen, { relations: relations, focusPersonId: 'a' });
  assert.ok(Math.abs(explicit.x + (800 + 84) * pixels - screen.width / 2) < 1e-9);
});

test('稀疏等密度多代家谱偏向中间或较新一代，单代也能定位人数集中处', function () {
  const layout = { width: 12000, height: 8000, nodes: [
    { _id: 'old', x: 4000, y: 80 }, { _id: 'middle', x: 4000, y: 1080 }, { _id: 'new', x: 4000, y: 2080 }
  ] };
  const result = viewport.initialTransform(layout, screen);
  const pixels = result.scale * screen.rpxToPx;
  assert.ok(Math.abs(result.y + (1080 + 82) * pixels - screen.height / 2) < 1e-9);
  layout.nodes.splice(1, 1);
  const twoGenerations = viewport.initialTransform(layout, screen);
  assert.ok(Math.abs(twoGenerations.y + (2080 + 82) * pixels - screen.height / 2) < 1e-9);
  const singleGeneration = { width: 12000, height: 900, nodes: [
    { _id: 'isolated', x: 80, y: 80 }, { _id: 'a', x: 4000, y: 80 },
    { _id: 'b', x: 4200, y: 80 }, { _id: 'c', x: 4400, y: 80 }
  ] };
  const row = viewport.initialTransform(singleGeneration, screen);
  assert.ok(Math.abs(row.x + (4200 + 84) * pixels - screen.width / 2) < 1e-9);
});

test('小家谱和竖排姓名按可读大小居中，空图不会产生无效坐标', function () {
  const layout = { width: 248, height: 324, nodeWidth: 88, nodeHeight: 164, nodes: [{ _id: 'one', x: 80, y: 80 }] };
  const result = viewport.initialTransform(layout, screen);
  const pixels = result.scale * screen.rpxToPx;
  assert.ok(Math.abs(result.x + layout.width * pixels / 2 - screen.width / 2) < 1e-9);
  assert.ok(Math.abs(result.y + layout.height * pixels / 2 - screen.height / 2) < 1e-9);
  const empty = viewport.initialTransform({ width: 750, height: 900, nodes: [] }, screen);
  assert.ok(Number.isFinite(empty.x) && Number.isFinite(empty.y) && Number.isFinite(empty.scale));
});

test('分享指定人物首屏以统一可读大小定位，失效人物回到默认密集区域', function () {
  const result = viewport.initialTransform(graph, screen, { focusPersonId: 'focus', currentScale: 0.32 });
  const pixels = result.scale * screen.rpxToPx;
  assert.ok(Math.abs(result.x + (600 + 84) * pixels - screen.width / 2) < 1e-9);
  assert.ok(Math.abs(result.y + (420 + 58) * pixels - screen.height * 0.38) < 1e-9);
  assert.ok(Math.abs(28 * pixels - 16) < 1e-9);
  const missing = viewport.initialTransform(graph, screen, { focusPersonId: 'removed' });
  assert.deepEqual(missing, viewport.initialTransform(graph, screen));
});

test('适配全谱时保持在缩放边界内并居中', function () {
  const result = viewport.fitTransform(graph, screen, { fitAll: true });
  assert.ok(result.scale >= viewport.MIN_SCALE);
  assert.ok(result.scale <= 1);
  assert.equal(result.x, (screen.width - graph.width * screen.rpxToPx * result.scale) / 2);
  assert.equal(result.y, (screen.height - graph.height * screen.rpxToPx * result.scale) / 2);
});

test('人物定位保持可读缩放并把目标放在稳定位置', function () {
  const result = viewport.fitTransform(graph, screen, {
    fitAll: false,
    focusPersonId: 'focus',
    currentScale: 0.4,
    minimumFocusScale: 0.68
  });
  assert.equal(result.scale, 0.68);
  assert.equal(result.x + (600 + 84) * screen.rpxToPx * result.scale, screen.width / 2);
  assert.equal(result.y + (420 + 58) * screen.rpxToPx * result.scale, screen.height * 0.38);
});

test('按钮缩放保持屏幕中心对应的内容点不变', function () {
  const before = { x: -180, y: -90, scale: 0.6 };
  const after = viewport.zoomAroundCenter(before, 0.75, screen);
  const beforeContentX = (screen.width / 2 - before.x) / before.scale;
  const beforeContentY = (screen.height / 2 - before.y) / before.scale;
  const afterContentX = (screen.width / 2 - after.x) / after.scale;
  const afterContentY = (screen.height / 2 - after.y) / after.scale;
  assert.ok(Math.abs(beforeContentX - afterContentX) < 1e-9);
  assert.ok(Math.abs(beforeContentY - afterContentY) < 1e-9);
});

test('缩放等级带迟滞，临界值附近不会反复切换', function () {
  assert.equal(viewport.zoomClassForScale(0.7, 'zoom-detail'), 'zoom-compact');
  assert.equal(viewport.zoomClassForScale(0.5, 'zoom-overview'), 'zoom-overview');
  assert.equal(viewport.zoomClassForScale(0.58, 'zoom-overview'), 'zoom-compact');
});

test('横屏按 rpx 比例降低最小缩放且不低于安全下限', function () {
  assert.equal(viewport.minimumScaleForViewport({ rpxToPx: 0.5 }), viewport.MIN_SCALE);
  assert.equal(viewport.minimumScaleForViewport({ rpxToPx: 1 }), 0.16);
  assert.equal(viewport.minimumScaleForViewport({ rpxToPx: 4 }), 0.12);
});

test('横竖屏切换保持逻辑中心和人物实际显示比例', function () {
  const portrait = { width: 375, height: 520, rpxToPx: 0.5 };
  const landscape = { width: 740, height: 300, rpxToPx: 740 / 750 };
  const before = { x: -120, y: -60, scale: 0.8 };
  const after = viewport.resizeTransform(before, portrait, landscape);
  const beforeLogicalX = (portrait.width / 2 - before.x) / before.scale / portrait.rpxToPx;
  const beforeLogicalY = (portrait.height / 2 - before.y) / before.scale / portrait.rpxToPx;
  const afterLogicalX = (landscape.width / 2 - after.x) / after.scale / landscape.rpxToPx;
  const afterLogicalY = (landscape.height / 2 - after.y) / after.scale / landscape.rpxToPx;
  assert.ok(Math.abs(beforeLogicalX - afterLogicalX) < 1e-9);
  assert.ok(Math.abs(beforeLogicalY - afterLogicalY) < 1e-9);
  assert.ok(Math.abs(before.scale * portrait.rpxToPx - after.scale * landscape.rpxToPx) < 1e-9);
  const roundTrip = viewport.resizeTransform(after, landscape, portrait);
  assert.ok(Math.abs(roundTrip.x - before.x) < 1e-9);
  assert.ok(Math.abs(roundTrip.y - before.y) < 1e-9);
  assert.ok(Math.abs(roundTrip.scale - before.scale) < 1e-9);
});

test('尺寸切换后的缩放遵守新视口边界', function () {
  const result = viewport.resizeTransform(
    { x: 0, y: 0, scale: 0.13 },
    { width: 375, height: 520, rpxToPx: 0.5 },
    { width: 844, height: 320, rpxToPx: 844 / 750 },
    { minimumScale: 0.2, maximumScale: 0.7 }
  );
  assert.equal(result.scale, 0.2);
});
