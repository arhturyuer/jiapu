// Secret-authenticated, temporary staging probe. Never deployed with production APIs.
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');
const records = require('./membership-records');
const commerce = require('./commerce');
const redemption = require('./membership-redemption');
const codes = require('./redemption-codes');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database(); const _ = db.command;
const hash = (value, length = 32) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
function check(condition, code, message) { if (!condition) throw Object.assign(new Error(message || code), { code }); }
async function read(scope, name, id) {
  try { return (await scope.collection(name).doc(id).get()).data || null; }
  catch (error) { if (/document with _id [^\s]+ does not exist/.test(String(error.errMsg || error.message))) return null; throw error; }
}
async function list(name, where) {
  const rows = []; let cursor = '';
  while (true) {
    const result = await db.collection(name).where(Object.assign({}, where, cursor ? { _id: _.gt(cursor) } : {})).orderBy('_id', 'asc').limit(100).get();
    const page = result.data || []; rows.push(...page); check(rows.length <= 5000, 'PROBE_LIMIT');
    if (page.length < 100) return rows;
    cursor = page[page.length - 1]._id;
  }
}
async function remove(name, where) { for (const row of await list(name, where)) await db.collection(name).doc(row._id).remove(); }
function fixture(run) {
  const prefix = 'redemption_probe_' + run;
  return { prefix, operatorId: prefix + '_op', openids: [prefix + '_actor', prefix + '_other'], familyIds: Array.from({ length: 7 }, (_, index) => prefix + '_family_' + index) };
}
async function seed(run) {
  const f = fixture(run);
  await db.collection('system_config').doc(f.prefix).set({ data: { kind: 'staging_redemption_probe', createdAt: new Date() } });
  await db.collection('operators').doc(f.operatorId).set({ data: { role: 'super_admin', status: 'active', authUid: f.prefix, createdAt: new Date() } });
  for (const openid of f.openids) {
    const userId = 'u_' + hash(openid);
    await db.collection('users').doc(userId).set({ data: { status: 'active', openid, createdAt: new Date() } });
    for (const [index, familyId] of f.familyIds.entries()) {
      if (openid === f.openids[0]) await db.collection('families').doc(familyId).set({ data: { status: 'active', name: '虚构兑换验收家谱 ' + index, proLifetime: false, createdAt: new Date() } });
      await db.collection('family_memberships').doc('fm_' + hash(familyId + ':' + openid)).set({ data: { familyId, userId, status: 'active', role: ['admin', 'member', 'viewer'][index % 3], joinedAt: new Date() } });
    }
  }
  return { seeded: true };
}
function services(f) {
  let openid = f.openids[0]; let role = 'super_admin';
  const context = {
    db, _, cloud, assert: check, hash, cleanText: (value, limit) => String(value || '').trim().slice(0, limit),
    userId: value => 'u_' + hash(value), idempotencyId: (value, action, id) => 'idem_' + hash([value, action, id].join(':'), 40),
    maybeGet: read, testAccounts: { usesTestIdentity: () => false },
    mustGet: async (scope, name, id, code) => { const row = await read(scope, name, id); check(row, code || 'NOT_FOUND'); return row; }
  };
  // These are exact deployed implementations, with only synthetic identity injected.
  vm.runInNewContext(fs.readFileSync(__dirname + '/user-mutate.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(__dirname + '/user-delivery.js', 'utf8'), context);
  const opsContext = { ...context, maybeGet: (name, id, scope = db) => read(scope, name, id) };
  vm.runInNewContext(fs.readFileSync(__dirname + '/ops-mutate.js', 'utf8'), opsContext);
  const paymentContext = { ...context, protocol: require('./protocol'), crypto };
  vm.runInNewContext(fs.readFileSync(__dirname + '/payment-refund.js', 'utf8'), paymentContext);
  const users = redemption.createService({ db, assert: check, commerce, ACTIVE_ROLES: ['admin', 'member', 'viewer'],
    getOpenid: () => openid, requireActiveUser: async () => { const user = await read(db, 'users', 'u_' + hash(openid)); check(user && user.status === 'active', 'ACCOUNT_UNAVAILABLE'); return user; },
    requireMembership: async (familyId, roles, scope) => {
      const family = await read(scope, 'families', familyId); check(family && family.status === 'active', 'FAMILY_UNAVAILABLE');
      const member = await read(scope, 'family_memberships', 'fm_' + hash(familyId + ':' + openid)); check(member && member.status === 'active', 'NO_FAMILY_ACCESS');
      return { family, membership: member };
    }, mutate: context.mutate, maybeGet: read
  });
  const ops = codes.createService({ db, assert: check, opsMutate: opsContext.opsMutate,
    maybeGet: opsContext.maybeGet, writeOpsAudit: opsContext.writeOpsAudit,
    requireOperator: async (context, roles) => { check(roles.includes(role), 'NO_PERMISSION'); return { _id: f.operatorId, role }; }
  });
  return { users, ops, refund: paymentContext.applyRefund,
    deliver: (order, wxOrderId) => db.runTransaction(tx => context.fulfillOrderTransaction(tx, order, wxOrderId, new Date())),
    setOpenid: value => { openid = value; }, setRole: value => { role = value; } };
}
async function runCases(run) {
  const f = fixture(run); const service = services(f); const results = {};
  const expectCode = async (callback, code) => { let actual; try { await callback(); } catch (error) { actual = error.code; } check(actual === code, 'PROBE_EXPECT_' + code); };
  const generated = [];
  for (const [index, productId] of ['youpu_vip_30d', 'youpu_vip_365d', 'youpu_vip_life'].entries()) {
    const event = { productId, quantity: index === 0 ? 50 : 1, requestId: f.prefix + '_gen_' + index };
    const batch = await service.ops.generate(event, {});
    const repeated = await service.ops.generate(event, {}); check(repeated.batchId === batch.batchId, 'PROBE_BATCH_IDEMPOTENT');
    const full = await service.ops.reveal({ batchId: batch.batchId }, {}); generated.push(...full.items);
    const row = full.items[0]; const familyId = f.familyIds[index];
    const redeemed = await service.users.redeem({ familyId, code: row.code.toLowerCase(), requestId: f.prefix + '_redeem_' + index });
    check(redeemed.record.recordType === 'redemption' && redeemed.record.priceCents === null, 'PROBE_REDEMPTION_RECORD');
    const family = await read(db, 'families', familyId); check(commerce.entitlementFromFamily(family).active, 'PROBE_ACTIVE');
    const repeatedRedeem = await service.users.redeem({ familyId, code: row.code, requestId: f.prefix + '_repeat_' + index });
    check(repeatedRedeem.alreadyRedeemed, 'PROBE_REDEEM_IDEMPOTENT');
    await expectCode(() => service.ops.revoke({ codeId: row._id, requestId: f.prefix + '_revoke_used_' + index }, {}), 'CODE_ALREADY_REDEEMED');
  }
  results.threeProducts = true; results.batchIdempotent = true; results.redemptionIdempotent = true;
  const used = await list('membership_codes', { createdBy: f.operatorId, status: 'redeemed' });
  const unused = generated.filter(row => !used.some(item => item._id === row._id));
  await expectCode(() => service.users.redeem({ familyId: f.familyIds[0], code: unused[0].code, requestId: f.prefix + '_active' }), 'REDEMPTION_MEMBERSHIP_ACTIVE');
  check((await read(db, 'membership_codes', unused[0]._id)).status === 'unused', 'PROBE_ACTIVE_NOT_CONSUMED');
  const competition = await Promise.allSettled([3, 4].map(index => service.users.redeem({ familyId: f.familyIds[index], code: unused[0].code, requestId: f.prefix + '_race_' + index })));
  check(competition.filter(item => item.status === 'fulfilled').length === 1, 'PROBE_CONCURRENCY');
  const expiry = new Date(Date.now() - 1000);
  await db.collection('membership_codes').doc(unused[1]._id).update({ data: { expiresAt: expiry } });
  await expectCode(() => service.users.redeem({ familyId: f.familyIds[5], code: unused[1].code, requestId: f.prefix + '_expired' }), 'REDEMPTION_CODE_EXPIRED');
  await service.ops.revoke({ codeId: unused[2]._id, requestId: f.prefix + '_revoke' }, {});
  await expectCode(() => service.users.redeem({ familyId: f.familyIds[5], code: unused[2].code, requestId: f.prefix + '_revoked' }), 'REDEMPTION_CODE_REVOKED');
  service.setRole('operator');
  for (const action of ['generate', 'reveal', 'revoke']) await expectCode(() => service.ops[action]({ productId: 'youpu_vip_30d', codeId: unused[3]._id, requestId: f.prefix + '_denied' }, {}), 'NO_PERMISSION');
  const masked = await service.ops.list({ batchId: generated[0].batchId }, {});
  check(masked.items.every(row => !row.code && !row.fullCode), 'PROBE_MASKED');
  results.activeDenied = true; results.concurrency = true; results.expiredRevokedDenied = true; results.operatorDenied = true;
  const own = await service.users.list({ familyId: f.familyIds[0], pageSize: 1 }); check(own.items.length === 1 && own.items[0].recordType === 'redemption', 'PROBE_USER_RECORDS');
  service.setOpenid(f.openids[1]); const foreign = await service.users.list({ familyId: f.familyIds[0] }); check(foreign.items.length === 0, 'PROBE_RECORDS_SCOPED'); service.setOpenid(f.openids[0]);
  const paymentId = f.prefix + '_payment'; const now = new Date();
  await db.collection('payment_orders').doc(paymentId).set({ data: { familyId: f.familyIds[0], payerUserId: 'u_' + hash(f.openids[0]), status: 'refunded', priceCents: 1500, productId: 'youpu_vip_30d', createdAt: now, paidAt: now } });
  const first = await service.users.list({ familyId: f.familyIds[0], pageSize: 1 });
  const second = await service.users.list({ familyId: f.familyIds[0], pageSize: 1, cursor: first.nextCursor });
  check(first.hasMore && first.items[0].recordType === 'payment' && second.items[0].recordType === 'redemption' && !second.hasMore, 'PROBE_MERGED_PAGES');
  results.recordsScoped = true; results.mergedPagination = true;
  const refundOrder = f.prefix + '_refund'; const wxOrderId = f.prefix + '_wx';
  await db.collection('payment_orders').doc(refundOrder).set({ data: {
    familyId: f.familyIds[0], payerUserId: 'u_' + hash(f.openids[0]), status: 'pending', wxOrderId,
    priceCents: 1500, productId: 'youpu_vip_30d', durationDays: 30, createdAt: now, paidAt: now
  } });
  const beforePurchase = await read(db, 'families', f.familyIds[0]);
  await service.deliver(await read(db, 'payment_orders', refundOrder), wxOrderId);
  const afterPurchase = await read(db, 'families', f.familyIds[0]);
  check(new Date(afterPurchase.proExpiresAt).getTime() - new Date(beforePurchase.proExpiresAt).getTime() === 30 * 86400000, 'PROBE_PURCHASE_STACKS');
  await service.refund({ outTradeNo: refundOrder, wxOrderId, refundId: f.prefix + '_refund_event' });
  const retained = await read(db, 'families', f.familyIds[0]);
  check(commerce.entitlementFromFamily(retained).active && !retained.proLifetime, 'PROBE_REFUND_RETAINS_REDEMPTION');
  const activeGrants = await list('membership_grants', { familyId: f.familyIds[0], status: 'active' });
  check(activeGrants.length === 1 && activeGrants[0].recordType === 'redemption', 'PROBE_REFUND_GRANTS');
  results.refundRetainsRedemption = true; results.purchaseAfterRedemption = true; results.batchSize50 = true;
  const schema = await read(db, 'system_config', 'schema'); check(schema.version === 12, 'PROBE_SCHEMA'); results.schemaVersion = schema.version;
  const gateway = await cloud.callFunction({ name: 'youpuUserApi', data: { type: 'membership.redeem', familyId: f.familyIds[6], code: unused[3].code, requestId: f.prefix + '_gateway' } });
  check(gateway.result && !gateway.result.success && ['UNAUTHENTICATED', 'NO_FAMILY_ACCESS'].includes(gateway.result.code), 'PROBE_USER_GATEWAY');
  const deniedOps = await cloud.callFunction({ name: 'youpuOpsApi', data: { action: 'commerce.codes.generate', productId: 'youpu_vip_30d', quantity: 1, requestId: f.prefix + '_gateway_ops' } });
  check(deniedOps.result && !deniedOps.result.success && ['UNAUTHENTICATED', 'NOT_OPERATOR'].includes(deniedOps.result.code), 'PROBE_OPS_GATEWAY');
  results.userGateway = gateway.result.code; results.opsGateway = deniedOps.result.code;
  return results;
}
async function cleanup(run) {
  const f = fixture(run);
  for (const familyId of f.familyIds) {
    for (const name of ['family_memberships', 'membership_redemptions', 'membership_grants', 'payment_orders', 'payment_events']) await remove(name, { familyId });
    await db.collection('families').doc(familyId).remove();
  }
  await remove('membership_codes', { createdBy: f.operatorId });
  await remove('audit_logs', { actorId: 'operator_' + f.operatorId });
  await remove('idempotency_records', { actorId: 'operator_' + f.operatorId });
  for (const openid of f.openids) {
    const userId = 'u_' + hash(openid);
    await remove('idempotency_records', { actorId: userId }); await remove('rate_limits', { actorId: userId });
    await db.collection('users').doc(userId).remove();
  }
  await db.collection('operators').doc(f.operatorId).remove(); await db.collection('system_config').doc(f.prefix).remove();
  return { cleaned: true };
}
exports.main = async event => {
  try {
    const actual = cloud.getWXContext().ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE;
    check(process.env.PROBE_ENV && actual === process.env.PROBE_ENV && actual !== 'cloud1-d5gs5yj4l283d9c6d' && event.secret === process.env.PROBE_SECRET, 'PROBE_UNAUTHORIZED');
    check(/^[a-f0-9]{12}$/.test(event.run || ''), 'PROBE_RUN_INVALID');
    const handlers = { seed, run: runCases, cleanup }; check(handlers[event.action], 'PROBE_ACTION');
    return { success: true, data: await handlers[event.action](event.run) };
  } catch (error) { return { success: false, code: error.code || 'PROBE_FAILED', message: error.message }; }
};
