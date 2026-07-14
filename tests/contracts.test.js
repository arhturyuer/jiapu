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

test('函数与存储安全规则使用 CloudBase 支持的表达式且生产不静默降级', function () {
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
  assert.match(deployScript, /ALLOW_PRIVATE_STORAGE_FALLBACK !== '1'/);
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
