require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/profile-image-cache.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  let now = 1000000;
  const storage = new Map(), files = new Set(), calls = [], downloads = [];
  const app = { globalData: { env: 'fictional-staging', user: { _id: 'u1', avatarAssetId: 'a1' } } };
  const wx = {
    env: { USER_DATA_PATH: '/test-user' },
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
    getFileSystemManager: () => ({ accessSync(file) { assert.ok(files.has(file), 'file missing'); }, unlinkSync: file => files.delete(file) }),
    downloadFile(options) { downloads.push(options.url); files.add(options.filePath); options.success({ statusCode: 200, filePath: options.filePath }); }
  };
  const api = {
    call: async type => { calls.push(type); return { available: true, qrCodeUrl: 'https://example.test/qr.png' }; },
    getMediaPresentation: async ids => { calls.push(ids[0]); return { [ids[0]]: { status: 'approved', url: 'https://example.test/' + ids[0] } }; }
  };
  function restart() {
    const context = { module: { exports: {} }, require: () => api, Date: class extends Date { static now() { return now; } } };
    vm.runInNewContext(source, context);
    return context.module.exports.createCache(wx, api);
  }
  return { app, wx, api, calls, downloads, storage, files, restart, advance: ms => { now += ms; }, cache: restart() };
}

test('头像无时间过期，合并并发并跨启动复用本地文件', async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.cache.getAvatar(h.app, 'a1'), h.cache.getAvatar(h.app, 'a1')]);
  assert.equal(first.url, second.url);
  assert.match(first.url, /^\/test-user\/youpu-profile-image-/);
  h.advance(365 * 24 * 3600000);
  assert.equal((await h.restart().getAvatar(h.app, 'a1')).url, first.url);
  assert.deepEqual(h.calls, ['a1']);
  assert.equal(h.downloads.length, 1);
});

test('二维码跨入口和启动合并，12 小时边界到期后下一次读取更新', async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.cache.getFeedback(h.app), h.cache.getFeedback(h.app)]);
  assert.equal(first.qrCodeUrl, second.qrCodeUrl);
  h.advance(12 * 3600000 - 1);
  assert.equal(h.restart().peekFeedback(h.app).qrCodeUrl, first.qrCodeUrl);
  assert.equal((await h.restart().getFeedback(h.app)).qrCodeUrl, first.qrCodeUrl);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  assert.equal(h.cache.peekFeedback(h.app), null);
  assert.ok(!h.files.has(first.qrCodeUrl));
  await h.cache.getFeedback(h.app);
  assert.equal(h.calls.length, 2);
});

test('实际环境 ID 和用户隔离缓存，切换家谱不影响缓存', async () => {
  const h = harness();
  await h.cache.getAvatar(h.app, 'a1'); await h.cache.getFeedback(h.app);
  h.app.globalData.currentFamily = { _id: 'f2' };
  await h.cache.getAvatar(h.app, 'a1'); await h.cache.getFeedback(h.app);
  assert.equal(h.calls.length, 2);
  h.app.globalData.env = 'replacement-staging';
  assert.equal(h.cache.peekAvatar(h.app, 'a1'), null); assert.equal(h.cache.peekFeedback(h.app), null);
  await h.cache.getAvatar(h.app, 'a1');
  h.app.globalData.user = { _id: 'u2', avatarAssetId: 'a1' };
  assert.equal(h.cache.peekAvatar(h.app, 'a1'), null);
  await h.cache.getAvatar(h.app, 'a1');
  assert.equal(h.calls.length, 4);
});

test('头像替换清理旧文件；待审核和拒绝不会写入长期缓存', async () => {
  const h = harness();
  const first = await h.cache.getAvatar(h.app, 'a1');
  h.app.globalData.user.avatarAssetId = 'a2';
  h.cache.replaceAvatar(h.app, 'a2');
  assert.equal(h.files.has(first.url), false);
  for (const status of ['pending', 'rejected', 'deleted']) {
    h.api.getMediaPresentation = async () => ({ a2: { status, url: '' } });
    assert.equal((await h.cache.getAvatar(h.app, 'a2')).status, status);
    assert.equal(h.cache.peekAvatar(h.app, 'a2'), null);
  }
});

test('文件丢失和强制重试重新获取；未配置和失败不缓存', async () => {
  const h = harness();
  const first = await h.cache.getFeedback(h.app);
  h.files.delete(first.qrCodeUrl);
  assert.equal(h.cache.peekFeedback(h.app), null);
  await h.cache.getFeedback(h.app);
  await h.cache.getFeedback(h.app, { force: true });
  assert.equal(h.calls.length, 3);
  h.cache.discardFeedback(h.app);
  h.api.call = async () => ({ available: false, qrCodeUrl: '' });
  await h.cache.getFeedback(h.app);
  assert.equal(h.cache.peekFeedback(h.app), null);
  h.api.call = async () => { throw new Error('offline'); };
  await assert.rejects(h.cache.getFeedback(h.app), /offline/);
  h.api.call = async () => ({ available: true, qrCodeUrl: 'https://example.test/restored' });
  await h.cache.getFeedback(h.app);
  assert.ok(h.cache.peekFeedback(h.app));
});

test('图片下载或元数据保存失败保留可显示 URL，下次可重试', async () => {
  for (const failure of ['download', 'storage']) {
    const h = harness();
    const download = h.wx.downloadFile, store = h.wx.setStorageSync;
    if (failure === 'download') h.wx.downloadFile = options => options.fail(new Error('offline'));
    else h.wx.setStorageSync = () => { throw new Error('storage full'); };
    assert.equal((await h.cache.getFeedback(h.app)).qrCodeUrl, 'https://example.test/qr.png');
    assert.equal(h.cache.peekFeedback(h.app), null);
    assert.equal(h.files.size, 0);
    h.wx.downloadFile = download; h.wx.setStorageSync = store;
    await h.cache.getFeedback(h.app);
    assert.ok(h.cache.peekFeedback(h.app));
  }
});

test('环境、用户、会话清理及头像变化时，迟到结果不落盘', async () => {
  for (const change of ['env', 'user', 'clear', 'avatar']) {
    const h = harness(), wait = deferred();
    h.api.getMediaPresentation = () => wait.promise;
    const pending = h.cache.getAvatar(h.app, 'a1');
    await Promise.resolve();
    if (change === 'env') h.app.globalData.env = 'other';
    if (change === 'user') h.app.globalData.user = { _id: 'u2', avatarAssetId: 'a1' };
    if (change === 'clear') h.cache.clear();
    if (change === 'avatar') h.app.globalData.user.avatarAssetId = 'a2';
    wait.resolve({ a1: { status: 'approved', url: 'https://example.test/a1' } });
    await assert.rejects(pending, { code: 'IMAGE_CACHE_CHANGED' });
    assert.equal(h.files.size, 0);
  }
});

test('下载中清理和新请求优先均清除旧落地文件，不覆盖新二维码', async () => {
  const h = harness(), waits = [];
  h.wx.downloadFile = options => waits.push(options);
  const first = h.cache.getFeedback(h.app);
  await new Promise(resolve => setImmediate(resolve));
  const second = h.cache.getFeedback(h.app, { force: true });
  await new Promise(resolve => setImmediate(resolve));
  for (const index of [1, 0]) {
    h.files.add(waits[index].filePath); waits[index].success({ statusCode: 200 });
    if (index === 1) await second;
  }
  await assert.rejects(first, { code: 'IMAGE_CACHE_CHANGED' });
  assert.equal(h.files.size, 1);
  assert.equal(h.cache.peekFeedback(h.app).qrCodeUrl, waits[1].filePath);
  h.cache.clear();
  assert.equal(h.files.size, 0);
  assert.equal(h.cache.peekFeedback(h.app), null);
});
