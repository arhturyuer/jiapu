require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const environment = require('../miniprogram/config/env');
const imageCache = require('../miniprogram/utils/profile-image-cache');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.js'), 'utf8');
const qr = { available: true, qrCodeUrl: 'https://example.test/feedback.png' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(accountState = 'active') {
  let page;
  const calls = [], previews = [], updates = [], visits = [];
  const app = {
    globalData: { user: { _id: 'fictional-user', nickName: '测试用户' }, accountState,
      environment: 'staging', env: environment.environments.staging.cloudEnv },
    ensureLogin: () => Promise.resolve(),
    isCacheFresh: () => true,
    getProfileData: load => load(),
    getCurrentFamily: () => null,
    setUser(user) { this.globalData.user = user; },
    clearTestSession() { this.globalData.user = null; }
  };
  const api = {
    call(type) { calls.push(type); return Promise.resolve(type === 'account.resetTest' ? { reset: true } : qr); },
    userMessage: (error, fallback) => error.message || fallback
  };
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    previewImage: options => previews.push(options),
    showModal: () => Promise.resolve({ confirm: false }),
    showToast() {},
    reLaunch: options => { visits.push(options); return Promise.resolve(); }
  };
  const storage = new Map(), files = new Set();
  wx.env = { USER_DATA_PATH: '/test-user' };
  wx.getStorageSync = key => storage.get(key);
  wx.setStorageSync = (key, value) => storage.set(key, value);
  wx.removeStorageSync = key => storage.delete(key);
  wx.getFileSystemManager = () => ({ accessSync(file) { assert.ok(files.has(file)); }, unlinkSync: file => files.delete(file) });
  wx.downloadFile = options => { files.add(options.filePath); options.success({ statusCode: 200 }); };
  const cache = imageCache.createCache(wx, api);
  const dependencies = {
    '../../utils/launch-ad': { wrap: definition => definition },
    '../../utils/api': api,
    '../../utils/profile-image-cache': cache,
    '../../utils/privacy': {},
    '../../utils/platform-capabilities': require('../miniprogram/utils/platform-capabilities'),
    '../../utils/form-state': { clearLeaveAlert() {} },
    '../../utils/ad-access': { hide() {}, refresh: () => Promise.resolve() },
    '../../utils/share-card': {},
    '../../utils/my-miniprogram-guide': require('../miniprogram/utils/my-miniprogram-guide'),
    '../../config/env': environment
  };
  vm.runInNewContext(source, {
    getApp: () => app, Page: definition => { page = definition; }, wx,
    require(name) { assert.ok(dependencies[name], name); return dependencies[name]; }, console
  }, { filename: 'profile/index.js' });
  page.data = { ...page.data };
  page.setData = patch => { updates.push(patch); Object.assign(page.data, patch); };
  function feedbackPage() {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/pages/feedback-group/index.js'), 'utf8'), {
      getApp: () => app, Page: value => { definition = value; }, wx,
      require(name) { assert.ok(dependencies[name], name); return dependencies[name]; }
    });
    definition.data = { ...definition.data };
    definition.setData = patch => Object.assign(definition.data, patch);
    return definition;
  }
  return { page, app, api, wx, calls, previews, updates, visits, cache, files, feedbackPage };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('我的和独立反馈群页共享一次获取，首次登录后也能正常完成并恢复图片失败', async () => {
  const h = harness();
  h.app.globalData.user = null;
  h.app.ensureLogin = () => { h.app.globalData.user = { _id: 'new-user' }; return Promise.resolve(); };
  const feedback = h.feedbackPage();
  await Promise.all([h.page.loadFeedbackGroup(), feedback.loadFeedbackGroup()]);
  assert.deepEqual(h.calls, ['feedbackGroup.get']);
  assert.equal(feedback.data.qrCodeUrl, h.page.data.feedbackQrCodeUrl);
  feedback.qrError({ currentTarget: { dataset: { url: feedback.data.qrCodeUrl } } });
  assert.match(feedback.data.error, /重新加载/);
  await feedback.loadFeedbackGroup({ type: 'tap' });
  assert.equal(h.calls.length, 2);
  assert.equal(feedback.data.loading, false);
});

test('长期头像不随资料刷新、昵称或家谱变化回源；文件丢失后恢复', async () => {
  const h = harness();
  h.app.globalData.user.avatarAssetId = 'a1';
  let presentations = 0;
  h.api.getMediaPresentation = async () => { presentations += 1; return { a1: { status: 'approved', url: 'https://example.test/a1' } }; };
  await h.page.loadPage();
  const local = h.page.data.avatarUrl;
  assert.ok(h.files.has(local));
  for (let i = 0; i < 5; i++) {
    h.app.globalData.user.nickName = '改名' + i;
    h.app.globalData.currentFamily = { _id: 'family-' + i };
    await h.page.loadPage({ force: true });
  }
  assert.equal(presentations, 1);
  h.files.delete(local);
  await h.page.loadPage();
  assert.equal(presentations, 2);
  assert.ok(h.files.has(h.page.data.avatarUrl));
});

test('更新头像失败保留旧缓存，成功替换且资料迟到响应不覆盖新图', async () => {
  const h = harness();
  h.app.globalData.user.avatarAssetId = 'a1';
  h.api.getMediaPresentation = async ids => ({ [ids[0]]: { status: 'approved', url: 'https://example.test/' + ids[0] } });
  await h.page.loadPage();
  const old = h.page.data.avatarUrl;
  h.api.call = () => Promise.reject(new Error('save failed'));
  await assert.rejects(h.page.saveProfileAvatar({ assetId: 'a2', previewUrl: 'local-preview', moderationStatus: 'approved' }));
  assert.equal(h.cache.peekAvatar(h.app, 'a1').url, old);
  const delayed = deferred();
  h.app.getProfileData = () => delayed.promise;
  const loading = h.page.loadPage({ force: true });
  h.api.call = async () => ({ user: { _id: 'fictional-user', nickName: '测试用户', avatarAssetId: 'a2' }, moderationStatus: 'approved' });
  await h.page.saveProfileAvatar({ assetId: 'a2', previewUrl: 'local-preview', moderationStatus: 'approved' });
  const fresh = h.page.data.avatarUrl;
  delayed.resolve({ user: { _id: 'fictional-user', avatarAssetId: 'a1' }, avatarAssetId: 'a1' });
  await loading;
  assert.equal(h.page.data.avatarUrl, fresh);
  assert.equal(h.files.has(old), false);
  assert.ok(h.files.has(fresh));
});

test('头像解码错误仅自动重取一次，旧图片错误和隐藏回调不清理新缓存', async () => {
  const h = harness();
  h.app.globalData.user.avatarAssetId = 'a1';
  let presentations = 0;
  h.api.getMediaPresentation = async () => { presentations += 1; return { a1: { status: 'approved', url: 'https://example.test/a1' } }; };
  await h.page.loadPage();
  const old = { currentTarget: { dataset: { asset: 'a1', url: h.page.data.avatarUrl } } };
  h.page.avatarError(old); await flush();
  assert.equal(presentations, 2);
  const current = h.page.data.avatarUrl;
  h.page.avatarError(old);
  assert.equal(h.page.data.avatarUrl, current);
  h.page.avatarError({ currentTarget: { dataset: { asset: 'a1', url: current } } }); await flush();
  assert.equal(presentations, 2);
});

test('反馈二维码独立于资料缓存，切回页面命中本地缓存且不清空或显示加载提示', async () => {
  const h = harness();
  h.page._hasLoaded = true;
  h.page.data.loading = false;
  h.page.data.user = h.app.globalData.user;
  h.page.data.avatarAssetId = '';
  h.app.getProfileData = () => { throw new Error('不应刷新已缓存资料'); };
  h.page.onShow();
  await flush();
  assert.deepEqual(h.calls, ['feedbackGroup.get']);
  const cachedUrl = h.page.data.feedbackQrCodeUrl;
  assert.match(cachedUrl, /youpu-profile-image-/);
  assert.equal(h.page.data.feedbackLoading, false);
  h.page.onHide();
  h.api.call = type => { h.calls.push(type); return Promise.resolve({ available: true, qrCodeUrl: 'https://example.test/replaced.png' }); };
  h.page.onShow();
  assert.equal(h.page.data.feedbackQrCodeUrl, cachedUrl);
  assert.equal(h.page.data.feedbackLoading, false);
  await flush();
  assert.deepEqual(h.calls, ['feedbackGroup.get']);
  assert.equal(h.page.data.feedbackQrCodeUrl, cachedUrl);
});

test('二维码未返回时个人资料已显示，正常及注销冷静期账户均可读取', async () => {
  for (const state of ['active', 'pending_delete']) {
    const h = harness(state);
    const request = deferred();
    h.api.call = () => request.promise;
    h.page.onShow();
    await flush();
    assert.equal(h.page.data.loading, false);
    assert.equal(h.page.data.accountState, state);
    assert.equal(h.page.data.feedbackLoading, true);
    request.resolve(qr);
    await flush();
    assert.equal(h.page.data.feedbackAvailable, true);
    assert.match(h.page.data.feedbackQrCodeUrl, /youpu-profile-image-/);
  }
});

test('未配置及不完整配置清除旧二维码，进入不可用状态', async () => {
  const h = harness();
  await h.page.loadFeedbackGroup();
  for (const config of [{ available: false, qrCodeUrl: '' }, { available: true, qrCodeUrl: '' }, { available: false, qrCodeUrl: qr.qrCodeUrl }]) {
    h.api.call = () => Promise.resolve(config);
    await h.page.loadFeedbackGroup({ force: true });
    assert.equal(h.page.data.feedbackLoading, false);
    assert.equal(h.page.data.feedbackAvailable, false);
    assert.equal(h.page.data.feedbackError, '');
    assert.equal(h.page.data.feedbackQrCodeUrl, '');
  }
});

test('请求或登录失败结束加载，重试成功恢复二维码且不设置资料页错误', async () => {
  for (const failure of ['request', 'login']) {
    const h = harness();
    if (failure === 'request') h.api.call = () => Promise.reject(new Error('网络失败'));
    else h.app.ensureLogin = () => Promise.reject(new Error('登录失败'));
    await h.page.loadFeedbackGroup({ force: true });
    assert.equal(h.page.data.feedbackLoading, false);
    assert.ok(h.page.data.feedbackError);
    assert.equal(h.page.data.error, '');
    h.app.ensureLogin = () => Promise.resolve();
    h.api.call = () => Promise.resolve(qr);
    await h.page.loadFeedbackGroup();
    assert.equal(h.page.data.feedbackError, '');
    assert.equal(h.page.data.feedbackAvailable, true);
  }
});

test('新请求优先，旧成功或失败不覆盖已替换二维码', async () => {
  for (const rejectOld of [false, true]) {
    const h = harness();
    const old = deferred();
    h.api.call = () => old.promise;
    const pending = h.page.loadFeedbackGroup();
    await flush();
    h.api.call = () => Promise.resolve({ available: true, qrCodeUrl: 'https://example.test/new.png' });
    await h.page.loadFeedbackGroup({ force: true });
    const count = h.updates.length;
    if (rejectOld) old.reject(new Error('旧请求失败'));
    else old.resolve(qr);
    await pending;
    assert.equal(h.updates.length, count);
    assert.match(h.page.data.feedbackQrCodeUrl, /youpu-profile-image-/);
  }
});

test('隐藏和卸载后丢弃迟到结果，登录等待期间离页不再发起二维码请求', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const h = harness();
    const request = deferred();
    h.api.call = () => request.promise;
    const pending = h.page.loadFeedbackGroup();
    await flush();
    h.page[lifecycle]();
    const count = h.updates.length;
    request.resolve(qr);
    await pending;
    assert.equal(h.updates.length, count);
    await h.page.loadFeedbackGroup();
    assert.equal(h.updates.length, count);
  }
  const h = harness();
  const login = deferred();
  h.app.ensureLogin = () => login.promise;
  const pending = h.page.loadFeedbackGroup();
  h.page.onHide();
  login.resolve();
  await pending;
  assert.equal(h.calls.length, 0);
});

test('当前图片失败可重试，同一 URL 的旧图片错误也不会污染新请求', async () => {
  const h = harness();
  await h.page.loadFeedbackGroup();
  const event = { currentTarget: { dataset: { version: h.page.data.feedbackVersion, url: h.page.data.feedbackQrCodeUrl } } };
  h.page.feedbackQrError(event);
  assert.equal(h.page.data.feedbackAvailable, false);
  assert.equal(h.page.data.feedbackQrCodeUrl, '');
  assert.match(h.page.data.feedbackError, /重新加载/);
  await h.page.loadFeedbackGroup();
  h.page.feedbackQrError(event);
  assert.equal(h.page.data.feedbackAvailable, true);
  const current = { currentTarget: { dataset: { version: h.page.data.feedbackVersion, url: h.page.data.feedbackQrCodeUrl } } };
  h.page.onHide();
  h.page.feedbackQrError(current);
  assert.equal(h.page.data.feedbackError, '');
});

test('点击当前二维码使用原生可长按预览，不可用及离页后不预览', async () => {
  const h = harness();
  h.page.previewFeedbackQrCode();
  assert.equal(h.previews.length, 0);
  await h.page.loadFeedbackGroup();
  h.page.previewFeedbackQrCode();
  assert.equal(h.previews.length, 1);
  const options = h.previews[0];
  assert.equal(options.current, h.page.data.feedbackQrCodeUrl);
  assert.deepEqual(Array.from(options.urls), [h.page.data.feedbackQrCodeUrl]);
  assert.equal(options.showmenu, true);
  h.page.onHide();
  h.page.previewFeedbackQrCode();
  assert.equal(h.previews.length, 1);
});

test('账户重置丢弃旧响应，取消或失败后恢复读取，成功后清空二维码', async () => {
  for (const result of ['cancel', 'fail', 'success']) {
    const h = harness();
    const old = deferred(), modal = deferred();
    h.api.call = () => old.promise;
    const pending = h.page.loadFeedbackGroup();
    await flush();
    h.wx.showModal = () => modal.promise;
    const reset = h.page.resetTestAccount();
    const count = h.updates.length;
    old.resolve(qr);
    await pending;
    assert.equal(h.updates.length, count);
    h.api.call = type => {
      h.calls.push(type);
      if (type === 'account.resetTest') return result === 'fail' ? Promise.reject(new Error('重置失败')) : Promise.resolve({ reset: true });
      return Promise.resolve(qr);
    };
    modal.resolve({ confirm: result !== 'cancel' });
    await reset;
    assert.equal(h.page.data.resettingTestAccount, false);
    if (result === 'success') {
      assert.equal(h.page.data.feedbackAvailable, false);
      assert.equal(h.page.data.feedbackQrCodeUrl, '');
      assert.deepEqual(h.calls, ['account.resetTest']);
      assert.equal(h.visits[0].url, '/pages/tree/index');
    } else {
      assert.equal(h.page.data.feedbackAvailable, true);
      assert.equal(h.calls.filter(type => type === 'feedbackGroup.get').length, 0);
    }
  }
});

test('帮助区域共用于两种账户状态，修谱指南排首位，保留反馈和阅读设置', () => {
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxss'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.js'), 'utf8');
  assert.equal((template.match(/帮助与反馈/g) || []).length, 1);
  assert.match(template, /<\/block>\s*<view class="section-block">\s*<template is="readingHelpEntry"/);
  assert.match(template, /template name="readingHelpEntry"[\s\S]*帮助与反馈/);
  const help = template.match(/<template name="readingHelpEntry">([\s\S]*?)<\/template>/)[1];
  assert.match(help, /class="help-card surface-card">\s*<navigator url="\/pages\/guides\/index"/);
  assert.match(help, /修谱指南<\/text>[\s\S]*<\/navigator>\s*<view class="help-divider"/);
  assert.ok(help.indexOf('修谱指南') < help.indexOf('用户反馈群'));
  assert.ok(help.indexOf('用户反馈群') < help.indexOf('长辈模式与字号'));
  assert.match(template, /用户反馈群<\/text>[\s\S]*<text class="setting-desc" wx:else>长按识别二维码，进群交流、反馈问题<\/text>/);
  assert.match(template, /class="setting-desc" wx:if="{{feedbackError}}">{{feedbackError}}<\/text>/);
  assert.match(template, /mode="aspectFit" show-menu-by-longpress="{{true}}"/);
  assert.match(template, /binderror="feedbackQrError"/);
  assert.match(template, /wx:elif="{{feedbackError}}"[\s\S]*bindtap="loadFeedbackGroup"/);
  assert.match(template, /反馈群暂未开放[\s\S]*open-type="contact"/);
  assert.ok(template.indexOf('<template is="readingHelpEntry"') < template.indexOf('ad-placement'));
  assert.ok(template.indexOf('ad-placement') < template.indexOf('开发版测试工具'));
  assert.doesNotMatch(source, /showFeedbackGroup|\/pages\/feedback-group\/index/);
  assert.match(privacy, /showFeedbackGroup[\s\S]*\/pages\/feedback-group\/index/);
  assert.match(style, /\.feedback-copy\s*\{[^}]*flex: 1;[^}]*min-width: 0;/);
  assert.match(style, /\.feedback-card\s*\{[^}]*padding: 8rpx 24rpx;/);
  assert.match(style, /\.feedback-qr-slot\s*\{[^}]*flex: 0 0 120rpx; width: 120rpx; height: 120rpx;/);
  assert.match(style, /\.feedback-qr-image\s*\{[^}]*width: 120rpx; height: 120rpx; background: #fff;/);
  assert.match(style, /\.feedback-copy \.setting-desc\s*\{[^}]*white-space: normal; overflow-wrap: break-word;/);
});
