const crypto = require('crypto');

const PRODUCTS = Object.freeze({
  youpu_vip_30d: Object.freeze({
    productId: 'youpu_vip_30d',
    name: '有谱家庭会员 30 天',
    priceCents: 1500,
    durationDays: 30,
    lifetime: false,
    recommended: false,
    sortOrder: 10
  }),
  youpu_vip_365d: Object.freeze({
    productId: 'youpu_vip_365d',
    name: '有谱家庭会员 1 年',
    priceCents: 9800,
    durationDays: 365,
    lifetime: false,
    recommended: true,
    sortOrder: 20
  }),
  youpu_vip_life: Object.freeze({
    productId: 'youpu_vip_life',
    name: '有谱家庭永久会员',
    priceCents: 99800,
    durationDays: 0,
    lifetime: true,
    recommended: false,
    sortOrder: 30
  })
});

const PAYMENT_PROFILES = Object.freeze({
  mock: Object.freeze({ mode: 'mock', env: 1, external: false }),
  sandbox: Object.freeze({ mode: 'sandbox', env: 1, external: true }),
  live: Object.freeze({ mode: 'live', env: 0, external: true })
});

function paymentProfile(value) {
  const mode = String(value || '').toLowerCase();
  return PAYMENT_PROFILES[mode] || PAYMENT_PROFILES.mock;
}

function catalog() {
  return Object.keys(PRODUCTS).map(function (key) {
    return Object.assign({}, PRODUCTS[key]);
  }).sort(function (left, right) { return left.sortOrder - right.sortOrder; });
}

function product(productId) {
  return PRODUCTS[String(productId || '')] || null;
}

function hmac(key, value) {
  return crypto.createHmac('sha256', String(key || '')).update(String(value || ''), 'utf8').digest('hex');
}

function paySignature(uri, postBody, appKey) {
  return hmac(appKey, String(uri || '') + '&' + String(postBody || ''));
}

function userSignature(postBody, sessionKey) {
  return hmac(sessionKey, postBody);
}

function buildSignData(input) {
  const source = input || {};
  return JSON.stringify({
    offerId: String(source.offerId || ''),
    buyQuantity: 1,
    env: Number(source.env) === 1 ? 1 : 0,
    currencyType: 'CNY',
    productId: String(source.productId || ''),
    goodsPrice: Number(source.goodsPrice) || 0,
    outTradeNo: String(source.outTradeNo || ''),
    attach: String(source.attach || '')
  });
}

function entitlementFromFamily(family, now) {
  const source = family || {};
  const current = now instanceof Date ? now : new Date(now || Date.now());
  const expiresAt = source.proExpiresAt ? new Date(source.proExpiresAt) : null;
  const lifetime = Boolean(source.proLifetime);
  const active = lifetime || Boolean(expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > current.getTime());
  return {
    active: active,
    lifetime: lifetime,
    expiresAt: lifetime ? null : (expiresAt || null),
    plan: lifetime ? 'lifetime' : (active ? 'fixed_term' : 'free')
  };
}

function recomputeEntitlement(grants, now) {
  const current = now instanceof Date ? new Date(now.getTime()) : new Date(now || Date.now());
  const active = (grants || []).filter(function (grant) {
    return grant && grant.status !== 'refunded' && grant.status !== 'revoked';
  }).sort(function (left, right) {
    return new Date(left.paidAt || left.createdAt || 0).getTime() - new Date(right.paidAt || right.createdAt || 0).getTime();
  });
  if (active.some(function (grant) { return Boolean(grant.lifetime); })) {
    return { active: true, lifetime: true, expiresAt: null, plan: 'lifetime' };
  }
  let cursor = null;
  active.forEach(function (grant) {
    const paidAt = new Date(grant.paidAt || grant.createdAt || current).getTime();
    const paidTime = Number.isFinite(paidAt) ? paidAt : current.getTime();
    cursor = cursor === null ? paidTime : Math.max(cursor, paidTime);
    cursor += Math.max(0, Number(grant.durationDays) || 0) * 24 * 60 * 60 * 1000;
  });
  const expiresAt = cursor === null ? null : new Date(cursor);
  const isActive = Boolean(expiresAt && expiresAt.getTime() > current.getTime());
  return {
    active: isActive,
    lifetime: false,
    expiresAt: expiresAt,
    plan: isActive ? 'fixed_term' : 'free'
  };
}

function publicProduct(item) {
  return {
    productId: item.productId,
    name: item.name,
    priceCents: item.priceCents,
    durationDays: item.durationDays,
    lifetime: item.lifetime,
    recommended: item.recommended
  };
}

module.exports = {
  PRODUCTS: PRODUCTS,
  PAYMENT_PROFILES: PAYMENT_PROFILES,
  catalog: catalog,
  product: product,
  paymentProfile: paymentProfile,
  publicProduct: publicProduct,
  buildSignData: buildSignData,
  paySignature: paySignature,
  userSignature: userSignature,
  entitlementFromFamily: entitlementFromFamily,
  recomputeEntitlement: recomputeEntitlement
};
