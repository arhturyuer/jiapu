import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { assertDeploymentTarget } from './target-guard.mjs';
const root = resolve(import.meta.dirname, '..');
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('数据库优化验收只允许独立 staging');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.staging.local.json')));
assertDeploymentTarget(manifest.envId, '数据库调用对照');
const stage = process.env.CALL_REDUCTION_STAGE || '1';
if (!/^[123]$/.test(stage)) throw new Error('阶段必须为 1、2 或 3');
const run = randomBytes(6).toString('hex'); const name = 'youpuDbCallsProbe' + run;
const base = resolve(root, 'deployment/backups/call-reduction-20261013', 'stage-' + stage + '-' + run);
const directory = resolve(base, 'function'); mkdirSync(directory, { recursive: true, mode: 0o700 });
function cli(args, label, timeout = 180000) {
  const result = spawnSync(process.env.TCB_BIN || 'tcb', args, { cwd: root, encoding: 'utf8', maxBuffer: 30000000, timeout,
    input: label === 'remove' ? 'y\n' : undefined });
  writeFileSync(resolve(base, label + '.log'), (result.stdout || '') + (result.stderr || ''), { mode: 0o600 });
  if (result.status !== 0) throw new Error(label + ' 失败；受控记录 ' + relative(root, base));
  const start = result.stdout.indexOf('{'); return start < 0 ? null : JSON.parse(result.stdout.slice(start)).data;
}
function copySource(from, to) {
  mkdirSync(to, { recursive: true });
  for (const item of readdirSync(from)) {
    if (['node_modules', '.git'].includes(item)) continue;
    const source = join(from, item); const target = join(to, item);
    if (statSync(source).isDirectory()) copySource(source, target); else copyFileSync(source, target);
  }
}
const hashes = [];
const components = [['user', 'youpuUserApi'], ['ops', 'youpuOpsApi']];
if (stage === '3') components.push(['jobs', 'youpuJobs']);
for (const [kind, functionName] of components) {
  const downloaded = resolve(base, 'download-' + functionName);
  let downloadError;
  try { cli(['-e', manifest.envId, 'fn', 'code', 'download', functionName, downloaded, '--json'], 'download-' + kind, kind === 'jobs' ? 240000 : 180000); }
  catch (error) { downloadError = error; }
  // The large jobs ZIP can time out during dependency extraction. Accept it
  // only if every application source and package hash already matches.
  if (downloadError && kind !== 'jobs') throw downloadError;
  const local = resolve(root, 'cloudfunctions', functionName);
  for (const file of readdirSync(local).filter(file => file.endsWith('.js') || file === 'package.json')) {
    const hash = location => createHash('sha256').update(readFileSync(location)).digest('hex');
    if (!existsSync(resolve(downloaded, file)) || hash(resolve(local, file)) !== hash(resolve(downloaded, file))) throw new Error(functionName + '/' + file + ' 回读不一致');
    hashes.push({ functionName, file, sha256: hash(resolve(local, file)) });
  }
  if (kind === 'jobs') {
    for (const phase of ['before', 'after']) {
      const source = phase === 'before' ? resolve(root, 'deployment/backups/call-reduction-20261013/baseline/cloudfunctions', functionName) : downloaded;
      const target = resolve(directory, phase + '-jobs'); mkdirSync(target, { recursive: true });
      for (const file of readdirSync(source).filter(file => file.endsWith('.js'))) copyFileSync(resolve(source, file), resolve(target, file));
    }
  } else {
    copySource(downloaded, resolve(directory, 'after-' + kind));
    copySource(resolve(root, 'deployment/backups/call-reduction-20261013/baseline/cloudfunctions', functionName), resolve(directory, 'before-' + kind));
  }
}
copyFileSync(resolve(root, 'deployment/database-call-reduction-probe.js'), resolve(directory, 'index.js'));
copyFileSync(resolve(root, 'tests/helpers/counting-runtime.js'), resolve(directory, 'counting-runtime.js'));
copyFileSync(resolve(root, 'tests/helpers/miniapp-runtime.js'), resolve(directory, 'miniapp-runtime.js'));
for (const phase of ['before', 'after']) {
  const source = phase === 'before' ? resolve(root, 'deployment/backups/call-reduction-20261013/baseline') : root;
  for (const file of ['miniprogram/app.js', 'miniprogram/utils/api.js', 'miniprogram/utils/activity-ledger.js']) {
    const target = resolve(directory, phase + '-client', file); mkdirSync(resolve(target, '..'), { recursive: true });
    copyFileSync(resolve(source, file), target);
  }
}
const dependencies = JSON.parse(readFileSync(resolve(root, 'cloudfunctions/youpuUserApi/package.json'))).dependencies;
writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'database-call-reduction-probe', version: '1.0.0', dependencies }));
const secret = randomBytes(32).toString('hex'); const config = resolve(base, 'cloudbaserc.json');
writeFileSync(config, JSON.stringify({ envId: manifest.envId, functionRoot: '.', functions: [{ name, dir: directory,
  handler: 'index.main', runtime: 'Nodejs20.19', timeout: 180, memorySize: 512, installDependency: true,
  envVariables: { PROBE_ENV: manifest.envId, PROBE_SECRET: secret, PROBE_RUN: run, PROBE_STAGE: stage,
    STAGING_ACCOUNT_RESET_ENV: manifest.envId, STAGING_ACCOUNT_RESET_ENABLED: '1' } }] }), { mode: 0o600 });
const asOf = new Date().toISOString();
const previousRuns = (process.env.CALL_REDUCTION_CLEAN_RUNS || '').split(',').filter(Boolean);
if (previousRuns.some(run => !/^[a-f0-9]{12}$/.test(run))) throw new Error('清理记录编号不合法');
function invoke(action, phase, round = '') {
  const response = cli(['-e', manifest.envId, 'fn', 'invoke', name, '-d', JSON.stringify({ action, run, secret, phase, asOf, previousRuns }), '--json'], [action, phase, round].filter(Boolean).join('-'));
  const result = typeof response.RetMsg === 'string' ? JSON.parse(response.RetMsg) : response.RetMsg;
  if (!result || !result.success) throw new Error(action + ' 未通过；详见受控记录'); return result;
}
const summary = { record: 'stage-' + stage + '-' + run, target: 'staging', hashes, rows: [], cleaned: false, functionRemoved: false };
let deployed = false;
try {
  cli(['--config-file', config, '-e', manifest.envId, 'fn', 'deploy', name, '--force', '--json'], 'deploy'); deployed = true;
  // The CLI's SCF request timeout is 60s. Keep each comparison phase in a
  // separate invocation; do not change SDK/CLI timeouts or environment guards.
  const coldBefore = invoke('run', 'before', 'cold'); const coldAfter = invoke('run', 'after', 'cold');
  const warmBefore = invoke('run', 'before', 'warm'); const warmAfter = invoke('run', 'after', 'warm');
  summary.instances = { cold: coldBefore.instanceId, after: coldAfter.instanceId, warm: warmBefore.instanceId, warmAfter: warmAfter.instanceId,
    same: [coldAfter, warmBefore, warmAfter].every(row => row.instanceId === coldBefore.instanceId) };
  summary.rows = coldBefore.rows.concat(coldAfter.rows); summary.warmRows = warmBefore.rows.concat(warmAfter.rows);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  for (const rows of [summary.rows, summary.warmRows]) for (const scenario of ['dashboard500', 'report-build']) {
    const extract = row => scenario === 'dashboard500' ? row.results[0].stats : { totals: row.results[0].totals, rows: row.results[0].rows, sku: row.results[0].sku, filters: row.results[0].filters, asOf: row.results[0].asOf };
    const before = rows.find(row => row.phase === 'before' && row.scenario === scenario); const after = rows.find(row => row.phase === 'after' && row.scenario === scenario);
    if (before && after && JSON.stringify(canonical(extract(before))) !== JSON.stringify(canonical(extract(after)))) throw new Error(scenario + ' 结果不一致');
  }
  for (const row of summary.rows.concat(summary.warmRows).filter(row => row.phase === 'after')) {
    if (row.informational) continue;
    const before = summary.rows.find(item => item.phase === 'before' && item.scenario === row.scenario);
    if (['client-states5min'].includes(row.scenario) && row.reads + row.writes < before.reads + before.writes) continue;
    if (!before || row.reads + row.writes >= before.reads + before.writes) throw new Error(row.scenario + ' 总调用量未下降');
  }
  console.log(JSON.stringify({ record: summary.record, rows: summary.rows.map(({ results, collections, ...row }) => row) }));
} finally {
  if (deployed) {
    summary.cleaned = invoke('cleanup').cleaned;
    if (summary.cleaned) { cli(['-e', manifest.envId, 'fn', 'delete', name, '--json'], 'remove'); summary.functionRemoved = true; }
  }
  writeFileSync(resolve(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ record: summary.record, cleaned: summary.cleaned, functionRemoved: summary.functionRemoved }));
}
