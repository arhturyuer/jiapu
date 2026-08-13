const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const participation = require('../cloudfunctions/youpuOpsApi/participation');

test('用户参与度按创建和加入的当前有效数量分层', function () {
  assert.deepEqual(participation.summarize(0, 0), {
    createdFamilyCount: 0,
    joinedFamilyCount: 0,
    activeFamilyCount: 0,
    participationType: 'visitor'
  });
  assert.equal(participation.classify(1, 0), 'creator');
  assert.equal(participation.classify(0, 1), 'member');
  assert.deepEqual(participation.summarize(2, 3), {
    createdFamilyCount: 2,
    joinedFamilyCount: 3,
    activeFamilyCount: 5,
    participationType: 'creator_member'
  });
});

test('参与度计数会将无效输入归零', function () {
  assert.deepEqual(participation.summarize(-1, 'not-a-number'), {
    createdFamilyCount: 0,
    joinedFamilyCount: 0,
    activeFamilyCount: 0,
    participationType: 'visitor'
  });
});

test('运营 API 保持首次进入自动建档，并批量计算当前有效参与度', function () {
  const root = path.resolve(__dirname, '..');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
  assert.match(userApi, /async function authLogin[\s\S]*ensureUser\(openid\)/);
  assert.match(app, /api\.call\('auth\.login'/);
  assert.doesNotMatch(profile, /auth\.register|unregistered/);
  assert.match(opsApi, /listByIds\('families', 'creatorId', ids, \{ status: 'active' \}\)/);
  assert.match(opsApi, /listByIds\('family_memberships', 'userId', ids, \{ status: 'active' \}\)/);
  assert.match(opsApi, /participationFilter\(event\.participationType\)/);
  assert.match(opsApi, /currentParticipatingUsers/);
  assert.match(admin, /仅访问，尚未参与家谱/);
  assert.match(admin, /首次进入时间/);
  assert.match(admin, /用户家谱参与筛选/);
});
