require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../miniprogram/utils/api');

function pageFor(t, name, data) {
  const previous = { wx: global.wx, getApp: global.getApp, Page: global.Page };
  const calls = { back: 0, toasts: [] };
  global.wx = {
    showToast: function (options) { calls.toasts.push(options.title); },
    navigateBack: function () { calls.back++; }, disableAlertBeforeUnload: function () {}
  };
  global.getApp = function () { return { globalData: { environment: 'fixture' }, invalidateFamilyData: function () {} }; };
  let definition;
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/' + name + '/index');
  delete require.cache[modulePath];
  require(modulePath);
  t.after(function () { Object.assign(global, previous); });
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data, data);
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  return { page: page, calls: calls };
}

test('阅读设置唯一入口在我的帮助与反馈，资料加载或失败也可进入', function () {
  const root = path.resolve(__dirname, '../miniprogram');
  const pages = JSON.parse(fs.readFileSync(path.join(root, 'app.json'))).pages;
  for (const route of pages) {
    const source = fs.readFileSync(path.join(root, route + '.wxml'), 'utf8');
    const entries = source.match(/(?:bindtap="openReadingSettings"|data-action="openReadingSettings")/g) || [];
    assert.equal(entries.length, route === 'pages/profile/index' ? 1 : 0, route);
  }
  const profile = fs.readFileSync(path.join(root, 'pages/profile/index.wxml'), 'utf8');
  assert.match(profile, /template name="readingHelpEntry"[\s\S]*帮助与反馈[\s\S]*bindtap="openReadingSettings"/);
  assert.equal((profile.match(/template is="readingHelpEntry"/g) || []).length, 2);
  assert.match(profile, /wx:if="\{\{loading \|\| error\}\}"[\s\S]*template is="readingHelpEntry"/);
  assert.match(profile, /长辈模式\{\{elderMode \? '已开启' : '未开启'\}\}/);
  const help = profile.match(/<template name="readingHelpEntry">([\s\S]*?)<\/template>/)[1];
  assert.equal((help.match(/surface-card/g) || []).length, 1);
  assert.match(help, /用户反馈群[\s\S]*class="help-divider"[\s\S]*bindtap="openReadingSettings"[\s\S]*长辈模式与字号[\s\S]*简化操作，调大按钮与字号/);
});

for (const name of ['tree', 'example']) {
  test(name + '普通模式首次选中、再次打开抽屉；长辈模式一次打开', function (t) {
    const { page } = pageFor(t, name, { rawPersons: [{ _id: 'fictional', name: '虚构家人' }], selectedPersonId: '', elderMode: false });
    let opened = 0;
    page.decorateSelectedPerson = function (person) { return person; };
    page.openMemberActions = function () { opened++; };
    page.renderGraph = function (_, __, options) { page.setData(options.statePatch); };
    const event = { currentTarget: { dataset: { id: 'fictional' } } };
    page.showPerson(event);
    assert.equal(opened, 0);
    assert.equal(page.data.selectedPersonId, 'fictional');
    page.showPerson(event);
    assert.equal(opened, 1);
    page.setData({ elderMode: true, selectedPersonId: '' });
    page.showPerson(event);
    assert.equal(opened, 2);
    page.setData({ elderMode: false, selectedPersonId: '' });
    page.showPerson(event);
    assert.equal(opened, 2);
  });
}

for (const name of ['add-member', 'edit-member']) {
  for (const elderMode of [false, true]) {
    test(name + (elderMode ? '长辈模式持续显示保存结果' : '普通模式保留原成功提示和自动返回时机'), async function (t) {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { page, calls } = pageFor(t, name, { elderMode: elderMode, name: '虚构家人', gender: 'male', lifeStatus: 'living',
        personId: 'fictional', familyId: 'fictional-family', loadingContext: false, hasFormChanges: true });
      page._initialForm = { name: '旧名', gender: 'male', lifeStatus: 'living', birthDateInfo: '', deathDateInfo: '', birthPlace: '', bio: '' };
      page.createNewPerson = function () { return Promise.resolve({ pending: false }); };
      t.mock.method(api, 'call', function () { return Promise.resolve({ pending: false }); });
      await page.submit();
      assert.equal(page.data.readingSaved, true);
      assert.equal(calls.toasts.at(-1), name === 'add-member' ? '关系已保存' : '资料已保存');
      assert.equal(calls.back, 0);
      const delay = name === 'add-member' ? 600 : 700;
      t.mock.timers.tick(delay - 1);
      assert.equal(calls.back, 0);
      t.mock.timers.tick(1);
      assert.equal(calls.back, elderMode ? 0 : 1);
      if (elderMode) { page.readingBack(); assert.equal(calls.back, 1); }
    });
  }
}

test('普通模式失败保持输入和原提示，不自动聚焦；长辈模式定位字段', async function (t) {
  const { page, calls } = pageFor(t, 'add-member', { elderMode: false, name: '', gender: 'male', loadingContext: false });
  let scrolls = 0;
  global.wx.pageScrollTo = function () { scrolls++; };
  await page.submit();
  assert.equal(page.data.name, '');
  assert.equal(calls.back, 0);
  assert.equal(calls.toasts.at(-1), '请完整选择成员和关系');
  assert.equal(page.data.readingNameFocus, undefined);
  assert.equal(scrolls, 0);
  page.setData({ elderMode: true });
  await page.submit();
  assert.equal(page.data.readingNameFocus, true);
  assert.equal(scrolls, 1);
});

test('离开表单清除返回计时，不把下一页弹回', async function (t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { page, calls } = pageFor(t, 'add-member', { elderMode: false, name: '虚构家人', gender: 'male', loadingContext: false });
  page.createNewPerson = function () { return Promise.resolve({ pending: false }); };
  await page.submit();
  page.onHide();
  t.mock.timers.tick(1000);
  assert.equal(calls.back, 0);
  page.onUnload();
});

test('标准普通模式日期保留原滚轮尺寸，大字和长辈模式同步放大选中行', function () {
  const root = path.resolve(__dirname, '../miniprogram');
  const template = fs.readFileSync(path.join(root, 'components/person-date-picker/index.wxml'), 'utf8');
  assert.match(template, /readingLarge \? \(readingBodySize \* 1\.5 \+ 24\) \+ 'px' : \(isWide \? '44px' : '88rpx'\)/);
  const css = fs.readFileSync(path.join(root, 'styles/reading.wxss'), 'utf8');
  assert.match(css, /\.reading-large \.date-option \{[^}]*height:calc\(var\(--reading-body/);
  assert.match(css, /\.reading-elder button \{ min-width:60px; min-height:60px;/);
  assert.doesNotMatch(css, /\.reading-root (?:button|\[data-reading-control\]) \{[^}]*min-height/);
  assert.doesNotMatch(css, /\.reading-root \.graph-controls \{[^}]*grid-template-columns/);
});

test('开屏标准普通模式保留原区域分配，仅大字布局使用按钮实测高度', function (t) {
  const { page } = pageFor(t, 'launch-ad', { adVisible: true, readingLarge: false });
  global.wx.getWindowInfo = function () { return { windowWidth: 375, windowHeight: 667 }; };
  global.wx.createSelectorQuery = function () {
    const query = { select: function () { return query; }, boundingClientRect: function () { return query; },
      exec: function (callback) { callback([null, null, null, { width: 375, height: 200 }, null, { height: 280 }]); } };
    return query;
  };
  page.updateLayout();
  const originalHeight = page.data.contentHeight;
  page.inspectLayout();
  assert.equal(page.data.contentHeight, originalHeight);
  assert.equal(page._readingActionsHeight, undefined);
  for (const elderMode of [false, true]) {
    page.setData({ elderMode: elderMode, readingLarge: true });
    page.inspectLayout();
    assert.equal(page._readingActionsHeight, 280);
    assert.equal(page.data.contentHeight, 667 - 44 - 280);
  }
  page.setData({ readingLarge: false });
  page.updateLayout();
  assert.equal(page.data.contentHeight, originalHeight);
});
