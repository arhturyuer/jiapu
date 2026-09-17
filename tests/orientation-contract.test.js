const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

['tree', 'example'].forEach(function (pageName) {
  test(pageName + ' 家谱页声明横竖屏切换契约', function () {
    const base = 'miniprogram/pages/' + pageName + '/index';
    const script = read(base + '.js');
    const template = read(base + '.wxml');
    const style = read(base + '.wxss');
    const config = JSON.parse(read(base + '.json'));
    assert.equal(config.pageOrientation, 'portrait');
    assert.match(template, /<page-meta[^>]+page-orientation="\{\{pageOrientation\}\}"[^>]+bindresize="onPageResize"/);
    assert.match(template, /bindtap="togglePageOrientation"/);
    assert.match(template, /bindtap="zoomGraphIn"[\s\S]*bindtap="zoomGraphOut"[\s\S]*bindtap="fitWholeGraph"[\s\S]*bindtap="togglePageOrientation"/);
    assert.doesNotMatch(template, /bindtap="locateGraphFocus"/);
    assert.doesNotMatch(template, /class="graph-control[^>]+bindtap="(?:toggleNameLayout|expandAllBranches)"/);
    assert.match(template, /class="graph-control graph-control-text" bindtap="openDisplaySettings">设置<\/view>/);
    assert.match(script, /pageOrientation:\s*'portrait'/);
    assert.match(script, /togglePageOrientation:\s*function/);
    assert.match(script, /onPageResize:\s*function/);
    assert.match(style, /\.is-landscape/);
    assert.match(style, /\.is-landscape \.graph-viewport \{[^}]*height:\s*100vh/);
  });
});

test('主家谱横屏隐藏页面工具栏和原生 TabBar，并显示当前家谱名称', function () {
  const script = read('miniprogram/pages/tree/index.js');
  const style = read('miniprogram/pages/tree/index.wxss');
  assert.match(style, /\.tree-page\.is-landscape \.tree-toolbar \{[^}]*display:\s*none/);
  assert.match(script, /setNavigationBarTitle\(\{ title: isLandscape && familyName \? familyName : '有谱' \}\)/);
  assert.match(script, /wx\.hideTabBar\(\{ animation: false \}\)/);
  assert.match(script, /wx\.showTabBar\(\{ animation: false \}\)/);
});

test('主家谱竖屏画布只扣除顶部工具栏，不重复预留原生 TabBar 高度', function () {
  const script = read('miniprogram/pages/tree/index.js');
  const style = read('miniprogram/pages/tree/index.wxss');
  assert.match(style, /height:\s*calc\(100vh - 112rpx\)/);
  assert.doesNotMatch(style, /height:\s*calc\(100vh - 112rpx - 120rpx\)/);
  assert.match(script, /isLandscape \? 0 : 112 \* rpxToPx/);
  assert.match(script, /width > height \? 0 : 112 \* width \/ 750/);
  assert.match(style, /\.graph-help \{[^}]*bottom:\s*calc\(24rpx \+ env\(safe-area-inset-bottom\)\)/);
});
