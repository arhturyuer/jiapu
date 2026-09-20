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
  const backup = read('miniprogram/pages/family-backup/index.js');
  assert.match(privacy, /onHide: function \(\)/);
  assert.match(privacy, /clearExportTimer/);
  assert.match(privacy, /self\._pageVisible !== false/);
  assert.match(privacy, /\}, 30000\)/);
  assert.match(privacy, /api\.call\('account\.exportStatus'/);
  assert.match(privacy, /api\.call\('account\.exportUrl'/);
  assert.match(backup, /onHide: function \(\) \{ this\.stopTaskPolling\(\); \}/);
  assert.match(backup, /Math\.min\(30000, 4000 \* Math\.pow\(2/);
});

test('后台任务按用户事件派发，仅保留每日数据保留触发器', function () {
  const jobs = read('cloudfunctions/youpuJobs/index.js');
  const userApi = read('cloudfunctions/youpuUserApi/index.js');
  const dispatcher = read('cloudfunctions/youpuUserApi/job-dispatcher.js');
  const manifest = JSON.parse(read('deployment/cloudbaserc.example.json'));
  const config = JSON.parse(read('cloudfunctions/youpuJobs/config.json'));
  const triggers = manifest.functions.find(function (item) { return item.name === 'youpuJobs'; }).triggers;
  const names = triggers.map(function (item) { return item.name; });
  assert.deepEqual(names, ['youpu-retention-maintenance']);
  assert.deepEqual(config.triggers, triggers);
  assert.match(jobs, /async function processAccountExportTask\(taskId\)/);
  assert.match(jobs, /async function processFamilyBackupTask\(taskId\)/);
  assert.match(jobs, /async function retentionRun\(\) \{[\s\S]*processDeletions[\s\S]*purgeArchivedFamilies[\s\S]*expireExportTasks/);
  assert.doesNotMatch(jobs, /reconcilePendingPayments|updateCommerceMetricsDaily|syncProfiles|createBackupManifest/);
  assert.match(userApi, /dispatchExportTask\('task\.account-export'/);
  assert.match(userApi, /dispatchExportTask\('task\.family-backup'/);
  assert.match(userApi, /result\.data\.backupTaskId !== task\.taskId/);
  assert.match(userApi, /collection\('family_memberships'\)\.where\(/);
  assert.doesNotMatch(userApi, /profile_sync_tasks/);
  assert.match(dispatcher, /InvocationType: 'Event'/);
  assert.match(jobs, /if \(!data && action === 'maintenance\.run'\)/);
  assert.match(jobs, /event\.triggerName \|\| event\.TriggerName/);
  assert.match(jobs, /request\.triggerName \|\| request\.TriggerName/);
});

test('任务派发只传任务标识并使用异步调用', async function () {
  const dispatcherPath = path.join(root, 'cloudfunctions/youpuUserApi/job-dispatcher.js');
  delete require.cache[dispatcherPath];
  const dispatcher = require(dispatcherPath);
  let invoked;
  const fakeClient = {
    Invoke: async function (payload) { invoked = payload; return { RequestId: 'scf-request' }; }
  };
  const result = await dispatcher.dispatchJob('task.account-export', 'exp_example', {
    secret: '12345678901234567890123456789012',
    region: 'ap-shanghai',
    namespace: 'staging-example',
    requestId: 'request-example',
    client: fakeClient
  });
  const body = JSON.parse(invoked.ClientContext);
  assert.equal(invoked.InvocationType, 'Event');
  assert.equal(invoked.FunctionName, 'youpuJobs');
  assert.deepEqual(body, {
    action: 'task.account-export',
    taskId: 'exp_example',
    internalSecret: '12345678901234567890123456789012',
    requestId: 'request-example'
  });
  assert.equal(result.requestId, 'scf-request');
});
