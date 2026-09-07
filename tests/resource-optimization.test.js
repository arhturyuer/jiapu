const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('家谱读取合并保持列表顺序、权限校验和媒体逐家庭去重', function () {
  const api = read('cloudfunctions/youpuUserApi/index.js');
  assert.match(api, /const familyIds = Array\.from\(new Set\(page\.items\.map/);
  assert.match(api, /where\(\{ _id: _\.in\(familyIds\) \}\)\.limit\(familyIds\.length\)\.get\(\)/);
  assert.match(api, /familiesById\.get\(membership\.familyId\)/);
  assert.match(api, /const family = access\.family;/);
  assert.match(api, /async function accessibleMediaAssets/);
  assert.match(api, /memberships\.set\(asset\.familyId, getMembership\(db, asset\.familyId, openid\)\)/);
  assert.match(api, /if \(await memberships\.get\(asset\.familyId\)\) accessible\.push\(asset\)/);
  assert.match(api, /requireActiveUser\(openid\)/);
});

test('导出轮询仅在可见页面运行，且不改变异步导出接口', function () {
  const privacy = read('miniprogram/pages/privacy/index.js');
  assert.match(privacy, /onHide: function \(\)/);
  assert.match(privacy, /clearExportTimer/);
  assert.match(privacy, /self\._pageVisible !== false/);
  assert.match(privacy, /\}, 30000\)/);
  assert.match(privacy, /api\.call\('account\.exportStatus'/);
  assert.match(privacy, /api\.call\('account\.exportUrl'/);
});

test('四类维护触发器按职责严格路由，手动全量维护入口保留', function () {
  const jobs = read('cloudfunctions/youpuJobs/index.js');
  const manifest = JSON.parse(read('deployment/cloudbaserc.example.json'));
  const config = JSON.parse(read('cloudfunctions/youpuJobs/config.json'));
  const triggers = manifest.functions.find(function (item) { return item.name === 'youpuJobs'; }).triggers;
  const names = triggers.map(function (item) { return item.name; });
  assert.deepEqual(names, [
    'youpu-frequent-maintenance',
    'youpu-profile-maintenance',
    'youpu-hourly-maintenance',
    'youpu-daily-maintenance'
  ]);
  assert.deepEqual(config.triggers, triggers);
  assert.match(jobs, /async function frequentRun\(\) \{[\s\S]*processExportTasks\(\)[\s\S]*processFamilyBackupTasks\(\)[\s\S]*reconcilePendingPayments\(\)/s);
  assert.match(jobs, /async function profileRun\(\) \{\s*return \{ profileSync: await syncProfiles\(\) \};\s*\}/s);
  assert.match(jobs, /async function hourlyRun\(\) \{[\s\S]*recoverStaleDeletions[\s\S]*processDeletions/);
  assert.match(jobs, /async function dailyRun\(\) \{[\s\S]*expireInvitations[\s\S]*purgeArchivedFamilies[\s\S]*expireExportTasks/);
  assert.match(jobs, /if \(!data && action === 'maintenance\.run'\)/);
  assert.match(jobs, /event\.triggerName \|\| event\.TriggerName/);
  assert.match(jobs, /request\.triggerName \|\| request\.TriggerName/);
});
