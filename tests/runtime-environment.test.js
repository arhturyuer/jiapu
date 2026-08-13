const test = require('node:test');
const assert = require('node:assert/strict');

function loadEnvironment() {
  const modulePath = require.resolve('../miniprogram/config/env');
  delete require.cache[modulePath];
  return require('../miniprogram/config/env');
}

function runtime(version) {
  return {
    getAccountInfoSync: function () {
      return { miniProgram: { envVersion: version } };
    }
  };
}

test('官方小程序版本将开发版和体验版路由到 staging，正式版路由到 production', function () {
  const environment = loadEnvironment();
  assert.equal(environment.resolveRuntimeEnvironment(runtime('develop')).active, 'staging');
  assert.equal(environment.resolveRuntimeEnvironment(runtime('trial')).active, 'staging');
  assert.equal(environment.resolveRuntimeEnvironment(runtime('release')).active, 'production');
});

test('账号信息缺失、异常或未知版本安全降级到 staging', function () {
  const environment = loadEnvironment();
  assert.equal(environment.resolveRuntimeEnvironment(null).active, 'staging');
  assert.equal(environment.resolveRuntimeEnvironment({
    getAccountInfoSync: function () { throw new Error('unsupported'); }
  }).active, 'staging');
  assert.equal(environment.resolveRuntimeEnvironment(runtime('future')).active, 'staging');
});
