const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '..');

function fixture(t) {
  // Spaces in the path exercise argument boundaries in the shell wrapper.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu local check ')));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  for (const dir of ['scripts', 'tests', 'admin', 'bin', 'docs', 'miniprogram/config', 'node_modules', 'admin/dist']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const name of ['check.sh', 'check.mjs', 'workspace-files.mjs', 'check-docs.mjs']) {
    fs.copyFileSync(path.join(sourceRoot, 'scripts', name), path.join(root, 'scripts', name));
  }
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nadmin/dist/\nminiprogram/config/env.local.js\n');
  fs.writeFileSync(path.join(root, 'tests/example.test.js'), '/* test substitute */\n');
  fs.writeFileSync(path.join(root, 'scripts/example.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'node_modules/bad.js'), 'NOT VALID JS');
  fs.writeFileSync(path.join(root, 'admin/dist/bad.js'), 'NOT VALID JS');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(root, 'docs/文档索引.md'), [
    '<!-- docs-index:start -->',
    '| [README](../README.md) | 现行规范 | fixture | 2026-09-16 | [代码](../scripts/example.mjs) | — | 保留 |',
    '| [索引](./文档索引.md) | 现行规范 | fixture | 2026-09-16 | [代码](../scripts/example.mjs) | — | 保留 |',
    '<!-- docs-index:end -->'
  ].join('\n'));
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
fs.appendFileSync(process.env.CHECK_LOG, JSON.stringify({name, args, cwd:process.cwd(), env:process.env.VITE_CLOUDBASE_ENV || ''})+'\\n');
if (name === 'node-stub' && /check(?:-docs)?\\.mjs$/.test(args[0] || '')) {
  const result = cp.spawnSync(${JSON.stringify(process.execPath)}, args, {stdio:'inherit', env:process.env});
  process.exit(result.status || (result.error ? 1 : 0));
}
if (name === 'node-stub' && args[0] === '--check') process.exit(process.env.FAIL_STAGE === 'syntax' ? 17 : 0);
if (name === 'node-stub' && args[0] === '--test') process.exit(process.env.FAIL_STAGE === 'tests' ? 18 : 0);
if (name === 'pnpm-stub' && args[0] === 'run') process.exit(process.env.FAIL_STAGE === 'admin' ? 19 : 0);
process.exit(99);
`;
  for (const name of ['node-stub', 'pnpm-stub', 'tcb', 'wechat', 'cli']) {
    fs.writeFileSync(path.join(root, 'bin', name), stub, { mode: 0o755 });
  }
  const env = Object.assign({}, process.env, {
    NODE_BIN: path.join(root, 'bin/node-stub'), PNPM_BIN: path.join(root, 'bin/pnpm-stub'),
    CHECK_LOG: path.join(root, 'calls.log'), PATH: path.join(root, 'bin') + ':' + process.env.PATH
  });
  for (const key of Object.keys(env)) {
    if (/^(STAGING_|VP_|BOOTSTRAP_|VITE_|ALLOW_PRODUCTION|DEPLOYMENT_TARGET|TARGET_ENV_ID|PREFLIGHT_MODE|FAIL_STAGE)/.test(key)) delete env[key];
  }
  return {
    root,
    run: function (args = [], extra = {}) {
      fs.writeFileSync(env.CHECK_LOG, '');
      const result = spawnSync('bash', [path.join(root, 'scripts/check.sh'), ...args], {
        cwd: os.tmpdir(), encoding: 'utf8', env: Object.assign({}, env, extra)
      });
      const calls = fs.readFileSync(env.CHECK_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      return { result, calls };
    }
  };
}

test('本地检查无本机配置或凭据运行，包含新文件并排除依赖产物，不调用云端', function (t) {
  const f = fixture(t);
  const { result, calls } = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(calls.some(function (call) { return call.args[0] === '--check' && call.args[1].endsWith('example.mjs'); }));
  assert.ok(calls.some(function (call) { return call.args[0] === '--test'; }));
  assert.ok(calls.some(function (call) { return call.name === 'pnpm-stub' && call.args[1] === 'typecheck' && call.cwd === path.join(f.root, 'admin'); }));
  assert.ok(calls.every(function (call) { return ['node-stub', 'pnpm-stub'].includes(call.name); }));
  assert.doesNotMatch(JSON.stringify(calls), /bad\.js|env\.local\.js/);
  assert.equal(fs.existsSync(path.join(f.root, 'miniprogram/config/env.local.js')), false);
});

test('构建必须显式指定有效环境，未知参数在任何检查阶段前失败', function (t) {
  const f = fixture(t);
  for (const [args, env] of [[['--unknown'], {}], [['--build-admin'], {}], [['--build-admin'], { VITE_CLOUDBASE_ENV: 'REPLACE_WITH_ENV' }]]) {
    const { result, calls } = f.run(args, env);
    assert.equal(result.status, 2);
    assert.equal(calls.length, 1, '只允许启动入口，不得进行检查或构建');
  }
  const { result, calls } = f.run(['--build-admin'], { VITE_CLOUDBASE_ENV: 'cloud1-fixture-staging' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const admin = calls.filter(function (call) { return call.name === 'pnpm-stub'; });
  assert.equal(admin.length, 1);
  assert.deepEqual(admin[0].args, ['run', 'build']);
  assert.equal(admin[0].env, 'cloud1-fixture-staging');
});

test('语法、文档、测试和后台检查失败均阻止后续阶段并传播退出状态', function (t) {
  const f = fixture(t);
  for (const [stage, code] of [['syntax', 17], ['tests', 18], ['admin', 19]]) {
    const { result, calls } = f.run([], { FAIL_STAGE: stage });
    assert.equal(result.status, code);
    if (stage !== 'admin') assert.ok(!calls.some(function (call) { return call.name === 'pnpm-stub'; }));
    if (stage === 'syntax') assert.ok(!calls.some(function (call) { return call.args[0] === '--test'; }));
  }
  fs.appendFileSync(path.join(f.root, 'README.md'), '\n[broken](missing.md)\n');
  const { result, calls } = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing.md/);
  assert.ok(!calls.some(function (call) { return call.args[0] === '--test' || call.name === 'pnpm-stub'; }));
});

test('真实环境路由测试在无本机配置的独立目录通过，保留拒绝错误配置的护栏', function (t) {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'tests/helpers'));
  for (const file of ['miniprogram/config/env.js', 'tests/helpers/test-environment.js', 'tests/runtime-environment.test.js']) {
    fs.copyFileSync(path.join(sourceRoot, file), path.join(f.root, file));
  }
  const result = spawnSync(process.execPath, ['--test', 'tests/runtime-environment.test.js'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.root, 'miniprogram/config/env.local.js')), false);
});

test('发布预检复用本地构建入口且保留环境不匹配和生产不可跳过预览的约束', function (t) {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'deployment'));
  for (const file of ['deployment/preflight.sh', 'miniprogram/config/env.js', 'miniprogram/config/legal.js']) {
    fs.copyFileSync(path.join(sourceRoot, file), path.join(f.root, file));
  }
  fs.writeFileSync(path.join(f.root, 'miniprogram/config/env.local.js'), "module.exports = { stagingCloudEnv: 'cloud1-fixture-staging' };\n");
  fs.writeFileSync(path.join(f.root, 'scripts/check.sh'), '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$VITE_CLOUDBASE_ENV|$*" >> "$PREFLIGHT_CHECK_LOG"\nexit "${CHECK_EXIT:-0}"\n');
  const cli = path.join(f.root, 'bin/preview-stub');
  fs.writeFileSync(cli, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PREFLIGHT_PREVIEW_LOG"\n', { mode: 0o755 });
  const checkLog = path.join(f.root, 'preflight-check.log');
  const previewLog = path.join(f.root, 'preflight-preview.log');
  function run(extra = {}) {
    fs.writeFileSync(checkLog, '');
    fs.writeFileSync(previewLog, '');
    const env = Object.assign({}, process.env, {
      NODE_BIN: process.execPath, PNPM_BIN: path.join(f.root, 'bin/pnpm-stub'), WECHAT_CLI: cli,
      PREFLIGHT_MODE: 'staging', TARGET_ENV_ID: 'cloud1-fixture-staging', SKIP_WECHAT_PREVIEW: '1',
      ALLOW_PRODUCTION: '0', STAGING_PAYMENT_MODE: 'sandbox',
      STAGING_VP_APP_ID: 'fixture', STAGING_VP_APP_SECRET: 'fixture', STAGING_VP_OFFER_ID: 'fixture',
      STAGING_VP_APP_KEY: 'fixture', STAGING_VP_INTERNAL_NOTIFY_SECRET: 'fixture-secret-32-characters-long-only',
      PREFLIGHT_CHECK_LOG: checkLog, PREFLIGHT_PREVIEW_LOG: previewLog, CHECK_EXIT: '0'
    }, extra);
    return spawnSync('bash', [path.join(f.root, 'deployment/preflight.sh')], { cwd: f.root, encoding: 'utf8', env });
  }
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(checkLog, 'utf8').trim(), 'cloud1-fixture-staging|--build-admin');
  assert.equal(fs.readFileSync(previewLog, 'utf8'), '');
  assert.equal(run({ TARGET_ENV_ID: 'cloud1-other' }).status, 3);
  assert.equal(fs.readFileSync(checkLog, 'utf8'), '');
  assert.equal(run({ TARGET_ENV_ID: 'cloud1-d5gs5yj4l283d9c6d' }).status, 3);
  assert.equal(run({ PREFLIGHT_MODE: 'production', TARGET_ENV_ID: 'cloud1-d5gs5yj4l283d9c6d' }).status, 3);
  const production = run({ PREFLIGHT_MODE: 'production', TARGET_ENV_ID: 'cloud1-d5gs5yj4l283d9c6d', ALLOW_PRODUCTION: '1' });
  assert.equal(production.status, 4, production.stdout + production.stderr);
  assert.match(production.stdout, /不允许跳过微信预览/);
  assert.equal(fs.readFileSync(previewLog, 'utf8'), '');
  assert.equal(run({ SKIP_WECHAT_PREVIEW: '0', CHECK_EXIT: '21' }).status, 21);
  assert.equal(fs.readFileSync(previewLog, 'utf8'), '');
});
