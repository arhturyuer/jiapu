#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { assertDeploymentTarget } from './target-guard.mjs';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('复制验收只允许独立 staging');
assertDeploymentTarget(manifest.envId, '虚构数据复制功能验收');
const run = randomBytes(6).toString('hex');
const base = resolve(root, 'deployment/backups/staging-copy-20261006/probe-' + run);
const directory = resolve(base, 'function'); mkdirSync(directory, { recursive: true, mode: 0o700 });
copyFileSync(resolve(root, 'deployment/family-copy-staging-probe.js'), resolve(directory, 'index.js'));
copyFileSync(resolve(root, 'cloudfunctions/youpuUserApi/family-copy.js'), resolve(directory, 'family-copy-api.js'));
copyFileSync(resolve(root, 'cloudfunctions/youpuUserApi/job-dispatcher.js'), resolve(directory, 'job-dispatcher.js'));
writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'staging-copy-probe', version: '1.0.0', dependencies: { 'wx-server-sdk': '4.0.2', 'tencentcloud-sdk-nodejs-scf': '4.0.389' } }));
const name = 'youpuCopyProbe' + run;
const secret = randomBytes(32).toString('hex');
const jobs = manifest.functions.find(f => f.name === 'youpuJobs');
const config = { envId: manifest.envId, functionRoot: '.', functions: [{ name, dir: directory, handler: 'index.main', runtime: 'Nodejs20.19', timeout: 900, memorySize: 512, installDependency: true, envVariables: { PROBE_ENV: manifest.envId, PROBE_SECRET: secret, JOB_DISPATCH_SECRET: jobs.envVariables.JOB_DISPATCH_SECRET, JOB_FUNCTION_NAMESPACE: manifest.envId } }] };
const configPath = resolve(base, 'config.json'); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
function cli(args, label) {
  const response = spawnSync(process.env.TCB_BIN || 'tcb', args, { cwd: root, encoding: 'utf8', maxBuffer: 20000000, input: label === 'remove-function' ? 'y\n' : undefined });
  writeFileSync(resolve(base, label + '.log'), response.stdout + response.stderr, { mode: 0o600 });
  if (response.status !== 0) throw new Error(label + ' 执行失败，详见受控日志');
  const start = response.stdout.indexOf('{');
  return start >= 0 ? JSON.parse(response.stdout.slice(start)).data : null;
}
function invoke(action, parameters) {
  const result = cli(['-e', manifest.envId, 'fn', 'invoke', name, '-d', JSON.stringify(Object.assign({ action, run, secret }, parameters)), '--json'], action + '-' + (parameters.large ? 'large' : parameters.role || 'small'));
  const value = typeof result.RetMsg === 'string' ? JSON.parse(result.RetMsg) : result.RetMsg;
  if (!value || !value.success) throw new Error(action + ' 失败：' + (value && (value.code + ' ' + value.message) || '函数无有效返回'));
  return value.data;
}
console.log('只操作已通过护栏的 staging；验收记录编号 probe-' + run);
async function seedFixture(large) {
  invoke('seed', { large, phase: 'start' });
  for (const [phase, count, size] of [['avatars', large ? 100 : 3, 10], ['persons', large ? 500 : 12, 50], ['relations', large ? 2000 : 15, 50]]) {
    for (let offset = 0; offset < count; offset += size) invoke('seed', { large, phase, offset });
  }
}
async function copyFixture(large, role) {
  invoke('run', { large, role, startOnly: true });
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = invoke('run', { large, role, startOnly: false });
    if (!['pending', 'processing'].includes(result.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error('复制任务仍未完成，保留受控验收记录');
}
let deployed = false; let cleaned = false;
const summary = { record: 'probe-' + run, cases: [], cleaned: false, functionRemoved: false };
try {
  cli(['--config-file', configPath, '-e', manifest.envId, 'fn', 'deploy', name, '--force', '--json'], 'deploy'); deployed = true;
  console.log('已创建仅限 staging、密钥鉴权的临时验收函数');
  await seedFixture(false);
  summary.gateway = invoke('gateway', {});
  console.log('真实用户 API 已拒绝非成员复制和非本人任务查询');
  for (const role of ['admin', 'member', 'viewer']) {
    const result = await copyFixture(false, role); summary.cases.push(result);
    console.log(role + '：' + result.personCount + ' 人/' + result.relationCount + ' 关系、独立头像及缺失提示通过');
  }
  console.log('准备 500 人、2000 条关系和 100 头像的虚构数据');
  await seedFixture(true);
  const large = await copyFixture(true, 'admin'); summary.cases.push(large);
  console.log('上限复制通过：' + large.personCount + ' 人/' + large.relationCount + ' 关系/' + large.independentAvatars + ' 独立头像');
} finally {
  if (deployed) {
    try {
      for (let attempt = 0; attempt < 100 && !cleaned; attempt += 1) cleaned = invoke('cleanup', {}).cleaned;
      summary.cleaned = cleaned;
      if (!cleaned) throw new Error('清理未完成，保留受控记录');
      console.log('本次虚构数据与文件已清理');
    }
    finally {
      // Preserve a running probe and its ledger for safe follow-up instead of
      // deleting resources while a real copy worker might still be writing.
      if (cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove-function'); summary.functionRemoved = true; console.log('临时验收函数已删除'); }
      writeFileSync(resolve(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    }
  }
}
