#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { assertDeploymentTarget } from './target-guard.mjs';

const envId = process.argv[2];
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('公开示例验证仅允许独立 staging。');
assertDeploymentTarget(envId, '公开示例实际读取验证');
const cli = process.env.TCB_BIN || 'tcb';
const run = 'public-example-check-' + Date.now();
function invoke(type, fields = {}) {
  const result = spawnSync(cli, ['-e', envId, 'fn', 'invoke', 'youpuUserApi', '-d', JSON.stringify({ type, requestId: run + '-' + type.split('.').pop(), ...fields }), '--json'], {
    encoding: 'utf8', env: process.env, timeout: 60000, maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error('staging 调用失败，请检查 CLI 登录和目标环境。');
  const start = (result.stdout || '').indexOf('{');
  if (start < 0) throw new Error('staging 调用未返回 JSON。');
  const data = JSON.parse(result.stdout.slice(start)).data || {};
  let response = data.RetMsg || data.retMsg || data;
  if (typeof response === 'string') response = JSON.parse(response);
  return response;
}
function requireSuccess(response, action) {
  if (response.success !== true) {
    throw new Error(action + '失败：' + (response.code || 'INVALID_RESPONSE') + '；requestId=' + (response.requestId || 'unknown'));
  }
  return response.data;
}
const list = requireSuccess(invoke('public.examples.list'), '公开示例列表');
if (!Array.isArray(list.items) || !list.items.length) throw new Error('staging 没有已发布示例，请在该环境后台发布官方虚构示例。');
const slug = list.items[0].slug;
const detail = requireSuccess(invoke('public.examples.get', { slug }), '默认示例详情');
const example = detail && detail.example;
if (!example || example.slug !== slug || !Array.isArray(example.persons) || !example.persons.length || !Array.isArray(example.relations)) {
  throw new Error('staging 默认示例没有可绘制的已发布人物数据。');
}
if (Object.hasOwn(example, 'draftContent') || Object.hasOwn(example, 'publishedContent')) throw new Error('公开响应不应返回原始草稿或快照。');
const missing = invoke('public.examples.get', { slug: 'missing-' + run });
if (missing.success !== false || missing.code !== 'EXAMPLE_NOT_FOUND') throw new Error('无效示例没有返回明确下架/不存在状态。');
console.log(JSON.stringify({ target: 'staging', publicList: true, defaultExample: true, missingExampleRejected: true,
  publishedExamples: list.items.length, slug, personCount: example.persons.length, relationCount: example.relations.length }));
