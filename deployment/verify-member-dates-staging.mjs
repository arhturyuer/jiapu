import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { assertDeploymentTarget } from './target-guard.mjs';

const root = resolve(import.meta.dirname, '..');
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('成员日期验收只允许独立 staging');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
assertDeploymentTarget(manifest.envId, '成员日期虚构数据验收');
const run = randomBytes(6).toString('hex');
const name = 'youpuMemberDateProbe' + run;
const base = resolve(root, 'deployment/backups/staging-member-dates-20261012', 'probe-' + run);
const directory = resolve(base, 'function');
mkdirSync(directory, { recursive: true, mode: 0o700 });

function cli(args, label) {
  const result = spawnSync(process.env.TCB_BIN || 'tcb', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 30000000, timeout: 180000,
    input: label === 'remove' ? 'y\n' : undefined
  });
  writeFileSync(resolve(base, label + '.log'), result.stdout + result.stderr, { mode: 0o600 });
  if (result.status !== 0) throw new Error(label + ' 失败，详见受控日志');
  const start = result.stdout.indexOf('{');
  return start >= 0 ? JSON.parse(result.stdout.slice(start)).data : null;
}

const download = resolve(base, 'download-youpuUserApi');
cli(['-e', manifest.envId, 'fn', 'code', 'download', 'youpuUserApi', download, '--json'], 'download');
const hashes = {};
for (const path of ['index.js', 'domain.js', 'person-date.js', 'staging-account-reset.js', 'package.json']) {
  const hash = data => createHash('sha256').update(data).digest('hex');
  hashes[path] = { deployed: hash(readFileSync(resolve(download, path))), local: hash(readFileSync(resolve(root, 'cloudfunctions/youpuUserApi', path))) };
}
for (const path of ['domain.js', 'person-date.js', 'staging-account-reset.js', 'package.json']) copyFileSync(resolve(download, path), resolve(directory, path));
copyFileSync(resolve(root, 'cloudfunctions/youpuUserApi/request-context.js'), resolve(directory, 'request-context.js'));
copyFileSync(resolve(download, 'index.js'), resolve(directory, 'source-index.js'));
copyFileSync(resolve(root, 'deployment/member-date-staging-probe.js'), resolve(directory, 'index.js'));
const secret = randomBytes(32).toString('hex');
const configPath = resolve(base, 'cloudbaserc.json');
writeFileSync(configPath, JSON.stringify({ envId: manifest.envId, functionRoot: '.', functions: [{
  name, dir: directory, handler: 'index.main', runtime: 'Nodejs20.19', timeout: 120, memorySize: 512,
  installDependency: true, envVariables: { PROBE_ENV: manifest.envId, PROBE_SECRET: secret, PROBE_RUN: run,
    STAGING_ACCOUNT_RESET_ENV: manifest.envId, STAGING_ACCOUNT_RESET_ENABLED: '1', CONTENT_MODERATION_MODE: 'strict' }
}] }), { mode: 0o600 });

function invoke(action) {
  const response = cli(['-e', manifest.envId, 'fn', 'invoke', name, '-d', JSON.stringify({ action, run, secret }), '--json'], action);
  const value = typeof response.RetMsg === 'string' ? JSON.parse(response.RetMsg) : response.RetMsg;
  if (!value || !value.success) throw new Error(action + ' 未返回成功；详见受控日志');
  return value;
}

const summary = { record: 'member-date-' + run, target: 'staging', hashes, outcomes: [], cleaned: false, functionRemoved: false };
let deployed = false;
try {
  cli(['--config-file', configPath, '-e', manifest.envId, 'fn', 'deploy', name, '--force', '--json'], 'deploy');
  deployed = true;
  summary.outcomes = invoke('run').outcomes;
  console.log(JSON.stringify({ record: summary.record, outcomes: summary.outcomes }));
} finally {
  if (deployed) {
    summary.cleaned = invoke('cleanup').cleaned === true;
    if (summary.cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove'); summary.functionRemoved = true; }
  }
  writeFileSync(resolve(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ record: summary.record, cleaned: summary.cleaned, functionRemoved: summary.functionRemoved }));
}
if (!summary.outcomes.length || summary.outcomes.some(row => !row.success)) process.exitCode = 1;
