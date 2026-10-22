import { cpSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { assertDeploymentTarget } from './target-guard.mjs';
const root = resolve(import.meta.dirname, '..');
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('夫妻顺序验收只允许独立 staging');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
assertDeploymentTarget(manifest.envId, '夫妻顺序虚构数据验收');
const run = randomBytes(6).toString('hex'); const name = 'youpuSpouseOrderProbe' + run;
const base = resolve(root, 'deployment/backups/spouse-order-20261020', 'probe-' + run);
const directory = resolve(base, 'function'); mkdirSync(directory, { recursive: true, mode: 0o700 });
function cli(args, label) {
  const result = spawnSync(process.env.TCB_BIN || 'tcb', args, { cwd: root, encoding: 'utf8', maxBuffer: 30000000, timeout: 180000, input: label === 'remove' ? 'y\n' : undefined });
  writeFileSync(resolve(base, label + '.log'), (result.stdout || '') + (result.stderr || ''), { mode: 0o600 });
  if (result.status !== 0) throw new Error(label + '失败，详见受控日志');
  const start = result.stdout.indexOf('{'); return start >= 0 ? JSON.parse(result.stdout.slice(start)).data : null;
}
const hashes = {};
for (const fn of ['youpuUserApi', 'youpuJobs']) {
  const download = resolve(base, 'download-' + fn);
  cli(['-e', manifest.envId, 'fn', 'code', 'download', fn, download, '--json'], 'download-' + fn);
  const source = resolve(root, 'cloudfunctions', fn);
  function compare(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (['node_modules', 'config.json'].includes(entry.name)) continue;
      const file = resolve(folder, entry.name);
      if (entry.isDirectory()) compare(file);
      else {
        const name = relative(source, file); const hash = bytes => createHash('sha256').update(bytes).digest('hex');
        const expected = hash(readFileSync(file)); const actual = hash(readFileSync(resolve(download, name)));
        hashes[fn + '/' + name] = { local: expected, deployed: actual };
        if (expected !== actual) throw new Error('部署源码不一致：' + fn + '/' + name);
      }
    }
  }
  compare(source);
  if (fn === 'youpuUserApi') { cpSync(download, resolve(directory, 'user'), { recursive: true, filter: file => !relative(download, file).split('/').includes('node_modules') }); copyFileSync(resolve(download, 'package.json'), resolve(directory, 'package.json')); }
}
copyFileSync(resolve(root, 'deployment/spouse-order-staging-probe.js'), resolve(directory, 'index.js'));
const secret = randomBytes(32).toString('hex'); const config = resolve(base, 'cloudbaserc.json');
writeFileSync(config, JSON.stringify({ envId: manifest.envId, functionRoot: '.', functions: [{ name, dir: directory, handler: 'index.main', runtime: 'Nodejs20.19', timeout: 120, memorySize: 512, installDependency: true, envVariables: { PROBE_ENV: manifest.envId, PROBE_SECRET: secret, PROBE_RUN: run } }] }), { mode: 0o600 });
function invoke(action) {
  const response = cli(['-e', manifest.envId, 'fn', 'invoke', name, '-d', JSON.stringify({ action, run, secret }), '--json'], action);
  const value = typeof response.RetMsg === 'string' ? JSON.parse(response.RetMsg) : response.RetMsg;
  if (!value || !value.success) throw new Error(action + '未返回成功，详见受控日志'); return value;
}
const summary = { target: 'staging', record: 'spouse-order-' + run, hashes, outcomes: [], cleaned: false, functionRemoved: false }; let deployed = false;
try {
  cli(['--config-file', config, '-e', manifest.envId, 'fn', 'deploy', name, '--force', '--json'], 'deploy'); deployed = true;
  summary.outcomes = invoke('run').outcomes;
} finally {
  try { if (deployed) { summary.cleaned = invoke('cleanup').cleaned === true; if (summary.cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove'); summary.functionRemoved = true; } } }
  finally { writeFileSync(resolve(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ target: 'staging', record: summary.record, sourceFiles: Object.keys(hashes).length, outcomes: summary.outcomes, cleaned: summary.cleaned, functionRemoved: summary.functionRemoved })); }
}
if (!summary.outcomes.length || !summary.cleaned || !summary.functionRemoved) process.exitCode = 1;
