const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function probe(t, mode, overrides = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'youpu-public-probe-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const cli = path.join(folder, 'fixture-cli');
  fs.writeFileSync(cli, '#!' + process.execPath + '\n' + `
    const args = process.argv.slice(2);
    const input = JSON.parse(args[args.indexOf('-d') + 1]);
    const mode = process.env.PROBE_FIXTURE_MODE;
    let result;
    if (mode === 'old') result = { success: false, code: 'UNKNOWN_ACTION', requestId: 'fixture-request' };
    else if (input.type.endsWith('.list')) result = { success: true, data: { items: mode === 'empty' ? [] : [{ slug: 'fixture-example' }] } };
    else if (input.slug !== 'fixture-example') result = { success: false, code: 'EXAMPLE_NOT_FOUND' };
    else result = { success: true, data: { example: { slug: input.slug, persons: [{ _id: 'fictional-person' }], relations: [] } } };
    console.log(JSON.stringify({ data: { RetMsg: JSON.stringify(result) } }));
  `, { mode: 0o700 });
  return spawnSync(process.execPath, [path.resolve(__dirname, '../deployment/verify-public-examples-staging.mjs'), overrides.envId || 'fixture-public-staging'], {
    encoding: 'utf8', env: { ...process.env, DEPLOYMENT_TARGET: 'staging', STAGING_ENV_ID: 'fixture-public-staging', TCB_BIN: cli, PROBE_FIXTURE_MODE: mode, ...overrides }
  });
}

test('公开示例部署验证读取默认示例并拒绝不存在的内容', t => {
  const result = probe(t, 'ready');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).defaultExample, true);
  assert.equal(JSON.parse(result.stdout).missingExampleRejected, true);
});

test('旧服务缺接口和没有已发布示例时实际验证明确失败', t => {
  const old = probe(t, 'old'); assert.notEqual(old.status, 0); assert.match(old.stderr, /UNKNOWN_ACTION.*fixture-request/);
  const empty = probe(t, 'empty'); assert.notEqual(empty.status, 0); assert.match(empty.stderr, /没有已发布示例/);
});

test('公开示例探针在生产或环境不一致时先拒绝', t => {
  const production = probe(t, 'ready', { DEPLOYMENT_TARGET: 'production', ALLOW_PRODUCTION_CHANGE: '1' });
  assert.notEqual(production.status, 0); assert.match(production.stderr, /仅允许独立 staging/);
  const mismatch = probe(t, 'ready', { STAGING_ENV_ID: 'other-staging' });
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /目标与 STAGING_ENV_ID 不一致/);
});
