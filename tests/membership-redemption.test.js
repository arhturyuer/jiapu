const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createDatabase } = require('./helpers/membership-db');
const records = require('../cloudfunctions/youpuUserApi/membership-records');
const commerce = require('../cloudfunctions/youpuUserApi/commerce');
const userService = require('../cloudfunctions/youpuUserApi/membership-redemption');
const opsService = require('../cloudfunctions/youpuOpsApi/redemption-codes');

function check(condition, code, message) { if (!condition) throw Object.assign(new Error(message), { code }); }
function harness() {
  const db = createDatabase(); let actor = 'actor'; let role = 'super_admin';
  db.put('users', 'actor', { status: 'active' }); db.put('users', 'other', { status: 'active' });
  db.put('operators', 'op', { status: 'active', role: 'super_admin' });
  for (const id of ['A', 'B']) db.put('families', id, { name: '虚构家谱 ' + id, status: 'active' });
  const memberships = new Map(['actor:A', 'actor:B', 'other:A', 'other:B'].map(key => [key, 'viewer']));
  async function mutateFor(who, action, event, handler) {
    check(event.requestId, 'REQUEST_ID_REQUIRED');
    return db.runTransaction(async tx => {
      const key = who + ':' + action + ':' + event.requestId;
      const prior = (await tx.collection('idempotency_records').doc(key).get()).data;
      if (prior) return prior.result;
      const result = await handler(tx);
      await tx.collection('idempotency_records').doc(key).set({ data: { result } }); return result;
    });
  }
  const users = userService.createService({ db, assert: check, commerce, ACTIVE_ROLES: ['admin', 'member', 'viewer'],
    getOpenid: () => actor, requireActiveUser: async () => { const user = db.get('users', actor); check(user && user.status === 'active', 'ACCOUNT_UNAVAILABLE'); return user; },
    requireMembership: async (id, roles, scope) => {
      const family = (await scope.collection('families').doc(id).get()).data;
      check(family && family.status === 'active', 'FAMILY_UNAVAILABLE'); check(memberships.has(actor + ':' + id), 'NO_FAMILY_ACCESS');
      return { family, membership: { role: memberships.get(actor + ':' + id) } };
    },
    mutate: async (action, event, openid, handler) => mutateFor(openid, action, event, async tx => {
      const user = (await tx.collection('users').doc(openid).get()).data; check(user && user.status === 'active', 'ACCOUNT_UNAVAILABLE'); return handler(tx);
    }),
    maybeGet: async (scope, collection, id) => (await scope.collection(collection).doc(id).get()).data
  });
  const ops = opsService.createService({ db, assert: check,
    requireOperator: async (context, roles) => { check(roles.includes(role), 'NO_PERMISSION'); return { _id: 'op', role }; },
    opsMutate: async (operator, action, event, handler) => mutateFor(operator._id, action, event, handler),
    writeOpsAudit: async (scope, operator, action, objectType, objectId, reason, summary) => scope.collection('audit_logs').add({ data: { action, objectType, objectId, reason, summary } }),
    maybeGet: async (collection, id, scope = db) => (await scope.collection(collection).doc(id).get()).data
  });
  async function generate(productId = 'youpu_vip_30d', extra = {}) {
    const batch = await ops.generate({ productId, quantity: 1, requestId: 'generate-' + db.all('membership_codes').length, ...extra }, {});
    const codes = await ops.reveal({ batchId: batch.batchId }, {}); return { batch, code: codes.items[0].code, row: codes.items[0] };
  }
  return { db, users, ops, generate, memberships, setActor: value => { actor = value; }, setRole: value => { role = value; } };
}

test('兑换码随机格式、输入规范化和遮罩不泄露完整码', () => {
  const values = Array.from({ length: 2000 }, () => records.generateCode());
  assert.equal(new Set(values).size, values.length);
  assert.ok(values.every(records.validCode));
  const formatted = records.formatCode(values[0]); assert.match(formatted, /^\w{4}(-\w{4}){3}$/);
  assert.equal(records.normalizeCode(' ' + formatted.toLowerCase() + ' '), values[0]);
  assert.equal(records.validCode('IIIIIIIIIIIIIIII'), false);
});
for (const productId of ['youpu_vip_30d', 'youpu_vip_365d', 'youpu_vip_life']) {
  test(productId + ' 兑换从当前时点开始并写入一份权益', async () => {
    const h = harness(); const { code } = await h.generate(productId);
    h.db.put('families', 'A', { status: 'active', proExpiresAt: new Date(Date.now() - 1000) });
    const result = await h.users.redeem({ familyId: 'A', code: code.toLowerCase(), requestId: 'r1' });
    const product = commerce.product(productId); const grant = h.db.all('membership_grants')[0];
    assert.equal(h.db.all('membership_redemptions').length, 1); assert.equal(grant.recordType, 'redemption');
    assert.equal(grant.lifetime, product.lifetime); assert.equal(h.db.get('families', 'A').proRevision, 1);
    if (!product.lifetime) assert.equal(grant.endsAt - grant.startsAt, product.durationDays * 86400000);
    assert.equal(result.record.recordType, 'redemption'); assert.equal(result.record.priceCents, null);
    assert.equal(JSON.stringify(result).includes(code), false);
  });
}
test('有效会员、永久会员、无访问权限、异常账号及家谱状态均不消耗码', async () => {
  for (const mode of ['active', 'lifetime', 'access', 'frozen', 'pending_delete', 'archived']) {
    const h = harness(); const { code, row } = await h.generate();
    if (mode === 'active') h.db.put('families', 'A', { status: 'active', proExpiresAt: new Date(Date.now() + 86400000) });
    if (mode === 'lifetime') h.db.put('families', 'A', { status: 'active', proLifetime: true });
    if (mode === 'access') h.memberships.delete('actor:A');
    if (['frozen', 'pending_delete'].includes(mode)) h.db.put('users', 'actor', { status: mode });
    if (mode === 'archived') h.db.put('families', 'A', { status: 'archived' });
    await assert.rejects(h.users.redeem({ familyId: 'A', code, requestId: 'r1' }));
    assert.equal(h.db.get('membership_codes', row._id).status, 'unused'); assert.equal(h.db.all('membership_grants').length, 0);
  }
});
test('无效、已作废及截止时刻的码不能兑换', async () => {
  const h = harness(); const { code, row } = await h.generate();
  await assert.rejects(h.users.redeem({ familyId: 'A', code: 'INVALID', requestId: 'r' }), { code: 'REDEMPTION_CODE_INVALID' });
  h.db.put('membership_codes', row._id, { ...h.db.get('membership_codes', row._id), expiresAt: new Date(Date.now() - 1) });
  assert.equal(records.codeStatus({ status: 'unused', expiresAt: new Date(100) }, new Date(100)), 'expired');
  await assert.rejects(h.users.redeem({ familyId: 'A', code, requestId: 'r' }), { code: 'REDEMPTION_CODE_EXPIRED' });
  await h.ops.revoke({ codeId: row._id, requestId: 'revoke' }, {});
  await assert.rejects(h.users.redeem({ familyId: 'A', code, requestId: 'r' }), { code: 'REDEMPTION_CODE_REVOKED' });
});
test('相同请求和换请求重试均返回原结果，参数不匹配拒绝，另一用户不可领取', async () => {
  const h = harness(); const { code } = await h.generate(); const event = { familyId: 'A', code, requestId: 'r' };
  const first = await h.users.redeem(event); const retry = await h.users.redeem(event);
  assert.deepEqual(first, retry);
  assert.equal((await h.users.redeem({ ...event, requestId: 'r2' })).alreadyRedeemed, true);
  await assert.rejects(h.users.redeem({ ...event, familyId: 'B' }), { code: 'REQUEST_MISMATCH' });
  h.setActor('other'); await assert.rejects(h.users.redeem({ ...event, requestId: 'r3' }), { code: 'REDEMPTION_CODE_USED' });
  assert.equal(h.db.all('membership_grants').length, 1);
});
test('并发跨家谱抢同一码只有一次成功；同家谱抢不同码也只有一次成功', async () => {
  for (const sameFamily of [false, true]) {
    const h = harness(); const first = await h.generate(); const second = sameFamily ? await h.generate() : first;
    const results = await Promise.allSettled([
      h.users.redeem({ familyId: 'A', code: first.code, requestId: '1' }),
      h.users.redeem({ familyId: sameFamily ? 'A' : 'B', code: second.code, requestId: '2' })
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(h.db.all('membership_redemptions').length, 1); assert.equal(h.db.all('membership_grants').length, 1);
  }
});
test('任意权益写入失败回滚兑换码、记录和幂等结果', async () => {
  const h = harness(); const { code, row } = await h.generate();
  h.db.writeHook = name => { if (name === 'families') throw new Error('injected'); };
  await assert.rejects(h.users.redeem({ familyId: 'A', code, requestId: '1' }), /injected/);
  assert.equal(h.db.get('membership_codes', row._id).status, 'unused');
  assert.equal(h.db.all('membership_redemptions').length, 0); assert.equal(h.db.all('membership_grants').length, 0);
  h.db.writeHook = null; await h.users.redeem({ familyId: 'A', code, requestId: '1' });
});
test('批量生成限制、幂等、备注和期限校验，审计不包含完整码', async () => {
  const h = harness();
  for (const quantity of [0, 51, 1.5]) await assert.rejects(h.ops.generate({ productId: 'youpu_vip_30d', quantity, requestId: '1' }, {}), { code: 'INVALID_INPUT' });
  for (const expiresAt of ['invalid', '2000-01-01T00:00:00Z']) await assert.rejects(h.generate('youpu_vip_30d', { expiresAt }), { code: 'INVALID_INPUT' });
  const event = { productId: 'youpu_vip_365d', quantity: 50, note: '虚构批次', requestId: 'same' };
  const first = await h.ops.generate(event, {}); const second = await h.ops.generate(event, {});
  assert.deepEqual(first, second); assert.equal(h.db.all('membership_codes').length, 50);
  await assert.rejects(h.ops.generate({ ...event, quantity: 2 }, {}), { code: 'REQUEST_MISMATCH' });
  const full = await h.ops.reveal({ batchId: first.batchId }, {});
  assert.equal(full.items.length, 50); assert.equal(new Set(full.items.map(row => row.code)).size, 50);
  const text = JSON.stringify(h.db.all('audit_logs')); assert.ok(full.items.every(row => !text.includes(row.code)));
});
test('普通运营可读脱敏状态和记录，但不能生成、揭示及作废', async () => {
  const h = harness(); const { code, row } = await h.generate();
  h.setRole('operator');
  const page = await h.ops.list({}, {}); assert.equal(JSON.stringify(page).includes(code), false);
  for (const [action, data] of [['generate', { productId: 'youpu_vip_30d' }], ['reveal', { codeId: row._id }], ['revoke', { codeId: row._id }]]) await assert.rejects(h.ops[action](data, {}), { code: 'NO_PERMISSION' });
  assert.equal((await h.ops.listRecords({}, {})).items.length, 0);
});
test('作废已兑换码拒绝；超管在事务中已被停用也拒绝生成', async () => {
  const h = harness(); const { code, row } = await h.generate(); await h.users.redeem({ familyId: 'A', code, requestId: 'r' });
  await assert.rejects(h.ops.revoke({ codeId: row._id, requestId: 'x' }, {}), { code: 'CODE_ALREADY_REDEEMED' });
  h.db.put('operators', 'op', { status: 'disabled', role: 'super_admin' });
  await assert.rejects(h.generate(), { code: 'NO_PERMISSION' });
});

test('生成冲突拒绝插入并整体回滚，不覆盖已有码', async () => {
  const h = harness(); const first = await h.generate();
  const opsRecords = require('../cloudfunctions/youpuOpsApi/membership-records');
  const original = opsRecords.generateCode;
  opsRecords.generateCode = () => records.normalizeCode(first.code);
  try { await assert.rejects(h.generate(), /duplicate key/); }
  finally { opsRecords.generateCode = original; }
  assert.equal(h.db.all('membership_codes').length, 1); assert.equal(h.db.get('membership_codes', first.row._id).status, 'unused');
});

test('路由登记兑换 mutation、20 次限流及 schema 权限，兑换不接入支付收入集合', () => {
  const user = fs.readFileSync('cloudfunctions/youpuUserApi/index.js', 'utf8');
  assert.match(user, /'membership\.redeem': \{ max: 20, windowMs: 60 \* 60 \* 1000 \}/);
  assert.match(user, /const MUTATION_TYPES = new Set\(\[\s*'membership\.redeem'/);
  for (const action of ['membership.redeem', 'membership.listRecords']) assert.ok(user.includes("'" + action + "':"));
  const schema = require('../deployment/database-indexes.json'); assert.equal(schema.schemaVersion, 14);
  assert.ok(schema.indexes.membership_codes && schema.indexes.membership_redemptions);
  assert.doesNotMatch(fs.readFileSync('cloudfunctions/youpuUserApi/membership-redemption.js', 'utf8'), /collection\('payment_orders'\)/);
  for (const name of ['membership_codes', 'membership_redemptions']) assert.ok(fs.readFileSync('deployment/apply-security.mjs', 'utf8').includes("'" + name + "'"));
});
test('两种记录按稳定游标跨同时间分页，本人家谱隔离，旧支付兼容', async () => {
  const h = harness(); const createdAt = new Date('2026-10-09T00:00:00Z');
  for (let i = 0; i < 27; i += 1) {
    const common = { familyId: 'A', productId: 'youpu_vip_30d', createdAt };
    h.db.put('payment_orders', 'p' + String(i).padStart(2, '0'), { ...common, payerUserId: 'actor', status: i % 2 ? 'refunded' : 'fulfilled', priceCents: 1500 });
    h.db.put('membership_redemptions', 'r' + String(i).padStart(2, '0'), { ...common, redeemedBy: 'actor', redeemedAt: createdAt });
  }
  h.db.put('payment_orders', 'pending', { familyId: 'A', payerUserId: 'actor', status: 'pending', createdAt });
  h.db.put('membership_redemptions', 'foreign', { familyId: 'A', redeemedBy: 'other', createdAt });
  h.db.put('membership_redemptions', 'another-family', { familyId: 'B', redeemedBy: 'actor', createdAt });
  let cursor = ''; let all = [];
  do { const page = await h.users.list({ familyId: 'A', pageSize: 7, cursor }); all.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(all.length, 54); assert.equal(new Set(all.map(row => row.recordId)).size, 54);
  assert.ok(all.every(row => row.familyId === 'A' && ['fulfilled', 'refunded'].includes(row.status)));
  assert.equal((await h.ops.listRecords({ recordType: 'payment' }, {})).items.every(row => row.recordType === 'payment'), true);
  await assert.rejects(h.users.list({ familyId: 'A', cursor: 'wrong' }), { code: 'INVALID_CURSOR' });
  const payment = all.find(row => row.recordType === 'payment'); assert.equal(payment.priceCents, 1500);
});
test('兑换码筛选正确处理长期有效、过期、套餐和批次', async () => {
  const h = harness(); const a = await h.generate(); const b = await h.generate('youpu_vip_365d');
  h.db.put('membership_codes', b.row._id, { ...h.db.get('membership_codes', b.row._id), expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await h.ops.list({ status: 'unused' }, {})).items[0]._id, a.row._id);
  assert.equal((await h.ops.list({ status: 'expired' }, {})).items[0]._id, b.row._id);
  assert.equal((await h.ops.list({ productId: 'youpu_vip_365d', batchId: b.batch.batchId }, {})).items.length, 1);
  await assert.rejects(h.ops.list({ status: 'bad' }, {}), { code: 'INVALID_INPUT' });
});
test('退款重算保留兑换权益且拒绝旧快照覆盖并发兑换', async () => {
  const source = fs.readFileSync('cloudfunctions/youpuPaymentNotify/index.js', 'utf8');
  const db = createDatabase(); const paidAt = new Date(Date.now() - 86400000);
  db.put('families', 'A', { status: 'active', proRevision: 1 });
  db.put('payment_orders', 'pay', { familyId: 'A', status: 'fulfilled', wxOrderId: 'wx', priceCents: 1500 });
  db.put('membership_grants', 'grant_pay', { familyId: 'A', status: 'active', durationDays: 30, paidAt });
  for (let i = 0; i < 110; i += 1) db.put('membership_grants', 'grant_redeem' + i, { familyId: 'A', status: 'active', recordType: 'redemption', durationDays: 1, paidAt: new Date() });
  const context = { db, _: db.command, crypto: require('node:crypto'), protocol: { assertRefundMatchesOrder: () => ({ duplicate: false }) } };
  vm.runInNewContext(source.slice(source.indexOf('async function applyRefund('), source.indexOf('function isTrustedInternalInvocation(')), context);
  db.queryHook = async name => {
    if (name === 'membership_grants') { db.queryHook = null; await db.collection('families').doc('A').update({ data: { proRevision: db.command.inc(1) } }); }
  };
  await assert.rejects(context.applyRefund({ outTradeNo: 'pay', wxOrderId: 'wx', refundId: 'refund' }), /membership changed/);
  assert.equal(db.get('payment_orders', 'pay').status, 'fulfilled');
  await context.applyRefund({ outTradeNo: 'pay', wxOrderId: 'wx', refundId: 'refund' });
  assert.equal(db.get('payment_orders', 'pay').status, 'refunded');
  assert.equal(db.get('families', 'A').proLifetime, false);
  assert.ok(new Date(db.get('families', 'A').proExpiresAt).getTime() > Date.now() + 109 * 86400000);
  assert.equal(db.all('membership_grants').filter(row => row.status === 'active').length, 110);
});
