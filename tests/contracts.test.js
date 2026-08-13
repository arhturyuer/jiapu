const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('添加亲属支持关联已有成员并由用户确认伴侣的共同子女', function () {
  const pageSource = fs.readFileSync(path.join(root, 'miniprogram/pages/add-member/index.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/add-member/index.wxml'), 'utf8');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.match(pageSource, /api\.call\('relation\.linkExisting'/);
  assert.match(pageSource, /sharedChildIds:/);
  assert.match(template, /关联已有成员/);
  assert.match(template, /未勾选不会自动推断/);
  assert.match(userApi, /type:\s*'link_existing_relation'/);
  assert.match(userApi, /relationCount:\s*_\.inc\(linked\.relationCount\)/);
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

test('我的页具备账户三态、单次家谱加载和受控媒体展示', function () {
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  const clientApi = fs.readFileSync(path.join(root, 'miniprogram/utils/api.js'), 'utf8');
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.match(profile, /accountState === 'pending_delete'/);
  assert.match(profile, /app\.loadFamilyPages\(true\)/);
  assert.doesNotMatch(profile, /app\.loadFamilies\(\)/);
  assert.match(profile, /api\.getMediaPresentation/);
  assert.match(template, /账户正在注销冷静期/);
  assert.match(template, />创建家谱</);
  assert.match(template, /查看家谱/);
  assert.match(template, /保存名字/);
  assert.match(clientApi, /function getMediaPresentation/);
  assert.match(userApi, /'media\.getPresentation':\s*mediaGetPresentation/);
  assert.match(userApi, /asset\.ownerId === userId\(openid\)/);
});

test('家谱页和我的页空状态使用一致的三级创建引导', function () {
  const tree = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.wxml'), 'utf8');
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  [tree, profile].forEach(function (template) {
    assert.match(template, />创建家谱</);
    assert.match(template, />浏览示例家谱</);
    assert.match(template, /收到家人邀请，在微信中打开邀请卡片/);
    assert.match(template, /empty-guide-actions/);
  });
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
  assert.match(privacy, /wx\.downloadFile/);
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

test('小程序按官方运行时版本路由环境，体验版只能连接 staging', function () {
  const environment = require(path.join(root, 'miniprogram/config/env.js'));
  const legal = require(path.join(root, 'miniprogram/config/legal.js'));
  const preflight = fs.readFileSync(path.join(root, 'deployment/preflight.sh'), 'utf8');
  const indexes = JSON.parse(fs.readFileSync(path.join(root, 'deployment/database-indexes.json'), 'utf8'));
  const localStaging = path.join(root, 'miniprogram/config/env.local.js');
  assert.ok(fs.existsSync(localStaging));
  assert.equal(environment.active, 'staging');
  assert.equal(environment.resolveRuntimeEnvironment({
    getAccountInfoSync: function () { return { miniProgram: { envVersion: 'release' } }; }
  }).active, 'production');
  assert.notEqual(environment.environments.staging.cloudEnv, environment.environments.production.cloudEnv);
  assert.ok(environment.environments.production.cloudEnv);
  assert.equal(legal.registrationVerified, true);
  assert.doesNotMatch(legal.operatorName, /^(运营者|有谱小程序运营者|待填写|测试主体|示例主体)$/);
  assert.match(preflight, /RUNTIME_VERSION="release"/);
  assert.match(preflight, /RUNTIME_VERSION="trial"/);
  assert.match(preflight, /已阻止 staging 预检指向 production/);
  const config = fs.readFileSync(path.join(root, 'miniprogram/config/env.js'), 'utf8');
  const upload = fs.readFileSync(path.join(root, 'deployment/upload-miniprogram.sh'), 'utf8');
  assert.match(config, /miniProgram\.envVersion/);
  assert.match(config, /runtimeVersion === 'release' \? 'production' : 'staging'/);
  assert.match(upload, /\{staging\|production\}/);
  assert.match(upload, /开发版\/体验版连接 staging，正式发布后连接 production/);
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
  assert.deepEqual(cloudbase.functions.map(function (item) { return item.runtime; }), ['Nodejs20.19', 'Nodejs20.19', 'Nodejs20.19']);
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
