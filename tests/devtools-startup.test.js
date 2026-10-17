const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('微信缺失本机模块时给出配置指引，配置执行错误继续原样拒绝', () => {
  const source = fs.readFileSync(path.join(root, 'miniprogram/config/env.js'), 'utf8');
  const load = error => vm.runInNewContext(source, {
    module: { exports: {} }, require: () => { throw error; }
  });
  assert.throws(() => load(new Error("module 'config/env.local.js' is not defined, require args is './env.local'")), /缺少 staging 环境配置.*configure-miniprogram/);
  for (const error of [new Error('配置执行失败'), new Error("module 'config/other.js' is not defined, require args is './other'")]) {
    assert.throws(() => load(error), value => value === error);
  }
});

test('本地配置生成拒绝无效目标且不覆盖已有文件，合法 staging 不需要部署密钥', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-devtools-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const dir of ['deployment', 'miniprogram/config']) fs.mkdirSync(path.join(fixture, dir), { recursive: true });
  for (const file of ['configure-miniprogram.mjs', 'target-guard.mjs']) {
    fs.copyFileSync(path.join(root, 'deployment', file), path.join(fixture, 'deployment', file));
  }
  const destination = path.join(fixture, 'miniprogram/config/env.local.js');
  const previous = 'module.exports = { stagingCloudEnv: "cloud1-previous-staging" };\n';
  fs.writeFileSync(destination, previous);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(STAGING_|PRODUCTION_|VP_|BOOTSTRAP_|DEPLOYMENT_TARGET|ALLOW_PRODUCTION)/.test(key)));
  const run = (values, args = []) => spawnSync(process.execPath, [path.join(fixture, 'deployment/configure-miniprogram.mjs'), ...args], {
    cwd: os.tmpdir(), encoding: 'utf8', env: { ...env, ...values }
  });
  for (const values of [
    {}, { DEPLOYMENT_TARGET: 'staging' },
    { DEPLOYMENT_TARGET: 'production', STAGING_ENV_ID: 'cloud1-d5gs5yj4l283d9c6d', ALLOW_PRODUCTION_CHANGE: '1' },
    ...['cloud1-d5gs5yj4l283d9c6d', 'REPLACE_WITH_STAGING_ENV_ID', 'YOUR_ENV', 'bad id', 'bad;id'].map(id => ({ DEPLOYMENT_TARGET: 'staging', STAGING_ENV_ID: id }))
  ]) {
    const result = run(values);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(destination, 'utf8'), previous);
  }
  const valid = { DEPLOYMENT_TARGET: 'staging', STAGING_ENV_ID: 'cloud1-fixture-staging' };
  assert.equal(run(valid, ['--unknown']).status, 2);
  assert.equal(fs.readFileSync(destination, 'utf8'), previous);
  const result = run(valid);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const context = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(destination, 'utf8'), context);
  assert.equal(context.module.exports.stagingCloudEnv, valid.STAGING_ENV_ID);
  assert.equal(fs.existsSync(path.join(fixture, 'deployment/cloudbaserc.staging.local.json')), false);
});

test('app.json 不声明相机或相册 permission，保留微信隐私校验', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  assert.equal(config.permission && config.permission['scope.camera'], undefined);
  assert.equal(config.permission && config.permission['scope.writePhotosAlbum'], undefined);
  assert.equal(config.__usePrivacyCheck__, true);
});
