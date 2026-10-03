require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../miniprogram/utils/api');
const shareCard = require('../miniprogram/utils/share-card');

const root = path.resolve(__dirname, '..');

function loadPage(relativePath, app) {
  const previousPage = global.Page;
  const previousGetApp = global.getApp;
  let definition;
  global.getApp = function () { return app || {}; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve(relativePath);
  delete require.cache[modulePath];
  try { require(modulePath); } finally {
    global.Page = previousPage;
    global.getApp = previousGetApp;
  }
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function (patch) { Object.assign(page.data, patch); };
  return page;
}

test('我的页产品卡只介绍有谱，使用独立图片和落地页', function () {
  const card = shareCard.create({ kind: 'discovery', variant: 'intro', familyName: '私密家谱', inviterName: '私密姓名' });
  assert.deepEqual(card, {
    kind: 'discovery',
    title: '我发现有谱做家谱很好用，推荐给你',
    path: '/pages/share-intro/index?source=share_menu',
    imageUrl: '/images/share/youpu-intro.jpg'
  });
  assert.doesNotMatch(JSON.stringify(card), /私密家谱|私密姓名/);
  assert.equal(shareCard.create({ kind: 'discovery' }).path, '/pages/create-family/index?source=share_menu');
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  const profileStyles = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxss'), 'utf8');
  const landing = fs.readFileSync(path.join(root, 'miniprogram/pages/share-intro/index.wxml'), 'utf8');
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  assert.match(profile, /open-type="share"/);
  assert.match(profile, /分享有谱家谱/);
  assert.ok(profile.indexOf('关于有谱') < profile.indexOf('<view class="setting-row setting-share-row"'));
  assert.match(profile, /<view class="setting-row setting-share-row"[^>]*><view class="setting-share-copy">.*class="setting-title"[^>]*>分享有谱<\/text>.*<\/view><text class="setting-arrow">›<\/text><button class="setting-share-hit" open-type="share"[^>]*><\/button><\/view>/);
  assert.match(profileStyles, /\.setting-row\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between/);
  assert.match(profileStyles, /\.setting-share-row\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*hidden/);
  assert.match(profileStyles, /\.setting-share-copy\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0/);
  assert.match(profileStyles, /\.setting-share-hit\s*\{[^}]*position:\s*absolute;[^}]*left:\s*0;[^}]*top:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*min-width:\s*100%;[^}]*transform:\s*scale\(8\)/);
  assert.match(landing, /先看示例家谱/);
  assert.match(landing, /创建我的家谱/);
  assert.match(landing, /仅受邀家人可访问/);
  assert.ok(appConfig.pages.includes('pages/share-intro/index'));
});

test('我的页分享只记录通用发现卡的准备和发送', function () {
  const previousCall = api.call;
  const calls = [];
  api.call = function (type, payload) { calls.push({ type: type, payload: payload }); return Promise.resolve(); };
  try {
    const profile = loadPage('../miniprogram/pages/profile/index');
    const message = profile.onShareAppMessage();
    assert.equal(message.path, '/pages/share-intro/index?source=share_menu');
    assert.equal(message.imageUrl, '/images/share/youpu-intro.jpg');
    message.success();
    assert.deepEqual(calls, [
      { type: 'share.record', payload: { stage: 'prepared', kind: 'discovery' } },
      { type: 'share.record', payload: { stage: 'sent', kind: 'discovery' } }
    ]);
  } finally { api.call = previousCall; }
});

test('介绍页记录一次打开，并将分享来源传到示例与创建', async function () {
  const previousCall = api.call;
  const previousWx = global.wx;
  const calls = [];
  const urls = [];
  api.call = function (type, payload) { calls.push({ type: type, payload: payload }); return Promise.resolve(); };
  global.wx = { navigateTo: function (options) { urls.push(options.url); }, redirectTo: function (options) { urls.push(options.url); } };
  try {
    const landing = loadPage('../miniprogram/pages/share-intro/index', { ensureLogin: function () { return Promise.resolve(); } });
    landing.onLoad({ source: 'share_menu' });
    await new Promise(function (resolve) { setImmediate(resolve); });
    landing.openExamples();
    landing.createFamily();
    assert.deepEqual(urls, [
      '/pages/examples/index?source=share_menu',
      '/pages/create-family/index?source=share_menu&opened=1'
    ]);
    assert.deepEqual(calls, [{ type: 'share.record', payload: { stage: 'opened', kind: 'discovery' } }]);
  } finally { api.call = previousCall; global.wx = previousWx; }
});

test('经示例列表与示例图创建时保留来源，创建页不重复记录打开', function () {
  const previousCall = api.call;
  const previousWx = global.wx;
  const calls = [];
  const urls = [];
  api.call = function (type, payload) { calls.push({ type: type, payload: payload }); return Promise.resolve(); };
  global.wx = { navigateTo: function (options) { urls.push(options.url); }, redirectTo: function (options) { urls.push(options.url); } };
  try {
    const examples = loadPage('../miniprogram/pages/examples/index');
    examples.loadExamples = function () { return Promise.resolve(); };
    examples.onLoad({ source: 'share_menu' });
    examples.openExample({ currentTarget: { dataset: { slug: 'family-demo' } } });
    examples.createFamily();

    const example = loadPage('../miniprogram/pages/example/index');
    example.loadExample = function () { return Promise.resolve(); };
    example.onLoad({ slug: 'family-demo', source: 'share_menu' });
    example.createFamily();
    example.data.selectedPerson = { _id: 'person-1' };
    example.openMemberDetail();

    const detail = loadPage('../miniprogram/pages/example-person-detail/index');
    detail.onLoad({ slug: 'family-demo', id: 'person-1', source: 'share_menu' });
    detail.explainCreate();
    detail.viewFromPerson();

    const create = loadPage('../miniprogram/pages/create-family/index');
    create.onLoad({ source: 'share_menu', opened: '1' });
    assert.equal(create.data.source, 'share_menu');
    assert.deepEqual(urls, [
      '/pages/example/index?slug=family-demo&source=share_menu',
      '/pages/create-family/index?source=share_menu&opened=1',
      '/pages/create-family/index?source=share_menu&opened=1&example=family-demo',
      '/pages/example-person-detail/index?slug=family-demo&id=person-1&source=share_menu',
      '/pages/create-family/index?source=share_menu&opened=1&example=family-demo',
      '/pages/example/index?slug=family-demo&personId=person-1&source=share_menu'
    ]);
    assert.deepEqual(calls, []);
    create.onLoad({ source: 'share_menu' });
    assert.deepEqual(calls, [{ type: 'share.record', payload: { stage: 'opened', kind: 'discovery' } }]);
  } finally { api.call = previousCall; global.wx = previousWx; }
});
