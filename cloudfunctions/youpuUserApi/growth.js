const crypto = require('crypto');
const DAY = 86400000;
const PAGES = ['pages/share-intro/index', 'pages/about/index', 'pages/guides/index', 'pages/guide/index', 'pages/examples/index', 'pages/example/index', 'pages/example-person-detail/index', 'pages/example-reading/index'];
// Verified against wechat-miniprogram/api-typings/types/wx/lib.wx.app.d.ts, 2026-10-18.
function source(scene) {
  if ([1129, 1030, 1203].includes(Number(scene))) return 'excluded';
  if ([1005, 1006, 1027, 1042, 1053, 1183].includes(Number(scene))) return 'search';
  if ([1007, 1008, 1044].includes(Number(scene))) return 'share';
  return 'unknown';
}
function digest(value) { return crypto.createHash('sha256').update('youpu-growth:' + value).digest('hex').slice(0, 40); }
function visitorId(openid) { return 'gv_' + digest(openid); }
function day(at) { return new Date(new Date(at).getTime() + 8 * 3600000).toISOString().slice(0, 10); }
async function read(scope, collection, id) {
  try { return (await scope.collection(collection).doc(id).get()).data || null; }
  catch (error) {
    if (/document.*does not exist|document.*not found/i.test(String(error.errMsg || error.message || ''))) return null;
    throw error;
  }
}
function createService({ db, assert, getContext, actorId, isTest, validateExample, validateGuide, now = () => new Date() }) {
  async function record(event) {
    assert(['view', 'example', 'create_click', 'landing', 'load_error'].includes(event.event), 'GROWTH_INVALID_EVENT', '访问类型无效');
    assert(PAGES.includes(event.page), 'GROWTH_INVALID_PAGE', '公开页面无效');
    const entryType = event.entryType === undefined ? '' : event.entryType;
    assert(entryType === '' || (entryType === 'default_example' && event.page === 'pages/example/index'), 'GROWTH_INVALID_ENTRY', '入口类型无效');
    const landingEvent = ['landing', 'load_error'].includes(event.event);
    assert(!landingEvent || entryType === 'default_example', 'GROWTH_INVALID_EVENT', '入口事件无效');
    const context = getContext();
    const origin = source(event.scene);
    if (!context.OPENID || origin === 'excluded') return { recorded: false, reason: origin === 'excluded' ? 'excluded' : 'no_identity' };
    const slug = String(event.slug || '');
    assert(slug.length <= 80 && !/[\s/?&#]/.test(slug), 'GROWTH_INVALID_CONTENT', '公开内容无效');
    if (entryType && (landingEvent || event.event === 'create_click')) assert(!slug, 'GROWTH_INVALID_CONTENT', '入口事件不需要内容参数');
    else if (event.page === 'pages/guide/index') await validateGuide(slug);
    else if (['pages/example/index', 'pages/example-person-detail/index', 'pages/example-reading/index'].includes(event.page)) {
      assert(slug, 'GROWTH_INVALID_CONTENT', '缺少示例');
      await validateExample(slug);
    } else assert(!slug, 'GROWTH_INVALID_CONTENT', '此页面不需要内容参数');
    assert(event.event !== 'example' || event.page === 'pages/example/index', 'GROWTH_INVALID_EVENT', '示例事件无效');
    const at = now();
    const id = visitorId(context.OPENID);
    const test = Boolean(isTest(context));
    const parts = [id, day(at), event.event, event.page, slug];
    if (entryType) parts.push(entryType);
    const key = 'ge_' + digest(parts.join('|'));
    await db.runTransaction(async function (scope) {
      const visitor = await read(scope, 'growth_visitors', id);
      const previous = await read(scope, 'growth_events', key);
      if (!visitor) await scope.collection('growth_visitors').doc(id).set({ data: {
        firstAt: at, firstDay: day(at), page: event.page, slug, source: origin, test, ...(entryType ? { entryType } : {}),
        attributionEndsAt: new Date(at.getTime() + 7 * DAY), expiresAt: new Date(at.getTime() + 180 * DAY)
      } });
      if (!previous) await scope.collection('growth_events').doc(key).set({ data: {
        visitorId: id, day: day(at), event: event.event, page: event.page, slug, at, test, ...(entryType ? { entryType } : {}),
        expiresAt: new Date(at.getTime() + 180 * DAY)
      } });
    });
    return { recorded: true };
  }
  async function link(user) {
    const context = getContext();
    if (!context.OPENID || !user || user.status !== 'active') return;
    const id = visitorId(context.OPENID);
    await db.runTransaction(async function (scope) {
      const visitor = await read(scope, 'growth_visitors', id);
      if (!visitor || visitor.userId || now() >= new Date(visitor.attributionEndsAt)) return;
      const saved = Number.isFinite(new Date(user.createdAt).getTime()) ? user : await read(scope, 'users', actorId(context.OPENID));
      const created = saved && new Date(saved.createdAt).getTime();
      if (created < new Date(visitor.firstAt).getTime() || !Number.isFinite(created)) return;
      await scope.collection('growth_visitors').doc(id).update({ data: { userId: actorId(context.OPENID), registeredAt: saved.createdAt } });
    });
  }
  return { record, link };
}
module.exports = { createService, source, visitorId, PAGES, DAY };
