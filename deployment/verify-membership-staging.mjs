import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { assertDeploymentTarget } from './target-guard.mjs';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('会员验收只允许 staging');
assertDeploymentTarget(manifest.envId, '会员虚构资料验收');
const base = resolve(root, 'deployment/backups/staging-membership-20261008');
const source = readFileSync(resolve(base, 'download-api/index.js'), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
if (hash(source) !== hash(readFileSync(resolve(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8'))) throw new Error('部署代码回读不一致');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const run = randomBytes(6).toString('hex'); const name = 'youpuMembershipProbe' + run; const secret = randomBytes(32).toString('hex');
const directory = resolve(base, 'probe-' + run); mkdirSync(directory, { recursive: true, mode: 0o700 });
copyFileSync(resolve(root, 'deployment/membership-staging-probe.js'), resolve(directory, 'index.js'));
writeFileSync(resolve(directory, 'purchase-api.js'), extract('function publicOrder(', 'async function membershipCatalog(') + '\n' + extract('async function paymentCreateOrder(', 'async function fulfillOrderTransaction(') + '\n' + extract('async function paymentReconcileNow(', 'async function paymentListMine(') + '\n' + extract('async function paymentListMine(', 'function publicActivity('));
writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'staging-membership-probe', version: '1.0.0', dependencies: { 'wx-server-sdk': '4.0.2' } }));
const config = { envId: manifest.envId, functionRoot: '.', functions: [{ name, dir: directory, runtime: 'Nodejs20.19', handler: 'index.main', timeout: 900, memorySize: 512, installDependency: true, envVariables: { PROBE_ENV: manifest.envId, PROBE_SECRET: secret } }] };
const configPath = resolve(directory, 'cloudbaserc.json'); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
function cli(args, label) {
  const result = spawnSync(process.env.TCB_BIN || 'tcb', args, { cwd: root, encoding: 'utf8', maxBuffer: 20000000, input: label === 'remove' ? 'y\n' : undefined });
  writeFileSync(resolve(directory, label + '.log'), result.stdout + result.stderr, { mode: 0o600 });
  if (result.status !== 0) throw new Error(label + ' 失败，详见受控日志');
  const start = result.stdout.indexOf('{'); return start >= 0 ? JSON.parse(result.stdout.slice(start)).data : null;
}
let deployed = false; const summary = { record: 'probe-' + run, codeReadbackMatches: true, cleaned: false, functionRemoved: false };
try {
  cli(['--config-file', configPath, '-e', manifest.envId, 'fn', 'deploy', name, '--force', '--json'], 'deploy'); deployed = true;
  const response = cli(['-e', manifest.envId, 'fn', 'invoke', name, '-d', JSON.stringify({ run, secret }), '--json'], 'run');
  const value = typeof response.RetMsg === 'string' ? JSON.parse(response.RetMsg) : response.RetMsg;
  summary.cleaned = Boolean(value && value.cleaned); summary.cases = value && value.data;
  if (!value || !value.success) throw new Error('虚构资料验收失败：' + (value && value.code || 'NO_RESULT'));
  console.log('staging 会员虚构资料验收通过：已付款／退款分页、历史页之外成功项、客户端返回标记、互斥筛选、待确认分页、幂等恢复及未付款状态回读；未触发平台支付');
} finally {
  if (deployed && summary.cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove'); summary.functionRemoved = true; }
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  writeFileSync(resolve(base, 'functional-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
}
