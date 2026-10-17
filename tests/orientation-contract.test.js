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
    if (pageName === 'tree') {
      const controls = template.match(/<view class="graph-controls"[\s\S]*?<\/scroll-view>/)[0];
      assert.equal((controls.match(/class="graph-control(?: |")/g) || []).length, 6);
      assert.doesNotMatch(controls, /generatePoster|openPdfExport|更多/);
      assert.match(controls, /bindtap="openDisplaySettings"[^>]*><text class="graph-control-label">设置/);
      assert.match(controls, /bindtap="toggleCleanScreen"[^>]*><text class="graph-control-label">清屏/);
      assert.match(controls, /bindtap="fitWholeGraph"[^>]*><text class="graph-control-label">全图/);
      assert.doesNotMatch(template, /reading-graph-tools|reading-more/);
      assert.match(template, /bindtap="openExportSheet"/);
    } else {
      assert.match(template, /class="graph-control graph-control-text" bindtap="openDisplaySettings">设置<\/view>/);
      assert.match(template, /bindtap="generatePoster">图片<\/view>\s*<view[^>]*bindtap="openPdfExport">PDF<\/view>\s*<view[^>]*bindtap="toggleCleanScreen"[^>]*aria-label="清屏查看家谱"[^>]*>\s*<view class="clean-screen-icon"[^>]*>[\s\S]*?<\/view>\s*<\/view>\s*<\/view>/);
    }
    assert.match(template, /<button class="clean-screen-exit"[^>]*aria-label="退出清屏"[^>]*>\s*<text wx:if="\{\{elderMode\}\}">退出清屏<\/text>\s*<view class="clean-screen-icon is-exit"/);
    assert.match(template, /<text wx:if="\{\{elderMode\}\}">退出清屏<\/text>/);
    assert.match(script, /pageOrientation:\s*'portrait'/);
    assert.match(script, /togglePageOrientation:\s*function/);
    assert.match(script, /onPageResize:\s*function/);
    assert.match(style, /\.is-landscape/);
    if (pageName === 'tree') assert.match(style, /\.is-landscape \.graph-viewport \{[^}]*height:\s*100vh/);
    else assert.match(style, /\.is-landscape \.graph-viewport \{[^}]*height:\s*100vh/);
  });
});

test('主家谱横屏隐藏页面工具栏和原生 TabBar，并显示当前家谱名称', function () {
  const script = read('miniprogram/pages/tree/index.js');
  const style = read('miniprogram/pages/tree/index.wxss');
  assert.match(style, /\.tree-page\.is-landscape \.tree-toolbar \{[^}]*display:\s*none/);
  assert.match(read('miniprogram/pages/tree/index.wxml'), /page-navigation title="\{\{currentFamily.name \|\| '有谱'\}\}"/);
  assert.doesNotMatch(script, /setNavigationBarTitle/);
  assert.match(script, /wx\.hideTabBar\(\{ animation: false \}\)/);
  assert.match(script, /wx\.showTabBar\(\{ animation: false \}\)/);
});

test('主家谱竖屏画布扣除导航和工具栏，不重复预留原生 TabBar 高度', function () {
  const script = read('miniprogram/pages/tree/index.js');
  const style = read('miniprogram/pages/tree/index.wxss');
  assert.match(read('miniprogram/styles/navigation-graph.wxss'), /\.navigation-graph \.graph-viewport \{[^}]*flex:1; height:auto !important/);
  assert.match(script, /height - \(this.data.navigationHeight \|\| 0\)/);
  assert.doesNotMatch(style, /height:\s*calc\(100vh - 112rpx - 120rpx\)/);
  assert.match(script, /const toolbar = this\.getToolbarHeight\(info\)/);
  assert.match(script, /const toolbar = this\.getToolbarHeight\(size\)/);
  assert.match(style, /\.graph-help \{[^}]*bottom:\s*calc\(24rpx \+ env\(safe-area-inset-bottom\)\)/);
});
