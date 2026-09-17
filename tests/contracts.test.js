require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

test('页面注册、文件和 WXML 事件处理器保持一致', function () {
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  appConfig.pages.forEach(function (pagePath) {
    const base = path.join(root, 'miniprogram', pagePath);
    ['.js', '.json', '.wxml', '.wxss'].forEach(function (extension) {
      assert.equal(fs.existsSync(base + extension), true, pagePath + extension + ' 不存在');
    });
    JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
    const source = fs.readFileSync(base + '.js', 'utf8');
    const template = fs.readFileSync(base + '.wxml', 'utf8');
    const handlers = new Set(Array.from(template.matchAll(/(?:bind|catch)(?:tap|input|change|submit|confirm|blur)="([A-Za-z0-9_]+)"/g)).map(function (match) { return match[1]; }));
    handlers.forEach(function (handler) {
      assert.match(source, new RegExp('\\b' + handler + '\\s*:\\s*function\\b'), pagePath + ' 缺少事件处理器 ' + handler);
    });
  });
});

test('小程序只通过用户 API 访问数据且调用动作都有服务端路由', function () {
  const apiSource = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const miniFiles = [];
  function walk(directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(function (entry) {
      if (['env.local.js', 'node_modules', 'miniprogram_npm', 'dist'].includes(entry.name)) return;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith('.js')) miniFiles.push(target);
    });
  }
  walk(path.join(root, 'miniprogram'));
  const source = miniFiles.map(function (file) { return fs.readFileSync(file, 'utf8'); }).join('\n');
  assert.doesNotMatch(source, /wx\.cloud\.database\s*\(/);
  const actions = new Set(Array.from(source.matchAll(/api\.call\('([^']+)'/g)).map(function (match) { return match[1]; }));
  actions.forEach(function (action) {
    assert.ok(apiSource.includes("'" + action + "':"), '服务端缺少动作 ' + action);
  });
});

test('归档与注销入口遵守弹窗限制并保留可处理的失败信息', function () {
  const clientApi = fs.readFileSync(path.join(root, 'miniprogram/utils/api.js'), 'utf8');
  const familyManage = fs.readFileSync(path.join(root, 'miniprogram/pages/family-manage/index.js'), 'utf8');
  const familyTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/family-manage/index.wxml'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.js'), 'utf8');
  const privacyTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.wxml'), 'utf8');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const miniFiles = [];
  function walk(directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(function (entry) {
      if (['env.local.js', 'node_modules', 'miniprogram_npm', 'dist'].includes(entry.name)) return;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith('.js')) miniFiles.push(target);
    });
  }
  walk(path.join(root, 'miniprogram'));
  miniFiles.forEach(function (file) {
    const source = fs.readFileSync(file, 'utf8');
    Array.from(source.matchAll(/confirmText:\s*'([^']+)'/g)).forEach(function (match) {
      assert.ok(Array.from(match[1]).length <= 4, path.relative(root, file) + ' 的 confirmText 超过 4 个字符');
    });
  });
  assert.match(clientApi, /function normalizeCloudError/);
  assert.match(clientApi, /source\.errMsg/);
  assert.match(familyManage, /confirmText:\s*'确认移入'/);
  assert.match(familyManage, /archiving: false/);
  assert.match(familyManage, /if \(this\.data\.archiving\) return/);
  assert.match(familyTemplate, /正在移入回收站，请稍候/);
  assert.match(privacy, /showLastAdminGuidance/);
  assert.match(privacy, /error\.code === 'LAST_ADMIN'/);
  assert.match(privacy, /deletionExecuteText/);
  assert.match(privacyTemplate, /预计于/);
  assert.match(userApi, /remediation:\s*'transfer_or_archive'/);
  assert.match(userApi, /familyId:\s*family\._id/);
});

test('云函数调用保留微信 errMsg 以便页面展示', async function () {
  const source = fs.readFileSync(path.join(root, 'miniprogram/utils/api.js'), 'utf8');
  let attempts = 0;
  const context = {
    module: { exports: {} },
    require: function () {
      return { resolveRuntimeEnvironment: function () { return { environment: { userApi: 'youpuUserApi' } }; } };
    },
    setTimeout: function (callback, delay) {
      if (delay === 250) Promise.resolve().then(callback);
      return 1;
    },
    clearTimeout: function () {},
    Promise: Promise,
    wx: {
      cloud: {
        callFunction: function () {
          attempts += 1;
          return Promise.reject({ errMsg: 'request:fail network disconnected' });
        }
      }
    }
  };
  vm.runInNewContext(source, context, { filename: 'api.js' });
  await assert.rejects(context.module.exports.call('family.archive'), function (error) {
    assert.equal(error.message, 'request:fail network disconnected');
    assert.equal(error.code, 'CLOUD_CALL_FAILED');
    return true;
  });
  assert.equal(attempts, 2, '非业务错误应保留一次网络重试');
});

test('关于页使用正式版实际版本并按最新在前展示受控更新记录', function () {
  const releaseInfo = require(path.join(root, 'miniprogram/utils/release-info.js'));
  const releaseNotes = require(path.join(root, 'miniprogram/config/release-notes.js'));
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.js'), 'utf8');
  const profileTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  const aboutTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/about/index.wxml'), 'utf8');
  const uploadScript = fs.readFileSync(path.join(root, 'deployment/upload-miniprogram.sh'), 'utf8');
  const verifier = fs.readFileSync(path.join(root, 'deployment/verify-release-note.mjs'), 'utf8');
  assert.deepEqual(releaseInfo.validateReleaseNotes(releaseNotes), [
    {
      version: '1.2.9',
      summary: '新增家谱横竖屏切换与横屏沉浸浏览，精简画布操作并优化竖屏底部空间。'
    },
    {
      version: '1.2.8',
      summary: '优化多祖先家谱布局，保持父母双方分支归属并压缩子女间距。'
    },
    {
      version: '1.2.7',
      summary: '重构家庭与我的页面职责，集中家谱管理入口并优化多机型卡片与按钮布局。'
    },
    {
      version: '1.2.6',
      summary: '新增子女排行标识与手动调整功能，支持按出生日期自动区分长子、次子、长女、次女。'
    },
    {
      version: '1.2.5',
      summary: '新增家谱人物男女视觉区分，并完善新成员性别必填与伴侣性别选择。'
    },
    {
      version: '1.2.4',
      summary: '优化添加亲属流程，支持一次补齐共同父母、共同子女和伴侣关系，提升连续录入效率。'
    },
    {
      version: '1.2.3',
      summary: '完善人物视角亲属称谓，修正姑姥、表舅等称呼，支持多重关系与路径查看。'
    },
    {
      version: '1.2.2',
      summary: '新增家庭会员购买记录与待确认订单自动核验。'
    },
    {
      version: '1.2.1',
      summary: '修复家谱归档、优化注销引导、增加关于页与版本更新记录'
    }
  ]);
  assert.throws(function () {
    releaseInfo.validateReleaseNotes([{ version: '1.0.0', summary: '旧版本' }, { version: '1.1.0', summary: '新版本' }]);
  }, /最新版本在前/);
  assert.throws(function () {
    releaseInfo.validateReleaseNotes([{ version: '1.1.0', summary: '新版本' }, { version: '1.1.0', summary: '重复版本' }]);
  }, /重复版本号/);
  assert.equal(releaseInfo.getCurrentReleaseVersion({ getAccountInfoSync: function () {
    return { miniProgram: { envVersion: 'release', version: '1.2.3' } };
  } }), '1.2.3');
  assert.equal(releaseInfo.getCurrentReleaseVersion({ getAccountInfoSync: function () {
    return { miniProgram: { envVersion: 'trial', version: '1.2.3' } };
  } }), '');
  assert.match(profile, /navigateTo\(\{ url: '\/pages\/about\/index' \}\)/);
  assert.doesNotMatch(profileTemplate, /有谱 v1\.0\.0/);
  assert.match(aboutTemplate, /版本更新/);
  assert.match(aboutTemplate, /更新记录将在下一版本发布后显示/);
  assert.match(uploadScript, /verify-release-note\.mjs/);
  assert.match(verifier, /上传版本.*最新版本记录/);
});

test('添加亲属支持关联已有成员并由用户确认伴侣的共同子女', function () {
  const pageSource = fs.readFileSync(path.join(root, 'miniprogram/pages/add-member/index.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/add-member/index.wxml'), 'utf8');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.match(pageSource, /api\.call\('relation\.linkExisting'/);
  assert.match(pageSource, /sharedChildIds:/);
  assert.match(pageSource, /coParentId:/);
  assert.match(pageSource, /parentPartnerId:/);
  assert.match(pageSource, /sharedParentIds:/);
  assert.match(pageSource, /idempotencyKey:/);
  assert.match(template, /关联已有成员/);
  assert.match(template, /保存并继续添加/);
  assert.match(template, /兄弟姐妹/);
  assert.match(template, /照片和补充资料（可选）/);
  assert.equal((template.match(/（可选）/g) || []).length, 1);
  assert.ok(template.indexOf('出生日期') < template.indexOf('wx:if="{{showMoreFields}}"'));
  assert.match(template, /未勾选不会自动推断/);
  assert.match(userApi, /type:\s*'link_existing_relation'/);
  assert.match(userApi, /relationCount:\s*_\.inc\(linked\.relationCount\)/);
  assert.match(userApi, /relatedRelationEdges/);
  assert.match(userApi, /relationSummary:/);
});

test('头像使用独立保存接口、只读审核状态且新增成员延迟上传', function () {
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const clientApi = fs.readFileSync(path.join(root, 'miniprogram/utils/api.js'), 'utf8');
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.js'), 'utf8');
  const editMember = fs.readFileSync(path.join(root, 'miniprogram/pages/edit-member/index.js'), 'utf8');
  const addMember = fs.readFileSync(path.join(root, 'miniprogram/pages/add-member/index.js'), 'utf8');
  assert.match(userApi, /'auth\.updateAvatar':\s*authUpdateAvatar/);
  assert.match(userApi, /'media\.getStates':\s*mediaGetStates/);
  assert.match(userApi, /const hasAvatarUpdate = event\.avatarAssetId !== undefined/);
  assert.match(clientApi, /call\('media\.getStates'/);
  assert.match(profile, /api\.call\('auth\.updateAvatar'/);
  assert.match(editMember, /data:\s*\{ avatarAssetId: media\.assetId \}/);
  assert.match(addMember, /已选择，添加成员时一并上传/);
  assert.match(addMember, /submitStage:\s*'正在上传头像…'/);
});

test('我的页具备账户三态、独立个人资料和受控媒体展示', function () {
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  const clientApi = fs.readFileSync(path.join(root, 'miniprogram/utils/api.js'), 'utf8');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.match(profile, /accountState === 'pending_delete'/);
  assert.doesNotMatch(profile, /loadFamilyPages|loadFamilies|familyList|archivedFamilies/);
  assert.match(profile, /api\.getMediaPresentation/);
  assert.match(template, /账户正在注销冷静期/);
  assert.match(template, /profile-card/);
  assert.match(template, /账户与隐私/);
  assert.doesNotMatch(template, /创建家谱|当前家谱|切换家谱|家庭管理|家谱回收站|家谱变更历史|完整家庭备份|membershipTierText/);
  assert.match(template, /保存名字/);
  assert.match(clientApi, /function getMediaPresentation/);
  assert.match(userApi, /'media\.getPresentation':\s*mediaGetPresentation/);
  assert.match(userApi, /asset\.ownerId === userId\(openid\)/);
});

test('家谱页和家庭页空状态使用一致的三级创建引导', function () {
  const tree = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.wxml'), 'utf8');
  const members = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.wxml'), 'utf8');
  [tree, members].forEach(function (template) {
    assert.match(template, />创建家谱</);
    assert.match(template, />浏览示例家谱</);
    assert.match(template, /收到家人邀请，在微信中打开邀请卡片/);
    assert.match(template, /empty-guide-actions/);
  });
});

test('家庭页保留首次引导，家谱页在三位成员后提供可关闭的邀请待办', function () {
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const members = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.js'), 'utf8');
  const membersTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.wxml'), 'utf8');
  const tree = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.js'), 'utf8');
  const treeTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.wxml'), 'utf8');
  assert.match(userApi, /'family\.dismissShareReminder': familyDismissShareReminder/);
  assert.match(userApi, /requireMembership\(event\.familyId, \['admin'\]/);
  assert.match(userApi, /shareReminderDismissedAt/);
  assert.match(userApi, /sharedAt: family\.sharedAt \|\| family\.onboardingSharedAt \|\| null/);
  assert.doesNotMatch(members, /showShareReminder|dismissShareReminder/);
  assert.match(membersTemplate, /让家谱活起来/);
  assert.match(membersTemplate, /家谱已创建/);
  assert.match(membersTemplate, /推荐补到 3 位家人/);
  assert.match(membersTemplate, /发送到家庭群/);
  assert.doesNotMatch(membersTemplate, /邀请家人一起补全|暂不分享/);
  assert.match(tree, /personCount[\s\S]{0,80}>= 3/);
  assert.match(tree, /!family\.sharedAt/);
  assert.match(tree, /!family\.shareReminderDismissedAt/);
  assert.match(tree, /api\.call\('family\.dismissShareReminder'/);
  assert.match(treeTemplate, /邀请家人一起补全/);
  assert.match(treeTemplate, /暂不分享/);
  assert.match(treeTemplate, /bindtap="startShare"/);
});

test('分享弹框预先准备本机邀请码并直接转发给微信好友', function () {
  const members = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.js'), 'utf8');
  const membersTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.wxml'), 'utf8');
  const tree = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.js'), 'utf8');
  const treeTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.wxml'), 'utf8');
  const cache = fs.readFileSync(path.join(root, 'miniprogram/utils/share-invite.js'), 'utf8');
  [members, tree].forEach(function (source) {
    assert.match(source, /require\('\.\.\/\.\.\/utils\/share-invite'\)/);
    assert.match(source, /\}, this\.prepareShare\)/);
    assert.match(source, /shareInvite\.get\(shareContext\)/);
    assert.match(source, /shareInvite\.set\(shareContext, card, data\.expiresAt\)/);
  });
  [membersTemplate, treeTemplate].forEach(function (template) {
    assert.match(template, /open-type="share">转发给微信好友/);
    assert.match(template, /正在准备微信邀请/);
    assert.doesNotMatch(template, /生成微信邀请/);
  });
  assert.match(cache, /youpu_share_invite_cards/);
  assert.match(cache, /expirationTime\(entry\.expiresAt\) > now/);
  assert.match(cache, /ownerId.*familyId.*role.*viewMode.*viewPersonId/s);
});

test('个人导出使用私有异步任务，不会复制数据到剪贴板', function () {
  const privacy = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.wxml'), 'utf8');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const jobs = fs.readFileSync(path.join(root, 'cloudfunctions/youpuJobs/index.js'), 'utf8');
  const indexes = JSON.parse(fs.readFileSync(path.join(root, 'deployment/database-indexes.json'), 'utf8'));
  assert.doesNotMatch(privacy, /wx\.setClipboardData/);
  assert.match(privacy, /api\.call\('account\.export'/);
  assert.match(privacy, /api\.call\('account\.exportStatus'/);
  assert.match(privacy, /api\.call\('account\.exportUrl'/);
  assert.match(privacy, /fileTransfer\.downloadToTempFile/);
  assert.match(privacy, /fileTransfer\.removeTempFile/);
  assert.match(template, /仅可领取一次/);
  assert.match(userApi, /'account\.exportStatus':\s*accountExportStatus/);
  assert.match(userApi, /'account\.exportUrl':\s*accountExportUrl/);
  assert.match(userApi, /current\.userId === user\._id/);
  assert.match(userApi, /downloadIssuedAt/);
  assert.match(jobs, /processExportTasks/);
  assert.match(jobs, /cloud\.uploadFile/);
  assert.match(jobs, /expireExportTasks/);
  assert.ok(indexes.indexes.export_tasks);
});

test('缓存清理入口位于隐私与账户页的权限与保存模块', function () {
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.js'), 'utf8');
  const profileTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.js'), 'utf8');
  const privacyTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.wxml'), 'utf8');
  assert.match(profileTemplate, /隐私与账户/);
  assert.doesNotMatch(profileTemplate, /隐私、导出与注销|清除本机缓存|bindtap="clearCache"/);
  assert.doesNotMatch(profile, /clearCache\s*:\s*function/);
  assert.match(privacyTemplate, /权限与保存[\s\S]*bindtap="clearCache"[\s\S]*清除本机缓存/);
  assert.match(privacy, /clearCache\s*:\s*function[\s\S]*app\.clearLocalData\(\)/);
});

test('用户反馈群二维码由运营后台受控替换并在小程序双入口展示', function () {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.wxml'), 'utf8');
  const feedbackPage = fs.readFileSync(path.join(root, 'miniprogram/pages/feedback-group/index.wxml'), 'utf8');
  const feedbackSource = fs.readFileSync(path.join(root, 'miniprogram/pages/feedback-group/index.js'), 'utf8');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'admin/src/components/FeedbackGroupManager.vue'), 'utf8');
  const jobs = fs.readFileSync(path.join(root, 'cloudfunctions/youpuJobs/index.js'), 'utf8');
  assert.ok(app.pages.includes('pages/feedback-group/index'));
  [profile, privacy].forEach(function (template) { assert.match(template, /showFeedbackGroup[\s\S]*用户反馈群/); });
  assert.match(feedbackPage, /长按识别二维码加入微信群/);
  assert.match(feedbackPage, /反馈群暂未开放/);
  assert.match(feedbackSource, /api\.call\('feedbackGroup\.get'/);
  assert.match(feedbackSource, /wx\.previewImage/);
  assert.match(userApi, /async function feedbackGroupGet/);
  assert.match(userApi, /'feedbackGroup\.get': feedbackGroupGet/);
  assert.match(opsApi, /async function feedbackGroupUpdate/);
  assert.match(opsApi, /feedback_group_settings/);
  assert.match(opsApi, /FEEDBACK_QR_MAX_BYTES/);
  assert.match(opsApi, /cloud\.uploadFile/);
  assert.match(opsApi, /ops\.feedback_group\.update/);
  assert.match(opsApi, /'feedbackGroup\.update': feedbackGroupUpdate/);
  assert.match(admin, /确认替换二维码/);
  assert.match(admin, /feedbackGroup\.update/);
  assert.match(jobs, /'feedback_group_settings'/);
});

test('小程序按官方运行时版本路由环境，开发版连接 staging、体验版和正式版连接 production', function () {
  const environment = require(path.join(root, 'miniprogram/config/env.js'));
  const legal = require(path.join(root, 'miniprogram/config/legal.js'));
  const preflight = fs.readFileSync(path.join(root, 'deployment/preflight.sh'), 'utf8');
  const indexes = JSON.parse(fs.readFileSync(path.join(root, 'deployment/database-indexes.json'), 'utf8'));
  assert.equal(environment.active, 'staging');
  assert.equal(environment.resolveRuntimeEnvironment({
    getAccountInfoSync: function () { return { miniProgram: { envVersion: 'develop' } }; }
  }).active, 'staging');
  assert.equal(environment.resolveRuntimeEnvironment({
    getAccountInfoSync: function () { return { miniProgram: { envVersion: 'trial' } }; }
  }).active, 'production');
  assert.equal(environment.resolveRuntimeEnvironment({
    getAccountInfoSync: function () { return { miniProgram: { envVersion: 'release' } }; }
  }).active, 'production');
  assert.notEqual(environment.environments.staging.cloudEnv, environment.environments.production.cloudEnv);
  assert.ok(environment.environments.production.cloudEnv);
  assert.equal(legal.registrationVerified, true);
  assert.doesNotMatch(legal.operatorName, /^(运营者|有谱小程序运营者|待填写|测试主体|示例主体)$/);
  assert.match(preflight, /RUNTIME_VERSION="release"/);
  assert.match(preflight, /RUNTIME_VERSION="develop"/);
  assert.match(preflight, /已阻止 staging 预检指向 production/);
  const config = fs.readFileSync(path.join(root, 'miniprogram/config/env.js'), 'utf8');
  const upload = fs.readFileSync(path.join(root, 'deployment/upload-miniprogram.sh'), 'utf8');
  assert.match(config, /miniProgram\.envVersion/);
  assert.match(config, /runtimeVersion === 'trial' \|\| runtimeVersion === 'release'/);
  assert.match(upload, /\{staging\|production\}/);
  assert.match(upload, /EXPECTED_RUNTIMES=\("trial" "release"\)/);
  assert.match(upload, /开发版连接 staging，体验版\/正式版连接 production/);
  assert.ok(indexes.indexes.example_templates.some(function (index) { return index.name === 'slug_unique' && index.unique; }));
  assert.ok(indexes.indexes.example_template_versions.some(function (index) { return index.name === 'template_version_unique' && index.unique; }));
});

test('账户资料更新和导出请求具备用户级限流', function () {
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.match(userApi, /'auth\.updateProfile':\s*\{ max: 20, windowMs: 60 \* 60 \* 1000 \}/);
  assert.match(userApi, /'auth\.updateAvatar':\s*\{ max: 20, windowMs: 60 \* 60 \* 1000 \}/);
  assert.match(userApi, /'account\.export':\s*\{ max: 3, windowMs: 24 \* 60 \* 60 \* 1000 \}/);
  assert.match(userApi, /if \(RATE_LIMITS\[type\]\) await enforceRateLimit/);
});

test('管理员可以软删除不会使家谱断裂的单条关系', function () {
  const pageSource = fs.readFileSync(path.join(root, 'miniprogram/pages/member-detail/index.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/member-detail/index.wxml'), 'utf8');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.match(pageSource, /api\.call\('relation\.remove'/);
  assert.match(pageSource, /RELATION_DISCONNECTS_GRAPH/);
  assert.match(template, /移除关系/);
  assert.match(template, /wx:if="\{\{isAdmin\}\}"/);
  assert.match(userApi, /'relation\.remove':\s*relationRemove/);
  assert.match(userApi, /requireMembership\(snapshotRelation\.familyId, \['admin'\]/);
  assert.match(userApi, /status:\s*'deleted', deletedAt:/);
  assert.match(userApi, /relationCount:\s*_\.inc\(-1\)/);
  assert.match(userApi, /action:\s*'relation\.remove'/);
});

test('生产基础库、云函数运行时和客户端直连禁用配置已锁定', function () {
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  assert.equal(project.libVersion, '3.16.2');
  assert.equal(project.setting.urlCheck, true);
  const cloudbase = JSON.parse(fs.readFileSync(path.join(root, 'deployment/cloudbaserc.example.json'), 'utf8'));
  assert.deepEqual(cloudbase.functions.map(function (item) { return item.runtime; }), ['Nodejs20.19', 'Nodejs20.19', 'Nodejs20.19', 'Nodejs20.19']);
  const databaseRule = JSON.parse(fs.readFileSync(path.join(root, 'deployment/security/database-deny-all.json'), 'utf8'));
  assert.equal(databaseRule.read, false);
  assert.equal(databaseRule.write, false);
});

test('函数与存储安全规则支持个人套餐显式 PRIVATE 生产基线', function () {
  const functionRules = JSON.parse(fs.readFileSync(path.join(root, 'deployment/security/function-rules.json'), 'utf8'));
  const authenticatedRule = "auth.loginType != 'ANONYMOUS' && auth != null";
  assert.equal(functionRules['*'].invoke, false);
  assert.equal(functionRules.youpuUserApi.invoke, authenticatedRule);
  assert.equal(functionRules.youpuOpsApi.invoke, authenticatedRule);
  assert.equal(functionRules.youpuJobs.invoke, false);
  assert.equal(functionRules.youpuPaymentNotify.invoke, false);

  const storageRules = JSON.parse(fs.readFileSync(path.join(root, 'deployment/security/storage-private-staging.json'), 'utf8'));
  assert.equal(storageRules.read, false);
  assert.match(storageRules.write, /resource\.size <= 5242880/);
  assert.match(storageRules.write, /\^staging/);
  assert.match(storageRules.write, /\.test\(resource\.path\) == true/);

  const deployScript = fs.readFileSync(path.join(root, 'deployment/apply-security.mjs'), 'utf8');
  assert.match(deployScript, /OperationDenied\.FreePackageDenied/);
  assert.match(deployScript, /ALLOW_PERSONAL_PRIVATE_STORAGE !== '1'/);
  assert.match(deployScript, /storagePermissionName !== 'PRIVATE'/);
});

test('个人套餐上传由服务端核验对象路径和真实大小', function () {
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.match(userApi, /fileId\.endsWith\('\/' \+ asset\.cloudPath\)/);
  assert.match(userApi, /Range:\s*'bytes=0-0'/);
  assert.match(userApi, /const size = inspected\.size/);
  assert.doesNotMatch(userApi, /Number\(event\.size\)/);
  assert.match(userApi, /size > 5 \* 1024 \* 1024/);
  assert.match(userApi, /moderationStatus: 'approved', status: 'active'/);
});

test('事务只按文档主键读写且后台清理具备并发抢占和续跑保护', function () {
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const jobs = fs.readFileSync(path.join(root, 'cloudfunctions/youpuJobs/index.js'), 'utf8');
  assert.doesNotMatch(userApi + opsApi + jobs, /transaction\.collection\([^)]*\)\.where\s*\(/);
  assert.match(jobs, /reason:\s*'already_claimed'/);
  assert.match(jobs, /claimFamilyDeletion/);
  assert.match(jobs, /deletionStartedAt:\s*_\.lte/);
  assert.match(jobs, /deleteFamilyMediaFiles/);
});

test('document.set 不会把 _id 作为普通字段重复提交给 CloudBase', function () {
  const sources = ['youpuUserApi', 'youpuOpsApi', 'youpuJobs'].map(function (name) {
    return fs.readFileSync(path.join(root, 'cloudfunctions', name, 'index.js'), 'utf8');
  });
  sources.forEach(function (source) {
    assert.doesNotMatch(source, /\.doc\([^\n]+\)\.set\(\{\s*data:\s*\{\s*_id:/s);
    assert.doesNotMatch(source, /\.doc\([^\n]+\)\.set\(\{\s*data:\s*(?:user|relation|record)\s*\}\)/s);
  });
  assert.match(sources[0], /set\(\{ data: documentData\((?:user|relation|record)\) \}\)/);
});

test('三类云函数日志只记录请求、匿名主体、动作、耗时和结果码', function () {
  ['youpuUserApi', 'youpuOpsApi', 'youpuJobs'].forEach(function (name) {
    const source = fs.readFileSync(path.join(root, 'cloudfunctions', name, 'index.js'), 'utf8');
    assert.match(source, /requestId:/, name + ' 缺少请求 ID');
    assert.match(source, /actorId:/, name + ' 缺少匿名主体');
    assert.match(source, /durationMs:/, name + ' 缺少耗时');
    assert.match(source, /resultCode:/, name + ' 缺少结果码');
  });
});

test('运营后台不要求关联工单并自动记录具体运营账号', function () {
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const adminApp = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
  assert.doesNotMatch(opsApi, /requireLinkedWorkOrder|workOrderId|['"]REASON_REQUIRED['"]/);
  assert.doesNotMatch(adminApp, /window\.prompt|workOrderId|operatorForm\.reason|必须填写工单|操作原因/);
  assert.match(adminApp, /dialog\.action === 'reports\.resolve'/);
  assert.match(opsApi, /RESOLUTION_REQUIRED/);
  assert.match(opsApi, /actorAccount:\s*cleanText\(operator\.email \|\| operator\.displayName \|\| operator\._id/);
});

test('内容复核提供待办与历史视图并完整记录人工结论', function () {
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const adminApp = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
  assert.match(opsApi, /event\.scope === 'reviewed'/);
  assert.match(opsApi, /\['approved', 'rejected'\]/);
  assert.match(opsApi, /\['review', 'pending'\]/);
  assert.match(opsApi, /reviewSource:\s*reviewSource/);
  assert.match(opsApi, /available:\s*false/);
  assert.match(opsApi, /文字内容已按 30 天保留周期清理/);
  assert.match(opsApi, /拒绝图片已按 24 小时保留周期清理/);
  assert.match(opsApi, /REVIEW_REASON_REQUIRED/);
  assert.match(opsApi, /reviewedByName:\s*reviewedByName/);
  assert.match(opsApi, /reviewedByAccount:\s*reviewedByAccount/);
  assert.match(adminApp, /switchModerationScope\('pending'\)/);
  assert.match(adminApp, /switchModerationScope\('reviewed'\)/);
  assert.match(adminApp, /审核结果已写入审核记录/);
  assert.match(adminApp, /dialogNeedsReason/);
  assert.match(adminApp, /原内容已不可查看/);
});

test('图片复核模式支持默认通过、受控缩略图与违规隐藏', function () {
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const jobs = fs.readFileSync(path.join(root, 'cloudfunctions/youpuJobs/index.js'), 'utf8');
  const adminApp = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.js'), 'utf8');
  assert.match(userApi, /imageModerationMode/);
  assert.match(userApi, /moderationMode: moderationMode/);
  assert.match(userApi, /reviewSource: reviewMode \? 'review_mode' : 'machine'/);
  assert.match(jobs, /asset\.moderationMode === 'review'/);
  assert.match(jobs, /machineDecision: suggest/);
  assert.match(jobs, /retainForInvestigation/);
  assert.match(opsApi, /'moderation\.mode\.get': moderationModeGet/);
  assert.match(opsApi, /'moderation\.mode\.set': moderationModeSet/);
  assert.match(opsApi, /'moderation\.violate': moderationViolate/);
  assert.match(opsApi, /requireOperator\(context, \['super_admin'\]\)/);
  assert.match(opsApi, /VIOLATION_REASON_REQUIRED/);
  assert.match(opsApi, /thumbnailUrls/);
  assert.match(opsApi, /ops\.moderation\.violate/);
  assert.match(adminApp, /复核模式/);
  assert.match(adminApp, /违规并删除/);
  assert.match(adminApp, /thumbnailUrl/);
  assert.match(profile, /const unavailable = item\.status === 'rejected'/);
});

test('运营详情使用结构化信息而不是原始 JSON', function () {
  const adminApp = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
  assert.doesNotMatch(adminApp, /JSON\.stringify\(detail/);
  assert.match(adminApp, /账号信息/);
  assert.match(adminApp, /家庭协作者/);
  assert.match(adminApp, /举报内容/);
  assert.match(adminApp, /detail-info-grid/);
});

test('家谱详情支持谱内人物搜索分页、人物详情、风险和运营记录', function () {
  const adminApp = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  assert.match(adminApp, /callOps<PageResult>\('families\.persons'/);
  assert.match(adminApp, /callOps<Row>\('families\.personDetail'/);
  assert.match(adminApp, /输入姓名搜索/);
  assert.match(adminApp, /举报与内容风险/);
  assert.match(adminApp, /最近运营记录/);
  assert.match(opsApi, /'families\.persons': familiesPersons/);
  assert.match(opsApi, /'families\.personDetail': familiesPersonDetail/);
  assert.match(opsApi, /Number\(event\.pageSize\) \|\| 20/);
  assert.match(opsApi, /ops\.family\.person\.view/);
});

test('客户端不接收或缓存原始微信 openid', function () {
  const appSource = fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.doesNotMatch(appSource, /data\.openid|setStorageSync\(['"]youpu_openid/);
  const publicAccountBody = userApi.match(/function publicAccount\(user\) \{([\s\S]*?)\n\}/);
  assert.ok(publicAccountBody, '缺少账户公开字段映射');
  assert.doesNotMatch(publicAccountBody[1], /openid/);
});

test('冻结、注销重试、运营账号和完整审计只属于超级管理员', function () {
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  ['usersFreeze', 'familiesFreeze', 'auditsList', 'deletionsRetry', 'operatorsCreate', 'operatorsDisable'].forEach(function (functionName) {
    const match = opsApi.match(new RegExp('async function ' + functionName + '\\([^)]*\\) \\{([\\s\\S]*?)(?=\\nasync function|\\nconst handlers)'));
    assert.ok(match, '缺少运营接口 ' + functionName);
    assert.match(match[1], /requireOperator\(context, \['super_admin'\]\)/, functionName + ' 未限制为超级管理员');
  });
});

test('家谱显示偏好集中设置，画布保持精简操作且既有偏好继续生效', function () {
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const tree = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.js'), 'utf8');
  const treeTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.wxml'), 'utf8');
  const members = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.wxml'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'miniprogram/pages/display-settings/index.js'), 'utf8');
  const settingsTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/display-settings/index.wxml'), 'utf8');
  const example = fs.readFileSync(path.join(root, 'miniprogram/pages/example/index.js'), 'utf8');
  const exampleTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/example/index.wxml'), 'utf8');
  assert.match(userApi, /function normalizeFamilyPreference/);
  assert.match(userApi, /showChildRankBadge: preference\.showChildRankBadge !== false/);
  assert.match(userApi, /'family\.getPreference': familyGetPreference/);
  assert.match(userApi, /Object\.prototype\.hasOwnProperty\.call\(event, field\)/);
  assert.match(tree, /saveGraphPreference/);
  assert.match(tree, /openDisplaySettings/);
  assert.doesNotMatch(tree, /toggleNameLayout/);
  assert.match(treeTemplate, /class="graph-control graph-control-text" bindtap="openDisplaySettings">设置<\/view>/);
  assert.match(exampleTemplate, /class="graph-control graph-control-text" bindtap="openDisplaySettings">设置<\/view>/);
  assert.match(members, /bindtap="openDisplaySettings"[\s\S]{0,180}家谱显示设置/);
  assert.match(settings, /api\.call\('family\.getPreference'/);
  assert.match(settings, /api\.call\('family\.setPreference'/);
  assert.match(settingsTemplate, /data-field="showChildRankBadge"/);
  assert.match(settingsTemplate, /data-field="showGenderBadge"/);
  assert.match(settingsTemplate, /data-field="showGenderColors"/);
  assert.match(treeTemplate, /node-name-vertical/);
  assert.match(treeTemplate, /wx:if="\{\{nameLayout === 'vertical'\}\}"/);
  assert.match(treeTemplate, /showChildRankBadge && item\.childRankLabel/);
  assert.match(treeTemplate, /wx:if="\{\{showGenderBadge\}\}"/);
  assert.match(treeTemplate, /showGenderColors \? item\.genderClass : 'gender-neutral'/);
  assert.match(example, /exampleDisplayPreference\.get/);
  assert.match(example, /applyDisplayPreference/);
  assert.match(exampleTemplate, /showChildRankBadge && item\.childRankLabel/);
  assert.match(exampleTemplate, /wx:if="\{\{showGenderBadge\}\}"/);
  assert.match(exampleTemplate, /showGenderColors \? item\.genderClass : 'gender-neutral'/);
  assert.doesNotMatch(exampleTemplate, /bindtap="toggleNameLayout"/);
  assert.match(exampleTemplate, /node-name-vertical/);
});
