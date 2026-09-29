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

test('家庭页集中家谱管理入口并移除最近动态', function () {
  const template = read('miniprogram/pages/members/index.wxml');
  const source = read('miniprogram/pages/members/index.js');
  const profileTemplate = read('miniprogram/pages/profile/index.wxml');
  const profileSource = read('miniprogram/pages/profile/index.js');
  const userApi = read('cloudfunctions/youpuUserApi/index.js');
  const legacyApi = read('cloudfunctions/familyFunctions/index.js');
  const userDashboard = userApi.match(/async function familyDashboard\(event\) \{([\s\S]*?)\n\}/);
  const legacyDashboard = legacyApi.match(/async function familyDashboard\(event\) \{([\s\S]*?)\n\}/);

  assert.match(template, /家谱管理/);
  ['切换家谱', '家谱变更历史', '完整家庭备份', '家谱显示设置', '家庭与权限管理', '家谱回收站'].forEach(function (label) {
    assert.match(template, new RegExp(label));
  });
  assert.match(source, /app\.loadFamilyPages\(true/);
  assert.match(source, /switchFamily\s*:/);
  assert.match(source, /openArchivedFamily\s*:/);
  assert.doesNotMatch(template, /最近动态|activity-list|empty-activity/);
  assert.doesNotMatch(source, /recentActivities/);
  assert.ok(userDashboard);
  assert.ok(legacyDashboard);
  assert.doesNotMatch(userDashboard[1], /audit_logs|recentActivities/);
  assert.doesNotMatch(legacyDashboard[1], /audit_logs|recentActivities/);
  assert.doesNotMatch(profileTemplate, /切换家谱|家谱回收站|家谱变更历史|完整家庭备份|家庭管理/);
  assert.doesNotMatch(profileSource, /openFamilyManage|openActivity|openFamilyBackup|openArchivedFamily/);
});

test('家庭页不展示共同维护成员模块和查看完整家谱按钮', function () {
  const template = read('miniprogram/pages/members/index.wxml');
  const source = read('miniprogram/pages/members/index.js');
  const style = read('miniprogram/pages/members/index.wxss');

  assert.doesNotMatch(template, /collaborator-scroll|collaborator-card|查看完整家谱/);
  assert.doesNotMatch(source, /collaborators:\s*\[\]|data\.collaborators|api\.getMediaUrls\(collaborators/);
  assert.doesNotMatch(style, /\.collaborator-(?:scroll|row|card|avatar|placeholder|name|role)|\.graph-button/);
});

test('家庭页顶部卡片在窄屏完整展示家谱名称', function () {
  const template = read('miniprogram/pages/members/index.wxml');
  const style = read('miniprogram/pages/members/index.wxss');

  assert.match(template, /family-title-row[\s\S]*family-name[\s\S]*family-membership-badge/);
  assert.match(template, /family-progress-row[\s\S]*progress-track[\s\S]*invite-button/);
  assert.match(style, /\.family-hero-top\s*\{[^}]*flex-direction:\s*column/);
  assert.match(style, /\.family-name\s*\{[^}]*flex:\s*1[^}]*white-space:\s*normal[^}]*word-break:\s*break-all/);
  assert.match(style, /\.family-membership-badge\s*\{[^}]*height:\s*55rpx[^}]*align-items:\s*center/);
  assert.match(style, /\.family-progress-row\s*\{[^}]*width:\s*100%[^}]*display:\s*flex/);
  assert.match(style, /\.family-progress-main\s*\{[^}]*width:\s*0[^}]*flex:\s*1/);
  assert.match(style, /\.invite-button\s*\{[^}]*width:\s*0[^}]*height:\s*68rpx[^}]*flex:\s*1[^}]*white-space:\s*nowrap/);
  assert.doesNotMatch(style, /\.family-name\s*\{[^}]*text-overflow:\s*ellipsis/);
});

test('首次引导与家谱邀请卡使用紧凑分享按钮', function () {
  const familyTemplate = read('miniprogram/pages/members/index.wxml');
  const familyStyle = read('miniprogram/pages/members/index.wxss');
  const treeTemplate = read('miniprogram/pages/tree/index.wxml');
  const treeStyle = read('miniprogram/pages/tree/index.wxss');

  assert.match(familyTemplate, /onboarding-share-button[^>]*>去分享<\/button>/);
  assert.match(familyStyle, /\.onboarding-share-button\s*\{[^}]*width:\s*120rpx[^}]*flex:\s*none/);
  assert.match(treeTemplate, /tree-share-reminder-invite[^>]*>邀请家人<\/button>/);
  assert.match(treeStyle, /\.tree-share-reminder-invite\s*\{[^}]*width:120rpx[^}]*white-space:nowrap/);
});

test('成员列表可搜索并进入人物资料', function () {
  const source = read('miniprogram/pages/person-list/index.js');
  const template = read('miniprogram/pages/person-list/index.wxml');
  assert.match(source, /app\.getGraph\(this\.data\.familyId, options\)/);
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
