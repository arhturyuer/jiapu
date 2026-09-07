const crypto = require('crypto');

const PAYMENT_EVENTS = new Set([
  'xpay_goods_deliver_notify',
  'xpay_refund_notify'
]);

function text(value) {
  return String(value === undefined || value === null ? '' : value);
}

function eventName(event) {
  return text(event && (event.Event || event.event || event.eventType)).trim().toLowerCase();
}

function isSupportedPaymentEvent(event) {
  return PAYMENT_EVENTS.has(eventName(event));
}

function normalizePayload(source) {
  const item = source || {};
  const payInfo = item.WeChatPayInfo || item.weChatPayInfo || item.PayInfo || item.payInfo || {};
  const goodsInfo = item.GoodsInfo || item.goodsInfo || {};
  return {
    event: eventName(item),
    openid: text(item.OpenId || item.openid),
    wxOrderId: text(item.MchOrderNo || payInfo.MchOrderNo || payInfo.mchOrderNo || item.wx_order_id || item.WxOrderId || item.wxOrderId),
    outTradeNo: text(item.out_trade_no || item.OutTradeNo || item.outTradeNo),
    productId: text(item.product_id || item.ProductId || item.productId || goodsInfo.ProductId || goodsInfo.productId),
    quantity: Number(item.Quantity || item.quantity || goodsInfo.Quantity || goodsInfo.quantity || 1),
    refundId: text(item.WxRefundId || item.wxRefundId || item.MchRefundId || item.mchRefundId || item.refund_id || item.RefundId || item.refundId)
  };
}

function payerUserId(openid) {
  return 'u_' + crypto.createHash('sha256').update(text(openid)).digest('hex').slice(0, 32);
}

function assertDeliveryMatchesOrder(order, payload) {
  if (!payload.wxOrderId || !payload.outTradeNo) throw new Error('missing order identity');
  if (!order) throw new Error('order not found');
  if (payload.productId && payload.productId !== order.productId) throw new Error('product mismatch');
  if (payload.quantity !== 1) throw new Error('quantity mismatch');
  if (payload.openid && payerUserId(payload.openid) !== order.payerUserId) throw new Error('payer mismatch');
  if (order.wxOrderId && order.wxOrderId !== payload.wxOrderId) throw new Error('wx order mismatch');
  if (order.status === 'fulfilled') return { duplicate: true };
  if (order.status !== 'pending' && !(order.status === 'closed' && order.closeReason === 'payment_timeout')) throw new Error('order is final');
  return { duplicate: false };
}

function assertRefundMatchesOrder(order, payload) {
  if (!payload.wxOrderId) throw new Error('missing wx order id');
  if (!order) throw new Error('order not found');
  if (payload.outTradeNo && payload.outTradeNo !== order._id) throw new Error('order mismatch');
  if (payload.productId && payload.productId !== order.productId) throw new Error('product mismatch');
  if (payload.openid && payerUserId(payload.openid) !== order.payerUserId) throw new Error('payer mismatch');
  if (order.wxOrderId && order.wxOrderId !== payload.wxOrderId) throw new Error('wx order mismatch');
  if (order.status === 'refunded') return { duplicate: true };
  if (order.status !== 'fulfilled') throw new Error('order is not refundable');
  return { duplicate: false };
}

function successResponse() { return { ErrCode: 0, ErrMsg: 'success' }; }
function failureResponse() { return { ErrCode: 1, ErrMsg: 'failed' }; }

module.exports = {
  PAYMENT_EVENTS: PAYMENT_EVENTS,
  text: text,
  eventName: eventName,
  isSupportedPaymentEvent: isSupportedPaymentEvent,
  normalizePayload: normalizePayload,
  payerUserId: payerUserId,
  assertDeliveryMatchesOrder: assertDeliveryMatchesOrder,
  assertRefundMatchesOrder: assertRefundMatchesOrder,
  successResponse: successResponse,
  failureResponse: failureResponse
};
