const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('家庭页四项统计均提供对应入口', function () {
  const template = read('miniprogram/pages/members/index.wxml');
  const source = read('miniprogram/pages/members/index.js');
  assert.match(template, /bindtap="openPersonList"/);
  assert.match(template, /bindtap="openGraph"/);
  assert.match(template, /bindtap="openCollaborators"/);
  assert.match(template, /bindtap="openPendingChanges"/);
  assert.match(source, /pages\/person-list\/index\?familyId=/);
  assert.match(source, /section=collaborators/);
  assert.match(source, /pages\/change-list\/index\?familyId=/);
  assert.match(source, /app\.openFullGraph/);
});

test('成员列表可搜索并进入人物资料', function () {
  const source = read('miniprogram/pages/person-list/index.js');
  const template = read('miniprogram/pages/person-list/index.wxml');
  assert.match(source, /api\.call\('graph\.get'/);
  assert.match(source, /pages\/member-detail\/index\?id=/);
  assert.match(template, /输入姓名查找成员/);
  assert.match(template, /bindtap="openMember"/);
});

test('申请列表区分角色、状态并保留管理员审核能力', function () {
  const source = read('miniprogram/pages/change-list/index.js');
  const template = read('miniprogram/pages/change-list/index.wxml');
  assert.match(source, /api\.call\('change\.list'/);
  assert.match(source, /status:\s*this\.data\.activeStatus/);
  assert.match(source, /family\.currentRole === 'viewer'/);
  assert.match(source, /api\.call\('change\.review'/);
  assert.match(source, /label:\s*'已通过'/);
  assert.match(source, /label:\s*'未通过'/);
  assert.match(template, /isAdmin && item\.status === 'pending'/);
});
