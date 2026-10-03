require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
function source(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

function inviteCreateHarness() {
  const sourceCode = source('cloudfunctions/youpuUserApi/index.js');
  const match = sourceCode.match(/async function inviteCreate\(event\) \{[\s\S]*?\n\}\n\nasync function inviteCreatePoster/);
  assert.ok(match, '应能找到 invite.create 服务端入口');
  const created = [];
  let inviterRole = 'admin';
  const transaction = { collection: function (name) {
    assert.equal(name, 'invitations');
    return { add: async function (input) { created.push(input.data); return { _id: 'invite-1' }; } };
  } };
  const context = {
    getOpenid: function () { return 'openid-1'; },
    requireActiveUser: async function () {},
    mutate: async function (action, event, openid, callback) {
      assert.equal(action, 'invite.create');
      return callback(transaction);
    },
    requireMembership: async function (familyId, roles) {
      assert.equal(familyId, 'family-1');
      assert.ok(roles.includes(inviterRole), 'NO_PERMISSION');
      return { membership: { role: inviterRole, displayName: '测试成员' } };
    },
    getFamily: async function () { return { _id: 'family-1', name: '测试家谱' }; },
    mustGet: async function (transaction, collection, id) {
      assert.equal(collection, 'persons');
      return { _id: id, familyId: 'family-1', status: 'active', name: '测试人物' };
    },
    assert: function (condition, code) { if (!condition) throw new Error(code); },
    randomToken: function () { return 'test-token'; },
    hash: function () { return 'test-hash'; },
    userId: function () { return 'user-1'; },
    db: { serverDate: function () { return 'now'; } },
    audit: async function () {},
    ACTIVE_ROLES: ['admin', 'member', 'viewer'],
    Date: Date,
    Math: Math,
    Number: Number
  };
  vm.createContext(context);
  vm.runInContext(match[0].replace(/\n\nasync function inviteCreatePoster$/, ''), context);
  return {
    created: created,
    setRole: function (role) { inviterRole = role; },
    create: function (role, viewMode, limits) {
      return context.inviteCreate(Object.assign({ familyId: 'family-1', role: role, viewMode: viewMode || 'full', viewPersonId: 'person-1' }, limits));
    }
  };
}

test('邀请创建权限不超过分享者自身权限，人物视角沿用同一限制', async function () {
  const harness = inviteCreateHarness();
  for (const [inviter, allowed] of [
    ['admin', ['member', 'viewer']],
    ['member', ['member', 'viewer']],
    ['viewer', ['viewer']]
  ]) {
    harness.setRole(inviter);
    for (const role of allowed) {
      const result = await harness.create(role, 'perspective');
      assert.equal(result.role, role);
      assert.equal(result.viewMode, 'perspective');
      assert.equal(harness.created.at(-1).role, role);
      assert.equal(harness.created.at(-1).viewPersonId, 'person-1');
    }
  }
  harness.setRole('viewer');
  await assert.rejects(harness.create('member'), /NO_PERMISSION|INVALID_ROLE/);
  harness.setRole('member');
  await assert.rejects(harness.create('admin'), /INVALID_ROLE|NO_PERMISSION/);
  harness.setRole('admin');
  await assert.rejects(harness.create('admin'), /INVALID_ROLE/);
});

test('新普通邀请无期限和人数上限，旧客户端传入限制参数也不改变结果', async function () {
  const harness = inviteCreateHarness();
  const result = await harness.create('member', 'full', { expiresInDays: 1, maxUses: 1 });
  const saved = harness.created.at(-1);
  assert.equal(saved.purpose, 'direct');
  assert.equal(saved.expiresAt, null);
  assert.equal(saved.maxUses, null);
  assert.equal(result.expiresAt, null);
  assert.equal(result.maxUses, null);
});

test('家谱和家庭页为所有已加入角色提供不越权的分享选择，且不显示关闭按钮', function () {
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return { globalData: { user: {} } }; };
  try {
    for (const file of ['miniprogram/pages/members/index.js', 'miniprogram/pages/tree/index.js']) {
      let definition;
      global.Page = function (value) { definition = value; };
      delete require.cache[require.resolve(path.join(root, file))];
      require(path.join(root, file));
      const page = Object.assign({}, definition);
      page.data = Object.assign({}, definition.data, { currentFamily: { _id: 'family-1' } });
      page.setData = function (patch, callback) {
        Object.assign(this.data, patch);
        if (callback) callback.call(this);
      };
      page.prepareShare = function () {};
      for (const [role, defaultRole] of [['admin', 'member'], ['member', 'member'], ['viewer', 'viewer']]) {
        page.data.currentRole = role;
        page.data.isAdmin = role === 'admin';
        page.openShareSheet();
        assert.equal(page.data.shareRole, defaultRole, file + ' ' + role);
        page.chooseShareRole({ currentTarget: { dataset: { role: 'member' } } });
        assert.equal(page.data.shareRole, role === 'viewer' ? 'viewer' : 'member');
      }
    }
  } finally {
    global.getApp = previousGetApp;
    global.Page = previousPage;
  }
  const membersTemplate = source('miniprogram/pages/members/index.wxml');
  const treeTemplate = source('miniprogram/pages/tree/index.wxml');
  assert.doesNotMatch(membersTemplate + treeTemplate, /关闭分享卡片/);
  assert.match(membersTemplate, /<button class="invite-button" bindtap="openShareSheet">邀请家人<\/button>/);
  assert.match(membersTemplate, /data-role="member" bindtap="chooseShareRole" wx:if="\{\{currentRole !== 'viewer'\}\}"/);
  assert.match(treeTemplate, /<view class="toolbar-share landscape-hidden" bindtap="startShare">分享<\/view>/);
  assert.match(treeTemplate, /<view class="action-cell action-cell-wide" bindtap="shareSelectedPerson">/);
  assert.match(treeTemplate, /data-role="member" bindtap="chooseShareRole" wx:if="\{\{currentRole !== 'viewer'\}\}"/);
  assert.match(membersTemplate, /class="sheet-mask" wx:if="\{\{showShareSheet\}\}" bindtap="closeShareSheet"/);
  assert.match(treeTemplate, /class="sheet-mask" wx:if="\{\{showShareSheet\}\}" bindtap="closeShareSheet"/);
});
