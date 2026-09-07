const test = require('node:test');
const assert = require('node:assert/strict');

function loadPage(app) {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return app; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/membership/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  return definition;
}

function createPage(definition) {
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data);
  page.setData = function (patch, callback) {
    Object.assign(page.data, patch);
    if (callback) callback();
  };
  return page;
}

function installWx() {
  const previousWx = global.wx;
  const notices = [];
  global.wx = { showToast: function (options) { notices.push(options.title); } };
  return {
    notices: notices,
    restore: function () { global.wx = previousWx; }
  };
}

function order(status) {
  return {
    orderId: 'order-1', familyId: 'family-1', productId: 'youpu_vip_365d',
    productName: '有谱家庭会员 1 年', priceCents: 9800, status: status,
    createdAt: '2026-09-01T00:00:00Z', paidAt: status === 'fulfilled' ? '2026-09-01T00:02:00Z' : null
  };
}

test('会员页首次加载会读取当前家谱订单并自动确认最近待确认订单', async function () {
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const wxState = installWx();
  const invalidated = [];
  const calls = [];
  let statusCalls = 0;
  const app = {
    loadFamilyPages: function () { return Promise.resolve({ families: [{ _id: 'family-1', name: '赵氏家谱' }] }); },
    invalidateFamilyData: function (familyId) { invalidated.push(familyId); }
  };
  api.call = function (type, payload) {
    calls.push({ type: type, payload: payload });
    if (type === 'membership.catalog') return Promise.resolve({ products: [], paymentMode: 'mock' });
    if (type === 'membership.status') {
      statusCalls += 1;
      return Promise.resolve({ family: { _id: 'family-1', name: '赵氏家谱' }, membership: { active: statusCalls > 1, lifetime: false, expiresAt: '2027-09-01T00:00:00Z' } });
    }
    if (type === 'payment.listMine') return Promise.resolve({ items: [order(statusCalls > 1 ? 'fulfilled' : 'pending')], hasMore: false, nextCursor: '' });
    if (type === 'payment.getOrder') return Promise.resolve({ order: order('fulfilled') });
    throw new Error('unexpected action ' + type);
  };
  try {
    const page = createPage(loadPage(app));
    page.onLoad({ familyId: 'family-1' });
    await page.onShow();

    assert.deepEqual(calls.find(function (call) { return call.type === 'payment.listMine'; }).payload, { familyId: 'family-1', pageSize: 10, cursor: '' });
    assert.equal(calls.filter(function (call) { return call.type === 'payment.getOrder'; }).length, 1);
    assert.equal(page.data.orders[0].status, 'fulfilled');
    assert.equal(page.data.membership.active, true);
    assert.equal(page.data.paymentState, 'success');
    assert.deepEqual(invalidated, ['family-1']);
  } finally {
    api.call = previousCall;
    wxState.restore();
  }
});

test('待确认订单手动刷新会保留未完成状态，网络失败会给出反馈', async function () {
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const wxState = installWx();
  const app = { invalidateFamilyData: function () {} };
  const page = createPage(loadPage(app));
  page.setData({
    families: [{ _id: 'family-1', name: '赵氏家谱' }], familyIndex: 0,
    family: { _id: 'family-1' }, orders: [Object.assign(order('pending'), { canRefresh: true })]
  });
  try {
    api.call = function () { return Promise.resolve({ order: order('pending') }); };
    await page.refreshOrderById('order-1', false);
    assert.equal(page.data.orders[0].status, 'pending');
    assert.deepEqual(wxState.notices, ['订单仍在确认中，请稍后再试']);

    api.call = function () { return Promise.reject(new Error('网络异常')); };
    await page.refreshOrderById('order-1', false);
    assert.deepEqual(wxState.notices, ['订单仍在确认中，请稍后再试', '网络异常']);
    assert.equal(page.data.refreshingOrderId, '');
  } finally {
    api.call = previousCall;
    wxState.restore();
  }
});

test('沙箱待确认订单会主动调用服务端查单，而不是只读取本地订单', async function () {
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const wxState = installWx();
  const page = createPage(loadPage({ invalidateFamilyData: function () {} }));
  const calls = [];
  page.setData({
    paymentMode: 'sandbox', families: [{ _id: 'family-1', name: '赵氏家谱' }], familyIndex: 0,
    family: { _id: 'family-1' }, orders: [Object.assign(order('pending'), { canRefresh: true })]
  });
  try {
    api.call = function (type) {
      calls.push(type);
      return Promise.resolve({ order: order('pending') });
    };
    await page.refreshOrderById('order-1', false);
    assert.deepEqual(calls, ['payment.reconcileNow']);
  } finally {
    api.call = previousCall;
    wxState.restore();
  }
});

test('微信沙箱未找到订单时，会员页停止轮询并展示可操作的配置提示', async function () {
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const wxState = installWx();
  const page = createPage(loadPage({ invalidateFamilyData: function () {} }));
  page.setData({
    paymentMode: 'sandbox', families: [{ _id: 'family-1', name: '赵氏家谱' }], familyIndex: 0,
    family: { _id: 'family-1' }, paying: true
  });
  page._orderId = 'order-1';
  try {
    api.call = function () { return Promise.resolve({ order: Object.assign(order('pending'), {
      reconcileStatus: 'query_not_found', reconcileMessage: '微信沙箱未找到该订单，请核对配置'
    }) }); };
    await page.pollOrder(0);
    assert.equal(page.data.paying, false);
    assert.equal(page.data.paymentState, 'failed');
    assert.equal(page.data.paymentMessage, '微信沙箱未找到该订单，请核对配置');
  } finally {
    api.call = previousCall;
    wxState.restore();
  }
});

test('iOS 不会在 staging 沙箱创建虚拟支付订单，避免 Apple IAP 误走现网或留下待确认订单', function () {
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const previousWx = global.wx;
  let modal = null;
  global.wx = {
    getSystemInfoSync: function () { return { platform: 'ios', version: '8.0.68' }; },
    showModal: function (options) { modal = options; },
    showToast: function () {}
  };
  const page = createPage(loadPage({ invalidateFamilyData: function () {} }));
  page.setData({ paymentMode: 'sandbox', agreed: true, family: { _id: 'family-1' }, paying: false });
  try {
    api.call = function () { throw new Error('iOS 沙箱不应调用服务端创建订单'); };
    page.startPayment();
    assert.equal(page.data.paying, false);
    assert.equal(modal.title, '请使用 Android 完成沙箱验收');
    assert.match(modal.content, /不支持沙箱环境/);
  } finally {
    api.call = previousCall;
    global.wx = previousWx;
  }
});
