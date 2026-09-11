const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

test('子女排行接口纳入事务、图谱版本和成员审核流', function () {
  const api = read('cloudfunctions/youpuUserApi/index.js');
  assert.match(api, /'relation\.reorderChildren': relationReorderChildren/);
  assert.match(api, /MUTATION_TYPES[\s\S]*'relation\.reorderChildren'/);
  assert.match(api, /type: 'reorder_children'/);
  assert.match(api, /request\.type === 'reorder_children'/);
  assert.match(api, /childOrderUpdatedAt: db\.serverDate\(\)/);
  assert.match(api, /relationRevision: _\.inc\(1\)/);
  assert.match(api, /relationRevision: Number\(family\.relationRevision \|\| 0\)/);
});

test('家谱页常驻展示排行并从父母人物卡打开调整面板', function () {
  const source = read('miniprogram/pages/tree/index.js');
  const template = read('miniprogram/pages/tree/index.wxml');
  const styles = read('miniprogram/pages/tree/index.wxss');
  assert.match(template, /class="child-rank-badge"/);
  assert.match(template, /bindtap="openChildOrderSheet"/);
  assert.match(template, /data-direction="up"/);
  assert.match(template, /data-direction="down"/);
  assert.match(source, /api\.call\('relation\.reorderChildren'/);
  assert.match(styles, /\.child-rank-badge/);
  assert.doesNotMatch(styles, /zoom-(?:compact|overview)[^{]*[\s\S]{0,80}child-rank-badge[\s\S]{0,30}display:\s*none/);
});

test('家庭备份的关系表导出子女排行字段', function () {
  const jobs = read('cloudfunctions/youpuJobs/index.js');
  assert.match(jobs, /childOrder: item\.childOrder/);
  assert.match(jobs, /子女排行顺序/);
  assert.match(jobs, /排行更新时间/);
});
