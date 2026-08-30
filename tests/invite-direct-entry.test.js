const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
const invitePage = fs.readFileSync(path.join(root, 'miniprogram/pages/invite/index.js'), 'utf8');

function section(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

test('已加入用户可在邀请失效后由预览接口直接进入家谱', function () {
  const preview = section(userApi, 'async function invitePreview', 'async function inviteAccept');
  assert.match(userApi, /async function findInvitationByToken/);
  assert.match(preview, /const invitation = await findInvitationByToken\(event\.token\)/);
  assert.match(preview, /const membership = await getMembership\(db, family\._id, openid\)/);
  assert.match(preview, /if \(membership\)[\s\S]*alreadyJoined: true/);
  assert.ok(preview.indexOf('if (membership)') < preview.indexOf('assertInvitationActive(invitation)'));
  assert.match(preview, /alreadyJoined: false/);
});

test('重复接受邀请先返回已有成员资格，不重复使用邀请', function () {
  const accept = section(userApi, 'async function inviteAccept', 'async function shareRecord');
  assert.match(accept, /findInvitationByToken\(event\.token\)/);
  assert.match(accept, /if \(existing && existing\.status === 'active'\)[\s\S]*alreadyJoined: true/);
  assert.ok(accept.indexOf("if (existing && existing.status === 'active')") < accept.indexOf('assertInvitationActive(invitation)'));
  assert.equal((accept.match(/incrementShareMetric\(transaction, invitationShareKind\(invitation\), 'converted'\)/g) || []).length, 1);
});

test('邀请页收到已加入标识后直接进入原邀请视图', function () {
  assert.match(invitePage, /if \(data\.alreadyJoined\) \{\s*self\.enterFamily\(data\);/);
  assert.match(invitePage, /data\.viewMode === 'perspective' && data\.viewPersonId/);
  assert.match(invitePage, /app\.openPerspective\(family, data\.viewPersonId\)/);
  assert.match(invitePage, /app\.openFullGraph\(family\)/);
  assert.match(invitePage, /wx\.switchTab\(\{ url: '\/pages\/tree\/index' \}\)/);
});
