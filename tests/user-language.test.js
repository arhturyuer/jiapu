const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const userMessage = require('../miniprogram/utils/user-message');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('统一错误语言覆盖常见分类并保留问题编号', function () {
  const cases = [
    ['CLOUD_CALL_FAILED', '网络'],
    ['CLOUD_FUNCTION_TIMEOUT', '稍后'],
    ['NO_PERMISSION', '权限'],
    ['GRAPH_CHANGED', '刷新'],
    ['RATE_LIMITED', '频繁'],
    ['CONTENT_REJECTED', '安全检查'],
    ['PAYMENT_RECONCILE_UNAVAILABLE', '不要重复购买']
  ];
  cases.forEach(function (item) {
    const result = userMessage.fromError({ code: item[0], requestId: 'problem-123', errMsg: 'internal platform failure' });
    assert.match(result.message, new RegExp(item[1]));
    assert.equal(result.problemId, 'problem-123');
    assert.doesNotMatch(result.message, /internal|errMsg|platform failure/);
  });
  const fallback = userMessage.fromError({ code: 'NEW_INTERNAL_CODE', requestId: 'problem-456', message: 'database exploded' }, '暂时无法保存，请稍后重试');
  assert.equal(fallback.message, '暂时无法保存，请稍后重试');
  assert.equal(fallback.problemId, 'problem-456');
  assert.doesNotMatch(fallback.message, /database exploded|NEW_INTERNAL_CODE/);
  assert.equal(userMessage.lastProblemId(), 'problem-456');
});

test('重点页面不直接展示内部名词或原始动态值', function () {
  const templates = [
    'miniprogram/pages/activity/index.wxml',
    'miniprogram/pages/family-backup/index.wxml',
    'miniprogram/pages/privacy/index.wxml',
    'miniprogram/pages/membership/index.wxml'
  ];
  templates.forEach(function (file) {
    const source = read(file);
    assert.doesNotMatch(source, /person\.update|item\.action|openid|token|manifest|\bCSV\b|\bZIP\b|\bJSON\b|服务端发货|前端支付|微信返回/iu, file);
  });
  const membership = read('miniprogram/pages/membership/index.js');
  assert.doesNotMatch(membership, /reconcileMessage\s*\|\||paymentMessage:\s*(?:order|data\.order)\.reconcileMessage/);
  assert.doesNotMatch(membership, /paymentMessage:[^\n]*(?:staging|sandbox|env=1|IAP|发货)/i);
});

test('历史筛选使用受控动作值，未知变化有用户语言兜底', function () {
  const activity = read('miniprogram/pages/activity/index.js');
  assert.match(activity, /key: 'person\.createRelated', label: '添加家庭成员'/);
  assert.match(activity, /key: 'membership\.updateRole', label: '调整家人权限'/);
  assert.match(activity, /action: option\.key/);
  assert.match(activity, /summaryText:[^\n]*'其他家谱变化'/);
});

test('举报类型和备份失败信息均使用安全映射', function () {
  const privacy = read('miniprogram/pages/privacy/index.js');
  const privacyTemplate = read('miniprogram/pages/privacy/index.wxml');
  const userApi = read('cloudfunctions/youpuUserApi/index.js');
  assert.match(privacy, /person: '人物资料'/);
  assert.match(privacy, /media: '人物头像'/);
  assert.match(privacy, /family: '家谱资料'/);
  assert.match(privacy, /targetLabels\[item\.targetType\] \|\| '相关资料'/);
  assert.match(privacyTemplate, /item\.targetTypeText/);
  assert.match(privacyTemplate, /联系微信客服[\s\S]*问题编号/);
  assert.doesNotMatch(privacyTemplate, /item\.targetType}}/);
  assert.match(userApi, /failureMessage: task\.status === 'failed' \? '备份生成失败，请重新尝试' : ''/);
});

test('用户页面不再把 error.message 或 errMsg 直接作为展示文案', function () {
  const pagesRoot = path.join(root, 'miniprogram/pages');
  const files = [];
  fs.readdirSync(pagesRoot).forEach(function (directory) {
    const file = path.join(pagesRoot, directory, 'index.js');
    if (fs.existsSync(file)) files.push(file);
  });
  files.forEach(function (file) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /title:\s*(?:error|modalError)\.message\s*\|\||paymentMessage:\s*(?:error\.message|error\.errMsg)/, path.relative(root, file));
  });
});
