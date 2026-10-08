// Temporary, secret-gated staging fixture. It never enters deployable business functions.
const cloud = require('wx-server-sdk');
const vm = require('node:vm');
const fs = require('node:fs');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
function check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
async function read(scope, name, id) { return (await scope.collection(name).doc(id).get()).data; }
exports.main = async event => {
  const actual = process.env.TCB_ENV || process.env.SCF_NAMESPACE;
  check(process.env.PROBE_ENV && actual === process.env.PROBE_ENV && actual !== 'cloud1-d5gs5yj4l283d9c6d' && event.secret === process.env.PROBE_SECRET && /^[a-f0-9]{12}$/.test(event.run), 'PROBE_UNAUTHORIZED');
  const prefix = 'mp_' + event.run; const actor = prefix + '_actor'; const familyId = prefix + '_family';
  const records = []; let cleaned = false;
  async function seed(name, id, data) { records.push([name, id]); await db.collection(name).doc(id).set({ data }); }
  const context = {
    db, _: db.command, getOpenid: () => actor, requireActiveUser: async () => { const user = await read(db, 'users', actor); check(user.status === 'active', 'ACCOUNT_UNAVAILABLE'); return user; },
    cleanText: value => String(value || ''), assert: (value, code) => check(value, code), idempotencyId: (openid, type, requestId) => prefix + '_' + requestId,
    maybeGet: async (scope, name, id) => { try { return await read(scope, name, id); } catch (error) { return null; } }, mustGet: read,
    code2Session: () => { throw new Error('PROBE_MUST_NOT_EXCHANGE_LOGIN'); },
    paymentAccessToken: async () => 'injected-unpaid-result', queryPaymentOrder: async () => ({ status: 0 }), isPaidPaymentResult: () => false,
    canReconcilePaymentOrder: order => order.status === 'pending' || order.status === 'closed' && order.closeReason === 'payment_timeout'
  };
  vm.runInNewContext(fs.readFileSync('./purchase-api.js', 'utf8'), context);
  let result; let failure;
  try {
    await seed('users', actor, { status: 'active', nickName: '会员验收虚构用户' });
    const base = { payerUserId: actor, familyId, productId: 'youpu_vip_365d', productName: '虚构会员验收', priceCents: 9800, paymentMode: 'sandbox', createdAt: new Date('2026-01-01'), status: 'pending' };
    for (let i = 0; i < 12; i += 1) await seed('payment_orders', prefix + '_recent' + i, { ...base, status: 'fulfilled', createdAt: new Date('2026-10-08') });
    for (let i = 0; i < 52; i += 1) await seed('payment_orders', prefix + '_pending' + String(i).padStart(2, '0'), base);
    await seed('payment_orders', prefix + '_timeout', { ...base, status: 'closed', closeReason: 'payment_timeout' });
    await seed('payment_orders', prefix + '_unpaid', { ...base, status: 'closed', closeReason: 'payment_timeout', reconcileStatus: 'closed_unpaid' });
    await seed('payment_orders', prefix + '_foreign', { ...base, payerUserId: prefix + '_other' });
    await seed('payment_orders', prefix + '_otherfamily', { ...base, familyId: prefix + '_otherfamily' });
    await seed('payment_orders', prefix + '_olderpaid', { ...base, status: 'fulfilled', paidAt: new Date('2026-01-02') });
    await seed('payment_orders', prefix + '_refund', { ...base, status: 'refunded', paidAt: new Date('2026-01-02'), refundedAt: new Date('2026-01-03') });
    await db.collection('payment_orders').doc(prefix + '_pending00').update({ data: { clientPaymentCompletedAt: new Date(), clientResultCode: 0 } });
    const ordinary = await context.paymentListMine({ familyId, pageSize: 10 });
    check(ordinary.items.length === 10 && ordinary.items.every(order => order.status === 'fulfilled'), 'PROBE_RECENT_HISTORY');
    const first = await context.paymentListMine({ familyId, unresolvedOnly: true, pageSize: 50 });
    const second = await context.paymentListMine({ familyId, unresolvedOnly: true, pageSize: 50, cursor: first.nextCursor });
    const all = first.items.concat(second.items);
    check(first.hasMore && !second.hasMore && all.length === 53 && new Set(all.map(order => order.orderId)).size === 53, 'PROBE_ALL_PENDING_PAGES');
    check(all.every(order => order.familyId === familyId && order.orderId !== prefix + '_unpaid' && !order.orderId.endsWith('_foreign')), 'PROBE_PENDING_SCOPE');
    const paidFirst = await context.paymentListMine({ familyId, paidOnly: true, pageSize: 10 });
    const paidSecond = await context.paymentListMine({ familyId, paidOnly: true, pageSize: 10, cursor: paidFirst.nextCursor });
    const paid = paidFirst.items.concat(paidSecond.items);
    check(paidFirst.hasMore && !paidSecond.hasMore && paid.length === 14 && paid.every(order => ['fulfilled', 'refunded'].includes(order.status)), 'PROBE_PAID_PAGES');
    check(paid.some(order => order.orderId === prefix + '_olderpaid') && paid.some(order => order.status === 'refunded'), 'PROBE_OLDER_PAID_AND_REFUND');
    check(all.find(order => order.orderId === prefix + '_pending00').clientPaymentReturnedSuccess === true, 'PROBE_RETURNED_SUCCESS_MARKER');
    let filterConflict;
    try { await context.paymentListMine({ familyId, paidOnly: true, unresolvedOnly: true }); } catch (error) { filterConflict = error.code; }
    check(filterConflict === 'INVALID_INPUT', 'PROBE_FILTER_CONFLICT');
    const orderId = prefix + '_pending00';
    await seed('idempotency_records', prefix + '_request', { status: 'completed', actorId: actor, result: { order: { orderId }, payData: { signData: 'fixture-only' } } });
    const recovered = await context.paymentCreateOrder({ familyId, productId: base.productId, requestId: 'request', recoveryOnly: true });
    check(recovered.order.orderId === orderId, 'PROBE_REPLAY');
    for (const [data, code] of [[{ familyId: prefix + '_other' }, 'PAYMENT_REQUEST_MISMATCH'], [{ requestId: 'unknown' }, 'PAYMENT_CREATION_PENDING']]) {
      let actualCode;
      try { await context.paymentCreateOrder({ familyId, productId: base.productId, requestId: 'request', recoveryOnly: true, ...data }); } catch (error) { actualCode = error.code; }
      check(actualCode === code, 'PROBE_REPLAY_REJECTION');
    }
    await db.collection('payment_orders').doc(orderId).update({ data: { expiresAt: new Date(Date.now() - 1000), reconcileStatus: 'query_not_found' } });
    const reconciled = await context.paymentReconcileNow({ orderId });
    const stored = await read(db, 'payment_orders', orderId);
    check(reconciled.order.reconcileStatus === 'closed_unpaid' && stored.reconcileStatus === 'closed_unpaid', 'PROBE_RECONCILE_RESPONSE');
    result = { historyFirstPage: 10, paidPages: 2, paidCount: 14, olderPaidAndRefund: true, returnedSuccessMarker: true, filterConflictRejected: true, unresolvedPages: 2, unresolvedCount: 53, replay: true, mismatchRejected: true, recoveryDoesNotCreate: true, unpaidResponseMatchesStorage: true, externalPaymentResult: 'injected-unpaid' };
  } catch (error) { failure = error.code || error.message; }
  finally {
    for (const [name, id] of records.reverse()) await db.collection(name).doc(id).remove();
    cleaned = true;
  }
  return { success: !failure, data: result, code: failure || '', cleaned };
};
