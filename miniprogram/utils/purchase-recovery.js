const environment = require('../config/env');

function scope(app) {
  const runtime = environment.resolveRuntimeEnvironment(typeof wx === 'undefined' ? null : wx);
  const user = app.globalData && app.globalData.user;
  return runtime.environment.cloudEnv + ':' + (user && user._id || '');
}
function key(context) { return 'youpu_purchase:' + context.scope + ':' + context.familyId; }
function readAll(app, familyId) {
  const currentScope = scope(app);
  try {
    const value = wx.getStorageSync(key({ scope: currentScope, familyId }));
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items.filter(item => item && item.scope === currentScope && item.familyId === familyId && item.requestId && item.productId)
      .map(item => Object.assign({}, item));
  } catch (error) { return []; }
}
function read(app, familyId) { const items = readAll(app, familyId); return items[items.length - 1] || null; }
function save(app, context, newRequest) {
  if (scope(app) !== context.scope) return false;
  const items = readAll(app, context.familyId);
  const index = items.findIndex(item => item.requestId === context.requestId);
  if (index < 0 && items.length && !newRequest) return false;
  const item = {
    scope: context.scope, familyId: context.familyId, requestId: context.requestId,
    productId: context.productId, orderId: context.orderId || '', createdAt: context.createdAt,
    clientOutcome: ['success', 'cancelled'].includes(context.clientOutcome) ? context.clientOutcome : 'unknown'
  };
  if (index < 0) items.push(item); else items[index] = item;
  try { wx.setStorageSync(key(context), items); return true; } catch (error) { return false; }
}
function clear(app, context) {
  if (scope(app) !== context.scope) return;
  const items = readAll(app, context.familyId).filter(item => item.requestId !== context.requestId);
  try {
    if (items.length) wx.setStorageSync(key(context), items);
    else wx.removeStorageSync(key(context));
  } catch (error) { /* A later visit can retry recovery. */ }
}
module.exports = { scope, read, readAll, save, clear };
