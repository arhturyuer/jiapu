const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const productionEnvId = 'cloud1-d5gs5yj4l283d9c6d';
const stagingEnvId = 'cloud1-staging-example-1234567890';

function guard(environment, target) {
  return spawnSync(process.execPath, [
    '-e', "import('./deployment/target-guard.mjs').then(m => m.assertDeploymentTarget(process.argv[1], 'test'))",
    target
  ], {
    cwd: root,
    env: Object.assign({}, process.env, environment),
    encoding: 'utf8'
  });
}

test('staging 部署护栏永远拒绝 production 环境', function () {
  const result = guard({ DEPLOYMENT_TARGET: 'staging', STAGING_ENV_ID: productionEnvId }, productionEnvId);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /绝不能指向 production/);
});

test('staging 部署护栏要求显式且一致的 staging 环境 ID', function () {
  const missing = guard({ DEPLOYMENT_TARGET: 'staging' }, stagingEnvId);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /STAGING_ENV_ID/);

  const mismatch = guard({ DEPLOYMENT_TARGET: 'staging', STAGING_ENV_ID: 'cloud1-another-staging-env' }, stagingEnvId);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /不一致/);

  const accepted = guard({ DEPLOYMENT_TARGET: 'staging', STAGING_ENV_ID: stagingEnvId }, stagingEnvId);
  assert.equal(accepted.status, 0, accepted.stderr);
});

test('所有 staging 写入脚本都会加载共享生产保护护栏', function () {
  const fs = require('node:fs');
  ['deployment/apply-indexes.mjs', 'deployment/apply-security.mjs', 'deployment/verify-cloud.mjs', 'deployment/bootstrap-staging.mjs', 'uploadCloudFunction.sh', 'deployment/deploy-staging.sh']
    .forEach(function (file) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.match(source, /assertDeploymentTarget|target-guard/);
    });
});
