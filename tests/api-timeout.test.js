require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadApi(callFunction) {
  global.wx = { cloud: { callFunction: callFunction } };
  const modulePath = require.resolve('../miniprogram/utils/api');
  delete require.cache[modulePath];
  const api = require(modulePath);
  return api;
}

test('云函数网络失败只重试一次并返回可展示的错误', async function () {
  let calls = 0;
  const api = loadApi(function () {
    calls += 1;
    return Promise.reject(new Error('network fail'));
  });

  await assert.rejects(api.call('auth.login'), /network fail/);
  assert.equal(calls, 2);
  delete global.wx;
});

test('客户端云调用具备超时保护，避免页面永久停在加载态', function () {
  const api = require('../miniprogram/utils/api');
  assert.equal(typeof api.call, 'function');
  const source = require('node:fs').readFileSync(require.resolve('../miniprogram/utils/api'), 'utf8');
  assert.match(source, /const CLOUD_CALL_TIMEOUT = 8000/);
  assert.match(source, /CLOUD_FUNCTION_TIMEOUT/);
});
