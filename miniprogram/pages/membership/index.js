const launchAd = require('../../utils/launch-ad');
const app = getApp();
const api = require('../../utils/api');
const format = require('../../utils/format');

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
  return '有效至 ' + new Date(membership.expiresAt).toLocaleDateString();
}
function orderPresentation(order) {
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
    statusText: labels[status] || '处理中',
    statusClass: status,
    priceText: priceText(order.priceCents),
    timeText: date.label + (format.dateText(date.value) || '刚刚'),
    canRefresh: status === 'pending' || (status === 'closed' && order.closeReason === 'payment_timeout')
  });
}
function decorateOrders(items) { return (items || []).map(orderPresentation); }
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

Page(launchAd.wrap({
  data: { loading: true, families: [], familyIndex: 0, family: null, products: [], selectedProductId: 'youpu_vip_365d', membership: null, membershipText: '', agreed: false, paying: false, paymentState: '', paymentMessage: '', paymentMode: 'mock', orders: [], orderCursor: '', hasMoreOrders: false, loadingOrders: false, loadingMoreOrders: false, refreshingOrderId: '' },
  onLoad: function (options) { this.initialFamilyId = options.familyId || ''; this._stopped = false; },
  onShow: function () {
    this._stopped = false;
    if (!this._loaded) return this.loadPage();
    return this.refreshCurrentFamily(true);
  },
  onUnload: function () { this._stopped = true; if (this._pollTimer) clearTimeout(this._pollTimer); },
  loadPage: function () {
    const self = this; this.setData({ loading: true });
    return Promise.all([app.loadFamilyPages(false), api.call('membership.catalog')]).then(function (results) {
      const families = results[0].families || []; const catalog = results[1];
      let index = families.findIndex(function (item) { return item._id === self.initialFamilyId; });
      if (index < 0) index = 0;
      const products = (catalog.products || []).map(function (item) { return Object.assign({}, item, { priceText: priceText(item.priceCents) }); });
      self.setData({ families: families, familyIndex: index, products: products, paymentMode: catalog.paymentMode || 'mock', loading: false });
      return self.refreshCurrentFamily(true).then(function () { self._loaded = true; });
    }).catch(function (error) { self.setData({ loading: false }); wx.showToast({ title: api.userMessage(error, '会员信息加载失败'), icon: 'none' }); });
  },
  loadStatus: function () {
    const self = this; const family = this.data.families[this.data.familyIndex];
    if (!family) return Promise.resolve();
    const familyId = family._id;
    return api.call('membership.status', { familyId: family._id }).then(function (data) {
      if (self._stopped || !self.data.families[self.data.familyIndex] || self.data.families[self.data.familyIndex]._id !== familyId) return;
      self.setData({ family: data.family, membership: data.membership, membershipText: expiryText(data.membership) });
    });
  },
  loadOrders: function (reset) {
    const self = this; const family = this.data.families[this.data.familyIndex];
    if (!family || (!reset && (!this.data.hasMoreOrders || this.data.loadingMoreOrders))) return Promise.resolve();
    const familyId = family._id;
    if (reset) this.setData({ loadingOrders: true, orderCursor: '', hasMoreOrders: false });
    else this.setData({ loadingMoreOrders: true });
    return api.call('payment.listMine', { familyId: familyId, pageSize: 10, cursor: reset ? '' : this.data.orderCursor }).then(function (data) {
      if (self._stopped || !self.data.families[self.data.familyIndex] || self.data.families[self.data.familyIndex]._id !== familyId) return;
      const next = decorateOrders(data.items);
      self.setData({
        orders: reset ? next : self.data.orders.concat(next),
        orderCursor: data.nextCursor || '',
        hasMoreOrders: Boolean(data.hasMore),
        loadingOrders: false,
        loadingMoreOrders: false
      });
    }).catch(function (error) {
      if (self._stopped || !self.data.families[self.data.familyIndex] || self.data.families[self.data.familyIndex]._id !== familyId) return;
      self.setData({ loadingOrders: false, loadingMoreOrders: false });
      throw error;
    });
  },
  refreshCurrentFamily: function (checkPending) {
    const self = this; const family = this.data.families[this.data.familyIndex];
    if (!family) return Promise.resolve();
    return Promise.all([this.loadStatus(), this.loadOrders(true)]).then(function () {
      if (checkPending) return self.refreshLatestPendingOrder();
    });
  },
  refreshLatestPendingOrder: function () {
    const order = this.data.orders.find(function (item) { return item.canRefresh; });
    return order ? this.refreshOrderById(order.orderId, true) : Promise.resolve();
  },
  refreshOrderById: function (orderId, automatic) {
    const self = this;
    if (!orderId || this.data.refreshingOrderId) return Promise.resolve();
    const family = this.data.families[this.data.familyIndex];
    const familyId = family && family._id;
    this.setData({ refreshingOrderId: orderId });
    return api.call(orderConfirmationAction(this.data.paymentMode), { orderId: orderId }).then(function (data) {
      const order = orderPresentation(data.order || {});
      if (self._stopped || !familyId || order.familyId !== familyId || !self.data.families[self.data.familyIndex] || self.data.families[self.data.familyIndex]._id !== familyId) {
        self.setData({ refreshingOrderId: '' });
        return order;
      }
      const updated = self.data.orders.map(function (item) { return item.orderId === order.orderId ? order : item; });
      self.setData({ orders: updated, refreshingOrderId: '' });
      if (order.status === 'fulfilled') {
        self.setData({ paymentState: 'success', paymentMessage: automatic ? '已确认订单，家庭会员现已开通' : '家庭会员已开通，全体家人现在都可使用会员权益' });
        app.invalidateFamilyData(familyId);
        return self.refreshCurrentFamily(false);
      }
      if (['refunded', 'failed', 'closed'].includes(order.status)) {
        self.setData({ paymentState: 'failed', paymentMessage: order.status === 'refunded' ? '该订单已退款，会员权益已按剩余订单更新' : '该订单未完成，请重新发起购买或联系客服查单' });
      } else if (order.reconcileStatus === 'query_not_found') {
        self.setData({ paymentState: 'confirming', paymentMessage: '订单暂未查询到结果，请确认微信购买流程已完成，稍后再刷新状态' });
      } else if (automatic) {
        self.setData({ paymentState: 'confirming', paymentMessage: '检测到一笔待确认订单，已刷新状态，暂未收到开通通知' });
      } else {
        wx.showToast({ title: '订单仍在确认中，请稍后再试', icon: 'none' });
      }
      return order;
    }).catch(function (error) {
      self.setData({ refreshingOrderId: '' });
      if (!automatic) wx.showToast({ title: api.userMessage(error, '订单状态刷新失败'), icon: 'none' });
    });
  },
  refreshPendingOrder: function (event) { return this.refreshOrderById(event.currentTarget.dataset.id, false); },
  loadMoreOrders: function () { return this.loadOrders(false).catch(function () {}); },
  changeFamily: function (event) {
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._orderId = '';
    this.setData({ familyIndex: Number(event.detail.value) || 0, paymentState: '', paymentMessage: '', refreshingOrderId: '' });
    this.refreshCurrentFamily(true).catch(function (error) { wx.showToast({ title: api.userMessage(error, '订单记录加载失败'), icon: 'none' }); });
  },
  selectProduct: function (event) { if (!this.data.paying) this.setData({ selectedProductId: event.currentTarget.dataset.id }); },
  toggleAgreement: function () { this.setData({ agreed: !this.data.agreed }); },
  openRules: function () { wx.navigateTo({ url: '/pages/legal/index?type=membership' }); },
  startPayment: function () {
    const self = this; const family = this.data.family;
    if (!family || this.data.paying) return;
    if (!this.data.agreed) { wx.showToast({ title: '请先阅读并同意会员与退款说明', icon: 'none' }); return; }
    const system = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    const isIos = String(system.platform).toLowerCase() === 'ios';
    if (this.data.paymentMode === 'sandbox' && isIos) {
      wx.showModal({ title: '测试环境提示', content: '当前测试方式仅支持 Android 真机完成购买流程验证，iPhone 不会发起扣款。', showCancel: false }); return;
    }
    if (isIos && !versionAtLeast(system.version, '8.0.68')) {
      wx.showModal({ title: '请升级微信', content: 'iOS 微信 8.0.68 及以上版本才支持本次购买。', showCancel: false }); return;
    }
    this.setData({ paying: true, paymentState: 'creating', paymentMessage: '正在创建安全订单…' });
    wx.login().then(function (login) {
      return api.call('payment.createOrder', { familyId: family._id, productId: self.data.selectedProductId, loginCode: login.code || '' });
    }).then(function (data) {
      self._orderId = data.order.orderId;
      if (data.mock) {
        self.setData({ paymentState: 'confirming', paymentMessage: '测试订单正在确认，请稍候…' });
        return api.call('payment.mockComplete', { orderId: self._orderId });
      }
      if (typeof wx.requestVirtualPayment !== 'function') {
        const unsupported = new Error('payment capability unavailable');
        unsupported.code = 'PAYMENT_NOT_CONFIGURED';
        throw unsupported;
      }
      self.setData({ paymentState: 'paying', paymentMessage: '请在微信支付页面完成购买…' });
      return wx.requestVirtualPayment(data.payData).then(function (result) {
        // Keep only a small, non-sensitive callback trace. If WeChat supplies
        // its order id, server reconciliation can use it as a second lookup key.
        return api.call('payment.clientCompleted', Object.assign({ orderId: self._orderId }, clientPaymentResult(result))).catch(function () { return null; });
      });
    }).then(function () {
      self.setData({ paymentState: 'confirming', paymentMessage: '支付完成，正在核验支付状态…' });
      self.pollOrder(0);
    }).catch(function (error) {
      const cancelled = String(error.errMsg || error.message || '').toLowerCase().indexOf('cancel') >= 0;
      self.setData({ paying: false, paymentState: cancelled ? 'cancelled' : 'failed', paymentMessage: cancelled ? '已取消支付，未产生会员权益' : api.userMessage(error, '支付未完成，请稍后重试') });
    });
  },
  pollOrder: function (attempt) {
    const self = this;
    if (this._stopped || !this._orderId) return;
    api.call(orderConfirmationAction(this.data.paymentMode), { orderId: this._orderId }).then(function (data) {
      if (data.order.status === 'fulfilled') {
        self.setData({ paying: false, paymentState: 'success', paymentMessage: '家庭会员已开通，全体家人现在都可使用会员权益' });
        app.invalidateFamilyData(self.data.family._id); self.refreshCurrentFamily(false); return;
      }
      if (['refunded', 'failed', 'closed'].includes(data.order.status)) {
        self.setData({ paying: false, paymentState: 'failed', paymentMessage: '订单未完成，请重新发起或联系客服查单' }); return;
      }
      if (data.order.reconcileStatus === 'query_not_found') {
        self.setData({ paying: false, paymentState: 'confirming', paymentMessage: '订单暂未查询到结果，请确认微信购买流程已完成，稍后再刷新状态' }); return;
      }
      if (attempt >= 5) { self.setData({ paying: false, paymentState: 'confirming', paymentMessage: '订单仍在确认中，可稍后回到本页查看，请勿重复支付' }); return; }
      self._pollTimer = setTimeout(function () { self.pollOrder(attempt + 1); }, Math.min(6000, 900 + attempt * 700));
    }).catch(function () {
      if (attempt >= 5) self.setData({ paying: false, paymentState: 'confirming', paymentMessage: '网络不稳定，订单仍可能在确认，请稍后查看' });
      else self._pollTimer = setTimeout(function () { self.pollOrder(attempt + 1); }, 1800);
    });
  }
}));
