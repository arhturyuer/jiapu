const test = require('node:test');
const assert = require('node:assert/strict');

const { loadEnvironment } = require('./helpers/test-environment');

function runtime(version) {
  return {
    getAccountInfoSync: function () {
      return { miniProgram: { envVersion: version } };
    }
  };
}

test('官方小程序版本将开发版路由到 staging，体验版和正式版路由到 production', function () {
  const environment = loadEnvironment();
  assert.equal(environment.resolveRuntimeEnvironment(runtime('develop')).active, 'staging');
  assert.equal(environment.resolveRuntimeEnvironment(runtime('trial')).active, 'production');
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

test('应用缺少配置或 staging 指向生产及占位环境时仍拒绝启动', function () {
  [null, {}, { stagingCloudEnv: 'cloud1-d5gs5yj4l283d9c6d' }, { stagingCloudEnv: 'REPLACE_WITH_STAGING_ENV_ID' }]
    .forEach(function (local) {
      assert.throws(function () { loadEnvironment(local); }, /缺少 staging 环境配置/);
    });
});
