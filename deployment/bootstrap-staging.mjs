#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertDeploymentTarget } from './target-guard.mjs';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'deployment/staging.local.env');

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!existsSync(source)) fail('缺少 deployment/staging.local.env。');
const values = Object.create(null);
for (const rawLine of readFileSync(source, 'utf8').split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const separator = line.indexOf('=');
  if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
}

const envId = values.STAGING_ENV_ID || values.TARGET_ENV_ID || '';
assertDeploymentTarget(envId, 'staging 数据初始化');
const secret = values.STAGING_BOOTSTRAP_SECRET || '';
if (!secret || secret.length < 32) fail('STAGING_BOOTSTRAP_SECRET 缺失或过短。');

// Do not copy a UID from another environment. The initial operator is created
// only when this staging file explicitly contains a staging Auth UID.
const data = { action: 'system.bootstrap', secret: secret };
if (values.STAGING_INITIAL_OPERATOR_AUTH_UID) {
  data.initialOperatorAuthUid = values.STAGING_INITIAL_OPERATOR_AUTH_UID;
  data.initialOperatorEmail = values.STAGING_INITIAL_OPERATOR_EMAIL || '';
  data.initialOperatorName = values.STAGING_INITIAL_OPERATOR_NAME || 'Staging 超级管理员';
}

const result = spawnSync(process.env.TCB_BIN || 'tcb', [
  '-e', envId, 'fn', 'invoke', 'youpuJobs', '-d', JSON.stringify(data), '--json'
], { cwd: root, encoding: 'utf8', env: process.env, maxBuffer: 20 * 1024 * 1024 });
if (result.status !== 0) fail((result.stderr || result.stdout || 'staging bootstrap 调用失败').trim());

const output = result.stdout || '';
let parsed;
try {
  parsed = JSON.parse(output.slice(output.indexOf('{')));
} catch (error) {
  fail('staging bootstrap 返回不是有效 JSON。');
}
const response = parsed.data || {};
let invokeResult = response.RetMsg || response.retMsg || response;
if (typeof invokeResult === 'string') {
  try {
    invokeResult = JSON.parse(invokeResult);
  } catch (error) {
    fail('staging bootstrap 未返回可解析结果。');
  }
}
if (!invokeResult || invokeResult.success !== true) fail('staging bootstrap 未返回成功结果。');
console.log('staging 空集合初始化完成；未导入、复制或清空任何数据。');
