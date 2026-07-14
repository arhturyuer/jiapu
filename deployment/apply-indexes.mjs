#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envId = process.argv[2];
const instanceId = process.argv[3];
if (!envId || !instanceId) {
  console.error('用法: NODE_BIN=node PNPM_BIN=pnpm node deployment/apply-indexes.mjs <环境ID> <数据库实例ID>');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/database-indexes.json'), 'utf8'));
const pnpm = process.env.PNPM_BIN || 'pnpm';

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
  return JSON.parse(output.slice(start)).data || {};
}

function desiredIndex(item) {
  return {
    IndexName: item.name,
    MgoKeySchema: {
      MgoIndexKeys: item.fields.map(function (field) {
        return { Name: field.field, Direction: field.order === 'desc' ? '-1' : '1' };
      }),
      MgoIsUnique: Boolean(item.unique),
      MgoIsSparse: Boolean(item.sparse)
    }
  };
}

function sameIndex(actual, expected) {
  const expectedKeys = expected.fields.map(function (field) {
    return field.field + ':' + (field.order === 'desc' ? '-1' : '1');
  });
  const actualKeys = (actual.Keys || []).map(function (field) {
    return field.Name + ':' + field.Direction;
  });
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) && Boolean(actual.Unique) === Boolean(expected.unique);
}

let created = 0;
let existing = 0;
for (const [collectionName, indexes] of Object.entries(manifest.indexes)) {
  const base = { EnvId: envId, Tag: instanceId, TableName: collectionName };
  const before = callApi('DescribeTable', base);
  const byName = new Map((before.Indexes || []).map(function (item) { return [item.Name, item]; }));
  const missing = [];
  for (const item of indexes) {
    const current = byName.get(item.name);
    if (!current) {
      missing.push(item);
      continue;
    }
    if (!sameIndex(current, item)) throw new Error(collectionName + '.' + item.name + ' 与清单定义不一致');
    existing += 1;
  }
  if (missing.length) {
    callApi('UpdateTable', Object.assign({}, base, { CreateIndexes: missing.map(desiredIndex) }));
    created += missing.length;
  }
  const after = callApi('DescribeTable', base);
  const afterByName = new Map((after.Indexes || []).map(function (item) { return [item.Name, item]; }));
  for (const item of indexes) {
    const current = afterByName.get(item.name);
    if (!current || !sameIndex(current, item)) throw new Error(collectionName + '.' + item.name + ' 创建后校验失败');
  }
  console.log('已校验 ' + collectionName + '：' + indexes.length + ' 个索引');
}

console.log('索引部署完成：新建 ' + created + ' 个，复用 ' + existing + ' 个。');
