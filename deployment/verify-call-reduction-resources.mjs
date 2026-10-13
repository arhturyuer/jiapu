import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertDeploymentTarget } from './target-guard.mjs';
if (process.env.DEPLOYMENT_TARGET !== 'staging') throw new Error('资源核验只允许 staging');
const env = process.env.STAGING_ENV_ID; const instance = process.env.STAGING_DB_INSTANCE_ID;
assertDeploymentTarget(env, '数据库优化资源回读');
if (!instance) throw new Error('缺少 staging 数据库实例');
const root = resolve(import.meta.dirname, '..');
const base = resolve(root, 'deployment/backups/call-reduction-20261013/resources'); mkdirSync(base, { recursive: true });
function read(action, body) {
  const response = spawnSync(process.env.TCB_BIN || 'tcb', ['api', 'tcb', action, '--api-version', '2018-06-08', '--body', JSON.stringify(body), '--json'], { encoding: 'utf8', maxBuffer: 30000000, timeout: 60000 });
  writeFileSync(resolve(base, action + '-' + (body.TableName || body.ResourceType) + '.log'), (response.stdout || '') + (response.stderr || ''), { mode: 0o600 });
  if (response.status !== 0) throw new Error(action + ' 回读失败');
  const data = JSON.parse(response.stdout.slice(response.stdout.indexOf('{'))).data || {}; return data.Data || data;
}
const manifest = JSON.parse(readFileSync(resolve(root, 'deployment/database-indexes.json')));
const result = { target: 'staging', checkedAt: new Date().toISOString(), collections: [], indexCount: 0 };
for (const [name, expected] of Object.entries(manifest.indexes)) {
  const table = read('DescribeTable', { EnvId: env, Tag: instance, TableName: name });
  const actual = new Map((table.Indexes || []).map(row => [row.Name, row]));
  for (const row of expected) {
    const index = actual.get(row.name);
    const fields = row.fields.map(field => field.field + ':' + (field.order === 'desc' ? '-1' : '1'));
    if (!index || Boolean(index.Unique) !== Boolean(row.unique) || JSON.stringify((index.Keys || []).map(field => field.Name + ':' + field.Direction)) !== JSON.stringify(fields)) throw new Error(name + '.' + row.name + ' 索引不匹配');
  }
  result.collections.push(name); result.indexCount += expected.length;
}
const security = readFileSync(resolve(root, 'deployment/apply-security.mjs'), 'utf8').match(/const collections = \[([\s\S]*?)\];/);
if (!security) throw new Error('无法读取现行集合权限清单');
const collections = Array.from(new Set(result.collections.concat(Array.from(security[1].matchAll(/'([^']+)'/g), row => row[1]))));
result.permissionCollections = collections;
const permissions = read('DescribeResourcePermission', { EnvId: env, ResourceType: 'collection', Resources: collections });
const byName = new Map((permissions.PermissionList || []).map(row => [row.Resource, row]));
for (const name of collections) if (!byName.get(name) || byName.get(name).Permission !== 'ADMINONLY') throw new Error(name + ' 未禁止客户端数据库访问');
const functions = read('DescribeResourcePermission', { EnvId: env, ResourceType: 'function' });
const permission = (functions.PermissionList || [])[0];
const expected = JSON.parse(readFileSync(resolve(root, 'deployment/security/function-rules.json')));
const actual = permission && (typeof permission.SecurityRule === 'string' ? JSON.parse(permission.SecurityRule) : permission.SecurityRule);
if (!permission || permission.Permission !== 'CUSTOM' || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('函数安全规则不匹配');
result.permissions = 'ADMINONLY/CUSTOM'; writeFileSync(resolve(base, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result));
