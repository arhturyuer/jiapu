require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domain = require('../cloudfunctions/youpuUserApi/domain');
const shareInvite = require('../miniprogram/utils/share-invite');

const root = path.resolve(__dirname, '..');
const manageSource = fs.readFileSync(path.join(root, 'miniprogram/pages/family-manage/index.js'), 'utf8');

function withStorage(run) {
  const previousWx = global.wx;
  const storage = {};
  global.wx = {
    getStorageSync: function (key) { return storage[key]; },
    setStorageSync: function (key, value) { storage[key] = value; }
  };
  try { return run(); } finally { global.wx = previousWx; }
}

test('新邀请卡可重复使用，旧邀请到期后从缓存移除，撤销只移除指定卡片', function () {
  withStorage(function () {
    const first = { ownerId: 'user-1', familyId: 'family-1', role: 'member', fingerprint: 'first' };
    const second = { ownerId: 'user-1', familyId: 'family-1', role: 'viewer', fingerprint: 'second' };
    const expired = { ownerId: 'user-1', familyId: 'family-1', role: 'viewer', fingerprint: 'expired' };
    const firstCard = { path: '/pages/invite/index?token=first', invitationId: 'invite-1' };
    const secondCard = { path: '/pages/invite/index?token=second', invitationId: 'invite-2' };
    shareInvite.set(first, firstCard, null);
    shareInvite.set(second, secondCard, null);
    shareInvite.set(expired, { path: '/pages/invite/index?token=expired', invitationId: 'invite-old' }, '2020-01-01');
    assert.equal(shareInvite.get(first), firstCard);
    assert.equal(shareInvite.get(expired), null);
    shareInvite.removeInvitation('invite-1');
    assert.equal(shareInvite.get(first), null);
    assert.equal(shareInvite.get(second), secondCard);
  });
});

test('新版邀请管理区分长期邀请、历史限次邀请和失效状态', function () {
  const context = {
    getApp: function () { return {}; },
    require: function (name) {
      if (name === '../../utils/launch-ad') return { wrap: function (definition) { return definition; } };
      if (name === '../../utils/format') return { roleText: function () { return '共同补全'; } };
      return {};
    },
    Page: function () {}
  };
  vm.runInNewContext(manageSource, context);
  const items = context.decorateInvitations([
    { purpose: 'direct', role: 'member', viewMode: 'full', displayStatus: 'active', expiresAt: null, maxUses: null, useCount: 51 },
    { purpose: 'direct', role: 'member', viewMode: 'full', displayStatus: 'active', expiresAt: '2099-01-01', maxUses: 50, useCount: 2 },
    { purpose: 'direct', role: 'member', viewMode: 'full', displayStatus: 'expired', expiresAt: '2020-01-01', maxUses: 50, useCount: 2 }
  ]);
  assert.equal(items[0].statusText, '长期有效');
  assert.equal(items[0].usageText, '已加入 51 人');
  assert.equal(items[1].statusText, '有效');
  assert.equal(items[1].usageText, '已使用 2/50');
  assert.equal(items[2].statusText, '已过期');
  assert.equal(domain.invitationState({ status: 'active', expiresAt: null, maxUses: null, useCount: 51 }), 'active');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.wxml'), 'utf8'), /分享卡片将在 30 天后失效/);
});

test('管理员撤销邀请后清理本机卡片', async function () {
  const previousWx = global.wx;
  const storage = {};
  const cacheKey = { ownerId: 'user-1', familyId: 'family-1', role: 'member' };
  global.wx = {
    getStorageSync: function (key) { return storage[key]; },
    setStorageSync: function (key, value) { storage[key] = value; },
    showModal: function () { return Promise.resolve({ confirm: true }); },
    showToast: function () {}
  };
  try {
    shareInvite.set(cacheKey, { path: '/pages/invite/index?token=first', invitationId: 'invite-1' }, null);
    let pageDefinition;
    let revokedId = '';
    const app = {
      invalidateCache: function () {},
      invalidateInvites: function () {}
    };
    vm.runInNewContext(manageSource, {
      getApp: function () { return app; },
      require: function (name) {
        if (name === '../../utils/launch-ad') return { wrap: function (definition) { return definition; } };
        if (name === '../../utils/share-invite') return shareInvite;
        if (name === '../../utils/api') return { call: function (action, event) { revokedId = event.invitationId; return Promise.resolve({ revoked: true }); } };
        return {};
      },
      Page: function (definition) { pageDefinition = definition; },
      wx: global.wx
    });
    const page = Object.assign({}, pageDefinition, { data: { familyId: 'family-1' }, loadPage: function () {} });
    page.revokeInvite({ currentTarget: { dataset: { id: 'invite-1' } } });
    await new Promise(function (resolve) { setImmediate(resolve); });
    assert.equal(revokedId, 'invite-1');
    assert.equal(shareInvite.get(cacheKey), null);
  } finally {
    global.wx = previousWx;
  }
});
