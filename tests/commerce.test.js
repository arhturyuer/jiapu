const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const commerce = require('../cloudfunctions/youpuUserApi/commerce');
const paymentProtocol = require('../cloudfunctions/youpuPaymentNotify/protocol');

const root = path.resolve(__dirname, '..');

test('家庭会员目录固定三个 SKU 且价格和期限只存在服务端', function () {
  const products = commerce.catalog();
  assert.deepEqual(products.map(function (item) { return [item.productId, item.priceCents, item.durationDays, item.lifetime]; }), [
    ['youpu_vip_30d', 1500, 30, false],
    ['youpu_vip_365d', 9800, 365, false],
    ['youpu_vip_life', 99800, 0, true]
  ]);
  assert.equal(products.filter(function (item) { return item.recommended; })[0].productId, 'youpu_vip_365d');
  const membershipPage = fs.readFileSync(path.join(root, 'miniprogram/pages/membership/index.js'), 'utf8');
  assert.doesNotMatch(membershipPage, /priceCents\s*:/, '前端不得向创建订单接口提交价格');
});

test('期限从支付时间顺序累加且早期退款后可以正确回退', function () {
  const day = 86400000;
  const firstPaid = new Date('2026-01-01T00:00:00Z');
  const secondPaid = new Date('2026-01-20T00:00:00Z');
  const grants = [
    { orderId: 'a', paidAt: firstPaid, durationDays: 30, status: 'active' },
    { orderId: 'b', paidAt: secondPaid, durationDays: 365, status: 'active' }
  ];
  const stacked = commerce.recomputeEntitlement(grants, new Date('2026-01-21T00:00:00Z'));
  assert.equal(stacked.expiresAt.getTime(), firstPaid.getTime() + 395 * day);
  const afterRefund = commerce.recomputeEntitlement([Object.assign({}, grants[0], { status: 'refunded' }), grants[1]], new Date('2026-01-21T00:00:00Z'));
  assert.equal(afterRefund.expiresAt.getTime(), secondPaid.getTime() + 365 * day);
  assert.ok(afterRefund.expiresAt.getTime() < stacked.expiresAt.getTime());
});

test('永久 grant 覆盖期限，退款或撤销 grant 不计入权益', function () {
  const result = commerce.recomputeEntitlement([
    { paidAt: '2025-01-01', durationDays: 30, status: 'refunded' },
    { paidAt: '2026-01-01', durationDays: 0, lifetime: true, status: 'active' }
  ], new Date('2036-01-01'));
  assert.deepEqual(result, { active: true, lifetime: true, expiresAt: null, plan: 'lifetime' });
});

test('signData 保持精确 JSON 字段顺序且双 HMAC 输入不二次序列化', function () {
  const signData = commerce.buildSignData({ offerId: 'offer', env: 1, productId: 'sku', goodsPrice: 1500, outTradeNo: 'YP123', attach: '{"familyId":"f1"}' });
  assert.equal(signData, '{"offerId":"offer","buyQuantity":1,"env":1,"currencyType":"CNY","productId":"sku","goodsPrice":1500,"outTradeNo":"YP123","attach":"{\\"familyId\\":\\"f1\\"}"}');
  assert.equal(commerce.paySignature('requestVirtualPayment', signData, 'app-key'), crypto.createHmac('sha256', 'app-key').update('requestVirtualPayment&' + signData).digest('hex'));
  assert.equal(commerce.userSignature(signData, 'session-key'), crypto.createHmac('sha256', 'session-key').update(signData).digest('hex'));
});

test('支付模式将 staging 沙箱固定为 env=1，未知模式安全降级 mock', function () {
  assert.deepEqual(commerce.paymentProfile('sandbox'), { mode: 'sandbox', env: 1, external: true });
  assert.deepEqual(commerce.paymentProfile('live'), { mode: 'live', env: 0, external: true });
  assert.deepEqual(commerce.paymentProfile('mock'), { mode: 'mock', env: 1, external: false });
  assert.deepEqual(commerce.paymentProfile('unexpected'), { mode: 'mock', env: 1, external: false });
});

test('云函数消息推送只接受虚拟支付 JSON 事件并使用平台应答格式', function () {
  assert.equal(paymentProtocol.isSupportedPaymentEvent({ Event: 'xpay_goods_deliver_notify' }), true);
  assert.equal(paymentProtocol.isSupportedPaymentEvent({ Event: 'xpay_refund_notify' }), true);
  assert.equal(paymentProtocol.isSupportedPaymentEvent({ Event: 'xpay_coin_pay_notify' }), false);
  assert.equal(paymentProtocol.isSupportedPaymentEvent({ body: '<xml />' }), false);
  assert.deepEqual(paymentProtocol.normalizePayload({
    Event: 'xpay_goods_deliver_notify', OpenId: 'openid-1',
    WeChatPayInfo: { MchOrderNo: 'wx-order-1' }, OutTradeNo: 'YP123',
    GoodsInfo: { ProductId: 'youpu_vip_30d', Quantity: 1 }
  }), {
    event: 'xpay_goods_deliver_notify', openid: 'openid-1', wxOrderId: 'wx-order-1',
    outTradeNo: 'YP123', productId: 'youpu_vip_30d', quantity: 1, refundId: ''
  });
  assert.deepEqual(paymentProtocol.successResponse(), { ErrCode: 0, ErrMsg: 'success' });
  assert.deepEqual(paymentProtocol.failureResponse(), { ErrCode: 1, ErrMsg: 'failed' });
  assert.equal(paymentProtocol.normalizePayload({
    Event: 'xpay_refund_notify', WxOrderId: 'wx-order-1', WxRefundId: 'wx-refund-1'
  }).refundId, 'wx-refund-1');
});

test('云函数支付发货在订单、商品、付款人与重复消息上保持幂等校验', function () {
  const payload = paymentProtocol.normalizePayload({
    Event: 'xpay_goods_deliver_notify', OpenId: 'payer-openid', MchOrderNo: 'wx-order-1',
    OutTradeNo: 'order-1', ProductId: 'youpu_vip_30d', Quantity: 1
  });
  const pending = {
    _id: 'order-1', status: 'pending', productId: 'youpu_vip_30d',
    payerUserId: paymentProtocol.payerUserId('payer-openid')
  };
  assert.deepEqual(paymentProtocol.assertDeliveryMatchesOrder(pending, payload), { duplicate: false });
  assert.deepEqual(paymentProtocol.assertDeliveryMatchesOrder(Object.assign({}, pending, { status: 'closed', closeReason: 'payment_timeout' }), payload), { duplicate: false });
  assert.deepEqual(paymentProtocol.assertDeliveryMatchesOrder(Object.assign({}, pending, { status: 'fulfilled', wxOrderId: 'wx-order-1' }), payload), { duplicate: true });
  assert.throws(function () {
    paymentProtocol.assertDeliveryMatchesOrder(Object.assign({}, pending, { productId: 'youpu_vip_365d' }), payload);
  }, /product mismatch/);
  assert.throws(function () {
    paymentProtocol.assertDeliveryMatchesOrder(Object.assign({}, pending, { payerUserId: 'another-payer' }), payload);
  }, /payer mismatch/);
  assert.throws(function () {
    paymentProtocol.assertDeliveryMatchesOrder(pending, Object.assign({}, payload, { quantity: 2 }));
  }, /quantity mismatch/);
  const refunded = Object.assign({}, pending, { status: 'fulfilled', wxOrderId: 'wx-order-1' });
  assert.deepEqual(paymentProtocol.assertRefundMatchesOrder(refunded, payload), { duplicate: false });
  assert.throws(function () {
    paymentProtocol.assertRefundMatchesOrder(refunded, Object.assign({}, payload, { productId: 'youpu_vip_life' }));
  }, /product mismatch/);
  assert.throws(function () {
    paymentProtocol.assertRefundMatchesOrder(refunded, Object.assign({}, payload, { openid: 'another-openid' }));
  }, /payer mismatch/);
});

test('支付、历史、备份和回调契约具备服务端发货与安全护栏', function () {
  const api = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'miniprogram/pages/membership/index.js'), 'utf8');
  const notify = fs.readFileSync(path.join(root, 'cloudfunctions/youpuPaymentNotify/index.js'), 'utf8');
  const jobs = fs.readFileSync(path.join(root, 'cloudfunctions/youpuJobs/index.js'), 'utf8');
  ['membership.catalog', 'membership.status', 'payment.createOrder', 'payment.clientCompleted', 'payment.getOrder', 'payment.reconcileNow', 'payment.listMine', 'family.activity.list', 'family.backup.create', 'family.backup.status', 'family.backup.partUrl'].forEach(function (action) {
    assert.match(api, new RegExp("'" + action.replace(/\./g, '\\.') + "'\\s*:"));
  });
  assert.match(api, /payload\.openid === expectedOpenid/);
  assert.match(page, /wx\.requestVirtualPayment/);
  assert.match(page, /payment\.reconcileNow/);
  assert.match(page, /payment\.getOrder/);
  assert.doesNotMatch(page, /membership_grants|proExpiresAt|proLifetime/);
  assert.match(notify, /xpay_goods_deliver_notify/);
  assert.match(notify, /xpay_refund_notify/);
  assert.match(notify, /protocol\.isSupportedPaymentEvent/);
  assert.match(notify, /protocol\.successResponse/);
  assert.match(notify, /protocol\.assertDeliveryMatchesOrder/);
  assert.match(notify, /protocol\.assertRefundMatchesOrder/);
  assert.doesNotMatch(notify, /validPlainSignature|xmlPayload|decryptMessage|statusCode/);
  assert.match(notify, /payment_events/);
  assert.match(notify, /runTransaction/);
  assert.match(jobs, /\/xpay\/query_order/);
  assert.match(jobs, /paymentEnvironment\(order\)/);
  assert.match(jobs, /\[2, 3, 4\]\.includes\(Number\(source\.status\)\)/);
  assert.match(jobs, /closeReason: 'payment_timeout', updatedAt: _\.gte\(recoveryCutoff\)/);
  assert.match(jobs, /微信 query_order 返回失败 \[/);
  assert.match(api, /PAYMENT_QUERY_NOT_FOUND/);
  assert.match(api, /function canReconcilePaymentOrder/);
  assert.match(api, /closeReason: order\.closeReason \|\| ''/);
  assert.match(page, /status === 'closed' && order\.closeReason === 'payment_timeout'/);
  assert.match(api, /wx_order_id: orderReference/);
  assert.match(jobs, /wx_order_id: wxOrderId/);
  assert.match(page, /payment\.clientCompleted/);
  assert.match(api, /reconcileStatus: status, reconcileMessage: message/);
  assert.match(jobs, /query_not_found/);
  assert.doesNotMatch(jobs, /env:\s*0, order_id/);
  assert.match(api, /paymentEnv: profile\.env/);
  assert.match(api, /paymentMode: profile\.mode/);
  assert.match(api, /env: paymentEnvironment\(order\)/);
  assert.match(api, /function paymentNotifyFunctionName\(\)/);
  assert.match(api, /youpuPaymentNotifyV2/);
  assert.match(jobs, /function paymentNotifyFunctionName\(\)/);
  assert.match(api, /VP_INTERNAL_NOTIFY_SECRET/);
  assert.doesNotMatch(api, /reconcile_deliver_/);
  assert.match(jobs, /100 \* 1024 \* 1024/);
  assert.match(jobs, /72 \* 60 \* 60 \* 1000/);
  assert.match(api, /async function familyBackupStatus[\s\S]*?entitlementFromFamily\(access\.family\)\.active/);
  assert.match(api, /async function familyBackupPartUrl[\s\S]*?entitlementFromFamily\(access\.family\)\.active/);
  assert.match(jobs, /function hasActiveMembership\(family, now\)/);
  assert.match(jobs, /家庭会员已失效，未生成完整备份/);
});

test('staging 仅通过本机沙箱凭据生成部署清单，并要求云函数消息推送人工绑定', function () {
  const stagingExample = fs.readFileSync(path.join(root, 'deployment/staging.local.env.example'), 'utf8');
  const configure = fs.readFileSync(path.join(root, 'deployment/configure-staging.mjs'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, 'deployment/deploy-staging.sh'), 'utf8');
  const preflight = fs.readFileSync(path.join(root, 'deployment/preflight.sh'), 'utf8');
  const verify = fs.readFileSync(path.join(root, 'deployment/verify-cloud.mjs'), 'utf8');
  assert.match(stagingExample, /STAGING_PAYMENT_MODE=sandbox/);
  ['STAGING_VP_APP_ID', 'STAGING_VP_APP_SECRET', 'STAGING_VP_OFFER_ID', 'STAGING_VP_APP_KEY', 'STAGING_VP_INTERNAL_NOTIFY_SECRET'].forEach(function (key) {
    assert.match(stagingExample, new RegExp('^' + key + '=', 'm'));
    assert.match(preflight, new RegExp(key));
  });
  assert.match(configure, /STAGING_PAYMENT_MODE !== 'sandbox'/);
  assert.match(configure, /PAYMENT_MODE: 'sandbox'/);
  assert.match(configure, /VP_INTERNAL_NOTIFY_SECRET: sandboxVariables\.VP_INTERNAL_NOTIFY_SECRET/);
  assert.match(stagingExample, /xpay_goods_deliver_notify/);
  assert.match(stagingExample, /xpay_refund_notify/);
  assert.doesNotMatch(stagingExample, /VP_MESSAGE|VP_NOTIFY_URL/);
  assert.doesNotMatch(preflight, /VP_MESSAGE|VP_NOTIFY_URL/);
  assert.doesNotMatch(deploy, /payment-route|routes', 'list'/);
  const upload = fs.readFileSync(path.join(root, 'uploadCloudFunction.sh'), 'utf8');
  assert.doesNotMatch(upload, /HTTP 路由/);
  assert.match(upload, /fn deploy youpuPaymentNotifyV2/);
  assert.match(verify, /productionPaymentEnvironmentKeys/);
  assert.match(verify, /VP_INTERNAL_NOTIFY_SECRET/);
});

test('个人订单记录按付款人和家谱分页，会员页可恢复待确认订单', function () {
  const api = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'miniprogram/pages/membership/index.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/membership/index.wxml'), 'utf8');
  assert.match(api, /async function paymentListMine\(event\)/);
  assert.match(api, /const where = \{ payerUserId: user\._id \}/);
  assert.match(api, /if \(familyId\) where\.familyId = familyId/);
  assert.match(api, /\.orderBy\('createdAt', 'desc'\)\s*\.skip\(offset\)\s*\.limit\(pageSize \+ 1\)/);
  assert.match(api, /hasMore: rows\.length > pageSize/);
  assert.match(api, /nextCursor: rows\.length > pageSize \? String\(offset \+ items\.length\) : ''/);
  assert.match(page, /payment\.listMine/);
  assert.match(page, /refreshLatestPendingOrder/);
  assert.match(page, /refreshOrderById/);
  assert.match(page, /loadMoreOrders/);
  assert.match(template, /购买记录/);
  assert.match(template, /仅显示你的付款订单/);
  assert.match(template, /刷新状态/);
});

test('广告只在家庭和我的页预留且无 ID 或会员状态下隐藏', function () {
  const config = require('../miniprogram/config/commerce');
  assert.equal(config.resolveBanner('staging', 'family'), '');
  assert.equal(config.resolveBanner('staging', 'profile'), '');
  const members = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.wxml'), 'utf8');
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.match(members, /wx:if="\{\{adVisible\}\}"/);
  assert.match(profile, /wx:if="\{\{adVisible\}\}"/);
  ['tree', 'invite', 'edit-member', 'privacy', 'membership', 'legal'].forEach(function (name) {
    const source = fs.readFileSync(path.join(root, 'miniprogram/pages', name, 'index.wxml'), 'utf8');
    assert.doesNotMatch(source, /<ad\b/);
  });
});

test('会员状态合并到当前家谱卡并在家庭页顶部展示', function () {
  const profile = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  const profileSource = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/index.js'), 'utf8');
  const members = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.wxml'), 'utf8');
  const display = require('../miniprogram/utils/membership-display');
  assert.doesNotMatch(profile, /openCurrentGraph|查看家谱|membership-card/);
  assert.doesNotMatch(profileSource, /openCurrentGraph\s*:/);
  assert.match(profile, /current-family-membership/);
  assert.match(profile, /membershipTierText/);
  assert.match(profile, /bindtap="openMembership"/);
  assert.match(members, /family-membership-badge[\s\S]*membershipTierText/);
  assert.deepEqual(display.fromFamily({ membership: { active: false } }), {
    active: false, tierText: '免费版', detailText: '升级后全体家人共享会员权益'
  });
  assert.deepEqual(display.fromFamily({ membership: { active: true, lifetime: true } }), {
    active: true, tierText: '会员版', detailText: '永久有效 · 全体家人共享'
  });
  assert.deepEqual(display.fromFamily({ membership: { active: true, lifetime: false, expiresAt: '2026-10-01T00:00:00+08:00' } }), {
    active: true, tierText: '会员版', detailText: '有效至 2026-10-01 · 全体家人共享'
  });
});

test('家庭备份和个人信息导出使用二次点击转发并最终清理临时文件', function () {
  const backup = fs.readFileSync(path.join(root, 'miniprogram/pages/family-backup/index.js'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'miniprogram/pages/privacy/index.js'), 'utf8');
  [backup, privacy].forEach(function (source) {
    assert.match(source, /fileTransfer\.downloadToTempFile/);
    assert.match(source, /fileTransfer\.shareFile/);
    assert.match(source, /fileTransfer\.removeTempFile/);
    assert.doesNotMatch(source, /wx\.downloadFile\s*\([^)]*\)\.then/s);
  });
  assert.match(backup, /downloadingPartIndex/);
  assert.match(backup, /readyPartIndex === index[\s\S]*shareReadyPart\(\)/);
  assert.match(backup, /fileName:\s*data\.fileName/);
  assert.match(privacy, /exportFileReady && this\._readyExport[\s\S]*shareReadyExport\(\)/);
  assert.match(privacy, /fileName:\s*'有谱个人信息导出\.json'/);
});
