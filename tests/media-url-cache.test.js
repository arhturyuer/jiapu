require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/api');

test('头像临时链接在进程内复用并合并并发签发', async function () {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  let calls = 0;
  global.getApp = function () { return { globalData: { user: { _id: 'u1' } } }; };
  global.wx = {
    cloud: { callFunction: function (request) {
      assert.equal(request.data.type, 'media.getUrls');
      calls += 1;
      return Promise.resolve({ result: { success: true, data: { urls: { a: 'https://example.invalid/avatar' } } } });
    } }
  };
  try {
    api.clearMediaUrlCache();
    const results = await Promise.all([api.getMediaUrls(['a']), api.getMediaUrls(['a'])]);
    assert.equal(calls, 1);
    assert.equal(results[0].a, 'https://example.invalid/avatar');
    assert.equal(results[1].a, results[0].a);
    await api.getMediaUrls(['a']);
    assert.equal(calls, 1);
    api.clearMediaUrlCache();
    await api.getMediaUrls(['a']);
    assert.equal(calls, 2);
  } finally {
    api.clearMediaUrlCache();
    global.wx = previousWx;
    global.getApp = previousGetApp;
  }
});
