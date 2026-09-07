const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const protocol = require('./protocol');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function timingSafeEqual(left, right) {
  const a = Buffer.from(protocol.text(left)); const b = Buffer.from(protocol.text(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function addDays(time, days) { return new Date(time.getTime() + Math.max(0, Number(days) || 0) * 86400000); }

async function applyDelivery(payload) {
  const eventId = 'deliver_' + crypto.createHash('sha256').update(payload.wxOrderId).digest('hex').slice(0, 40);
  return db.runTransaction(async function (transaction) {
    let seen = null;
    try { seen = (await transaction.collection('payment_events').doc(eventId).get()).data; } catch (error) { /* new event */ }
    if (seen && seen.status === 'applied') return { duplicate: true, orderId: payload.outTradeNo };
    const orderResult = await transaction.collection('payment_orders').doc(payload.outTradeNo).get();
    const order = orderResult.data;
    const deliveryState = protocol.assertDeliveryMatchesOrder(order, payload);
    if (deliveryState.duplicate) return { duplicate: true, orderId: payload.outTradeNo };
    const familyResult = await transaction.collection('families').doc(order.familyId).get();
    const family = familyResult.data;
    if (!family || family.status === 'deleted') throw new Error('family unavailable');
    const paidAt = new Date();
    let startsAt = paidAt; let endsAt = null;
    if (!order.lifetime) {
      const oldExpiry = family.proExpiresAt ? new Date(family.proExpiresAt) : null;
      if (oldExpiry && oldExpiry.getTime() > startsAt.getTime()) startsAt = oldExpiry;
      endsAt = addDays(startsAt, order.durationDays);
    }
    await transaction.collection('membership_grants').doc('grant_' + order._id).set({ data: {
      familyId: order.familyId, orderId: order._id, productId: order.productId,
      durationDays: Number(order.durationDays) || 0, lifetime: Boolean(order.lifetime),
      startsAt: startsAt, endsAt: endsAt, paidAt: paidAt, status: 'active',
      createdAt: db.serverDate(), updatedAt: db.serverDate()
    } });
    await transaction.collection('families').doc(order.familyId).update({ data: {
      proLifetime: Boolean(family.proLifetime || order.lifetime),
      proExpiresAt: family.proLifetime || order.lifetime ? _.remove() : endsAt,
      proUpdatedAt: db.serverDate(), updatedAt: db.serverDate()
    } });
    await transaction.collection('payment_orders').doc(order._id).update({ data: {
      status: 'fulfilled', wxOrderId: payload.wxOrderId, paidAt: paidAt,
      closeReason: _.remove(), closedAt: _.remove(), fulfilledAt: db.serverDate(), updatedAt: db.serverDate()
    } });
    await transaction.collection('payment_events').doc(eventId).set({ data: {
      type: 'xpay_goods_deliver_notify', wxOrderId: payload.wxOrderId, orderId: order._id,
      familyId: order.familyId, status: 'applied', createdAt: db.serverDate()
    } });
    return { duplicate: false, orderId: order._id };
  });
}

async function applyRefund(payload) {
  const eventKey = payload.refundId || payload.wxOrderId;
  const eventId = 'refund_' + crypto.createHash('sha256').update(eventKey).digest('hex').slice(0, 40);
  let previewOrder = null;
  if (payload.outTradeNo) {
    try { previewOrder = (await db.collection('payment_orders').doc(payload.outTradeNo).get()).data; } catch (error) { /* fallback below */ }
  }
  if (!previewOrder) {
    const previewResult = await db.collection('payment_orders').where({ wxOrderId: payload.wxOrderId }).limit(1).get();
    previewOrder = previewResult.data && previewResult.data[0];
  }
  if (!previewOrder) throw new Error('order not found');
  const activeGrantResult = await db.collection('membership_grants').where({ familyId: previewOrder.familyId, status: 'active' }).limit(100).get();
  return db.runTransaction(async function (transaction) {
    let seen = null;
    try { seen = (await transaction.collection('payment_events').doc(eventId).get()).data; } catch (error) { /* new event */ }
    if (seen && seen.status === 'applied') return { duplicate: true, orderId: seen.orderId };
    const result = await transaction.collection('payment_orders').doc(previewOrder._id).get();
    const order = result.data;
    const refundState = protocol.assertRefundMatchesOrder(order, payload);
    if (refundState.duplicate) return { duplicate: true, orderId: order._id };
    const grantId = 'grant_' + order._id;
    await transaction.collection('membership_grants').doc(grantId).update({ data: { status: 'refunded', refundedAt: db.serverDate(), updatedAt: db.serverDate() } });
    const grants = (activeGrantResult.data || []).filter(function (item) { return item._id !== grantId; }).sort(function (a, b) { return new Date(a.paidAt || 0) - new Date(b.paidAt || 0); });
    const lifetime = grants.some(function (item) { return item.lifetime; });
    let cursor = null;
    grants.forEach(function (item) {
      if (item.lifetime) return;
      const paid = new Date(item.paidAt || item.createdAt || 0).getTime();
      cursor = cursor === null ? paid : Math.max(cursor, paid);
      cursor += Math.max(0, Number(item.durationDays) || 0) * 86400000;
    });
    await transaction.collection('families').doc(order.familyId).update({ data: {
      proLifetime: lifetime, proExpiresAt: lifetime || cursor === null ? _.remove() : new Date(cursor),
      proUpdatedAt: db.serverDate(), updatedAt: db.serverDate()
    } });
    await transaction.collection('payment_orders').doc(order._id).update({ data: { status: 'refunded', refundId: payload.refundId, refundedAt: db.serverDate(), updatedAt: db.serverDate() } });
    await transaction.collection('payment_events').doc(eventId).set({ data: {
      type: 'xpay_refund_notify', wxOrderId: payload.wxOrderId, refundId: payload.refundId,
      orderId: order._id, familyId: order.familyId, status: 'applied', createdAt: db.serverDate()
    } });
    return { duplicate: false, orderId: order._id };
  });
}

function isTrustedInternalInvocation(event) {
  const secret = protocol.text(process.env.VP_INTERNAL_NOTIFY_SECRET);
  return Boolean(secret && timingSafeEqual(protocol.text(event && event.internalSecret), secret));
}

exports.main = async function (event) {
  const request = event || {};
  try {
    const platformPush = protocol.isSupportedPaymentEvent(request);
    if (!platformPush && !isTrustedInternalInvocation(request)) throw new Error('untrusted payment notification');
    const payload = protocol.normalizePayload(request);
    if (payload.event === 'xpay_goods_deliver_notify') await applyDelivery(payload);
    else if (payload.event === 'xpay_refund_notify') await applyRefund(payload);
    else throw new Error('unsupported event');
    return protocol.successResponse();
  } catch (error) {
    console.error(JSON.stringify({ action: 'payment.notify', success: false, resultCode: error.code || 'NOTIFY_FAILED' }));
    return protocol.failureResponse();
  }
};
