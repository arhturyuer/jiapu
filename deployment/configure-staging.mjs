#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRODUCTION_ENV_ID } from './target-guard.mjs';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'deployment/staging.local.env');
const destination = resolve(root, 'miniprogram/config/env.local.js');
const cloudbaseConfig = resolve(root, 'deployment/cloudbaserc.staging.local.json');

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!existsSync(source)) {
  fail('缺少 deployment/staging.local.env；请先从 staging.local.env.example 复制并填写。');
}

const values = Object.create(null);
for (const rawLine of readFileSync(source, 'utf8').split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const separator = line.indexOf('=');
  if (separator < 1) fail('staging.local.env 格式错误：' + rawLine);
  values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
}

const envId = values.STAGING_ENV_ID || values.TARGET_ENV_ID || '';
if (!envId || /REPLACE_WITH|\s/.test(envId) || envId === PRODUCTION_ENV_ID) {
  fail('STAGING_ENV_ID 必须是独立的非 production CloudBase 环境 ID。');
}

const bootstrapSecret = values.STAGING_BOOTSTRAP_SECRET || '';
if (!bootstrapSecret || /REPLACE_WITH|CHANGE_BEFORE_DEPLOY|\s/.test(bootstrapSecret) || bootstrapSecret.length < 32) {
  fail('STAGING_BOOTSTRAP_SECRET 必须是 staging 专用、至少 32 字符的随机值。');
}

if (values.STAGING_PAYMENT_MODE !== 'sandbox') {
  fail('STAGING_PAYMENT_MODE 必须固定为 sandbox；staging 不允许使用 mock 或 live。');
}

const sandboxVariables = {
  VP_APP_ID: values.STAGING_VP_APP_ID || '',
  VP_APP_SECRET: values.STAGING_VP_APP_SECRET || '',
  VP_OFFER_ID: values.STAGING_VP_OFFER_ID || '',
  VP_APP_KEY: values.STAGING_VP_APP_KEY || '',
  VP_INTERNAL_NOTIFY_SECRET: values.STAGING_VP_INTERNAL_NOTIFY_SECRET || ''
};
const notificationNames = [
  'NOTIFY_JOIN_TEMPLATE_ID', 'NOTIFY_JOIN_MEMBER_KEY', 'NOTIFY_JOIN_TIME_KEY',
  'NOTIFY_REVIEW_TEMPLATE_ID', 'NOTIFY_REVIEW_SUBJECT_KEY', 'NOTIFY_REVIEW_DESCRIPTION_KEY'
];
const configuredNotificationNames = notificationNames.filter(function (name) {
  return values['STAGING_' + name] && !/REPLACE_WITH/.test(values['STAGING_' + name]);
});
if (configuredNotificationNames.length && configuredNotificationNames.length !== notificationNames.length) {
  fail('订阅消息模板必须完整配置两类模板 ID 和字段键，或全部留空。');
}
const notificationVariables = {};
if (configuredNotificationNames.length === notificationNames.length) {
  for (const name of notificationNames) notificationVariables[name] = values['STAGING_' + name];
  for (const name of notificationNames.filter(function (item) { return item.endsWith('_KEY'); })) {
    const pattern = name === 'NOTIFY_JOIN_TIME_KEY' ? /^time\d+$/ : /^thing\d+$/;
    if (!pattern.test(notificationVariables[name])) fail('订阅消息字段类型与所选模板不符：' + name);
  }
  if (notificationVariables.NOTIFY_JOIN_TEMPLATE_ID === notificationVariables.NOTIFY_REVIEW_TEMPLATE_ID ||
    notificationVariables.NOTIFY_REVIEW_SUBJECT_KEY === notificationVariables.NOTIFY_REVIEW_DESCRIPTION_KEY) {
    fail('订阅消息需要两个不同模板，且每个模板的两个字段键不能相同。');
  }
  notificationVariables.NOTIFY_MINIPROGRAM_STATE = 'developer';
}
for (const [key, value] of Object.entries(sandboxVariables)) {
  if (!value || /REPLACE_WITH|CHANGE_BEFORE_DEPLOY|\s/.test(value)) fail('缺少有效的 STAGING_' + key + '；不会生成沙箱部署清单。');
}
if (sandboxVariables.VP_INTERNAL_NOTIFY_SECRET.length < 32) {
  fail('STAGING_VP_INTERNAL_NOTIFY_SECRET 必须是 staging 专用、至少 32 字符的随机值。');
}
writeFileSync(destination, [
  '// 由 deployment/configure-staging.mjs 生成；请勿提交。',
  'module.exports = {',
  '  stagingCloudEnv: ' + JSON.stringify(envId),
  '};',
  ''
].join('\n'));

const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/cloudbaserc.example.json'), 'utf8'));
manifest.envId = envId;
for (const fn of manifest.functions || []) {
  if (fn.name === 'youpuJobs') Object.assign(fn.envVariables, {
    BOOTSTRAP_SECRET: bootstrapSecret,
    JOB_DISPATCH_SECRET: bootstrapSecret, JOB_FUNCTION_NAMESPACE: envId
  }, notificationVariables);
  if (fn.name === 'youpuUserApi') Object.assign(fn.envVariables, {
    JOB_DISPATCH_SECRET: bootstrapSecret, JOB_FUNCTION_NAMESPACE: envId,
    STAGING_ACCOUNT_RESET_ENABLED: '1', STAGING_ACCOUNT_RESET_ENV: envId,
    PAYMENT_MODE: 'sandbox', VP_APP_ID: sandboxVariables.VP_APP_ID,
    VP_APP_SECRET: sandboxVariables.VP_APP_SECRET, VP_OFFER_ID: sandboxVariables.VP_OFFER_ID,
    VP_APP_KEY: sandboxVariables.VP_APP_KEY, VP_INTERNAL_NOTIFY_SECRET: sandboxVariables.VP_INTERNAL_NOTIFY_SECRET
  }, notificationVariables);
  if (fn.name === 'youpuPaymentNotify') Object.assign(fn.envVariables, {
    VP_INTERNAL_NOTIFY_SECRET: sandboxVariables.VP_INTERNAL_NOTIFY_SECRET
  });
}
writeFileSync(cloudbaseConfig, JSON.stringify(manifest, null, 2) + '\n');

console.log('已生成小程序 staging 本地配置：' + destination);
console.log('已生成 staging 云函数部署清单：' + cloudbaseConfig);
console.log('staging 虚拟支付已固定为 sandbox；请在云开发控制台将两类虚拟支付事件推送绑定到 youpuPaymentNotify。');
