import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { assertDeploymentTarget } from './target-guard.mjs';

const root = resolve(import.meta.dirname, '..');
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('调用优化验收只允许独立 staging');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
assertDeploymentTarget(manifest.envId, '调用优化虚构数据验收');
const run = randomBytes(6).toString('hex');
const name = 'youpuCallOptimizationProbe' + run;
const record = 'call-optimization-' + run;
const baseline = resolve(root, 'deployment/backups/staging-call-optimization-20261012');
const base = resolve(baseline, record);
const directory = resolve(base, 'function');
mkdirSync(directory, { recursive: true, mode: 0o700 });

function cli(args, label) {
  const result = spawnSync(process.env.TCB_BIN || 'tcb', args, { cwd: root, encoding: 'utf8', maxBuffer: 30000000,
    timeout: label === 'download-jobs' ? 240000 : label.startsWith('download') ? 90000 : 180000, input: label === 'remove' ? 'y\n' : undefined });
  writeFileSync(resolve(base, label + '.log'), (result.stdout || '') + (result.stderr || ''), { mode: 0o600 });
  if (result.status !== 0) throw new Error(label + ' 失败，详见受控记录 ' + record);
  const start = result.stdout.indexOf('{');
  return start >= 0 ? JSON.parse(result.stdout.slice(start)).data : null;
}

const files = {
  user: ['index.js', 'domain.js', 'commerce.js', 'person-date.js', 'analytics.js', 'request-context.js'],
  ops: ['index.js', 'analytics.js', 'analytics-service.js'],
  jobs: ['index.js', 'retention-cleanup.js']
};
const hashes = [];
for (const [kind, functionName] of [['user', 'youpuUserApi'], ['ops', 'youpuOpsApi'], ['jobs', 'youpuJobs']]) {
  const downloaded = resolve(base, 'download-' + functionName);
  // Jobs code contains a large Linux runtime. Only the API ZIP is downloaded;
  // tolerate extraction timeout solely when every required source hash agrees.
  let downloadError;
  try { cli(['-e', manifest.envId, 'fn', 'code', 'download', functionName, downloaded, '--json'], 'download-' + kind); }
  catch (error) { downloadError = error; }
  const output = resolve(directory, 'after-' + kind);
  const before = resolve(directory, 'baseline-' + kind);
  mkdirSync(output, { recursive: true }); mkdirSync(before, { recursive: true });
  for (const file of files[kind]) {
    const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    const cloud = resolve(downloaded, file);
    const local = resolve(root, 'cloudfunctions', functionName, file);
    if (!existsSync(cloud) || hash(cloud) !== hash(local)) throw downloadError || new Error(functionName + '/' + file + ' 云端源码不一致');
    hashes.push({ function: functionName, file, sha256: hash(cloud) });
    copyFileSync(cloud, resolve(output, file));
    const old = resolve(baseline, 'baseline-' + functionName, file);
    if (existsSync(old)) copyFileSync(old, resolve(before, file));
  }
}
for (const file of ['request-context.js']) copyFileSync(resolve(root, 'cloudfunctions/youpuUserApi', file), resolve(directory, file));
copyFileSync(resolve(root, 'cloudfunctions/youpuJobs/retention-cleanup.js'), resolve(directory, 'retention-cleanup.js'));
copyFileSync(resolve(root, 'deployment/call-optimization-staging-probe.js'), resolve(directory, 'index.js'));
writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'staging-call-optimization-probe', version: '1.0.0', dependencies: { 'wx-server-sdk': '4.0.2', 'lunar-javascript': '1.7.7' } }));
const secret = randomBytes(32).toString('hex');
const configPath = resolve(base, 'cloudbaserc.json');
writeFileSync(configPath, JSON.stringify({ envId: manifest.envId, functionRoot: '.', functions: [{ name, dir: directory, handler: 'index.main',
  runtime: 'Nodejs20.19', timeout: 180, memorySize: 512, installDependency: true,
  envVariables: { PROBE_ENV: manifest.envId, PROBE_SECRET: secret, PROBE_RUN: run }
}] }), { mode: 0o600 });

function invoke(action) {
  const response = cli(['-e', manifest.envId, 'fn', 'invoke', name, '-d', JSON.stringify({ action, run, secret }), '--json'], action);
  const value = typeof response.RetMsg === 'string' ? JSON.parse(response.RetMsg) : response.RetMsg;
  if (!value || !value.success) throw new Error(action + ' 未返回成功；详见受控记录 ' + record);
  return value;
}

const summary = { record, target: 'staging', hashes, rows: [], checks: [], cleaned: false, functionRemoved: false };
let deployed = false;
try {
  cli(['--config-file', configPath, '-e', manifest.envId, 'fn', 'deploy', name, '--force', '--json'], 'deploy');
  deployed = true;
  const result = invoke('run');
  summary.rows = result.rows; summary.checks = result.checks;
  const after = summary.rows.filter(row => row.phase === 'after');
  if (after.length !== 6 || after.some(row => {
    const before = summary.rows.find(item => item.phase === 'baseline' && item.scenario === row.scenario);
    return !before || row.reads + row.writes >= before.reads + before.writes;
  })) throw new Error('同条件 staging SDK 操作数未全部下降');
  console.log(JSON.stringify({ record, rows: summary.rows, checks: summary.checks }));
} finally {
  if (deployed) {
    summary.cleaned = invoke('cleanup').cleaned === true;
    if (summary.cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove'); summary.functionRemoved = true; }
  }
  writeFileSync(resolve(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ record, cleaned: summary.cleaned, functionRemoved: summary.functionRemoved }));
}
