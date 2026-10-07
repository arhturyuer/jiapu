#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertDeploymentTarget } from './target-guard.mjs';
import { productionNotificationConfig, notificationKeys } from './production-notification-config.mjs';

const envId = process.argv[2];
if (!envId) {
  console.error('用法: PNPM_BIN=pnpm node deployment/verify-cloud.mjs <环境ID>');
  process.exit(2);
}
assertDeploymentTarget(envId, '云端配置验证');

const root = resolve(import.meta.dirname, '..');
const pnpm = process.env.PNPM_BIN || 'pnpm';
const localCli = process.env.TCB_BIN || '';
const generatedStagingManifest = resolve(root, 'deployment/cloudbaserc.staging.local.json');
const manifestPath = process.env.DEPLOYMENT_TARGET === 'staging' && existsSync(generatedStagingManifest)
  ? generatedStagingManifest
  : resolve(root, 'deployment/cloudbaserc.example.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const productionManifestPath = resolve(root, 'deployment/cloudbaserc.production.local.json');
const productionDefinitions = process.env.DEPLOYMENT_TARGET === 'production' && existsSync(productionManifestPath)
  ? new Map(JSON.parse(readFileSync(productionManifestPath, 'utf8')).functions.map(item => [item.name, item]))
  : new Map();
const actualProductionVariables = new Map();
const productionPaymentEnvironmentKeys = {
  youpuUserApi: ['CONTENT_MODERATION_MODE', 'JOB_DISPATCH_SECRET', 'JOB_FUNCTION_NAMESPACE', 'PAYMENT_MODE', 'VP_APP_ID', 'VP_APP_SECRET', 'VP_OFFER_ID', 'VP_APP_KEY', 'VP_INTERNAL_NOTIFY_SECRET'],
  youpuJobs: ['BOOTSTRAP_SECRET', 'JOB_DISPATCH_SECRET', 'JOB_FUNCTION_NAMESPACE'],
  youpuPaymentNotify: ['VP_INTERNAL_NOTIFY_SECRET'],
  youpuPaymentNotifyV2: ['VP_INTERNAL_NOTIFY_SECRET']
};

const expectedFunctions = manifest.functions.map(function (item) {
  if (process.env.DEPLOYMENT_TARGET === 'production' && item.name === 'youpuPaymentNotify') {
    return Object.assign({}, item, { name: 'youpuPaymentNotifyV2' });
  }
  return item;
});

function callCli(args) {
  const cliArguments = localCli ? args : [
    '--package=@cloudbase/cli@latest', 'dlx', 'tcb'
  ].concat(args);
  const result = spawnSync(localCli || pnpm, cliArguments, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 30 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(([result.stderr, result.stdout].filter(Boolean).join('\n') || args.join(' ') + ' 调用失败').trim());
  }
  const output = result.stdout || '';
  const start = output.indexOf('{');
  if (start < 0) throw new Error(args.join(' ') + ' 未返回 JSON');
  return JSON.parse(output.slice(start)).data || {};
}

function sameValues(left, right) {
  return JSON.stringify(Array.from(left).sort()) === JSON.stringify(Array.from(right).sort());
}

function expectedEnvironmentKeys(expected) {
  if (process.env.DEPLOYMENT_TARGET === 'production' && productionPaymentEnvironmentKeys[expected.name]) {
    const generated = productionDefinitions.get(expected.name);
    return new Set(generated ? Object.keys(generated.envVariables || {}) : productionPaymentEnvironmentKeys[expected.name]);
  }
  return new Set(Object.keys(expected.envVariables || {}));
}

for (const expected of expectedFunctions) {
  const actual = callCli(['fn', 'detail', expected.name, '--json', '-e', envId]);
  if (actual.Runtime !== expected.runtime) throw new Error(expected.name + ' 运行时不符合部署清单');
  if (Number(actual.Timeout) !== Number(expected.timeout)) throw new Error(expected.name + ' 超时不符合部署清单');
  if (Number(actual.MemorySize) !== Number(expected.memorySize)) throw new Error(expected.name + ' 内存不符合部署清单');
  if (actual.Status !== 'Active' || actual.AvailableStatus !== 'Available') {
    throw new Error(expected.name + ' 当前不可用');
  }

  const actualEnvKeys = new Set(((actual.Environment || {}).Variables || []).map(function (item) { return item.Key; }));
  const expectedEnvKeys = expectedEnvironmentKeys(expected);
  if (!sameValues(actualEnvKeys, expectedEnvKeys)) throw new Error(expected.name + ' 环境变量键不符合部署清单');
  if (process.env.DEPLOYMENT_TARGET === 'staging') {
    const actualEnv = new Map(((actual.Environment || {}).Variables || []).map(function (item) { return [item.Key, item.Value]; }));
    for (const [key, value] of Object.entries(expected.envVariables || {})) {
      if (key.startsWith('NOTIFY_') && actualEnv.get(key) !== value) {
        throw new Error(expected.name + ' 订阅消息配置回读不符合部署清单：' + key);
      }
    }
  }
  if (process.env.DEPLOYMENT_TARGET === 'production') {
    const actualEnv = new Map(((actual.Environment || {}).Variables || []).map(function (item) { return [item.Key, item.Value]; }));
    actualProductionVariables.set(expected.name, actualEnv);
    const generated = productionDefinitions.get(expected.name);
    for (const key of notificationKeys) {
      if (generated && actualEnv.get(key) !== (generated.envVariables || {})[key]) {
        throw new Error(expected.name + ' 生产订阅配置回读不符合部署清单：' + key);
      }
    }
    if (expected.name === 'youpuUserApi' && (actualEnv.get('PAYMENT_MODE') !== 'live' || actualEnv.get('CONTENT_MODERATION_MODE') !== 'strict')) {
      throw new Error('youpuUserApi production 支付或内容审核模式不符合要求');
    }
  }

  const actualTriggers = new Map((actual.Triggers || []).map(function (item) {
    const desc = JSON.parse(item.TriggerDesc || '{}');
    const enabled = item.Enable === undefined
      ? item.BindStatus !== 'off'
      : Number(item.Enable) === 1;
    return [item.TriggerName, { type: item.Type, cron: desc.cron, enabled: enabled }];
  }));
  const expectedTriggers = expected.triggers || [];
  if (actualTriggers.size !== expectedTriggers.length) throw new Error(expected.name + ' 触发器数量不符合部署清单');
  for (const trigger of expectedTriggers) {
    const current = actualTriggers.get(trigger.name);
    if (!current || current.type !== trigger.type || current.cron !== trigger.config || !current.enabled) {
      throw new Error(expected.name + '.' + trigger.name + ' 触发器不符合部署清单');
    }
  }

  console.log([
    expected.name,
    actual.Runtime,
    actual.Timeout + 's',
    actual.MemorySize + 'MB',
    actualTriggers.size + ' 个触发器',
    'Available'
  ].join(' / '));
}

if (process.env.DEPLOYMENT_TARGET === 'production') {
  const user = actualProductionVariables.get('youpuUserApi');
  const jobs = actualProductionVariables.get('youpuJobs');
  productionNotificationConfig(user, jobs);
  if (user.get('JOB_DISPATCH_SECRET') !== jobs.get('JOB_DISPATCH_SECRET') || user.get('JOB_FUNCTION_NAMESPACE') !== envId) {
    throw new Error('生产任务派发密钥或目标不一致');
  }
}
console.log('云函数运行配置验证完成；未输出任何环境变量值。');
