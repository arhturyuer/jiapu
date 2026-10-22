const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
test('夫妻排序云端验收没有明确staging上下文时在调用云端前拒绝', () => {
  for (const target of ['', 'production']) {
    const result = spawnSync(process.execPath, ['deployment/verify-spouse-order-staging.mjs'], { cwd: require('node:path').resolve(__dirname, '..'), env: { ...process.env, DEPLOYMENT_TARGET: target }, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /只允许独立 staging/);
  }
});
