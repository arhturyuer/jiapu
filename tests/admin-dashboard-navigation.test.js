const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
const ops = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');

test('首页数据卡片跳转到与指标一致的模块和筛选', function () {
  assert.match(admin, /openDashboardList\('users', \{ status: 'active' \}\)/);
  assert.match(admin, /openDashboardList\('users', \{ status: 'active', participationType: 'participating' \}\)/);
  assert.match(admin, /openDashboardList\('users', \{ status: 'active', participationType: 'visitor' \}\)/);
  assert.match(admin, /openDashboardList\('families', \{ status: 'active' \}\)/);
  assert.match(admin, /openDashboardList\('reports', \{ scope: 'backlog' \}\)/);
  assert.match(admin, /openDashboardList\('moderation'\)/);
  assert.match(admin, /openDashboardList\('deletions', \{ scope: 'backlog' \}\)/);
  assert.match(admin, /查看列表 →/);
  assert.match(admin, /principle-card/);
});

test('列表 API 仅接受受控的参与和待办聚合筛选', function () {
  assert.match(ops, /'participating'/);
  assert.match(ops, /filter === 'participating' \? stats\.participationType !== 'visitor'/);
  assert.match(ops, /scope === 'backlog'\n    \? \{ status: _\.in\(\['open', 'processing'\]\) \}/);
  assert.match(ops, /scope === 'backlog'\n    \? \{ status: _\.in\(\['pending', 'failed'\]\) \}/);
});

test('筛选状态会在查看全部、刷新和侧边栏跳转时清除', function () {
  assert.match(admin, /function clearListFilters/);
  assert.match(admin, /async function showAllRecords/);
  assert.match(admin, /@click="navigateModule\(item\.key\)"/);
  assert.match(admin, /@click="showAllRecords">刷新数据/);
  assert.match(admin, /当前查看：/);
});
