const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const notification = require('../cloudfunctions/youpuJobs/subscription-notification');

const root = path.resolve(__dirname, '..');
function source(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

test('两类模板缺失或字段重复时保持关闭', function () {
  assert.deepEqual(notification.templateConfig({}), { join: null, review: null });
  const config = notification.templateConfig({
    NOTIFY_JOIN_TEMPLATE_ID: 'join-template', NOTIFY_JOIN_MEMBER_KEY: 'thing1', NOTIFY_JOIN_TIME_KEY: 'time2',
    NOTIFY_REVIEW_TEMPLATE_ID: 'review-template', NOTIFY_REVIEW_SUBJECT_KEY: 'thing1', NOTIFY_REVIEW_DESCRIPTION_KEY: 'thing1'
  });
  assert.equal(config.join.templateId, 'join-template');
  assert.equal(config.review, null);
});

test('加入提醒去重分享者和管理员，待处理只发管理员', function () {
  const memberships = [
    { userId: 'sharer', role: 'admin', status: 'active' },
    { userId: 'other-admin', role: 'admin', status: 'active' },
    { userId: 'ordinary', role: 'member', status: 'active' },
    { userId: 'departed', role: 'admin', status: 'left' }
  ];
  assert.deepEqual(notification.recipients({ notificationType: 'join', inviterId: 'sharer' }, memberships), ['sharer', 'other-admin']);
  assert.deepEqual(notification.recipients({ notificationType: 'join', inviterId: 'ordinary' }, memberships), ['sharer', 'other-admin', 'ordinary']);
  assert.deepEqual(notification.recipients({ notificationType: 'review' }, memberships), ['sharer', 'other-admin']);
});

test('消息字段和跳转链接指向对应家谱及待处理页', function () {
  const family = { name: '测试家谱' };
  const joinTemplate = { templateId: 'join-template', memberKey: 'thing1', timeKey: 'time2' };
  const reviewTemplate = { templateId: 'review-template', subjectKey: 'thing1', descriptionKey: 'thing4' };
  const join = notification.messagePayload({ notificationType: 'join', familyId: 'f 1' }, family, { joinedAt: '2026-09-30T01:05:00.000Z' }, joinTemplate, { nickName: '新家人' }, 'developer');
  const review = notification.messagePayload({ notificationType: 'review', familyId: 'f 1' }, family, { title: '修改资料' }, reviewTemplate, {}, 'developer');
  assert.equal(join.page, 'pages/notification-entry/index?familyId=f%201');
  assert.equal(review.page, 'pages/change-list/index?familyId=f%201');
  assert.equal(join.miniprogramState, 'developer');
  assert.equal(join.data.thing1.value, '新家人');
  assert.equal(join.data.time2.value, '09:05');
  assert.equal(review.data.thing1.value, '测试家谱待审核');
  assert.equal(review.data.thing4.value, '修改资料');
});

test('业务事务记录通知事件，分享入口只在点击时请求订阅', function () {
  const api = source('cloudfunctions/youpuUserApi/index.js');
  const jobs = source('cloudfunctions/youpuJobs/index.js');
  assert.equal((api.match(/recordNotificationEvent\(transaction, 'review'/g) || []).length, 4);
  assert.match(api, /if \(!existing\) await recordNotificationEvent\(transaction, 'join'/);
  assert.match(api, /await sendNotificationEvent\(eventId\)/);
  assert.match(api, /cloud\.openapi\.subscribeMessage\.send\(payload\)/);
  assert.doesNotMatch(api, /dispatchJob\('task\.notification'/);
  assert.match(source('cloudfunctions/youpuUserApi/config.json'), /subscribeMessage\.send/);
  assert.match(jobs, /latestSource\.status !== 'pending'/);
  assert.match(jobs, /latestMembership\.role !== 'admin'/);
  assert.match(jobs, /subscribeMessage\.send\(payload\)/);
  assert.match(source('miniprogram/utils/subscribe-notifications.js'), /wx\.requestSubscribeMessage\(/);
});

test('客户端按身份订阅并如实处理拒绝和接口失败', async function () {
  const clientModule = { exports: {} };
  const sandbox = {
    module: clientModule,
    require: function () { return { call: function () { return Promise.resolve({}); } }; },
    wx: null,
    Promise: Promise,
    Date: Date
  };
  vm.runInNewContext(source('miniprogram/utils/subscribe-notifications.js'), sandbox);
  const subscribeClient = clientModule.exports;
  const templates = { joinTemplateId: 'join-template', reviewTemplateId: 'review-template' };
  let requested = [];
  sandbox.wx = { requestSubscribeMessage: function (options) {
    requested = options.tmplIds;
    options.success({ 'join-template': 'accept', 'review-template': 'reject' });
  } };
  const adminResult = await subscribeClient.request(templates, true);
  assert.equal(adminResult.accepted, 1);
  assert.equal(adminResult.requested, 2);
  assert.deepEqual(Array.from(requested), ['join-template', 'review-template']);
  const memberResult = await subscribeClient.request(templates, false);
  assert.equal(memberResult.accepted, 1);
  assert.equal(memberResult.requested, 1);
  assert.deepEqual(Array.from(requested), ['join-template']);
  sandbox.wx.requestSubscribeMessage = function (options) { options.fail({ errMsg: 'quota exhausted' }); };
  const failed = await subscribeClient.request(templates, true);
  assert.equal(failed.accepted, 0);
  assert.equal(failed.error.errMsg, 'quota exhausted');
});

test('家谱邀请卡返回后点遮罩关闭直接请求官方订阅，普通关闭和发现分享不请求', async function () {
  const clientApi = require('../miniprogram/utils/api');
  const subscriptions = require('../miniprogram/utils/subscribe-notifications');
  const originalCall = clientApi.call;
  const originalRequest = subscriptions.request;
  const originalShowResult = subscriptions.showResult;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  const requests = [];
  const resultToasts = [];
  const pages = [
    { file: '../miniprogram/pages/members/index', role: 'admin' },
    { file: '../miniprogram/pages/tree/index', role: 'member' }
  ];
  subscriptions.request = function (templates, isAdmin) {
    requests.push({ templates: templates, isAdmin: isAdmin });
    return Promise.resolve({ accepted: 1 });
  };
  subscriptions.showResult = function (result) { resultToasts.push(result); };
  clientApi.call = function () { return Promise.resolve({}); };
  global.getApp = function () { return { globalData: { user: {} } }; };
  try {
    for (const item of pages) {
      let definition;
      global.Page = function (value) { definition = value; };
      delete require.cache[require.resolve(item.file)];
      require(item.file);
      const page = Object.assign({}, definition);
      page.data = Object.assign({}, definition.data, {
        showShareSheet: true,
        shareCard: { title: '家谱邀请', path: '/pages/invite/index?token=t', imageUrl: '/card.jpg', invitationId: 'invite-1' },
        currentFamily: { _id: 'family-1' },
        currentRole: item.role,
        isAdmin: item.role === 'admin',
        notificationTemplates: { joinTemplateId: 'join-template' }
      });
      page.setData = function (patch) { Object.assign(this.data, patch); };

      page.closeShareSheet();
      assert.equal(requests.length, 0);
      page.data.showShareSheet = true;
      page.data.shareCard = { title: '家谱邀请', path: '/pages/invite/index?token=t', imageUrl: '/card.jpg', invitationId: 'invite-1' };
      const card = page.onShareAppMessage({ from: 'button', target: { dataset: {} } });
      assert.equal(card.path, '/pages/invite/index?token=t');
      assert.equal(requests.length, 0);
      page.closeShareSheet();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].isAdmin, item.role === 'admin');
      assert.equal(requests[0].templates.joinTemplateId, 'join-template');
      assert.equal(page.data.showShareSheet, false);
      await Promise.resolve();
      assert.equal(resultToasts.length, 0, '自动订阅即使被微信直接接受也不显示 toast');
      page.closeShareSheet();
      assert.equal(requests.length, 1);
      const discovery = page.onShareAppMessage({ from: 'menu' });
      assert.notEqual(discovery.path, card.path);
      page.closeShareSheet();
      assert.equal(requests.length, 1);
      if (item.role === 'admin') {
        page.requestNotifications();
        await Promise.resolve();
        assert.equal(resultToasts.length, 1, '手动提醒设置仍显示结果');
        resultToasts.length = 0;
      }
      requests.length = 0;
    }
    await Promise.resolve();
  } finally {
    clientApi.call = originalCall;
    subscriptions.request = originalRequest;
    subscriptions.showResult = originalShowResult;
    global.getApp = previousGetApp;
    global.Page = previousPage;
  }
});
