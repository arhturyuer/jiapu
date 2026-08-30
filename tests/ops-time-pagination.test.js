const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const ops = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
const indexes = JSON.parse(fs.readFileSync(path.join(root, 'deployment/database-indexes.json'), 'utf8'));

function cursorHelpers() {
  const start = ops.indexOf('function encodeTimeCursor');
  const end = ops.indexOf('async function page(', start);
  const source = ops.slice(start, end) + '\nresult = { encodeTimeCursor, decodeTimeCursor };';
  class TestOpsError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const context = {
    Buffer,
    Date,
    JSON,
    OpsError: TestOpsError,
    cleanText: function (value, length) { return String(value || '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, length || 200); },
    assert: function (condition, code, message) {
      if (!condition) throw new TestOpsError(code, message);
    }
  };
  vm.runInNewContext(source, context);
  return context.result;
}

test('运营列表使用时间降序与 ID 降序的稳定游标分页', function () {
  assert.match(ops, /function encodeTimeCursor/);
  assert.match(ops, /function decodeTimeCursor/);
  assert.match(ops, /INVALID_CURSOR/);
  assert.match(ops, /\.where\(_\.or\(\[/);
  assert.match(ops, /\.orderBy\(sort, 'desc'\)\s*\.orderBy\('_id', 'desc'\)/);
});

test('时间游标保留同一时间戳的 ID 次级排序，并拒绝无效游标', function () {
  const helpers = cursorHelpers();
  const cursor = helpers.encodeTimeCursor({ _id: 'record-b', createdAt: new Date('2026-08-28T08:00:00.000Z') }, 'createdAt');
  const decoded = helpers.decodeTimeCursor(cursor);
  assert.equal(decoded.id, 'record-b');
  assert.equal(decoded.timestamp.toISOString(), '2026-08-28T08:00:00.000Z');
  assert.throws(function () { helpers.decodeTimeCursor('not-a-cursor'); }, function (error) {
    return error && error.code === 'INVALID_CURSOR';
  });
});

test('各运营列表按其业务时间字段排序', function () {
  assert.match(ops, /page\('users',[\s\S]*?'createdAt'\)/);
  assert.match(ops, /page\('families',[\s\S]*?'createdAt'\)/);
  assert.match(ops, /page\('reports',[\s\S]*?'createdAt'\)/);
  assert.match(ops, /page\('moderation_tasks',[\s\S]*?scope === 'reviewed' \? 'updatedAt' : 'createdAt'\)/);
  assert.match(ops, /page\('account_deletion_requests',[\s\S]*?'requestedAt'\)/);
  assert.match(ops, /page\('audit_logs',[\s\S]*?'createdAt'\)/);
  assert.match(ops, /page\('operators', \{\}, event, 'createdAt'\)/);
});

test('用户参与度筛选以最后扫描的时间游标续页', function () {
  assert.match(ops, /usersPageWithParticipation[\s\S]*?encodeTimeCursor\(sourcePage\.items\[sourcePage\.items\.length - 1\], 'createdAt'\)/);
  const usersPage = ops.slice(ops.indexOf('async function usersPageWithParticipation'), ops.indexOf('async function usersList'));
  assert.match(usersPage, /let cursor = cleanText\(event\.cursor, 512\)/);
  const helpers = cursorHelpers();
  const cursor = helpers.encodeTimeCursor({ _id: 'a'.repeat(64), createdAt: new Date('2026-08-28T08:00:00.000Z') }, 'createdAt');
  assert.ok(cursor.length > 80, '长用户 ID 生成的有效游标应超过旧的 80 字符限制');
});

test('运营后台展示前后翻页和业务时间列', function () {
  assert.match(admin, /const pageNumber = ref\(1\)/);
  assert.match(admin, /const pageCursors = ref<string\[\]>\(\[''\]\)/);
  assert.match(admin, /direction: 'reset' \| 'next' \| 'previous'/);
  assert.match(admin, /上一页/);
  assert.match(admin, /下一页/);
  assert.match(admin, /第 \{\{ pageNumber \}\} 页/);
  assert.match(admin, /timeColumnLabel\(\)/);
  assert.match(admin, /rowTime\(row\)/);
});

test('时间游标所需索引已加入清单且不覆盖旧索引', function () {
  assert.equal(indexes.schemaVersion, 7);
  for (const collection of ['users', 'families', 'reports', 'moderation_tasks', 'account_deletion_requests', 'audit_logs', 'operators']) {
    assert.ok(indexes.indexes[collection].some(function (item) {
      return item.fields[0].order === 'desc' && item.fields[item.fields.length - 1].field === '_id' && item.fields[item.fields.length - 1].order === 'desc';
    }), collection + ' 缺少时间游标索引');
  }
  assert.ok(indexes.indexes.users.some(function (item) { return item.name === 'status_created_id_desc'; }));
  assert.ok(indexes.indexes.families.some(function (item) { return item.name === 'status_created_id_desc'; }));
  assert.ok(indexes.indexes.share_metrics_daily.some(function (item) { return item.name === 'day_kind'; }));
});
