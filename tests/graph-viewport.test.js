const test = require('node:test');
const assert = require('node:assert/strict');
const viewport = require('../miniprogram/utils/graph-viewport');

const graph = {
  width: 1500,
  height: 1200,
  nodes: [{ _id: 'focus', x: 600, y: 420 }]
};
const screen = { width: 375, height: 600, rpxToPx: 0.5 };

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
