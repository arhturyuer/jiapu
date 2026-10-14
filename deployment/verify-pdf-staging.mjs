import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertDeploymentTarget } from './target-guard.mjs';
const root = resolve(import.meta.dirname, '..');
const layoutOnly = process.argv.includes('--layout-only');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('PDF 验收仅允许 staging');
assertDeploymentTarget(manifest.envId, 'PDF 虚构数据验收');
const run = randomBytes(6).toString('hex'); const name = 'youpuPdfProbe' + run;
const base = resolve(root, 'deployment/backups/pdf-layout-20261013/probe-' + run);
const directory = resolve(base, 'function'); mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const [source, target] of [['deployment/pdf-staging-probe.js', 'index.js'], ['cloudfunctions/youpuUserApi/pdf-export.js', 'pdf-export.js'], ['cloudfunctions/youpuUserApi/family-copy.js', 'family-copy.js'], ['cloudfunctions/youpuUserApi/job-dispatcher.js', 'job-dispatcher.js'], ...['pdf-graph-source.js', 'domain.js', 'person-date.js'].map(name => ['cloudfunctions/youpuUserApi/' + name, name])]) copyFileSync(resolve(root, source), resolve(directory, target));
cpSync(resolve(root, 'cloudfunctions/youpuUserApi/pdf-shared'), resolve(directory, 'pdf-shared'), { recursive: true });
writeFileSync(resolve(directory, 'config.json'), JSON.stringify({ permissions: { openapi: ['wxacode.getUnlimited'] } }));
writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'pdf-staging-probe', version: '1.0.0', dependencies: { 'wx-server-sdk': '4.0.2', 'tencentcloud-sdk-nodejs-scf': '4.0.389', 'lunar-javascript': '1.7.7' } }));
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
  await invoke('seed', { phase: 'start', dense: layoutOnly });
  for (let offset = 0; offset < 500; offset += 50) await invoke('seed', { phase: 'persons', offset, dense: layoutOnly });
  await invoke('seed', { phase: 'avatars' });
  if (!miniProgram) throw new Error('原生小程序码需要 --wechat 客户端调用票据');
  const account = await userApi({ type: 'auth.login' });
  await invoke('clientPrepare', { actorId: account.userId, reserve: layoutOnly ? 3 : 2 });
  summary.nativeClient = [];
  for (const source of ['family', 'example']) {
    const sourceData = source === 'family' ? await userApi({ type: 'graph.get', familyId: 'pdf_probe_' + run }) : (await userApi({ type: 'examples.get', slug: 'pdf_probe_' + run })).example;
    const captured = await miniProgram.evaluate(function (graph, revision) {
      return require('utils/pdf-layout-snapshot.js').create(graph.persons, graph.relations, 'horizontal', revision);
    }, sourceData, source === 'family' ? sourceData.contentRevision : sourceData.publishedVersion);
    const task = await userApi({ type: 'pdf.create', source, familyId: source === 'family' ? 'pdf_probe_' + run : '', slug: source === 'example' ? 'pdf_probe_' + run : '', format: 'poster', display: { nameLayout: 'horizontal', showGenderColors: true }, layoutSnapshot: captured, requestId: 'pdf-native-' + run + '-' + source });
    let state;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      state = (await userApi({ type: 'pdf.status', taskId: task.taskId })).task;
      if (!['pending', 'processing'].includes(state.status)) break;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (!state || state.status !== 'completed') throw new Error('客户端原生码任务失败：' + (state && state.failureCode || 'TIMEOUT'));
    const verified = await invoke('clientStatus', { taskId: task.taskId });
    if (!verified.nativeCodeReady || !verified.geometryVerified || verified.layoutVersion !== captured.version || captured.version !== 2) throw new Error('客户端原生码或布局几何核对失败');
    const download = await userApi({ type: 'pdf.downloadUrl', taskId: task.taskId });
    const response = await fetch(download.url); if (!response.ok) throw new Error('客户端成品下载失败');
    const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('客户端成品不是 PDF');
    writeFileSync(resolve(base, 'native-' + source + '.pdf'), bytes, { mode: 0o600 });
    summary.nativeClient.push({ source, personCount: state.personCount, relationCount: state.relationCount, pageCount: state.pageCount, nativeCodeReady: true, bytes: bytes.length, ...verified });
    console.log('已部署用户 API：' + source + ' 客户端布局、原生码与 PDF 生成通过');
  }
  if (layoutOnly) {
    const graph = await userApi({ type: 'graph.get', familyId: 'pdf_probe_' + run });
    if (graph.persons.length !== 500 || graph.relations.length !== 2000) throw new Error('虚构家谱容量不完整');
    await miniProgram.evaluate(function (data) {
      require('utils/pdf-entry.js').open({ data: { currentFamily: data.family, rawPersons: data.persons, rawRelations: data.relations, contentRevision: data.contentRevision,
        nameLayout: 'horizontal', showGenderColors: true, showChildRankBadge: true, viewMode: 'perspective', collapsedPersonIds: [data.persons[0]._id], graphContentScale: 2 } }, 'family');
    }, graph);
    let page;
    for (let i = 0; i < 20; i++) { page = await miniProgram.currentPage(); if (page && page.path === 'pages/pdf-export/index' && !await page.data('loading')) break; await new Promise(resolve => setTimeout(resolve, 500)); }
    if (!page || page.path !== 'pages/pdf-export/index') throw new Error('PDF 内存交接页面未打开');
    const previous = await page.data('task');
    await page.callMethod('generate'); let state;
    for (let i = 0; i < 100; i++) { state = await page.data('task'); if (state && (!previous || state.taskId !== previous.taskId) && !['pending', 'processing'].includes(state.status)) break; await new Promise(resolve => setTimeout(resolve, 3000)); }
    if (!state || state.status !== 'completed') throw new Error('PDF 页面生成失败：' + (state && state.failureCode || await page.data('taskError')));
    const verified = await invoke('clientStatus', { taskId: state.taskId });
    if (!verified.geometryVerified || verified.nodeCount !== 500) throw new Error('PDF 页面布局未完整传递');
    const file = await page.callMethod('file'); if (!file || !file.filePath) throw new Error('小程序 PDF 文件下载未完成');
    summary.clientPage = { geometryVerified: true, personCount: state.personCount, relationCount: state.relationCount, fileDownloaded: true, snapshotBytes: verified.snapshotBytes };
    await miniProgram.navigateBack(); console.log('500 人／' + graph.relations.length + ' 条关系：真实 PDF 入口、内存交接、新任务生成及客户端下载通过');
  } else summary.gateway = await invoke('gateway');
  const cases = layoutOnly ? [] : [['admin', 'poster', false, false, false], ['admin', 'book', false, false, false], ['member', 'poster', false, true, false], ['viewer', 'book', false, false, false], ['viewer', 'book', true, false, false], ['viewer', 'poster', true, false, true]];
  for (const [role, format, example, vertical, legacy] of cases) {
    const started = await invoke('start', { role, format, example, vertical, legacy }); let task;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      task = await invoke('status', { role, taskId: started.taskId });
      if (!['pending', 'processing'].includes(task.status)) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (!task || task.status !== 'completed') throw new Error('PDF 未完成：' + (task && task.failureCode || 'TIMEOUT'));
    if (task.personCount !== (example ? 12 : 500) || !task.pageCount) throw new Error('PDF 数据不完整');
    if (format === 'poster' && !legacy && !task.geometryVerified) throw new Error('PDF 快照几何不一致');
    const response = await fetch(task.download.url); if (!response.ok) throw new Error('成品下载失败');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('成品不是 PDF');
    if (!example && (task.unavailableMediaCount !== 1 || (bytes.toString('latin1').match(/\/Subtype \/Image\b/g) || []).length < (format === 'poster' ? 2 : 1))) throw new Error('有效照片未成功嵌入成品');
    if (format === 'poster' && !task.miniCodePolicy) throw new Error('长期查看码业务规则未验证');
    if (format === 'poster' && !(bytes.toString('latin1').match(/\/Subtype \/Image\b/g) || []).length) throw new Error('小程序码未嵌入');
    writeFileSync(resolve(base, role + '-' + format + '-' + example + '.pdf'), bytes, { mode: 0o600 });
    summary.cases.push({ role, format, example, vertical: Boolean(vertical), legacy: Boolean(legacy), geometryVerified: task.geometryVerified, snapshotBytes: task.snapshotBytes || 0, count: started.count, personCount: task.personCount, relationCount: task.relationCount, pageCount: task.pageCount, bytes: bytes.length, unavailableMediaCount: task.unavailableMediaCount, miniCodePolicy: task.miniCodePolicy || null });
    console.log(role + ' ' + format + (example ? ' 示例' : ' 真实') + '：' + task.personCount + ' 人，' + task.pageCount + ' 页，下载通过');
  }
  summary.layoutRejected = await invoke('layoutReject');
  console.log('旧版本、缺失成员与伪造线段被拒绝，额度保持');
  if (!layoutOnly) {
    const boundary = await invoke('quota'); let quotaTask;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      quotaTask = await invoke('status', { role: 'admin', taskId: boundary.taskId });
      if (!['pending', 'processing'].includes(quotaTask.status)) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (!quotaTask || quotaTask.status !== 'completed') throw new Error('额度边界任务未完成');
    summary.quota = { ...await invoke('quotaLimit'), twentiethCompleted: true };
    console.log('每日第 20 次创建与幂等通过，第 21 次被拒绝');
  }
} catch (error) {
  summary.failure = String(error.message).slice(0, 300);
  throw error;
} finally {
  if (deployed) {
    try { const cleanup = await invoke('cleanup'); summary.cleaned = cleanup.cleaned; summary.clientPdfStateRestored = cleanup.clientPdfStateRestored; if (summary.cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove'); summary.functionRemoved = true; console.log('虚构资料、文件与临时验收函数已清理'); } }
    catch (error) { summary.cleanupFailure = String(error.message).slice(0, 300); throw error; }
    finally { if (miniProgram) miniProgram.disconnect(); writeFileSync(resolve(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 }); }
  }
}
