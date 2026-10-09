import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { assertDeploymentTarget } from './target-guard.mjs';
const root = resolve(import.meta.dirname, '..');
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('兑换码验收只允许独立 staging');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
assertDeploymentTarget(manifest.envId, '会员兑换码虚构资料验收');
const base = resolve(root, 'deployment/backups/staging-redemption-20261009');
const hash = data => createHash('sha256').update(data).digest('hex');
const files = {
  youpuUserApi: ['index.js', 'commerce.js', 'membership-redemption.js', 'membership-records.js'],
  youpuOpsApi: ['index.js', 'commerce.js', 'redemption-codes.js', 'membership-records.js'],
  youpuPaymentNotify: ['index.js', 'protocol.js'], youpuJobs: ['index.js']
};
let matched = 0;
for (const [name, paths] of Object.entries(files)) for (const path of paths) {
  if (hash(readFileSync(resolve(base, 'download-' + name, path))) !== hash(readFileSync(resolve(root, 'cloudfunctions', name, path)))) throw new Error('部署源码回读不一致：' + name + '/' + path);
  matched++;
}
const run = randomBytes(6).toString('hex'); const name = 'youpuRedemptionProbe' + run;
const directory = resolve(base, 'probe-' + run); mkdirSync(directory, { recursive: true, mode: 0o700 });
const secret = randomBytes(32).toString('hex');
copyFileSync(resolve(root, 'deployment/redemption-staging-probe.js'), resolve(directory, 'index.js'));
for (const path of ['commerce.js', 'membership-records.js', 'membership-redemption.js']) copyFileSync(resolve(base, 'download-youpuUserApi', path), resolve(directory, path));
copyFileSync(resolve(base, 'download-youpuOpsApi/redemption-codes.js'), resolve(directory, 'redemption-codes.js'));
copyFileSync(resolve(base, 'download-youpuPaymentNotify/protocol.js'), resolve(directory, 'protocol.js'));
function extract(source, start, end) {
  const first = source.indexOf(start); const last = source.indexOf(end, first);
  if (first < 0 || last <= first) throw new Error('探针代码边界缺失'); return source.slice(first, last);
}
const userSource = readFileSync(resolve(base, 'download-youpuUserApi/index.js'), 'utf8');
const opsSource = readFileSync(resolve(base, 'download-youpuOpsApi/index.js'), 'utf8');
writeFileSync(resolve(directory, 'user-mutate.js'), extract(userSource, 'async function mutate(', 'async function createPersonTx('));
writeFileSync(resolve(directory, 'user-delivery.js'), extract(userSource, 'async function fulfillOrderTransaction(', 'async function paymentMockComplete('));
writeFileSync(resolve(directory, 'ops-mutate.js'), extract(opsSource, 'async function writeOpsAudit(', 'function encodeTimeCursor('));
const notifySource = readFileSync(resolve(base, 'download-youpuPaymentNotify/index.js'), 'utf8');
writeFileSync(resolve(directory, 'payment-refund.js'), extract(notifySource, 'async function applyRefund(', 'function isTrustedInternalInvocation('));
writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'staging-redemption-probe', version: '1.0.0', dependencies: { 'wx-server-sdk': '4.0.2' } }));
const configPath = resolve(directory, 'cloudbaserc.json');
writeFileSync(configPath, JSON.stringify({ envId: manifest.envId, functionRoot: '.', functions: [{ name, dir: directory, runtime: 'Nodejs20.19', handler: 'index.main', timeout: 900, memorySize: 512, installDependency: true, envVariables: { PROBE_ENV: manifest.envId, PROBE_SECRET: secret } }] }), { mode: 0o600 });
function cli(args, label) {
  const response = spawnSync(process.env.TCB_BIN || 'tcb', args, { cwd: root, encoding: 'utf8', maxBuffer: 20000000, input: label === 'remove' ? 'y\n' : undefined });
  writeFileSync(resolve(directory, label + '.log'), response.stdout + response.stderr, { mode: 0o600 });
  if (response.status !== 0) throw new Error(label + ' 失败，详见受控日志');
  const start = response.stdout.indexOf('{'); return start >= 0 ? JSON.parse(response.stdout.slice(start)).data : null;
}
function invoke(action) {
  const response = cli(['-e', manifest.envId, 'fn', 'invoke', name, '-d', JSON.stringify({ action, run, secret }), '--json'], action);
  const value = typeof response.RetMsg === 'string' ? JSON.parse(response.RetMsg) : response.RetMsg;
  if (!value || !value.success) throw new Error(action + ' 失败：' + (value && (value.code + ' ' + value.message) || '无有效返回'));
  return value.data;
}
const summary = { record: 'probe-' + run, matchedSourceFiles: matched, checks: {}, cleaned: false, functionRemoved: false };
let deployed = false;
try {
  cli(['--config-file', configPath, '-e', manifest.envId, 'fn', 'deploy', name, '--force', '--json'], 'deploy'); deployed = true;
  invoke('seed'); summary.checks = invoke('run'); console.log('staging 兑换功能虚构资料验收通过');
} finally {
  if (deployed) {
    summary.cleaned = invoke('cleanup').cleaned;
    if (summary.cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove'); summary.functionRemoved = true; }
  }
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log('验收记录 ' + summary.record + '，源码 ' + matched + ' 项一致，数据清理=' + summary.cleaned + '，临时函数删除=' + summary.functionRemoved);
}
