#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envId = process.argv[2];
const storageBucket = process.argv[3];
const functionRulesFile = process.argv[4] || 'deployment/security/function-rules.json';

if (!envId || !storageBucket) {
  console.error('用法: PNPM_BIN=pnpm node deployment/apply-security.mjs <环境ID> <存储桶> [云函数规则文件]');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const pnpm = process.env.PNPM_BIN || 'pnpm';
const collections = [
  'users',
  'system_config',
  'families',
  'family_memberships',
  'user_family_preferences',
  'persons',
  'relations',
  'invitations',
  'change_requests',
  'audit_logs',
  'media_assets',
  'moderation_tasks',
  'reports',
  'notifications',
  'operators',
  'account_deletion_requests',
  'idempotency_records',
  'backup_manifests',
  'profile_sync_tasks',
  'rate_limits'
];

function readRule(file) {
  return JSON.parse(readFileSync(resolve(root, file), 'utf8'));
}

function callApi(action, body) {
  const result = spawnSync(pnpm, [
    '--package=@cloudbase/cli@latest', 'dlx', 'tcb',
    'api', 'tcb', action,
    '--api-version', '2018-06-08',
    '--body', JSON.stringify(body),
    '--json'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || action + ' 调用失败').trim());
  }
  const output = result.stdout || '';
  const start = output.indexOf('{');
  if (start < 0) throw new Error(action + ' 未返回 JSON');
  const response = JSON.parse(output.slice(start)).data || {};
  return response.Data || response;
}

function callCli(args) {
  const result = spawnSync(pnpm, [
    '--package=@cloudbase/cli@latest', 'dlx', 'tcb'
  ].concat(args), {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(([result.stderr, result.stdout].filter(Boolean).join('\n') || args.join(' ') + ' 调用失败').trim());
  }
  const output = result.stdout || '';
  const start = output.indexOf('{');
  if (start < 0) return {};
  return JSON.parse(output.slice(start)).data || {};
}

function normalizedRule(rule) {
  if (!rule) return '';
  return JSON.stringify(typeof rule === 'string' ? JSON.parse(rule) : rule);
}

function applyPermission(body) {
  const result = callApi('ModifyResourcePermission', body);
  if (!result.Success) throw new Error(body.ResourceType + ' 权限写入失败');
}

function describe(resourceType, resources) {
  const body = { EnvId: envId, ResourceType: resourceType };
  if (resources && resources.length) body.Resources = resources;
  return callApi('DescribeResourcePermission', body).PermissionList || [];
}

for (const collection of collections) {
  applyPermission({
    EnvId: envId,
    ResourceType: 'collection',
    Resource: collection,
    Permission: 'ADMINONLY'
  });
}

const collectionPermissions = describe('collection', collections);
const collectionPermissionMap = new Map(collectionPermissions.map(function (item) {
  return [item.Resource, item.Permission];
}));
for (const collection of collections) {
  if (collectionPermissionMap.get(collection) !== 'ADMINONLY') {
    throw new Error(collection + ' 未成功设为 ADMINONLY');
  }
}
console.log('数据库权限已校验：' + collections.length + ' 个集合均为 ADMINONLY');

const functionRules = readRule(functionRulesFile);
applyPermission({
  EnvId: envId,
  ResourceType: 'function',
  Permission: 'CUSTOM',
  SecurityRule: JSON.stringify(functionRules)
});
const functionPermission = describe('function')[0];
if (!functionPermission || functionPermission.Permission !== 'CUSTOM' ||
    normalizedRule(functionPermission.SecurityRule) !== normalizedRule(functionRules)) {
  throw new Error('云函数安全规则回读校验失败');
}
console.log('云函数安全规则已校验：用户接口需登录，后台任务禁止客户端调用');

const storageRules = readRule('deployment/security/storage-private-staging.json');
let customStorageApplied = false;
try {
  callCli([
    '--verbose', 'storage', 'rules', 'update',
    '--acl', 'CUSTOM',
    '--rule', JSON.stringify(storageRules),
    '--json',
    '-e', envId
  ]);
  customStorageApplied = true;
} catch (error) {
  const isFreePlanRestriction = String(error.message || '').includes('OperationDenied.FreePackageDenied');
  if (!isFreePlanRestriction || process.env.ALLOW_PRIVATE_STORAGE_FALLBACK !== '1') throw error;
}
const storagePermission = callCli(['storage', 'rules', 'get', '--json', '-e', envId]);
const storagePermissionName = storagePermission.Permission || storagePermission.permission || storagePermission.acl || storagePermission.Acl;
const storagePermissionRule = storagePermission.SecurityRule || storagePermission.securityRule || storagePermission.rule || storagePermission.Rule;
if (customStorageApplied) {
  if (storagePermissionName !== 'CUSTOM' || normalizedRule(storagePermissionRule) !== normalizedRule(storageRules)) {
    throw new Error('云存储安全规则回读校验失败');
  }
  console.log('云存储安全规则已校验（' + storageBucket + '）：仅允许登录用户写入私有 staging 图片，客户端不可直读');
} else {
  if (storagePermissionName !== 'PRIVATE') throw new Error('免费套餐的 PRIVATE 存储降级规则回读校验失败');
  console.warn('云存储使用预发布降级规则 PRIVATE（' + storageBucket + '）：升级套餐后必须重新部署 CUSTOM 规则');
}

console.log('三层安全权限部署完成。');
