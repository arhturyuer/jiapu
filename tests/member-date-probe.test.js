const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'deployment/member-date-staging-probe.js'), 'utf8');

function probe(env, actual) {
  const exports = {};
  const cloud = { init: () => {}, database: () => ({}), getWXContext: () => ({ ENV: actual }) };
  vm.runInNewContext(source, { exports, process: { env }, require: function (name) {
    if (name === 'wx-server-sdk') return cloud;
    if (name.startsWith('./')) return {};
    return require(name);
  } });
  return exports;
}

test('成员日期验收命令在读取本机配置前拒绝非 staging 目标', function () {
  for (const target of ['', 'production']) {
    const result = spawnSync(process.execPath, ['deployment/verify-member-dates-staging.mjs'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, DEPLOYMENT_TARGET: target }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /只允许独立 staging/);
  }
});

test('日期探针拒绝生产或环境不一致，尚未构建业务上下文', async function () {
  const production = 'cloud1-d5gs5yj4l283d9c6d';
  for (const [target, actual] of [[production, production], ['fake-staging', 'fake-other']]) {
    await assert.rejects(probe({ PROBE_ENV: target, TCB_ENV: actual }, actual).main({}), { code: 'PROBE_ENV_REJECTED' });
  }
});

test('日期探针只接受随机密钥及本次 run，不读取或清理其他命名空间', async function () {
  const env = { PROBE_ENV: 'fake-staging', TCB_ENV: 'fake-staging', PROBE_SECRET: 'fake-secret', PROBE_RUN: '123456789abc' };
  for (const event of [{}, { secret: 'fake-secret', run: '123456789abd' }, { secret: 'incorrect', run: env.PROBE_RUN }]) {
    await assert.rejects(probe(env, env.PROBE_ENV).main(event), { code: 'PROBE_UNAUTHORIZED' });
  }
});
