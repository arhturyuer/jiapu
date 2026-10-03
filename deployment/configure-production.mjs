#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertDeploymentTarget, PRODUCTION_ENV_ID } from './target-guard.mjs';
import { productionNotificationConfig } from './production-notification-config.mjs';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, 'deployment/cloudbaserc.production.local.json');
const cli = process.env.TCB_BIN || 'tcb';

assertDeploymentTarget(PRODUCTION_ENV_ID, '生产部署清单生成');

function fail(message) {
  throw new Error(message);
}

function functionDetail(name) {
  const result = spawnSync(cli, ['fn', 'detail', name, '--json', '-e', PRODUCTION_ENV_ID], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 30 * 1024 * 1024
  });
  if (result.status !== 0) {
    fail(name + ' 生产配置回读失败；未生成部署清单。');
  }
  const output = result.stdout || '';
  const start = output.indexOf('{');
  if (start < 0) fail(name + ' 生产配置回读未返回 JSON。');
  return (JSON.parse(output.slice(start)).data || {});
}

function environmentMap(detail) {
  return new Map((((detail || {}).Environment || {}).Variables || []).map(function (item) {
    return [item.Key, item.Value];
  }));
}

function requiredValue(values, key, minimumLength) {
  const value = String(values.get(key) || '');
  if (!value || /REPLACE_WITH|CHANGE_BEFORE_DEPLOY/.test(value) || (minimumLength && value.length < minimumLength)) {
    fail('生产环境缺少有效的 ' + key + '；未生成部署清单。');
  }
  return value;
}

const userDetail = functionDetail('youpuUserApi');
const jobsDetail = functionDetail('youpuJobs');
const userVariables = environmentMap(userDetail);
const jobsVariables = environmentMap(jobsDetail);

if (userVariables.get('CONTENT_MODERATION_MODE') !== 'strict' || userVariables.get('PAYMENT_MODE') !== 'live') {
  fail('youpuUserApi 生产内容审核或支付模式不符合要求。');
}
['VP_APP_ID', 'VP_APP_SECRET', 'VP_OFFER_ID', 'VP_APP_KEY', 'VP_INTERNAL_NOTIFY_SECRET'].forEach(function (key) {
  requiredValue(userVariables, key, key === 'VP_INTERNAL_NOTIFY_SECRET' ? 32 : 0);
});
const bootstrapSecret = requiredValue(jobsVariables, 'BOOTSTRAP_SECRET', 32);

const userDispatchSecret = String(userVariables.get('JOB_DISPATCH_SECRET') || '');
const jobsDispatchSecret = String(jobsVariables.get('JOB_DISPATCH_SECRET') || '');
if (userDispatchSecret && jobsDispatchSecret && userDispatchSecret !== jobsDispatchSecret) {
  fail('生产 JOB_DISPATCH_SECRET 两端不一致；未生成部署清单。');
}
const dispatchSecret = userDispatchSecret || jobsDispatchSecret || randomBytes(32).toString('hex');
if (dispatchSecret.length < 32) fail('生产 JOB_DISPATCH_SECRET 长度不足；未生成部署清单。');

const example = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.example.json'), 'utf8'));
const definitions = new Map((example.functions || []).map(function (item) { return [item.name, item]; }));
const userDefinition = structuredClone(definitions.get('youpuUserApi'));
const jobsDefinition = structuredClone(definitions.get('youpuJobs'));
if (!userDefinition || !jobsDefinition) fail('部署清单缺少 youpuUserApi 或 youpuJobs。');

userDefinition.envVariables = Object.fromEntries(userVariables);
Object.assign(userDefinition.envVariables, {
  JOB_DISPATCH_SECRET: dispatchSecret,
  JOB_FUNCTION_NAMESPACE: PRODUCTION_ENV_ID
});
const notificationVariables = productionNotificationConfig(userVariables, jobsVariables, process.env);
Object.assign(userDefinition.envVariables, notificationVariables);
jobsDefinition.envVariables = Object.assign({}, notificationVariables, {
  BOOTSTRAP_SECRET: bootstrapSecret,
  JOB_DISPATCH_SECRET: dispatchSecret
});

const manifest = {
  envId: PRODUCTION_ENV_ID,
  functionRoot: example.functionRoot,
  functions: [userDefinition, jobsDefinition]
};
writeFileSync(destination, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
chmodSync(destination, 0o600);

console.log('已生成受控生产部署清单：' + destination);
console.log('已保留 youpuUserApi 现有生产支付变量；密钥值未输出。');
console.log('youpuJobs 保留 bootstrap、任务派发及订阅变量，触发器仍仅每日保留任务。');
