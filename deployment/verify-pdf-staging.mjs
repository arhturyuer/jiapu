import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertDeploymentTarget } from './target-guard.mjs';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('PDF 验收仅允许 staging');
assertDeploymentTarget(manifest.envId, 'PDF 虚构数据验收');
const run = randomBytes(6).toString('hex'); const name = 'youpuPdfProbe' + run;
const base = resolve(root, 'deployment/backups/staging-pdf-20261007/probe-' + run);
const directory = resolve(base, 'function'); mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const [source, target] of [['deployment/pdf-staging-probe.js', 'index.js'], ['cloudfunctions/youpuUserApi/pdf-export.js', 'pdf-export.js'], ['cloudfunctions/youpuUserApi/family-copy.js', 'family-copy.js'], ['cloudfunctions/youpuUserApi/job-dispatcher.js', 'job-dispatcher.js']]) copyFileSync(resolve(root, source), resolve(directory, target));
writeFileSync(resolve(directory, 'config.json'), JSON.stringify({ permissions: { openapi: ['wxacode.getUnlimited'] } }));
writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'pdf-staging-probe', version: '1.0.0', dependencies: { 'wx-server-sdk': '4.0.2', 'tencentcloud-sdk-nodejs-scf': '4.0.389' } }));
const jobs = manifest.functions.find(f => f.name === 'youpuJobs'); const secret = randomBytes(32).toString('hex');
const config = { envId: manifest.envId, functionRoot: '.', functions: [{ name, dir: directory, handler: 'index.main', runtime: 'Nodejs20.19', timeout: 900, memorySize: 512, installDependency: true, envVariables: { PROBE_ENV: manifest.envId, PROBE_SECRET: secret, JOB_DISPATCH_SECRET: jobs.envVariables.JOB_DISPATCH_SECRET, JOB_FUNCTION_NAMESPACE: manifest.envId } }] };
const configPath = resolve(base, 'config.json'); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
function cli(args, label) {
  const result = spawnSync(process.env.TCB_BIN || 'tcb', args, { cwd: root, encoding: 'utf8', maxBuffer: 20000000, input: label === 'remove' ? 'y\n' : undefined });
  writeFileSync(resolve(base, label + '.log'), result.stdout + result.stderr, { mode: 0o600 });
  if (result.status !== 0) throw new Error(label + ' 失败，详见受控日志');
  const start = result.stdout.indexOf('{'); return start >= 0 ? JSON.parse(result.stdout.slice(start)).data : null;
}
let miniProgram;
if (process.argv.includes('--wechat')) {
  if (!process.env.WECHAT_AUTOMATOR_MODULE) throw new Error('请指定本地微信自动化 SDK 路径');
  const automator = createRequire(import.meta.url)(process.env.WECHAT_AUTOMATOR_MODULE);
  miniProgram = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
}
async function userApi(data) {
  if (!miniProgram) throw new Error('原生码验收请使用 --wechat');
  const result = await miniProgram.evaluate(function (env, input) {
    wx.cloud.init({ env: env, traceUser: true });
    return wx.cloud.callFunction({ name: 'youpuUserApi', config: { env }, data: input }).then(function (response) {
      if (input.type === 'auth.login' && response.result.success) return { success: true, data: { userId: response.result.data.user._id, accountState: response.result.data.accountState } };
      return response.result;
    });
  }, manifest.envId, data);
  if (!result || !result.success) throw new Error('客户端用户 API 失败：' + (result && result.code || 'NO_RESULT'));
  return result.data;
}
async function invoke(action, input = {}) {
  const response = cli(['-e', manifest.envId, 'fn', 'invoke', name, '-d', JSON.stringify({ action, run, secret, ...input }), '--json'], action + '-' + (input.role || input.phase || '') + '-' + (input.format || input.offset || '') + '-' + Boolean(input.example));
  const result = typeof response.RetMsg === 'string' ? JSON.parse(response.RetMsg) : response.RetMsg;
  if (!result || !result.success) throw new Error(action + ' 验收失败：' + (result && result.code || 'NO_RESULT'));
  return result.data;
}

const summary = { record: 'probe-' + run, cases: [], cleaned: false, functionRemoved: false, transport: miniProgram ? 'wechat-develop' : 'cli' }; let deployed = false;
try {
  console.log('PDF staging 验收记录 ' + summary.record);
  cli(['--config-file', configPath, '-e', manifest.envId, 'fn', 'deploy', name, '--force', '--json'], 'deploy'); deployed = true;
  await invoke('seed', { phase: 'start' });
  for (let offset = 0; offset < 500; offset += 50) await invoke('seed', { phase: 'persons', offset });
  await invoke('seed', { phase: 'avatars' });
  if (!miniProgram) throw new Error('原生小程序码需要 --wechat 客户端调用票据');
  const account = await userApi({ type: 'auth.login' });
  await invoke('clientPrepare', { actorId: account.userId });
  summary.nativeClient = [];
  for (const source of ['family', 'example']) {
    const task = await userApi({ type: 'pdf.create', source, familyId: source === 'family' ? 'pdf_probe_' + run : '', slug: source === 'example' ? 'pdf_probe_' + run : '', format: 'poster', display: { nameLayout: 'horizontal', showGenderColors: true }, requestId: 'pdf-native-' + run + '-' + source });
    let state;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      state = (await userApi({ type: 'pdf.status', taskId: task.taskId })).task;
      if (!['pending', 'processing'].includes(state.status)) break;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (!state || state.status !== 'completed') throw new Error('客户端原生码任务失败：' + (state && state.failureCode || 'TIMEOUT'));
    const verified = await invoke('clientStatus', { taskId: task.taskId });
    if (!verified.nativeCodeReady) throw new Error('客户端原生码缺失');
    summary.nativeClient.push({ source, personCount: state.personCount, pageCount: state.pageCount, nativeCodeReady: true });
    console.log('已部署用户 API：' + source + ' 原生码与 PDF 生成通过');
  }
  summary.gateway = await invoke('gateway');
  for (const [role, format, example] of [['admin', 'poster', false], ['admin', 'book', false], ['member', 'poster', false], ['viewer', 'book', false], ['viewer', 'book', true], ['viewer', 'poster', true]]) {
    const started = await invoke('start', { role, format, example, vertical: false }); let task;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      task = await invoke('status', { role, taskId: started.taskId });
      if (!['pending', 'processing'].includes(task.status)) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (!task || task.status !== 'completed') throw new Error('PDF 未完成：' + (task && task.failureCode || 'TIMEOUT'));
    if (task.personCount !== (example ? 12 : 500) || !task.pageCount) throw new Error('PDF 数据不完整');
    const response = await fetch(task.download.url); if (!response.ok) throw new Error('成品下载失败');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('成品不是 PDF');
    if (!example && (task.unavailableMediaCount !== 1 || (bytes.toString('latin1').match(/\/Subtype \/Image\b/g) || []).length < (format === 'poster' ? 2 : 1))) throw new Error('有效照片未成功嵌入成品');
    if (format === 'poster' && !task.miniCodePolicy) throw new Error('长期查看码业务规则未验证');
    if (format === 'poster' && !(bytes.toString('latin1').match(/\/Subtype \/Image\b/g) || []).length) throw new Error('小程序码未嵌入');
    writeFileSync(resolve(base, role + '-' + format + '-' + example + '.pdf'), bytes, { mode: 0o600 });
    summary.cases.push({ role, format, example, count: started.count, personCount: task.personCount, relationCount: task.relationCount, pageCount: task.pageCount, bytes: bytes.length, unavailableMediaCount: task.unavailableMediaCount, miniCodePolicy: task.miniCodePolicy || null });
    console.log(role + ' ' + format + (example ? ' 示例' : ' 真实') + '：' + task.personCount + ' 人，' + task.pageCount + ' 页，下载通过');
  }
  const boundary = await invoke('quota'); let quotaTask;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    quotaTask = await invoke('status', { role: 'admin', taskId: boundary.taskId });
    if (!['pending', 'processing'].includes(quotaTask.status)) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!quotaTask || quotaTask.status !== 'completed') throw new Error('额度边界任务未完成');
  summary.quota = { ...await invoke('quotaLimit'), twentiethCompleted: true };
  console.log('每日第 20 次创建与幂等通过，第 21 次被拒绝');
} finally {
  if (deployed) {
    try { const cleanup = await invoke('cleanup'); summary.cleaned = cleanup.cleaned; summary.clientPdfStateRestored = cleanup.clientPdfStateRestored; if (summary.cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove'); summary.functionRemoved = true; console.log('虚构资料、文件与临时验收函数已清理'); } }
    finally { if (miniProgram) miniProgram.disconnect(); writeFileSync(resolve(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 }); }
  }
}
