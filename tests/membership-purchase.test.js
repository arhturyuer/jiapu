require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const products = require('../cloudfunctions/youpuUserApi/commerce').catalog();

function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const storage = new Map(); const calls = []; const timers = new Map(); const invalidated = []; const notices = [];
  let nextId = 0; let nextTimer = 0; let definition;
  const env = { cloudEnv: 'fake-staging' };
  const families = [{ _id: 'A', name: '测试家谱 A' }, { _id: 'B', name: '测试家谱 B' }];
  const app = { globalData: { user: { _id: 'actor' } }, loadFamilyPages: async () => ({ families }), invalidateFamilyData: id => invalidated.push(id) };
  const wx = {
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
    getSystemInfoSync: () => ({ platform: 'android', version: '8.0.68' }), login: async () => ({ code: 'fake-code' }), requestVirtualPayment: async () => ({}),
    showModal: async () => ({ confirm: false }), showToast: value => notices.push(value.title), navigateTo: () => {}, setClipboardData: value => notices.push(value.data)
  };
  const api = { requestId: () => 'request-' + ++nextId, userMessage: (error, fallback) => fallback, call: async (type, payload) => {
    calls.push({ type, payload });
    if (type === 'membership.catalog') return { products, paymentMode: 'sandbox' };
    if (type === 'membership.status') return { family: families.find(f => f._id === payload.familyId), membership: { active: false, lifetime: false }, canPurchase: true };
    if (type === 'payment.listMine') return { items: [], hasMore: false };
    if (type === 'payment.createOrder') return { order: order('pending', payload.familyId, 'new-order'), payData: {} };
    if (type === 'payment.reconcileNow') return { order: order('pending', 'A', payload.orderId) };
    return {};
  } };
  const recoveryContext = { require: () => ({ resolveRuntimeEnvironment: () => ({ environment: env }) }), wx, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync('miniprogram/utils/purchase-recovery.js', 'utf8'), recoveryContext);
  const recovery = recoveryContext.module.exports;
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/membership/index.js', 'utf8'), {
    getApp: () => app, Page: value => { definition = value; }, wx,
    require: name => name.includes('launch-ad') ? { wrap: value => value } : name.includes('purchase-recovery') ? recovery : name.includes('format') ? { dateText: value => value ? '2026-10-08' : '' } : api,
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id)
  });
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.onLoad({ familyId: 'A' });
  return { page, app, api, wx, storage, calls, timers, invalidated, notices, recovery, env, families };
}
function order(status, familyId = 'A', orderId = 'order-1') { return { orderId, familyId, productId: 'youpu_vip_365d', productName: '有谱家庭会员 1 年', priceCents: 9800, status, createdAt: '2026-10-08T00:00:00Z', paymentMode: 'sandbox' }; }

 test('切谱清空旧权益与订单，请求乱序和 A→B→A 不会覆盖新结果', async () => {
  const h = harness(); await h.page.onShow();
  const a = deferred(); const b = deferred(); let requests = 0;
  const previous = h.api.call;
  h.api.call = (type, payload) => {
    if (type === 'membership.status' && ++requests < 3) return payload.familyId === 'B' ? b.promise : a.promise;
    return previous(type, payload);
  };
  const first = h.page.changeFamily({ detail: { value: 1 } });
  assert.equal(h.page.data.family._id, 'B'); assert.equal(h.page.data.membership, null); assert.equal(h.page.data.canBuy, false);
  await h.page.startPayment(); assert.equal(h.calls.some(c => c.type === 'payment.createOrder'), false);
  const second = h.page.changeFamily({ detail: { value: 0 } });
  const third = h.page.refreshCurrentFamily(false);
  await third;
  a.resolve({ family: h.families[0], membership: { active: true, lifetime: true } });
  b.resolve({ family: h.families[1], membership: { active: true, lifetime: true } });
  await Promise.all([first, second]);
  assert.equal(h.page.data.family._id, 'A'); assert.equal(h.page.data.membership.active, false);
});

test('无家谱、不可访问的指定家谱和整页加载失败均不会启用购买', async () => {
  for (const mode of ['empty', 'missing', 'error']) {
    const h = harness();
    if (mode === 'empty') h.app.loadFamilyPages = async () => ({ families: [] });
    if (mode === 'missing') h.page.initialFamilyId = 'unavailable';
    if (mode === 'error') h.app.loadFamilyPages = async () => { throw new Error('offline'); };
    await h.page.onShow(); assert.equal(h.page.data.canBuy, false);
    if (mode === 'missing') { assert.equal(h.page.data.family, null); assert.ok(h.page.data.selectionError); await h.page.changeFamily({ currentTarget: { dataset: { index: 0 } } }); assert.equal(h.page.data.family._id, 'A'); assert.equal(h.page.data.selectionError, ''); }
    if (mode === 'error') { assert.ok(h.page.data.pageError); h.app.loadFamilyPages = async () => ({ families: h.families }); await h.page.loadPage(); assert.equal(h.page.data.canBuy, true); }
  }
});

test('权益失败禁止购买，历史与后台核验失败不影响购买且可重试', async () => {
  for (const mode of ['status', 'history', 'pending']) {
    const h = harness(); const previous = h.api.call;
    h.api.call = (type, data) => {
      if (mode === 'status' && type === 'membership.status' || type === 'payment.listMine' && (mode === 'pending' ? data.unresolvedOnly : mode === 'history' && !data.unresolvedOnly)) return Promise.reject(new Error('offline'));
      return previous(type, data);
    };
    await h.page.onShow(); assert.equal(h.page.data.canBuy, mode !== 'status'); assert.ok(h.page.data.statusError || h.page.data.ordersError || h.page.data.recoveryError);
    h.api.call = previous; await h.page.retryFamily(); assert.equal(h.page.data.canBuy, true);
  }
});

test('待确认查询独立分页，历史第一页之外的订单不阻止新购买', async () => {
  const h = harness(); const previous = h.api.call; const pendingCalls = [];
  h.api.call = async (type, data) => {
    if (type === 'payment.listMine' && data.unresolvedOnly) {
      pendingCalls.push(data.cursor);
      return data.cursor ? { items: [order('pending', 'A', 'old-pending')], hasMore: false } : { items: [order('pending')], hasMore: true, nextCursor: '50' };
    }
    return previous(type, data);
  };
  await h.page.onShow(); assert.deepEqual(pendingCalls, ['', '50']);
  assert.equal(h.page.data.unresolvedOrders.length, 2); assert.equal(h.page.data.canBuy, true); assert.equal(h.page.data.orders.length, 0);
});

test('后台重复游标停止核验但不阻止购买', async () => {
  const h = harness(); const previous = h.api.call;
  h.api.call = async (type, data) => type === 'payment.listMine' && data.unresolvedOnly ? { items: [], hasMore: true, nextCursor: '50' } : previous(type, data);
  await h.page.onShow(); assert.equal(h.page.data.unresolvedReady, false); assert.ok(h.page.data.recoveryError); assert.equal(h.page.data.canBuy, true);
});

test('创建期间锁定家谱、商品和金额，未付款不入记录，取消后直接可购买', async () => {
  const h = harness(); await h.page.onShow();
  const created = deferred(); const paid = deferred(); const previous = h.api.call;
  h.api.call = (type, data) => type === 'payment.createOrder' ? created.promise : previous(type, data);
  h.wx.requestVirtualPayment = () => paid.promise;
  const payment = h.page.startPayment(); await flush();
  h.page.changeFamily({ detail: { value: 1 } }); h.page.selectProduct({ currentTarget: { dataset: { id: 'youpu_vip_30d' } } });
  assert.equal(h.page.data.family._id, 'A'); assert.equal(h.page._operation.productId, 'youpu_vip_365d'); assert.equal(h.page._operation.amount, 9800);
  created.resolve({ order: order('pending', 'A', 'new-order'), payData: {} }); await flush();
  assert.equal(h.page.data.orders.length, 0); assert.equal(h.page.data.unresolvedOrders[0].orderId, 'new-order');
  h.page.changeFamily({ detail: { value: 1 } }); assert.equal(h.page.data.family._id, 'A');
  paid.reject({ errMsg: 'requestVirtualPayment:fail cancel' }); await payment;
  assert.equal(h.page.data.paying, false); assert.equal(h.page.data.paymentState, 'failed'); assert.match(h.page.data.paymentMessage, /取消/);
  assert.equal(h.page.data.orders.length, 0); assert.equal(h.page.data.unresolvedOrders[0].status, 'pending'); assert.equal(h.page.data.canBuy, true);
});

test('最多六次自动查单，隐藏停止计时，返回恢复原单，离页迟到结果不更新', async () => {
  const h = harness(); await h.page.onShow();
  await h.page.startPayment();
  for (let i = 0; i < 5; i += 1) { const [id, run] = h.timers.entries().next().value; h.timers.delete(id); await run(); }
  assert.equal(h.calls.filter(c => c.type === 'payment.reconcileNow').length, 6); assert.equal(h.page.data.paying, false); assert.equal(h.timers.size, 0);
  await h.page.pollOrder(0); assert.equal(h.timers.size, 1);
  h.page.onHide(); assert.equal(h.timers.size, 0);
  await h.page.onShow(); assert.equal(h.page.data.paymentState, 'confirming'); assert.equal(h.page.data.paying, false);
  const result = deferred(); h.api.call = () => result.promise;
  const pending = h.page.refreshOrderById('new-order', false); h.page.onUnload();
  result.resolve({ order: order('fulfilled', 'A', 'new-order') }); await pending;
  assert.equal(h.page.data.paymentState, 'confirming'); assert.equal(h.invalidated.length, 0);
});

test('旧查单返回不能污染切换后的家谱，即使返回开通成功', async () => {
  const h = harness(); await h.page.onShow(); const pending = deferred();
  const previous = h.api.call;
  h.api.call = (type, data) => type === 'payment.reconcileNow' ? pending.promise : previous(type, data);
  h.page._operation = { ...h.page.viewToken(), requestId: 'original', productId: 'youpu_vip_365d', orderId: 'order-1', createdAt: Date.now() };
  const polling = h.page.pollOrder(0); h.page.onHide();
  h.page._stopped = false; h.page.setData({ paying: false });
  await h.page.changeFamily({ detail: { value: 1 } });
  pending.resolve({ order: order('fulfilled') }); await polling;
  assert.equal(h.page.data.family._id, 'B'); assert.equal(h.page.data.paymentState, ''); assert.deepEqual(h.invalidated, []);
});

test('创建超时保留原幂等标识，恢复只查单且不再次调用微信支付', async () => {
  const h = harness(); await h.page.onShow();
  const previous = h.api.call; const keys = []; let virtualCalls = 0;
  h.wx.requestVirtualPayment = async () => { virtualCalls += 1; return {}; };
  h.api.call = async (type, data) => {
    if (type === 'payment.createOrder') { keys.push(data); if (keys.length === 1) throw new Error('timeout'); return { order: order('pending'), payData: {} }; }
    return previous(type, data);
  };
  await h.page.startPayment(); assert.equal(h.storage.size, 1); assert.equal(h.page.data.canBuy, true);
  h.page._operation = null; h.page.resetFamily(); await h.page.refreshPayment();
  assert.equal(keys[0].idempotencyKey, keys[1].idempotencyKey); assert.equal(keys[1].recoveryOnly, true); assert.equal(virtualCalls, 0);
  const stored = [...h.storage.values()][0]; assert.equal(stored.length, 1); assert.deepEqual(Object.keys(stored[0]).sort(), ['clientOutcome', 'createdAt', 'familyId', 'orderId', 'productId', 'requestId', 'scope']);
});

test('隐藏后创建结果保存到原谱，返回不卡住且不自动发起支付', async () => {
  const h = harness(); await h.page.onShow();
  const created = deferred(); const previous = h.api.call; let virtualCalls = 0;
  h.api.call = (type, data) => type === 'payment.createOrder' ? created.promise : previous(type, data);
  h.wx.requestVirtualPayment = async () => { virtualCalls += 1; return {}; };
  const started = h.page.startPayment(); await flush(); h.page.onHide(); await h.page.onShow();
  created.resolve({ order: order('pending'), payData: {} }); await started;
  assert.equal(virtualCalls, 0); assert.equal(h.page.data.paying, false); assert.equal(h.page.data.recoveryPending, true);
  await h.page.onShow(); assert.equal(h.page.data.orders.length, 0); assert.equal(h.recovery.read(h.app, 'A').orderId, 'order-1');
});

test('原生支付隐藏后返回可以继续查询原订单', async () => {
  const h = harness(); await h.page.onShow();
  const native = deferred(); h.wx.requestVirtualPayment = () => native.promise;
  const payment = h.page.startPayment(); await flush(); h.page.onHide(); await h.page.onShow();
  native.resolve({}); await payment; assert.equal(h.page._operation.orderId, 'new-order'); assert.equal(h.timers.size, 1);
  h.page.onUnload();
});

test('仅已返回付款成功待确认时提示重购，旧单成功不覆盖新反馈或恢复记录', async () => {
  const h = harness(); await h.page.onShow();
  const apiCall = h.api.call; let created = 0;
  h.api.call = (type, data) => type === 'payment.createOrder' ? Promise.resolve({ order: order('pending', 'A', 'new-order-' + ++created), payData: {} }) : apiCall(type, data);
  await h.page.startPayment(); h.page.onHide(); await h.page.onShow();
  const original = h.page._operation.requestId;
  await h.page.repurchase(); assert.equal(h.page._operation.requestId, original); assert.equal(created, 1);
  h.wx.showModal = async () => ({ confirm: true });
  await h.page.repurchase(); assert.notEqual(h.page._operation.requestId, original); assert.equal(created, 2);
  h.page.onHide(); await h.page.onShow();
  const newer = h.page._operation.requestId; const feedback = h.page.data.paymentMessage;
  const previous = h.api.call;
  h.api.call = (type, data) => type === 'payment.reconcileNow' ? Promise.resolve({ order: order('fulfilled', 'A', data.orderId) }) : previous(type, data);
  await h.page.refreshOrderById('new-order-1', false);
  assert.equal(h.page._operation.requestId, newer); assert.equal(h.recovery.read(h.app, 'A').requestId, newer); assert.equal(h.page.data.paymentMessage, feedback); assert.equal(h.page.data.orders.length, 1); assert.equal(h.page.data.recordsExpanded, true);
  await h.page.refreshPayment(); assert.equal(h.page.data.paymentState, 'success'); assert.deepEqual(h.invalidated, ['A', 'A']); assert.equal(h.storage.size, 0);
});

test('恢复信息隔离环境、账户与家谱，旧结果不能覆盖或删除新请求', async () => {
  const h = harness(); const context = { scope: h.recovery.scope(h.app), familyId: 'A', requestId: 'old', productId: 'sku', orderId: 'order-1', createdAt: Date.now() };
  h.recovery.save(h.app, context); assert.equal(h.recovery.read(h.app, 'B'), null);
  h.app.globalData.user._id = 'another'; assert.equal(h.recovery.read(h.app, 'A'), null); assert.equal(h.recovery.save(h.app, context), false);
  h.app.globalData.user._id = 'actor'; h.env.cloudEnv = 'another-env'; assert.equal(h.recovery.read(h.app, 'A'), null);
  h.env.cloudEnv = 'fake-staging'; h.recovery.save(h.app, { ...context, requestId: 'new' }, true); h.recovery.clear(h.app, context);
  assert.equal(h.recovery.save(h.app, context), false, '旧创建结果不可覆盖新的恢复请求');
  assert.equal(h.recovery.read(h.app, 'A').requestId, 'new');
});

test('购买按钮显示服务端金额，免费、有效会员和永久会员状态准确', async () => {
  const h = harness(); await h.page.onShow(); assert.equal(h.page.data.payLabel, '开通家庭会员 ¥98'); assert.equal(h.page.data.termText, '支付确认后开始计时');
  h.page.setData({ membership: { active: true, lifetime: false } }); h.page.updatePurchase(); assert.equal(h.page.data.payLabel, '续费家庭会员 ¥98'); assert.equal(h.page.data.termText, '在现有有效期后继续累加');
  h.page.setData({ membership: { active: true, lifetime: true } }); h.page.updatePurchase(); assert.equal(h.page.data.canBuy, false);
  h.page.copyOrder({ currentTarget: { dataset: { id: 'order-copy' } } }); assert.ok(h.notices.includes('order-copy'));
  assert.match(fs.readFileSync('miniprogram/pages/membership/index.wxss', 'utf8'), /repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(fs.readFileSync('miniprogram/pages/membership/index.wxml', 'utf8'), /open-type="contact"/);
});

test('本地存储不可用时不发起订单；账号变化使旧结果失效并重载页面', async () => {
  const h = harness(); await h.page.onShow();
  h.wx.setStorageSync = () => { throw new Error('full'); };
  await h.page.startPayment(); assert.equal(h.calls.some(c => c.type === 'payment.createOrder'), false); assert.equal(h.page.data.paying, false);
  h.page._operation = { scope: h.recovery.scope(h.app), familyId: 'A', phase: 'creating' };
  h.app.globalData.user._id = 'new-account'; await h.page.onShow();
  assert.equal(h.page._operation, null); assert.equal(h.page.data.canBuy, true);
});

test('多次取消支付直接再次购买，恢复列表保留每个请求且不出现待付款记录', async () => {
  const h = harness(); await h.page.onShow(); let created = 0; let modals = 0;
  const previous = h.api.call;
  h.api.call = (type, data) => type === 'payment.createOrder' ? Promise.resolve({ order: order('pending', 'A', 'cancelled-' + ++created), payData: {} }) : previous(type, data);
  h.wx.requestVirtualPayment = async () => { throw { errMsg: 'requestVirtualPayment:fail cancel' }; };
  h.wx.showModal = async () => { modals += 1; return { confirm: true }; };
  for (let i = 0; i < 3; i += 1) { await h.page.startPayment(); assert.equal(h.page.data.canBuy, true); }
  const saved = h.recovery.readAll(h.app, 'A');
  assert.equal(created, 3); assert.equal(modals, 0); assert.equal(saved.length, 3);
  assert.equal(new Set(saved.map(item => item.requestId)).size, 3); assert.ok(saved.every(item => item.clientOutcome === 'cancelled'));
  assert.equal(h.page.data.orders.length, 0); assert.equal(h.page.data.recordsExpanded, false);
});

test('后台历史核验正在等待时可购买和切谱，迟到结果不能污染新操作', async () => {
  const h = harness(); const query = deferred(); const previous = h.api.call;
  h.api.call = (type, data) => type === 'payment.listMine' && data.unresolvedOnly && data.familyId === 'A' ? query.promise : previous(type, data);
  const loaded = h.page.onShow(); await flush();
  assert.equal(h.page.data.canBuy, true); assert.equal(h.page.data.unresolvedReady, false);
  await h.page.changeFamily({ detail: { value: 1 } });
  query.resolve({ items: [order('pending')], hasMore: false }); await loaded;
  assert.equal(h.page.data.family._id, 'B'); assert.equal(h.page.data.unresolvedOrders.length, 0);
  h.wx.requestVirtualPayment = async () => { throw { errMsg: 'cancel' }; };
  await h.page.startPayment(); assert.equal(h.page._operation.familyId, 'B');
});

test('服务端付款返回标记触发一次重购提示，刷新不新建、继续购买使用新请求', async () => {
  const h = harness(); const previous = h.api.call; let modals = 0;
  h.api.call = (type, data) => type === 'payment.listMine' && data.unresolvedOnly ? Promise.resolve({ items: [{ ...order('pending', 'A', 'reported'), clientPaymentReturnedSuccess: true }], hasMore: false }) : type === 'payment.reconcileNow' ? Promise.resolve({ order: { ...order('pending', 'A', data.orderId), clientPaymentReturnedSuccess: true } }) : previous(type, data);
  await h.page.onShow();
  h.wx.showModal = async options => { modals += 1; assert.equal(options.cancelText, '刷新状态'); return { confirm: false }; };
  await h.page.startPayment(); assert.equal(modals, 1); assert.equal(h.calls.filter(item => item.type === 'payment.createOrder').length, 0);
  h.wx.showModal = async () => { modals += 1; return { confirm: true }; };
  h.wx.requestVirtualPayment = async () => { throw { errMsg: 'cancel' }; };
  await h.page.startPayment(); assert.equal(modals, 2); assert.equal(h.calls.filter(item => item.type === 'payment.createOrder').length, 1);
});

test('微信成功但查明未付款不再要求确认重购', async () => {
  const h = harness(); await h.page.onShow(); const previous = h.api.call;
  h.api.call = (type, data) => type === 'payment.reconcileNow' ? Promise.resolve({ order: { ...order('pending', 'A', data.orderId), reconcileStatus: 'not_paid', clientPaymentReturnedSuccess: true } }) : previous(type, data);
  let modals = 0; h.wx.showModal = async () => { modals += 1; return { confirm: true }; };
  await h.page.startPayment(); assert.equal(h.timers.size, 0); assert.equal(h.page.data.canBuy, true);
  await h.page.startPayment(); assert.equal(modals, 0);
});

test('付款成功入记录并展开，退款仍保留记录，历史错误可独立重试', async () => {
  const h = harness(); await h.page.onShow(); const previous = h.api.call;
  h.api.call = (type, data) => type === 'payment.reconcileNow' ? Promise.resolve({ order: order('fulfilled', 'A', data.orderId) }) : previous(type, data);
  await h.page.startPayment(); assert.equal(h.page.data.orders.length, 1); assert.equal(h.page.data.recordsExpanded, true); assert.equal(h.page.data.paymentState, 'success');
  const token = h.page.viewToken(); await h.page.acceptOrder(order('refunded', 'A', 'new-order'), token);
  assert.equal(h.page.data.orders[0].statusText, '已退款'); assert.equal(h.storage.size, 0);
  h.page.toggleRecords(); assert.equal(h.page.data.recordsExpanded, false);
  h.api.call = (type, data) => type === 'payment.listMine' && data.paidOnly ? Promise.reject(new Error('offline')) : previous(type, data);
  await h.page.retryOrders(); assert.ok(h.page.data.ordersError); assert.equal(h.page.data.canBuy, true);
});

test('付款记录独立分页，退款和成功按订单 ID 合并且不混入未付款', async () => {
  const h = harness(); const previous = h.api.call; const cursors = [];
  h.api.call = (type, data) => {
    if (type === 'payment.listMine' && data.paidOnly) {
      cursors.push(data.cursor);
      return Promise.resolve(data.cursor ? { items: [order('refunded', 'A', 'older-paid')], hasMore: false } : { items: [order('fulfilled', 'A', 'recent-paid')], hasMore: true, nextCursor: '10' });
    }
    return previous(type, data);
  };
  await h.page.onShow(); await h.page.loadMoreOrders();
  assert.deepEqual(cursors, ['', '10']); assert.equal(h.page.data.orders.length, 2); assert.ok(h.page.data.orders.every(item => ['fulfilled', 'refunded'].includes(item.status)));
});

test('恢复列表兼容旧单条格式，更新旧请求不覆盖新请求且只清理指定项', () => {
  const h = harness(); const context = { scope: h.recovery.scope(h.app), familyId: 'A', requestId: 'legacy', productId: 'sku', orderId: '', createdAt: 1 };
  h.storage.set('youpu_purchase:' + context.scope + ':A', context);
  assert.equal(h.recovery.readAll(h.app, 'A').length, 1);
  h.recovery.save(h.app, { ...context, requestId: 'new', createdAt: 2 }, true);
  assert.equal(h.recovery.save(h.app, { ...context, orderId: 'late-order', clientOutcome: 'success' }), true);
  const saved = h.recovery.readAll(h.app, 'A'); assert.equal(saved.length, 2); assert.equal(saved[0].orderId, 'late-order'); assert.equal(saved[1].requestId, 'new');
  h.recovery.clear(h.app, context); assert.equal(h.recovery.read(h.app, 'A').requestId, 'new');
});

test('底栏按实测高度预留空间，尺寸变化重新测量，离页后测量回调不写入', async () => {
  const h = harness(); let callback; let height = 164;
  h.wx.nextTick = fn => fn(); h.wx.createSelectorQuery = () => ({ in() { return this; }, select(selector) { assert.equal(selector, '.purchase-dock'); return this; }, boundingClientRect(fn) { callback = fn; return this; }, exec() {} });
  await h.page.onShow(); callback({ height }); assert.equal(h.page.data.dockHeight, 164);
  h.page.onResize(); height = 220; callback({ height }); assert.equal(h.page.data.dockHeight, 220);
  h.page.onUnload(); callback({ height: 400 }); assert.equal(h.page.data.dockHeight, 220);
  const template = fs.readFileSync('miniprogram/pages/membership/index.wxml', 'utf8');
  assert.doesNotMatch(template, /pending-orders|toggleAgreement|确认未付款/); assert.match(template, /recordsExpanded/);
  assert.match(template, /开通会员表示同意/); assert.match(template, /dockHeight/);
});

test('被动查单限制每次六笔并优先成功返回项，防止历史查询耗尽购买请求额度', async () => {
  const h = harness(); const previous = h.api.call; const reconciled = []; let title;
  h.wx.setNavigationBarTitle = value => { title = value.title; };
  for (let i = 0; i < 8; i += 1) h.recovery.save(h.app, { scope: h.recovery.scope(h.app), familyId: 'A', requestId: 'cancelled-' + i, productId: 'youpu_vip_365d', orderId: 'pending-' + i, createdAt: i, clientOutcome: 'cancelled' }, true);
  h.api.call = (type, data) => {
    if (type === 'payment.listMine' && data.unresolvedOnly) return Promise.resolve({ items: Array.from({ length: 12 }, (_, index) => ({ ...order('pending', 'A', 'pending-' + index), clientPaymentReturnedSuccess: index === 11 })), hasMore: false });
    if (type === 'payment.reconcileNow') { reconciled.push(data.orderId); return Promise.resolve({ order: order('pending', 'A', data.orderId) }); }
    return previous(type, data);
  };
  await h.page.onShow(); assert.equal(reconciled.length, 6); assert.equal(reconciled[0], 'pending-11'); assert.equal(h.page.data.canBuy, true); assert.equal(title, '家庭会员');
});
