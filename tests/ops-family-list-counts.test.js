const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('运营家谱列表返回并展示加入用户数与谱内成员数', function () {
  const root = path.resolve(__dirname, '..');
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');

  assert.match(opsApi, /userCount: Number\(stats\.userCount\) \|\| 0/);
  assert.match(opsApi, /memberCount: Number\(stats\.memberCount\) \|\| 0/);
  assert.match(opsApi, /collection\('family_memberships'\)\.where\(\{ familyId: family\._id, status: 'active' \}\)\.count\(\)/);
  assert.match(opsApi, /collection\('persons'\)\.where\(\{ familyId: family\._id, status: 'active' \}\)\.count\(\)/);
  assert.match(admin, /<th v-if="activeModule === 'families'">用户数<\/th>/);
  assert.match(admin, /<th v-if="activeModule === 'families'">成员数<\/th>/);
  assert.match(admin, /row\.userCount \|\| 0/);
  assert.match(admin, /row\.memberCount \|\| 0/);
});
