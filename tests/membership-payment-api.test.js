const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('cloudfunctions/youpuUserApi/index.js', 'utf8');
const commerce = require('../cloudfunctions/youpuUserApi/commerce');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
function check(value, code, message) { if (!value) throw Object.assign(new Error(message), { code }); }
function load(overrides = {}) {
  const context = {
    getOpenid: () => 'actor', requireActiveUser: async () => ({ _id: 'actor' }), cleanText: value => String(value || ''), idempotencyId: (actor, type, id) => id,
    assert: check, commerce, ACTIVE_ROLES: ['admin', 'member', 'viewer'],
    maybeGet: async () => null, mustGet: async () => { throw new Error('unexpected read'); }, requireMembership: async () => ({ family: { _id: 'A', name: '测试家谱' } }),
    code2Session: async () => ({ sessionKey: 'fake' }), process: { env: { PAYMENT_MODE: 'sandbox', VP_OFFER_ID: 'fake-offer', VP_APP_KEY: 'fake-key' } },
    listAll: async () => [], createTradeNumber: () => 'new-order', db: {}, _: { in: value => value, gte: value => value }, mutate: async () => { throw new Error('unexpected mutation'); }, ...overrides
  };
  vm.runInNewContext(extract('function publicOrder(', 'async function membershipCatalog(') + '\n' + extract('async function paymentCreateOrder(', 'async function fulfillOrderTransaction(') + '\n' + extract('async function paymentListMine(', 'function publicActivity(') + '\n' + extract('async function paymentReconcileNow(', 'async function paymentListMine('), context);
  return context;
}
function record(status = 'pending') { return { _id: 'existing-order', payerUserId: 'actor', familyId: 'A', productId: 'youpu_vip_365d', status, priceCents: 9800 }; }

test('已完成幂等请求先回读原订单，不消耗登录 code；原单已开通也可恢复', async () => {
  const h = load({ maybeGet: async () => ({ status: 'completed', result: { order: { orderId: 'existing-order' }, payData: { signData: 'original' } } }), mustGet: async () => record('fulfilled'), code2Session: () => { throw new Error('must not exchange code twice'); }, requireMembership: () => { throw new Error('must recover paid order before lifetime rejection'); } });
  const result = await h.paymentCreateOrder({ requestId: 'original-request', familyId: 'A', productId: 'youpu_vip_365d' });
  assert.equal(result.order.status, 'fulfilled'); assert.equal(result.order.orderId, 'existing-order'); assert.equal(result.payData.signData, 'original');
});

test('原请求回读校验付款人、家谱和商品；恢复未知请求不会新建订单', async () => {
  for (const patch of [{ payerUserId: 'other' }, { familyId: 'B' }, { productId: 'youpu_vip_30d' }]) {
    const h = load({ maybeGet: async () => ({ status: 'completed', result: { order: { orderId: 'existing-order' } } }), mustGet: async () => ({ ...record(), ...patch }) });
    await assert.rejects(h.paymentCreateOrder({ requestId: 'original', familyId: 'A', productId: 'youpu_vip_365d' }), error => ['NO_PERMISSION', 'PAYMENT_REQUEST_MISMATCH'].includes(error.code));
  }
  const h = load({ code2Session: () => { throw new Error('no exchange'); } });
  await assert.rejects(h.paymentCreateOrder({ requestId: 'unknown', familyId: 'A', productId: 'youpu_vip_365d', recoveryOnly: true }), error => error.code === 'PAYMENT_CREATION_PENDING');
});

test('新购买仍用服务端价格与事务幂等；事务回放不能返回另一商品', async () => {
  const writes = [];
  const transaction = { collection: () => ({ doc: () => ({ set: async value => writes.push(value.data) }) }) };
  const h = load({ db: { serverDate: () => new Date('2026-10-08') }, mutate: async (type, event, actor, callback) => callback(transaction) });
  const result = await h.paymentCreateOrder({ requestId: 'new', familyId: 'A', productId: 'youpu_vip_365d', loginCode: 'fake', priceCents: 1 });
  assert.equal(writes[0].priceCents, 9800); assert.equal(writes[0].paymentEnv, 1); assert.equal(result.order.orderId, 'new-order');
  h.mutate = async () => ({ order: { familyId: 'A', productId: 'youpu_vip_30d' } });
  await assert.rejects(h.paymentCreateOrder({ requestId: 'conflict', familyId: 'A', productId: 'youpu_vip_365d' }), error => error.code === 'PAYMENT_REQUEST_MISMATCH');
});

function command(op, values) { return { op, values }; }
function matches(row, query) {
  if (query.op === 'and') return query.values.every(value => matches(row, value));
  if (query.op === 'or') return query.values.some(value => matches(row, value));
  return Object.entries(query).every(([key, value]) => value && value.op === 'neq' ? row[key] !== value.values : value && value.op === 'in' ? value.values.includes(row[key]) : row[key] === value);
}
function database(rows) {
  let query; let offset = 0; let limit = 0;
  const chain = { where(value) { query = value; return this; }, orderBy() { return this; }, skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; }, async get() { return { data: rows.filter(row => matches(row, query)).slice(offset, offset + limit) }; } };
  return { collection: () => chain };
}

test('unresolvedOnly 按付款人与家谱过滤待确认项，兼容缺失查单字段并维持分页', async () => {
  const rows = [
    record(), { ...record('closed'), _id: 'timeout', closeReason: 'payment_timeout' },
    { ...record('closed'), _id: 'unpaid', closeReason: 'payment_timeout', reconcileStatus: 'closed_unpaid' },
    { ...record('fulfilled'), _id: 'paid' }, { ...record(), _id: 'other', payerUserId: 'another' }, { ...record(), _id: 'B', familyId: 'B' }
  ];
  const h = load({ db: database(rows), _: { and: value => command('and', value), or: value => command('or', value), neq: value => command('neq', value) } });
  const first = await h.paymentListMine({ familyId: 'A', unresolvedOnly: true, pageSize: 1 });
  assert.equal(first.items[0].orderId, 'existing-order'); assert.equal(first.hasMore, true); assert.equal(first.nextCursor, '1');
  const second = await h.paymentListMine({ familyId: 'A', unresolvedOnly: true, pageSize: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].orderId, 'timeout'); assert.equal(second.hasMore, false);
  const ordinary = await h.paymentListMine({ familyId: 'A' }); assert.equal(ordinary.items.length, 4);
});

test('查单未付款返回本次写入的状态，超时关闭不残留 query_not_found', async () => {
  for (const expired of [true, false]) {
    const latest = { ...record(), reconcileStatus: 'query_not_found', closeReason: 'stale', expiresAt: new Date(Date.now() + (expired ? -1000 : 100000)) };
    let updated;
    const db = { serverDate: () => new Date(), collection: () => ({ doc: () => ({ update: async ({ data }) => { updated = data; } }) }), runTransaction: async callback => callback(db) };
    const h = load({ db, mustGet: async () => ({ ...latest, paymentMode: 'sandbox' }), canReconcilePaymentOrder: () => true,
      paymentAccessToken: async () => 'fake', queryPaymentOrder: async () => ({}), isPaidPaymentResult: () => false });
    const result = await h.paymentReconcileNow({ orderId: 'existing-order' });
    assert.equal(result.order.reconcileStatus, expired ? 'closed_unpaid' : 'not_paid'); assert.equal(result.order.closeReason, expired ? 'payment_timeout' : ''); assert.equal(result.order.reconcileStatus, updated.reconcileStatus);
  }
});


test('paidOnly 服务端筛选成功与退款，历史未付款不占用分页，默认协议不变', async () => {
  const rows = Array.from({ length: 15 }, (_, index) => ({ ...record(), _id: 'unpaid-' + index }));
  rows.push(record('fulfilled'), { ...record('refunded'), _id: 'refund' }, { ...record('fulfilled'), _id: 'foreign', payerUserId: 'other' }, { ...record('fulfilled'), _id: 'B', familyId: 'B' });
  const h = load({ db: database(rows), _: { in: values => command('in', values) } });
  const first = await h.paymentListMine({ familyId: 'A', paidOnly: true, pageSize: 1 });
  assert.equal(first.items[0].status, 'fulfilled'); assert.equal(first.hasMore, true);
  const second = await h.paymentListMine({ familyId: 'A', paidOnly: true, pageSize: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].status, 'refunded'); assert.equal(second.hasMore, false);
  const ordinary = await h.paymentListMine({ familyId: 'A', pageSize: 50 }); assert.equal(ordinary.items.length, 17);
  await assert.rejects(h.paymentListMine({ paidOnly: true, unresolvedOnly: true }), error => error.code === 'INVALID_INPUT');
});

test('支付返回成功只读标记不表示已付款或已发货，旧订单默认 false', () => {
  const h = load();
  assert.equal(h.publicOrder(record()).clientPaymentReturnedSuccess, false);
  const pending = h.publicOrder({ ...record(), clientPaymentCompletedAt: new Date(), clientResultCode: 0 });
  assert.equal(pending.clientPaymentReturnedSuccess, true); assert.equal(pending.status, 'pending');
  assert.equal(h.publicOrder({ ...record(), clientPaymentCompletedAt: new Date(), clientResultCode: -1 }).clientPaymentReturnedSuccess, false);
  assert.equal(h.publicOrder({ ...record(), clientPaymentCompletedAt: new Date() }).clientPaymentReturnedSuccess, false);
});
