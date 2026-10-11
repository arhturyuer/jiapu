const launchAd = require('../../utils/launch-ad');
const app = getApp();
const api = require('../../utils/api');
const format = require('../../utils/format');
const recovery = require('../../utils/purchase-recovery');

function versionAtLeast(current, required) {
  const left = String(current || '').split('.').map(Number); const right = String(required).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] || 0; const b = right[index] || 0;
    if (a !== b) return a > b;
  }
  return true;
}
function priceText(cents) { return '¥' + (Number(cents || 0) / 100).toFixed(Number(cents) % 100 ? 2 : 0); }
function expiryText(membership) {
  if (!membership || !membership.active) return '当前为免费家庭';
  if (membership.lifetime) return '永久有效';
  return '有效至 ' + format.dateText(membership.expiresAt);
}
function orderPresentation(order) {
  const redemption = order.recordType === 'redemption';
  const status = order.status || 'pending';
  const labels = { pending: '待确认', fulfilled: '已开通', refunded: '已退款', failed: '未完成', closed: '已关闭' };
  const dates = {
    pending: { label: '创建于 ', value: order.createdAt },
    fulfilled: { label: '支付于 ', value: order.paidAt || order.fulfilledAt || order.createdAt },
    refunded: { label: '退款于 ', value: order.refundedAt || order.createdAt },
    failed: { label: '创建于 ', value: order.createdAt },
    closed: { label: '关闭于 ', value: order.updatedAt || order.createdAt }
  };
  const date = dates[status] || dates.pending;
  return Object.assign({}, order, {
    recordId: order.recordId || 'payment:' + order.orderId,
    recordType: redemption ? 'redemption' : 'payment',
    typeText: redemption ? '兑换码兑换' : '付费购买',
    statusText: redemption ? '已兑换' : labels[status] || '处理中',
    statusClass: status,
    priceText: redemption ? '—' : priceText(order.priceCents),
    timeText: (redemption ? '兑换于 ' : date.label) + (format.dateText(redemption ? order.redeemedAt : date.value) || '刚刚'),
    canRefresh: !redemption && (status === 'pending' || (status === 'closed' && order.closeReason === 'payment_timeout' && order.reconcileStatus !== 'closed_unpaid'))
  });
}
function orderConfirmationAction(paymentMode) { return paymentMode === 'mock' ? 'payment.getOrder' : 'payment.reconcileNow'; }
function clientPaymentResult(result) {
  const source = result && typeof result === 'object' ? result : {};
  const wxOrderId = source.wx_order_id || source.wxOrderId || source.mch_order_no || source.mchOrderNo || '';
  return {
    wxOrderId: /^[A-Za-z0-9_-]{8,80}$/.test(String(wxOrderId)) ? String(wxOrderId) : '',
    resultCode: Number.isFinite(Number(source.errCode)) ? Number(source.errCode) : 0,
    resultKeys: Object.keys(source).slice(0, 12)
  };
}

function mergeOrders(current, incoming) {
  const items = new Map((current || []).map(function (item) { return [item.recordId || 'payment:' + item.orderId, item]; }));
  (incoming || []).forEach(function (item) { const row = orderPresentation(item); items.set(row.recordId, row); });
  return Array.from(items.values()).sort(function (a, b) {
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime() || (a.recordId > b.recordId ? -1 : 1);
  });
}

Page(launchAd.wrap({
  data: {
    loading: true, pageError: '', families: [], familyIndex: -1, family: null, selectionError: '',
    products: [], selectedProductId: 'youpu_vip_365d', membership: null, membershipText: '',
    paying: false, paymentState: '', paymentMessage: '', paymentMode: 'mock',
    orders: [], unresolvedOrders: [], orderCursor: '', hasMoreOrders: false, recordsExpanded: false,
    loadingOrders: false, loadingMoreOrders: false, refreshingOrderId: '',
    statusReady: false, ordersReady: false, unresolvedReady: false, statusError: '', ordersError: '', recoveryError: '',
    canBuy: false, payLabel: '确认购买', termText: '支付确认后开始计时', recoveryPending: false,
    showPaymentRefresh: false, dockHeight: 0,
    redeemOpen: false, redeemCode: '', redeeming: false, redeemError: ''
  },
  onLoad: function (options) { this.initialFamilyId = options.familyId || ''; this._stopped = false; this._epoch = 0; this._resolvedOrderIds = new Set(); },
  onReady: function () { this.measureDock(); },
  onResize: function () { this.measureDock(); },
  measureDock: function () {
    if (typeof wx.createSelectorQuery !== 'function') return;
    const measure = () => {
      if (this._stopped) return;
      wx.createSelectorQuery().in(this).select('.purchase-dock').boundingClientRect(rect => {
        if (!this._stopped && rect && rect.height > 0 && Math.abs(rect.height - this.data.dockHeight) > 1) this.setData({ dockHeight: Math.ceil(rect.height) });
      }).exec();
    };
    if (typeof wx.nextTick === 'function') wx.nextTick(measure); else measure();
  },
  onShow: function () {
    this._stopped = false;
    if (typeof wx.setNavigationBarTitle === 'function') wx.setNavigationBarTitle({ title: '家庭会员' });
    const scope = recovery.scope(app);
    if (this._scope && this._scope !== scope) {
      this._loaded = false; this._operation = null;
      if (this._pollTimer) clearTimeout(this._pollTimer);
      this.setData({ families: [], familyIndex: -1, family: null, paying: false, canBuy: false });
    }
    this._scope = scope;
    if (this._operation && ['creating', 'paying'].includes(this._operation.phase)) return Promise.resolve();
    return !this._loaded ? this.loadPage() : this.refreshCurrentFamily(true);
  },
  onHide: function () { this.stopView(); },
  onUnload: function () { this.stopView(); },
  stopView: function () {
    this._stopped = true; this._epoch = (this._epoch || 0) + 1;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
  },
  selectedFamily: function () { return this.data.families[this.data.familyIndex]; },
  viewToken: function () { const family = this.selectedFamily(); return { epoch: this._epoch || 0, familyId: family && family._id, scope: recovery.scope(app) }; },
  isCurrent: function (token) {
    const family = this.selectedFamily();
    return !this._stopped && token.epoch === (this._epoch || 0) && family && family._id === token.familyId && token.scope === recovery.scope(app);
  },
  operationCurrent: function (context, token) { return this.isCurrent(token) && this._operation === context; },
  updatePurchase: function () {
    const product = this.data.products.find(item => item.productId === this.data.selectedProductId);
    const membership = this.data.membership;
    this.setData({
      canBuy: Boolean(this.data.family && product && this.data.statusReady && !this.data.paying && !this.data.redeeming && !(membership && membership.lifetime)),
      payLabel: this.data.isDesktop && this.data.paymentMode !== 'mock' ? '请在手机微信开通' : membership && membership.lifetime ? '已开通永久会员' : this.data.paying ? '正在处理订单' : !this.data.family ? '请选择家谱' : !this.data.statusReady ? (this.data.statusError ? '请重试读取权益' : '正在读取会员权益') : (membership && membership.active ? '续费家庭会员 ' : '开通家庭会员 ') + (product ? product.priceText : ''),
      termText: product && product.lifetime ? '家谱未永久删除且服务持续运营期间有效' : membership && membership.active ? '在现有有效期后继续累加' : '支付确认后开始计时'
    });
    this.measureDock();
  },
  loadPage: async function () {
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this.setData({ loading: true, pageError: '', canBuy: false });
    try {
      if (app.ensureLogin) await app.ensureLogin();
      const scope = recovery.scope(app);
      const results = await Promise.all([app.loadFamilyPages(false, { force: true }), api.call('membership.catalog')]);
      if (this._stopped || epoch !== this._epoch || scope !== recovery.scope(app)) return;
      this._scope = scope;
      const families = results[0].families || []; const catalog = results[1];
      const index = this.initialFamilyId ? families.findIndex(item => item._id === this.initialFamilyId) : (families.length ? 0 : -1);
      const titles = { youpu_vip_30d: '30 天', youpu_vip_365d: '1 年', youpu_vip_life: '永久' };
      const products = (catalog.products || []).map(item => Object.assign({}, item, { displayName: titles[item.productId] || item.name, priceText: priceText(item.priceCents) }));
      const selected = products.find(item => item.productId === this.data.selectedProductId) || products.find(item => item.recommended) || products[0];
      this.setData({ families, familyIndex: index, products, selectedProductId: selected ? selected.productId : '', paymentMode: catalog.paymentMode || 'mock', loading: false,
        selectionError: this.initialFamilyId && index < 0 ? '原家谱已无法购买，请重新选择家谱' : '' });
      this._loaded = true; this.resetFamily();
      await this.refreshCurrentFamily(true);
    } catch (error) {
      if (this._stopped || epoch !== this._epoch) return;
      this.setData({ loading: false, pageError: api.userMessage(error, '会员信息加载失败，请重新加载'), canBuy: false });
    }
  },
  resetFamily: function () {
    this._redeemContext = null;
    const family = this.selectedFamily();
    this._epoch = (this._epoch || 0) + 1;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._operation = family ? recovery.read(app, family._id) : null;
    this._orderId = this._operation && this._operation.orderId || '';
    this._resolvedOrderIds = new Set();
    this.setData({ family: family || null, membership: null, membershipText: '', statusReady: false, ordersReady: false, unresolvedReady: false,
      statusError: '', ordersError: '', recoveryError: '', orders: [], unresolvedOrders: [], orderCursor: '', hasMoreOrders: false, recordsExpanded: false,
      loadingOrders: false, loadingMoreOrders: false, refreshingOrderId: '', paying: false, showPaymentRefresh: false,
      paymentState: '', paymentMessage: '', recoveryPending: Boolean(this._operation), canBuy: false,
      redeemOpen: false, redeemCode: '', redeeming: false, redeemError: '' });
    this.updatePurchase();
  },
  loadStatus: async function (background) {
    const token = this.viewToken(); if (!token.familyId) return;
    const sequence = this._statusSequence = (this._statusSequence || 0) + 1;
    if (!background) this.setData({ statusReady: false, statusError: '' });
    this.updatePurchase();
    try {
      const data = await api.call('membership.status', { familyId: token.familyId });
      if (!this.isCurrent(token) || sequence !== this._statusSequence) return;
      this.setData({ family: data.family, membership: data.membership, membershipText: expiryText(data.membership), statusReady: data.canPurchase !== false || Boolean(data.membership && data.membership.lifetime),
        statusError: data.canPurchase === false && !(data.membership && data.membership.lifetime) ? '这份家谱当前无法购买，请重新选择' : '' });
    } catch (error) {
      if (this.isCurrent(token) && sequence === this._statusSequence) this.setData({ statusError: api.userMessage(error, '会员权益读取失败，请重试'), statusReady: background && this.data.statusReady });
    }
    if (this.isCurrent(token)) this.updatePurchase();
  },
  loadOrders: async function (reset) {
    const token = this.viewToken();
    if (!token.familyId || (!reset && (!this.data.hasMoreOrders || this.data.loadingMoreOrders))) return;
    const sequence = this._ordersSequence = (this._ordersSequence || 0) + 1;
    const revision = this._recordsRevision || 0;
    if (reset) this.setData({ loadingOrders: true, ordersReady: false, ordersError: '', orderCursor: '', hasMoreOrders: false });
    else this.setData({ loadingMoreOrders: true, ordersError: '' });
    try {
      const data = await api.call('membership.listRecords', { familyId: token.familyId, pageSize: 10, cursor: reset ? '' : this.data.orderCursor });
      if (!this.isCurrent(token) || sequence !== this._ordersSequence) return;
      let orders = mergeOrders(reset ? [] : this.data.orders, data.items).filter(item => ['fulfilled', 'refunded'].includes(item.status));
      if (revision !== (this._recordsRevision || 0)) orders = mergeOrders(orders, this.data.orders);
      this.setData({ orders, orderCursor: data.nextCursor || '', hasMoreOrders: Boolean(data.hasMore), ordersReady: true });
    } catch (error) {
      if (this.isCurrent(token) && sequence === this._ordersSequence) this.setData({ ordersError: api.userMessage(error, '会员记录读取失败，请重试'), ordersReady: false });
    } finally {
      if (this.isCurrent(token) && sequence === this._ordersSequence) this.setData({ loadingOrders: false, loadingMoreOrders: false });
    }
  },
  loadUnresolved: async function () {
    const token = this.viewToken(); if (!token.familyId) return;
    this.setData({ unresolvedReady: false, recoveryError: '' });
    let cursor = ''; let items = []; const visited = new Set();
    try {
      do {
        if (visited.has(cursor)) throw new Error('invalid order cursor');
        visited.add(cursor);
        const data = await api.call('payment.listMine', { familyId: token.familyId, pageSize: 50, cursor, unresolvedOnly: true });
        if (!this.isCurrent(token)) return;
        items = mergeOrders(items, data.items).filter(item => item.canRefresh);
        cursor = data.hasMore ? data.nextCursor : '';
        if (data.hasMore && !cursor) throw new Error('missing order cursor');
      } while (cursor);
      this.setData({ unresolvedOrders: mergeOrders(items, this.data.unresolvedOrders).filter(item => item.canRefresh && !this._resolvedOrderIds.has(item.orderId)), unresolvedReady: true });
    } catch (error) {
      if (this.isCurrent(token)) this.setData({ recoveryError: api.userMessage(error, '后台支付状态同步暂未完成'), unresolvedReady: false });
    }
  },
  refreshCurrentFamily: async function (checkPending) {
    this._epoch = (this._epoch || 0) + 1;
    const token = this.viewToken(); if (!token.familyId) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this.setData({ paying: false, redeeming: false, refreshingOrderId: '' });
    // History and reconciliation do not gate the purchase button.
    const records = this.loadOrders(true);
    const pending = this.loadUnresolved().then(() => {
      if (checkPending && this.isCurrent(token)) return this.reconcileBackground(token);
    });
    await this.loadStatus();
    await Promise.all([records, pending]);
  },
  reconcileBackground: async function (token) {
    const contexts = recovery.readAll(app, token.familyId);
    const known = new Set(contexts.map(context => context.orderId).filter(Boolean));
    const queue = contexts.map(context => ({ context, orderId: context.orderId, returnedSuccess: context.clientOutcome === 'success' || this.data.unresolvedOrders.some(order => order.orderId === context.orderId && order.clientPaymentReturnedSuccess) }));
    this.data.unresolvedOrders.forEach(order => {
      if (!known.has(order.orderId)) queue.push({ orderId: order.orderId, returnedSuccess: Boolean(order.clientPaymentReturnedSuccess) });
    });
    queue.sort((a, b) => Number(b.returnedSuccess) - Number(a.returnedSuccess));
    for (const item of queue.slice(0, 6)) {
      if (!this.isCurrent(token) || this.data.paying) return;
      if (item.orderId) await this.refreshOrderById(item.orderId, true);
      else await this.recoverCreation(item.context, true);
    }
  },
  retryFamily: function () { return this.refreshCurrentFamily(true); },
  retryOrders: function () { return this.loadOrders(true); },
  toggleRecords: function () { this.setData({ recordsExpanded: !this.data.recordsExpanded }); },
  acceptOrder: async function (raw, token, feedbackContext) {
    if (!raw || !this.isCurrent(token) || raw.familyId !== token.familyId) return;
    const order = orderPresentation(raw);
    const local = recovery.readAll(app, token.familyId).find(item => item.orderId === order.orderId);
    if (!order.canRefresh) {
      this._resolvedOrderIds.add(order.orderId);
      if (local) recovery.clear(app, local);
    }
    const paid = ['fulfilled', 'refunded'].includes(order.status);
    const patch = { unresolvedOrders: mergeOrders(this.data.unresolvedOrders, [order]).filter(item => item.canRefresh && !this._resolvedOrderIds.has(item.orderId)), recoveryPending: recovery.readAll(app, token.familyId).length > 0 };
    if (paid) {
      this._recordsRevision = (this._recordsRevision || 0) + 1;
      patch.orders = mergeOrders(this.data.orders, [order]);
      if (order.status === 'fulfilled') patch.recordsExpanded = true;
    }
    // Only the tracked purchase may write its feedback. Old orders can still update shared entitlement.
    const own = this._operation && this._operation.orderId === order.orderId && (!feedbackContext || feedbackContext === this._operation);
    if (own) {
      const cancelled = this._operation.clientOutcome === 'cancelled';
      patch.showPaymentRefresh = order.canRefresh && !cancelled && order.reconcileStatus !== 'not_paid';
      patch.paymentState = order.status === 'fulfilled' ? 'success' : order.canRefresh && !cancelled && order.reconcileStatus !== 'not_paid' ? 'confirming' : 'failed';
      patch.paymentMessage = order.status === 'fulfilled' ? '会员已开通，全体家人共享权益' : order.status === 'refunded' ? '订单已退款，权益已更新' : cancelled ? '已取消本次支付，可重新购买' : order.reconcileStatus === 'not_paid' || !order.canRefresh ? '本次购买未完成，可重新购买' : '支付状态正在确认，可刷新查看';
      if (!order.canRefresh) this._operation.phase = 'done';
    }
    this.setData(patch); this.updatePurchase();
    if (paid) { app.invalidateFamilyData(token.familyId); await this.loadStatus(true); }
    return order;
  },
  refreshOrderById: async function (orderId, automatic) {
    if (!orderId || !automatic && (this.data.paying || this.data.refreshingOrderId)) return;
    const token = this.viewToken(); const context = this._operation;
    if (!automatic) this.setData({ refreshingOrderId: orderId });
    try {
      const data = await api.call(orderConfirmationAction(this.data.paymentMode), { orderId });
      return await this.acceptOrder(data.order, token, context);
    } catch (error) {
      if (this.isCurrent(token) && this._operation === context && context && context.orderId === orderId && context.clientOutcome !== 'cancelled') {
        this.setData({ paymentState: 'confirming', paymentMessage: '支付状态暂未同步，可刷新或联系客服', showPaymentRefresh: true });
      }
    } finally {
      if (!automatic && this.isCurrent(token)) this.setData({ refreshingOrderId: '' });
    }
  },
  refreshPendingOrder: function (event) { return this.refreshOrderById(event.currentTarget.dataset.id, false); },
  refreshPayment: function () {
    if (this.data.paying) return Promise.resolve();
    const uncertainPaid = this.data.unresolvedOrders.find(item => item.clientPaymentReturnedSuccess && item.reconcileStatus !== 'not_paid');
    const paidContext = recovery.readAll(app, this.viewToken().familyId).find(item => item.clientOutcome === 'success' && !this._resolvedOrderIds.has(item.orderId) && !this.data.unresolvedOrders.some(order => order.orderId === item.orderId && order.reconcileStatus === 'not_paid'));
    if (uncertainPaid) return this.refreshOrderById(uncertainPaid.orderId, false);
    if (paidContext) return paidContext.orderId ? this.refreshOrderById(paidContext.orderId, false) : this.recoverCreation(paidContext, false);
    if (this._operation && this._operation.phase !== 'done') {
      return this._operation.orderId ? this.refreshOrderById(this._operation.orderId, false) : this.recoverCreation(this._operation, false);
    }
    return this.refreshCurrentFamily(true);
  },
  loadMoreOrders: function () { return this.loadOrders(false); },
  changeFamily: function (event) {
    if (this.data.paying || this.data.redeeming) return;
    const index = Number(event.detail && event.detail.value !== undefined ? event.detail.value : event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.families[index]) return;
    this.setData({ familyIndex: index, selectionError: '' }); this.resetFamily();
    return this.refreshCurrentFamily(true);
  },
  selectProduct: function (event) {
    if (this.data.paying || this.data.redeeming) return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.products.some(item => item.productId === id)) return;
    this.setData({ selectedProductId: id }); this.updatePurchase();
  },
  openRules: function () { wx.navigateTo({ url: '/pages/legal/index?type=membership' }); },
  createFamily: function () { wx.navigateTo({ url: '/pages/create-family/index' }); },
  copyOrder: function (event) { wx.setClipboardData({ data: event.currentTarget.dataset.id }); },
  openRedeem: function () {
    if (this.data.paying || this.data.redeeming || !this.data.family) return;
    this.setData({ redeemOpen: true, redeemError: '' });
  },
  closeRedeem: function () { if (!this.data.redeeming) this.setData({ redeemOpen: false }); },
  stopRedeemTap: function () {},
  inputRedeem: function (event) {
    if (this.data.redeeming) return;
    this.setData({ redeemCode: event.detail.value, redeemError: '' });
  },
  submitRedeem: async function () {
    if (this.data.redeeming || this.data.paying || !this.data.statusReady || !this.data.family) return;
    const code = this.data.redeemCode.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/.test(code)) { this.setData({ redeemError: '请输入完整的 16 位兑换码' }); return; }
    const token = this.viewToken(); if (!this.isCurrent(token)) return;
    if (this.data.membership && this.data.membership.active && !(this._redeemContext && this._redeemContext.code === code)) {
      this.setData({ redeemError: '仅免费或会员已到期的家谱可以兑换' }); return;
    }
    if (!this._redeemContext || this._redeemContext.code !== code || this._redeemContext.familyId !== token.familyId) {
      this._redeemContext = { code, familyId: token.familyId, requestId: api.requestId() };
    }
    const context = this._redeemContext;
    this.setData({ redeeming: true, redeemError: '' }); this.updatePurchase();
    try {
      const result = await api.call('membership.redeem', { familyId: token.familyId, code, idempotencyKey: context.requestId });
      if (!this.isCurrent(token) || this._redeemContext !== context) return;
      app.invalidateFamilyData(token.familyId);
      this._recordsRevision = (this._recordsRevision || 0) + 1;
      this.setData({ redeemOpen: false, redeemCode: '', recordsExpanded: true, orders: mergeOrders(this.data.orders, [result.record]),
        paymentState: 'success', paymentMessage: '兑换成功，全体家人共享会员权益' });
      this._redeemContext = null;
      await Promise.all([this.loadStatus(true), this.loadOrders(true)]);
    } catch (error) {
      if (!this.isCurrent(token) || this._redeemContext !== context) return;
      this.setData({ redeemError: api.userMessage(error, '兑换结果暂未确认，请保留兑换码并重试') });
      if (error.isBusinessError) this._redeemContext = null;
    } finally {
      if (this.isCurrent(token)) { this.setData({ redeeming: false }); this.updatePurchase(); }
    }
  },
  platformAllowed: function () {
    const system = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    if (this.data.isDesktop && this.data.paymentMode !== 'mock') {
      wx.showModal({ title: '请在手机微信开通', content: '电脑端购买尚未通过平台验证。请使用同一微信账号在手机打开有谱，选择当前家谱开通会员；此处可查看权益、付款记录或兑换会员。', showCancel: false });
      return false;
    }
    const isIos = String(system.platform).toLowerCase() === 'ios';
    if (this.data.paymentMode === 'sandbox' && isIos) {
      wx.showModal({ title: '测试环境提示', content: '当前测试方式仅支持 Android 真机完成购买流程验证，iPhone 不会发起扣款。', showCancel: false }); return false;
    }
    if (isIos && !versionAtLeast(system.version, '8.0.68')) {
      wx.showModal({ title: '请升级微信', content: 'iOS 微信 8.0.68 及以上版本才支持本次购买。', showCancel: false }); return false;
    }
    if (this.data.paymentMode !== 'mock' && typeof wx.requestVirtualPayment !== 'function') {
      wx.showModal({ title: '暂不支持购买', content: '请升级微信并使用真机打开后重试。', showCancel: false }); return false;
    }
    return true;
  },
  startPayment: async function () {
    if (this.data.redeeming || !this.data.canBuy || !this.platformAllowed()) return;
    const token = this.viewToken();
    if (!this.isCurrent(token)) return;
    const product = this.data.products.find(item => item.productId === this.data.selectedProductId);
    this.setData({ paying: true }); this.updatePurchase();
    const previousPaid = this.data.unresolvedOrders.some(item => item.clientPaymentReturnedSuccess && item.reconcileStatus !== 'not_paid') || recovery.readAll(app, token.familyId).some(item => item.clientOutcome === 'success' && !this._resolvedOrderIds.has(item.orderId) && !this.data.unresolvedOrders.some(order => order.orderId === item.orderId && order.reconcileStatus === 'not_paid'));
    if (previousPaid) {
      let result;
      try { result = await wx.showModal({ title: '上一笔付款正在确认', content: '继续购买可能再次扣款；两笔成功将按现有规则开通。', cancelText: '刷新状态', confirmText: '继续购买' }); }
      catch (error) { result = { confirm: false }; }
      if (!this.isCurrent(token)) return;
      if (!result.confirm) { this.setData({ paying: false }); this.updatePurchase(); return this.refreshPayment(); }
    }
    if (!this.isCurrent(token) || this.data.membership && this.data.membership.lifetime) { this.setData({ paying: false }); this.updatePurchase(); return; }
    const context = { scope: token.scope, familyId: token.familyId, productId: product.productId, amount: product.priceCents, requestId: api.requestId(), createdAt: Date.now(), orderId: '', phase: 'creating', clientOutcome: 'unknown' };
    if (!recovery.save(app, context, true)) {
      this.setData({ paying: false, paymentState: 'failed', paymentMessage: '无法保存购买信息，请稍后重试', showPaymentRefresh: false }); this.updatePurchase(); return;
    }
    this._operation = context; this._orderId = '';
    return this.createOrder(context, token, false);
  },
  repurchase: function () { return this.startPayment(); },
  recoverCreation: async function (context, background) {
    context = context || this._operation;
    if (!context || this.data.paying) return;
    const token = this.viewToken();
    if (!background) this.setData({ refreshingOrderId: context.requestId });
    try {
      const data = await api.call('payment.createOrder', { familyId: context.familyId, productId: context.productId, idempotencyKey: context.requestId, recoveryOnly: true });
      context.orderId = data.order.orderId; recovery.save(app, context);
      if (!this.isCurrent(token)) return;
      if (this._operation && this._operation.requestId === context.requestId) { this._operation.orderId = context.orderId; this._orderId = context.orderId; }
      await this.acceptOrder(data.order, token, this._operation);
      if (orderPresentation(data.order).canRefresh) await this.refreshOrderById(context.orderId, true);
    } catch (error) {
      if (this.isCurrent(token) && this._operation && this._operation.requestId === context.requestId) this.setData({ paymentState: 'confirming', paymentMessage: '购买状态暂未同步，可刷新或重新购买', showPaymentRefresh: true });
    } finally {
      if (!background && this.isCurrent(token)) this.setData({ refreshingOrderId: '' });
    }
  },
  resumeUncertain: function (context) {
    const token = this.viewToken();
    if (!this.operationCurrent(context, token) || token.familyId !== context.familyId) return;
    this.setData({ paying: false, recoveryPending: true, paymentState: 'confirming', paymentMessage: '购买状态暂未同步，可刷新或重新购买', showPaymentRefresh: true });
    this.updatePurchase();
  },
  createOrder: async function (context, token, recovering) {
    if (recovering) return this.recoverCreation(context, false);
    this.setData({ paying: true, recoveryPending: true, paymentState: 'creating', paymentMessage: '正在准备购买…', showPaymentRefresh: false }); this.updatePurchase();
    let dispatched = false;
    try {
      const login = await wx.login();
      if (!this.operationCurrent(context, token)) { context.phase = 'confirming'; this.resumeUncertain(context); return; }
      dispatched = true;
      const data = await api.call('payment.createOrder', { familyId: context.familyId, productId: context.productId, loginCode: login.code || '', idempotencyKey: context.requestId });
      context.orderId = data.order.orderId; context.phase = 'confirming'; recovery.save(app, context);
      if (!this.operationCurrent(context, token)) { this.resumeUncertain(context); return; }
      this._orderId = context.orderId;
      this.setData({ unresolvedOrders: mergeOrders(this.data.unresolvedOrders, [data.order]).filter(item => item.canRefresh) });
      if (!orderPresentation(data.order).canRefresh) { this.setData({ paying: false }); return await this.acceptOrder(data.order, token, context); }
      if (data.mock) { context.clientOutcome = 'success'; recovery.save(app, context); await api.call('payment.mockComplete', { orderId: context.orderId }); }
      else {
        context.phase = 'paying'; this.setData({ paymentState: 'paying', paymentMessage: '请在微信完成支付…' });
        const result = await wx.requestVirtualPayment(data.payData);
        context.clientOutcome = 'success'; context.phase = 'confirming'; recovery.save(app, context);
        await api.call('payment.clientCompleted', Object.assign({ orderId: context.orderId }, clientPaymentResult(result))).catch(function () {});
      }
      const current = this.viewToken();
      if (!this.operationCurrent(context, current) || current.familyId !== context.familyId || current.scope !== context.scope) return;
      this.setData({ paymentState: 'confirming', paymentMessage: '正在确认会员开通…' });
      return this.pollOrder(0);
    } catch (error) {
      context.phase = 'confirming';
      const rejected = error.isBusinessError && ['NO_FAMILY_ACCESS', 'NO_PERMISSION', 'FAMILY_NOT_FOUND', 'FAMILY_ARCHIVED', 'FAMILY_FROZEN', 'PAYMENT_PRODUCT_INVALID', 'MEMBERSHIP_ALREADY_LIFETIME', 'PAYMENT_MONTHLY_LIMIT', 'PAYMENT_NOT_CONFIGURED', 'PAYMENT_IDENTITY_MISMATCH'].includes(error.code);
      const cancelled = /cancel/i.test(String(error.errMsg || error.message || ''));
      if (cancelled) context.clientOutcome = 'cancelled';
      if (!dispatched || rejected) recovery.clear(app, context); else recovery.save(app, context);
      const current = this.viewToken();
      if (!this.operationCurrent(context, current) || current.familyId !== context.familyId || current.scope !== context.scope) return;
      this.setData({ paying: false, recoveryPending: dispatched && !rejected, paymentState: cancelled || rejected || !dispatched ? 'failed' : 'confirming',
        paymentMessage: cancelled ? '已取消本次支付，可重新购买' : api.userMessage(error, rejected || !dispatched ? '购买未完成，可重新购买' : '购买状态暂未同步，可刷新或重新购买'), showPaymentRefresh: !cancelled && dispatched && !rejected });
      this.updatePurchase();
    }
  },
  pollOrder: async function (attempt) {
    const context = this._operation; const token = this.viewToken();
    if (!context || !context.orderId || !this.isCurrent(token)) return;
    context.phase = 'polling'; this.setData({ paying: true }); this.updatePurchase();
    let order;
    try {
      const data = await api.call(orderConfirmationAction(this.data.paymentMode), { orderId: context.orderId });
      if (!this.operationCurrent(context, token)) return;
      order = await this.acceptOrder(data.order, token, context);
    } catch (error) { /* Continue checking this order, without starting another payment. */ }
    if (!this.operationCurrent(context, token)) return;
    if (order && (!order.canRefresh || ['query_not_found', 'query_failed', 'not_paid'].includes(order.reconcileStatus)) || attempt >= 5) {
      context.phase = order && !order.canRefresh ? 'done' : 'confirming';
      this.setData({ paying: false });
      if (!order) this.setData({ paymentState: 'confirming', paymentMessage: '支付状态暂未同步，可刷新查看', showPaymentRefresh: true });
      this.updatePurchase(); return;
    }
    this._pollTimer = setTimeout(() => this.pollOrder(attempt + 1), Math.min(6000, 900 + attempt * 700));
  }
}));
