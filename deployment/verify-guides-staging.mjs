import { cpSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { assertDeploymentTarget } from './target-guard.mjs';
const root = resolve(import.meta.dirname, '..');
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('指南验收只允许独立 staging');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
assertDeploymentTarget(manifest.envId, '指南虚构数据验收');
const run = randomBytes(6).toString('hex'); const name = 'youpuGuidesProbe' + run;
const base = resolve(root, 'deployment/backups/guides-admin-20261019', 'probe-' + run); const directory = resolve(base, 'function');
mkdirSync(directory, { recursive: true, mode: 0o700 });
function cli(args, label) {
  const result = spawnSync(process.env.TCB_BIN || 'tcb', args, { cwd: root, encoding: 'utf8', maxBuffer: 30000000, timeout: 180000, input: label === 'remove' ? 'y\n' : undefined });
  writeFileSync(resolve(base, label + '.log'), (result.stdout || '') + (result.stderr || ''), { mode: 0o600 });
  if (result.status !== 0) throw new Error(label + '失败，详见受控日志');
  const start = result.stdout.indexOf('{'); return start >= 0 ? JSON.parse(result.stdout.slice(start)).data : null;
}
const download = resolve(base, 'download-ops');
cli(['-e', manifest.envId, 'fn', 'code', 'download', 'youpuOpsApi', download, '--json'], 'download');
const hashes = {};
for (const file of ['index.js', 'guides.js', 'guide-content.js']) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  hashes[file] = { deployed: hash(readFileSync(resolve(download, file))), local: hash(readFileSync(resolve(root, 'cloudfunctions/youpuOpsApi', file))) };
  if (hashes[file].deployed !== hashes[file].local) throw new Error('部署源码与本地不一致');
}
cpSync(download, resolve(directory, 'ops'), { recursive: true });
copyFileSync(resolve(download, 'package.json'), resolve(directory, 'package.json'));
copyFileSync(resolve(root, 'deployment/guides-staging-probe.js'), resolve(directory, 'index.js'));
const secret = randomBytes(32).toString('hex'); const config = resolve(base, 'cloudbaserc.json');
writeFileSync(config, JSON.stringify({ envId: manifest.envId, functionRoot: '.', functions: [{ name, dir: directory, handler: 'index.main', runtime: 'Nodejs20.19', timeout: 120, memorySize: 512, installDependency: true, envVariables: { PROBE_ENV: manifest.envId, PROBE_SECRET: secret, PROBE_RUN: run } }] }), { mode: 0o600 });
function invoke(action) {
  const response = cli(['-e', manifest.envId, 'fn', 'invoke', name, '-d', JSON.stringify({ action, run, secret }), '--json'], action);
  const value = typeof response.RetMsg === 'string' ? JSON.parse(response.RetMsg) : response.RetMsg;
  if (!value || !value.success) throw new Error(action + '未返回成功，详见受控日志'); return value;
}
const summary = { target: 'staging', record: 'guides-' + run, hashes, outcomes: [], cleaned: false, functionRemoved: false }; let deployed = false;
try {
  cli(['--config-file', config, '-e', manifest.envId, 'fn', 'deploy', name, '--force', '--json'], 'deploy'); deployed = true;
  summary.outcomes = invoke('run').outcomes; console.log(JSON.stringify({ target: 'staging', outcomes: summary.outcomes }));
} finally {
  try { if (deployed) { summary.cleaned = invoke('cleanup').cleaned === true; if (summary.cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove'); summary.functionRemoved = true; } } }
  finally { writeFileSync(resolve(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ target: 'staging', cleaned: summary.cleaned, functionRemoved: summary.functionRemoved })); }
}
if (!summary.outcomes.length || !summary.cleaned || !summary.functionRemoved) process.exitCode = 1;
