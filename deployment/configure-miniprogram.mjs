#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertDeploymentTarget } from './target-guard.mjs';

// Local development needs only a staging ID, not deployment/payment secrets.
// This command neither creates a deployment manifest nor accesses CloudBase.
try {
  if (process.argv.length > 2 || process.env.DEPLOYMENT_TARGET !== 'staging') {
    throw new Error('用法：DEPLOYMENT_TARGET=staging STAGING_ENV_ID=<独立测试环境ID> node deployment/configure-miniprogram.mjs');
  }
  const envId = process.env.STAGING_ENV_ID || '';
  assertDeploymentTarget(envId, '生成小程序本地配置');
  if (!/^[a-zA-Z0-9_-]+$/.test(envId)) throw new Error('STAGING_ENV_ID 格式无效。');
  const destination = resolve(import.meta.dirname, '../miniprogram/config/env.local.js');
  writeFileSync(destination, [
    '// 由 deployment/configure-miniprogram.mjs 生成；请勿提交。',
    'module.exports = {',
    '  stagingCloudEnv: ' + JSON.stringify(envId),
    '};',
    ''
  ].join('\n'));
  console.log('已生成小程序 staging 本地配置；请在微信开发者工具中重新编译。未访问云端或生成部署清单。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
