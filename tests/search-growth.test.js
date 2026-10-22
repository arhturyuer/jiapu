require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('./helpers/membership-db');
const { runtime } = require('./helpers/counting-runtime');
const growth = require('../cloudfunctions/youpuUserApi/growth');
const reports = require('../cloudfunctions/youpuOpsApi/growth');
const ranges = require('../cloudfunctions/youpuOpsApi/analytics');
const publicContent = require('../miniprogram/utils/public-content');
const guides = require('./fixtures/legacy-guides');
const root = path.resolve(__dirname, '..');
const start = new Date('2026-10-01T00:00:00+08:00');

function fixture(options = {}) {
  const db = createDatabase(); db.now = new Date(start);
  const context = { OPENID: 'fictional-visitor', ENV: 'fictional-environment' };
  const service = growth.createService({ db, assert: (condition, code, message) => { if (!condition) throw Object.assign(new Error(message), { code }); },
    getContext: () => context, actorId: () => 'new-user', isTest: () => Boolean(options.test), now: () => new Date(db.now),
    validateGuide: async slug => { if (!guides.get(slug)) throw Object.assign(new Error('下架'), { code: 'GUIDE_NOT_FOUND' }); },
    validateExample: async slug => { if (slug !== 'published-example') throw Object.assign(new Error('下架'), { code: 'EXAMPLE_NOT_FOUND' }); } });
  const event = { event: 'view', page: 'pages/guide/index', slug: guides.guides[0].slug, scene: 1005 };
  return { db, context, service, event };
}

test('默认入口只用本机家谱选择路径，明确直达链接保持不变', () => {
  assert.equal(publicContent.defaultPath({}, false), 'pages/example/index');
  assert.equal(publicContent.defaultPath({}, true), 'pages/tree/index');
  assert.equal(publicContent.defaultPath({ path: 'pages/invite/index', query: { token: 'fake' } }, false), 'pages/invite/index');
  assert.equal(publicContent.defaultPath({ path: 'pages/guide/index' }, true), 'pages/guide/index');
  assert.equal(publicContent.isPublic('pages/member-detail/index'), false);
  assert.deepEqual(publicContent.defaultTarget({ path: 'pages/launch-ad/index' }, false), { path: 'pages/example/index', query: { entry: 'default' } });
  assert.deepEqual(publicContent.defaultTarget({ path: 'pages/example/index', query: { slug: 'shared', personId: 'p' } }, false), { path: 'pages/example/index', query: { slug: 'shared', personId: 'p' } });
});

test('八篇指南有正文、问答、有效相关推荐和稳定唯一 slug', () => {
  assert.equal(guides.guides.length, 8);
  assert.equal(new Set(guides.guides.map(row => row.slug)).size, 8);
  assert.deepEqual(guides.guides.map(row => row.slug).sort(), require('../cloudfunctions/youpuJobs/guides-seed.json').map(row => row.slug).sort());
  for (const guide of guides.guides) {
    assert.match(guide.slug, /^[a-z]+(?:-[a-z]+)*$/);
    assert.ok(guide.title && guide.summary && guide.sections.length >= 3 && guide.questions.length >= 2);
    for (const slug of guide.related) assert.ok(guides.get(slug));
  }
  assert.equal(guides.get('missing'), null);
});

test('sitemap 默认禁止私密页，仅允许规范公开路径和参数组合', () => {
  const sitemap = require('../miniprogram/sitemap.json');
  function allowed(page, query = {}) {
    const keys = Object.keys(query).sort();
    return sitemap.rules.find(rule => (rule.page === '*' || rule.page === page) && (!rule.params || (rule.matching === 'exact' && JSON.stringify([...rule.params].sort()) === JSON.stringify(keys))))?.action === 'allow';
  }
  for (const page of ['tree', 'member-detail', 'invite', 'members', 'profile', 'pdf-export', 'family-backup']) assert.equal(allowed('pages/' + page + '/index'), false);
  assert.equal(allowed('pages/invite/index', { token: 'fake' }), false);
  assert.equal(allowed('pages/guide/index', { slug: 'prepare-family-records' }), true);
  assert.equal(allowed('pages/guide/index'), false);
  assert.equal(allowed('pages/example/index', { slug: 'fake' }), true);
  assert.equal(allowed('pages/example/index', { slug: 'fake', source: 'share_menu' }), false);
  assert.equal(allowed('pages/example/index', { slug: 'fake', personId: 'fake' }), false);
  assert.equal(allowed('pages/examples/index', { select: '1' }), false);
});

test('官方搜索场景分类明确，source 参数和未知场景不推定为搜索', () => {
  for (const scene of [1005, 1006, 1027, 1042, 1053, 1183]) assert.equal(growth.source(scene), 'search');
  for (const scene of [1129, 1030, 1203]) assert.equal(growth.source(scene), 'excluded');
  assert.equal(growth.source('search'), 'unknown'); assert.equal(growth.source(9999), 'unknown');
});

test('公开阅读并发、重试按北京时间日期幂等，无用户建档或私人字段', async () => {
  const { db, service, event } = fixture();
  await Promise.all([service.record(event), service.record(event), service.record(event)]);
  assert.equal(db.all('growth_visitors').length, 1); assert.equal(db.all('growth_events').length, 1);
  assert.equal(db.all('users').length, 0); assert.equal(db.all('analytics_activity_daily').length, 0);
  assert.doesNotMatch(JSON.stringify(db.all('growth_visitors')), /fictional-visitor|openid|姓名|token/);
  db.now = new Date(start.getTime() + growth.DAY);
  await service.record({ ...event, scene: 1007 });
  assert.equal(db.all('growth_events').length, 2);
  assert.equal(db.all('growth_visitors')[0].source, 'search', '后续来源不能覆盖首次触达');
  assert.equal(new Date(db.all('growth_visitors')[0].expiresAt) - start, 180 * growth.DAY);
});

test('默认首屏曝光不依赖示例，失败与点击可记录，旧参数与幂等键兼容', async () => {
  const { db, service, context } = fixture();
  const input = { page: 'pages/example/index', entryType: 'default_example', scene: 1001 };
  await Promise.all([service.record({ ...input, event: 'landing' }), service.record({ ...input, event: 'landing' })]);
  await service.record({ ...input, event: 'load_error' });
  await service.record({ ...input, event: 'create_click' });
  await service.record({ ...input, event: 'example', slug: 'published-example' });
  const visitor = db.get('growth_visitors', growth.visitorId(context.OPENID));
  assert.equal(visitor.entryType, 'default_example'); assert.equal(visitor.slug, ''); assert.equal(visitor.source, 'unknown');
  assert.equal(db.all('growth_events').length, 4); assert.equal(db.all('users').length, 0);
  for (const invalid of [{ ...input, event: 'landing', slug: 'draft-example' }, { ...input, event: 'landing', entryType: '' },
    { ...input, event: 'view' }, { ...input, event: 'landing', page: 'pages/about/index' }, { ...input, event: 'landing', entryType: 'other' }]) await assert.rejects(service.record(invalid));
  db.now = new Date(start.getTime() + growth.DAY);
  await service.record({ ...input, event: 'landing' });
  assert.equal(db.all('growth_visitors').length, 1);
  assert.equal(new Date(db.all('growth_visitors')[0].firstAt).getTime(), start.getTime());
});

test('默认入口分母包含失败访客，重试成功与失败并存，直达和旧记录不混入首屏指标', () => {
  const at = offset => new Date(start.getTime() + offset * growth.DAY);
  const visitors = ['failed', 'retry', 'success'].map(_id => ({ _id, firstAt: at(0), page: 'pages/example/index', slug: '', entryType: 'default_example', source: 'unknown' }));
  visitors[2].userId = 'new';
  visitors.push({ _id: 'old', firstAt: at(0), page: 'pages/example/index', slug: 'published-example', source: 'unknown' });
  const events = [
    { visitorId: 'failed', event: 'load_error', entryType: 'default_example', at: at(0) },
    { visitorId: 'failed', event: 'example', at: at(1) },
    { visitorId: 'retry', event: 'load_error', entryType: 'default_example', at: at(0) },
    { visitorId: 'retry', event: 'example', entryType: 'default_example', at: at(1) },
    { visitorId: 'success', event: 'example', entryType: 'default_example', at: at(0) },
    { visitorId: 'success', event: 'create_click', entryType: 'default_example', at: at(1) },
    { visitorId: 'old', event: 'example', at: at(0) }
  ];
  const users = [{ _id: 'new', createdAt: at(1), firstCreatedFamilyAt: at(2) }];
  const families = [{ _id: 'family', creatorId: 'new', createdAt: at(2), firstRelativeJoinedAt: at(3) }];
  const filters = { ...ranges.range({ startDay: '2026-10-01', endDay: '2026-10-01' }, at(20)), source: 'all' };
  const result = reports.summarize(visitors, events, users, families, filters, at(-1));
  assert.equal(result.totals.visitors, 4); assert.equal(result.totals.exampleVisitors, 4); assert.equal(result.defaultEntry.visitors, 3);
  assert.equal(result.defaultEntry.loadSuccessRate, 66.67); assert.equal(result.defaultEntry.loadErrorVisitors, 2);
  assert.equal(result.defaultEntry.clickRate, 33.33); assert.equal(result.defaultEntry.createRate, 33.33);
  assert.equal(result.defaultEntry.relativeRate, 100); assert.equal(result.defaultEntry.mature, true);
  const empty = reports.summarize([], [], [], [], filters, at(-1));
  assert.equal(empty.defaultEntry.loadSuccessRate, null); assert.equal(empty.defaultEntry.createRate, null);
});

test('无身份、爬虫及压测不写用户级数据，staging 测试单独标记', async () => {
  const { db, context, service, event } = fixture();
  context.OPENID = '';
  assert.equal((await service.record(event)).recorded, false);
  context.OPENID = 'fake';
  assert.equal((await service.record({ ...event, scene: 1129 })).recorded, false);
  assert.equal(db.all('growth_visitors').length, 0);
  const stage = fixture({ test: true }); await stage.service.record(stage.event);
  assert.equal(stage.db.all('growth_visitors')[0].test, true);
});

test('非法页面、未发布示例及伪造内容被拒绝，不保存任意路径', async () => {
  const { db, service, event } = fixture();
  for (const input of [{ ...event, page: 'pages/tree/index' }, { ...event, slug: 'missing' }, { ...event, event: 'paid' },
    { ...event, page: 'pages/about/index', slug: 'arbitrary' }, { ...event, page: 'pages/example/index', slug: 'draft-example' }]) {
    await assert.rejects(service.record(input));
  }
  assert.equal(db.all('growth_visitors').length, 0);
});

test('仅在7天窗口内关联新建活跃账户，老账户、冻结及过期不关联', async () => {
  for (const kind of ['new', 'old', 'frozen', 'expired']) {
    const { db, context, service, event } = fixture(); await service.record(event);
    db.now = new Date(start.getTime() + (kind === 'expired' ? 7 * growth.DAY : 1000));
    await service.link({ status: kind === 'frozen' ? 'frozen' : 'active', createdAt: new Date(start.getTime() + (kind === 'old' ? -1000 : 500)) });
    const linked = db.get('growth_visitors', growth.visitorId(context.OPENID));
    assert.equal(linked.userId, kind === 'new' ? 'new-user' : undefined);
  }
});

test('真实7天队列按入口独立汇总，不混入老账号、测试、过期或未来事件', () => {
  const at = offset => new Date(start.getTime() + offset * growth.DAY);
  const visitors = [
    { _id: 'v1', firstAt: at(0), page: 'pages/guide/index', slug: 'one', source: 'search', userId: 'u1' },
    { _id: 'v2', firstAt: at(0), page: 'pages/guide/index', slug: 'two', source: 'search', userId: 'u2' },
    { _id: 'v3', firstAt: at(0), page: 'pages/guide/index', slug: 'two', source: 'share' },
    { _id: 'test', firstAt: at(0), page: 'pages/guide/index', slug: 'one', source: 'search', test: true }
  ];
  const events = [{ visitorId: 'v1', event: 'example', at: at(1) }, { visitorId: 'v1', event: 'example', at: at(2) },
    { visitorId: 'v1', event: 'create_click', at: at(1) }, { visitorId: 'v2', event: 'example', at: at(7) }, { visitorId: 'v1', event: 'view', at: at(30) }];
  const users = [{ _id: 'u1', createdAt: at(0.1), firstCreatedFamilyAt: at(6) }, { _id: 'u2', createdAt: at(-1), firstCreatedFamilyAt: at(1) }];
  const families = [{ _id: 'f1', creatorId: 'u1', createdAt: at(6), firstRelativeJoinedAt: at(8) }];
  const filters = { ...ranges.range({ startDay: '2026-10-01', endDay: '2026-10-01', window: '7d' }, at(20)), source: 'search' };
  const result = reports.summarize(visitors, events, users, families, filters, at(-1));
  assert.equal(result.totals.visitors, 2); assert.equal(result.totals.exampleVisitors, 1);
  assert.equal(result.totals.newUsers, 1); assert.equal(result.totals.createdUsers, 1);
  assert.equal(result.totals.createRate, 50); assert.equal(result.totals.relativeRate, 100);
  assert.equal(result.rows.find(row => row.slug === 'two').visitors, 1, '新分组不能继承之前分组的累计数');
  assert.equal(result.mature, true); assert.equal(result.complete, true);
  const partial = reports.summarize(visitors, events, users, families, { ...filters, asOf: at(1).getTime() }, at(0));
  assert.equal(partial.totals.createdUsers, 0); assert.equal(partial.complete, false); assert.equal(partial.mature, false);
});

test('公开示例真实路由无需建档，只读已发布快照，旧私密接口仍拒绝无账号', async () => {
  const db = createDatabase();
  db.put('example_templates', 'published', { slug: 'published', status: 'published', title: '虚构示例',
    draftContent: { private: '不得返回的草稿' }, publishedContent: { family: { name: '虚构' }, persons: [{ _id: 'p', name: '示例人物', gender: 'male', avatarAssetId: 'private-asset', photoAssetIds: ['private'] }], relations: [] } });
  db.put('example_templates', 'draft', { slug: 'draft', status: 'draft', publishedContent: { family: {} } });
  const user = runtime(path.join(root, 'cloudfunctions/youpuUserApi'), db, { actor: '' });
  const list = await user.call({ type: 'public.examples.list' });
  assert.equal(list.success, true); assert.equal(list.data.items.length, 1);
  const detail = await user.call({ type: 'public.examples.get', slug: 'published' });
  assert.equal(detail.success, true); assert.equal(detail.data.example.persons[0].avatarAssetId, '');
  assert.doesNotMatch(JSON.stringify(detail), /不得返回的草稿|private-asset/);
  assert.equal((await user.call({ type: 'public.examples.get', slug: 'draft' })).success, false);
  assert.equal((await user.call({ type: 'examples.get', slug: 'published' })).success, false);
  assert.equal((await user.call({ type: 'person.get', personId: 'p' })).success, false);
  assert.equal(db.all('users').length, 0); assert.equal(db.all('analytics_activity_daily').length, 0);
});

test('实际用户API公开阅读不建档，显式登录后才关联新账号', async () => {
  const db = createDatabase();
  const user = runtime(path.join(root, 'cloudfunctions/youpuUserApi'), db);
  assert.equal((await user.call({ type: 'growth.record', event: 'view', page: 'pages/guides/index', scene: 1005 })).success, true);
  assert.equal(db.all('users').length, 0);
  db.now = new Date(Date.now() + 1000);
  const result = await user.call({ type: 'auth.login', growthEntry: true });
  assert.equal(result.success, true);
  assert.equal(db.all('growth_visitors')[0].userId, result.data.user._id);
  const oldId = db.all('growth_visitors')[0]._id;
  await user.call({ type: 'auth.login', growthEntry: true });
  assert.equal(db.all('growth_visitors')[0]._id, oldId);
});

test('App公开冷启动和前台直达不登录、不写原活跃；业务请求仍需身份', async () => {
  const vm = require('node:vm');
  const calls = []; let app;
  const environment = { active: 'staging', environments: { staging: { cloudEnv: 'fictional-stage' } },
    resolveRuntimeEnvironment: () => ({ active: 'staging', runtimeVersion: 'develop', environment: { cloudEnv: 'fictional-stage' } }) };
  const wx = { cloud: { init() {} }, getAccountInfoSync: () => ({ miniProgram: { appId: 'fictional-app' } }), getStorageSync: () => '', removeStorageSync() {} };
  const dependencies = {
    './utils/api': { call: type => { calls.push(type); return Promise.reject(new Error('登录不可用')); } },
    './config/env': environment, './utils/public-content': publicContent, './utils/growth': { enter() {} },
    './utils/reading-preference': { refresh() {} },
    './utils/launch-ad': { begin(target, options) { target._launchAd = { target: { path: publicContent.defaultPath(options, Boolean(target._preferredFamilyId)) } }; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8'), { App: value => { app = value; }, wx,
    require: name => dependencies[name] || {}, setInterval: () => { throw new Error('公开阅读不启动业务计时器'); }, clearInterval() {}, console: { error() {} } });
  app.onLaunch({ path: 'pages/guide/index', scene: 1005 });
  app.onShow({ path: 'pages/guide/index', scene: 1005 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  app.globalData.loggedIn = true; app.globalData.user = { _id: 'existing' };
  app.recordVisibleActivity();
  assert.deepEqual(calls, [], '先前私密页留下的计时器不能在公开页采集业务活动');
  app.globalData.loggedIn = false; app.globalData.user = null;
  app._publicBrowsing = false;
  app.onShow({ path: 'pages/examples/index', scene: 1005 });
  assert.deepEqual(calls, []);
  await assert.rejects(app.ensureLogin());
  assert.deepEqual(calls, ['auth.login']);
});

test('公开分享准备、发送和打开保持原漏斗，重试幂等且不建档', async () => {
  const db = createDatabase(); const user = runtime(path.join(root, 'cloudfunctions/youpuUserApi'), db);
  for (const stage of ['prepared', 'sent', 'opened']) {
    const input = { type: 'public.share.record', kind: 'discovery', stage, requestId: 'public-' + stage, scene: 1007 };
    assert.equal((await user.call(input)).success, true);
    assert.equal((await user.call(input)).success, true);
  }
  const counter = db.all('share_metrics_daily')[0];
  assert.equal(counter.prepared, 1); assert.equal(counter.sent, 1); assert.equal(counter.opened, 1);
  assert.equal(db.all('users').length, 0); assert.equal(db.all('analytics_activity_daily').length, 0);
  assert.equal((await user.call({ type: 'public.share.record', kind: 'discovery', stage: 'opened', invitationId: 'private-invite' })).success, false);
  assert.equal((await user.call({ type: 'public.share.record', kind: 'example', slug: 'unpublished', stage: 'opened' })).success, false);
  assert.equal((await user.call({ type: 'public.share.record', kind: 'discovery', stage: 'opened', scene: 1129 })).data.recorded, false);
  assert.equal(db.all('share_metrics_daily')[0].opened, 1);
});

test('保留的私密Tab重新显示会退出公开阅读状态', () => {
  const oldApp = global.getApp; const oldWx = global.wx;
  const app = { globalData: {}, _publicBrowsing: true };
  global.getApp = () => app; global.wx = {};
  try {
    const wrapper = require('../miniprogram/utils/launch-ad');
    const page = wrapper.wrap({ data: {}, onShow() {} });
    page.setData = patch => Object.assign(page.data, patch);
    page.onShow();
    assert.equal(app._publicBrowsing, false);
  } finally { global.getApp = oldApp; global.wx = oldWx; }
});
