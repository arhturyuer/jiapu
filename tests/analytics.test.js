const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const analytics = require('../cloudfunctions/youpuOpsApi/analytics');
const capture = require('../cloudfunctions/youpuUserApi/analytics');
const root = path.resolve(__dirname, '..');
const now = new Date('2026-10-03T10:00:00Z');
const time = day => day + 'T01:00:00+08:00';
function summarize(input = {}, filters = {}) {
  return analytics.summarize(Object.assign({ trackingStartedAt: time('2026-09-01') }, input), analytics.range(Object.assign({ startDay: '2026-10-01', endDay: '2026-10-03', paymentMode: 'live', window: 'asOf' }, filters), now));
}

test('北京时间归日、严格日期和 90 天上限与窗口校验', () => {
  assert.equal(analytics.day('2026-10-01T16:00:00Z'), '2026-10-02');
  assert.equal(capture.day(new Date('2026-10-01T16:00:00Z')), '2026-10-02');
  for (const input of [{ startDay: '2026-02-30' }, { startDay: '2026-06-01' }, { endDay: '2026-10-04' }, { startDay: '2026-10-03', endDay: '2026-10-01' }, { window: 'unknown' }, { paymentMode: 'unknown' }]) {
    assert.throws(() => analytics.range(input, now), { code: 'ANALYTICS_INVALID_RANGE' });
  }
  assert.equal(analytics.range({ startDay: '2026-07-06', endDay: '2026-10-03' }, now).endDay, '2026-10-03');
});

test('新用户按首次进入日分组，创建加入去重且率使用总分子分母', () => {
  const report = summarize({ users: [
    { _id: 'u1', createdAt: time('2026-10-01'), firstEnteredFamilyAt: time('2026-10-02'), firstCreatedFamilyAt: time('2026-10-01'), firstJoinedFamilyAt: time('2026-10-02') },
    { _id: 'u2', createdAt: time('2026-10-01') },
    { _id: 'u3', createdAt: time('2026-10-02'), firstCreatedFamilyAt: time('2026-10-02') },
    { _id: 'u4', createdAt: time('2026-10-03'), firstJoinedFamilyAt: '2026-10-03T20:00:00Z' }
  ] });
  assert.equal(report.rows[0].newUsers, 2);
  assert.equal(report.rows[0].enterRate, 50);
  assert.equal(report.totals.createRate, 50);
  assert.equal(report.totals.joinedUsers, 1);
  assert.equal(report.rows[2].partial, true);
  const sameDay = summarize({ users: [{ createdAt: time('2026-10-01'), firstJoinedFamilyAt: time('2026-10-02') }] }, { window: 'day' });
  assert.equal(sameDay.rows[0].joinedUsers, 0);
  assert.equal(sameDay.rows[0].mature, true);
  const seven = summarize({ users: [{ createdAt: time('2026-10-01'), firstJoinedFamilyAt: time('2026-10-02') }] }, { window: '7d' });
  assert.equal(seven.rows[0].joinedUsers, 1);
  assert.equal(seven.rows[0].mature, false);
});

test('建谱日队列只按家谱计数，不把人物或重复加入当作新家谱', () => {
  const report = summarize({ families: [
    { _id: 'f1', createdAt: time('2026-10-01'), firstRelativeJoinedAt: time('2026-10-02'), personCount: 50 },
    { _id: 'f2', createdAt: time('2026-10-01'), personCount: 100 },
    { _id: 'f3', createdAt: time('2026-10-02'), firstRelativeJoinedAt: time('2026-10-02') }
  ] });
  assert.equal(report.rows[0].relativeRate, 50);
  assert.equal(report.totals.relativeRate, 66.67);
  assert.equal(summarize({ families: [{ createdAt: time('2026-10-01'), firstRelativeJoinedAt: time('2026-10-02') }] }, { window: 'day' }).totals.relativeRate, 0);
});

test('日活与期间活跃各自去重，未采集不是零，空分母不可计算', () => {
  const input = { activity: [
    { day: '2026-10-01', kind: 'user', entityId: 'u1' }, { day: '2026-10-01', kind: 'user', entityId: 'u1' },
    { day: '2026-10-02', kind: 'user', entityId: 'u1' }, { day: '2026-10-02', kind: 'user', entityId: 'u2' },
    { day: '2026-10-01', kind: 'family', entityId: 'f1' }, { day: '2026-10-02', kind: 'family', entityId: 'f1' }
  ] };
  const report = summarize(input);
  assert.equal(report.rows[0].dau, 1);
  assert.equal(report.rows[1].dau, 2);
  assert.equal(report.totals.activeUsers, 2);
  assert.equal(report.totals.activeFamilies, 1);
  assert.equal(report.rows[2].dau, 0);
  assert.equal(report.rows[0].createRate, null);
  const incomplete = summarize(Object.assign(input, { trackingStartedAt: time('2026-10-01') }));
  assert.equal(incomplete.rows[0].dau, null);
  assert.equal(incomplete.rows[1].dau, 2);
  assert.equal(incomplete.totals.averageDau, null);
  assert.equal(incomplete.totals.enterRate, null);
});

test('支付、退款跨日归属，过滤支付环境，订单重复回读不重复计数', () => {
  const orders = [
    { _id: 'o1', createdAt: time('2026-10-01'), paidAt: time('2026-10-02'), refundedAt: time('2026-10-03'), status: 'refunded', priceCents: 900, payerUserId: 'u1', familyId: 'f1', productId: 'pro', paymentMode: 'live' },
    { _id: 'o2', createdAt: time('2026-09-30'), paidAt: time('2026-10-02'), status: 'fulfilled', priceCents: 200, payerUserId: 'u1', familyId: 'f1', productId: 'pro', paymentMode: 'live' },
    { _id: 'o3', createdAt: time('2026-10-01'), status: 'pending', priceCents: 900, paymentMode: 'live' },
    { _id: 'o4', createdAt: time('2026-10-01'), paidAt: time('2026-10-01'), status: 'fulfilled', priceCents: 9999, payerUserId: 'u2', familyId: 'f2', productId: 'mock', paymentMode: 'mock' }
  ];
  const report = summarize({ orders: orders.concat(orders[0]) });
  assert.equal(report.rows[0].paymentRate, 50);
  assert.equal(report.rows[0].gmvCents, 0);
  assert.equal(report.rows[1].gmvCents, 1100);
  assert.equal(report.rows[2].refundCents, 900);
  assert.equal(report.rows[2].netCents, -900);
  assert.equal(report.totals.netCents, 200);
  assert.equal(report.totals.payingUsers, 1);
  assert.equal(report.totals.payingFamilies, 1);
  assert.equal(report.totals.arppuCents, 1100);
  assert.equal(report.sku[0].orders, 2);
  assert.equal(summarize({ orders }, { paymentMode: 'mock' }).totals.gmvCents, 9999);
  assert.equal(summarize({ orders }, { paymentMode: 'all' }).totals.gmvCents, 11099);
});

test('采集按日实体幂等，首转化不可被重试覆盖，冻结用户不采集', async () => {
  const docs = new Map([['users/u1', { _id: 'u1', status: 'active' }]]);
  let writes = 0;
  const db = { serverDate: () => '2026-10-03T01:00:00Z', runTransaction: callback => callback(db), collection: name => ({ doc: id => ({
    get: async () => ({ data: docs.get(name + '/' + id) }),
    set: async ({ data }) => { writes += 1; docs.set(name + '/' + id, data); },
    update: async ({ data }) => { writes += 1; docs.set(name + '/' + id, Object.assign({}, docs.get(name + '/' + id), data)); }
  }) }) };
  const tracker = capture.createTracker(db);
  await tracker.record(docs.get('users/u1'), 'f1', true);
  const initialWrites = writes;
  await tracker.record(docs.get('users/u1'), 'f1', true);
  assert.equal(writes, initialWrites);
  await capture.createTracker(db).record(docs.get('users/u1'), 'f1', true);
  assert.equal(Array.from(docs.keys()).filter(key => key.startsWith('analytics_activity_daily')).length, 2);
  assert.equal(docs.get('users/u1').firstEnteredFamilyAt, '2026-10-03T01:00:00Z');
  await capture.firstConversion(db, db, 'u1', 'firstJoinedFamilyAt', time('2026-10-01'));
  await capture.firstConversion(db, db, 'u1', 'firstJoinedFamilyAt', time('2026-10-02'));
  assert.equal(docs.get('users/u1').firstJoinedFamilyAt, time('2026-10-01'));
  const before = writes;
  await tracker.record({ _id: 'frozen', status: 'frozen' }, 'f1', true);
  assert.equal(writes, before);
});

test('运营汇总与访问接口在读取和采集前进行角色、成员校验', async () => {
  const ops = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const source = ops.slice(ops.indexOf('async function analyticsSummary'), ops.indexOf('async function commerceOrders'));
  let reads = 0;
  const context = { analytics, requireOperator: async () => { const error = new Error('denied'); error.code = 'NO_PERMISSION'; throw error; }, maybeGet: () => { reads += 1; } };
  vm.runInNewContext(source + '; result = analyticsSummary;', context);
  await assert.rejects(context.result({}, {}), { code: 'NO_PERMISSION' });
  assert.equal(reads, 0);
  const user = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const visit = user.slice(user.indexOf('async function analyticsTrack'), user.indexOf('// Old clients contribute'));
  let recorded = false;
  const userContext = { db: {}, assert: condition => assert.ok(condition), getOpenid: () => 'fake', cleanText: value => value, requireActiveUser: async () => ({ _id: 'u1' }), requireMembership: async () => { throw new Error('no access'); }, ACTIVE_ROLES: [], analyticsTracker: { record: async () => { recorded = true; } } };
  vm.runInNewContext(visit + '; result = analyticsTrack;', userContext);
  await assert.rejects(userContext.result({ kind: 'family', familyId: 'other' }), /no access/);
  assert.equal(recorded, false);
});

test('自动采集故障不会把已提交的业务结果变成失败', async () => {
  const user = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const source = user.slice(user.indexOf('exports.main = async function'));
  const expected = { family: { _id: 'f1' } };
  const context = {
    testAccounts: { run: async (context, callback) => callback(), usesTestIdentity: () => false }, recordBusinessActivity: async () => { throw new Error('store offline'); },
    exports: {}, Date, cleanText: value => value || '', randomToken: () => 'request',
    cloud: { getWXContext: () => ({ OPENID: 'fake' }) }, userId: () => 'u1',
    handlers: { 'family.create': async () => expected }, assert: (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); },
    MUTATION_TYPES: new Set(['family.create']), RATE_LIMITS: {},
    maybeGet: async () => ({ _id: 'u1', status: 'active' }), analyticsTracker: { record: async () => { throw new Error('store offline'); } },
    console: { log() {}, warn() {}, error() {} }, success: data => ({ success: true, data })
  };
  vm.runInNewContext(source, context);
  const response = await context.exports.main({ type: 'family.create' });
  assert.equal(response.success, true);
  assert.equal(response.data, expected);
});

test('客户端缓存访问每天按用户家谱上报一次，失败可重试，切日重置', async () => {
  const app = fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8');
  const source = app.slice(app.indexOf('  recordVisit: function'), app.indexOf('  getPersonDetail: function'));
  let clock = Date.parse('2026-10-01T15:59:59Z');
  let calls = 0;
  let fail = false;
  const context = {
    Date: class extends Date { static now() { return clock; } },
    api: { call: async (type, input) => { assert.equal(type, 'analytics.track'); assert.equal(input.familyId, 'f1'); calls += 1; if (fail) throw new Error('offline'); } }
  };
  vm.runInNewContext('result = {' + source + '};', context);
  const client = Object.assign(context.result, { globalData: { user: { _id: 'u1' }, loggedIn: true } });
  client.recordFamilyVisit('f1'); client.recordFamilyVisit('f1');
  assert.equal(calls, 1);
  clock += 2000;
  fail = true;
  client.recordFamilyVisit('f1');
  await Promise.resolve(); await Promise.resolve();
  fail = false;
  client.recordFamilyVisit('f1');
  assert.equal(calls, 3);
  client.globalData.user = { _id: 'u2' };
  client.recordFamilyVisit('f1');
  assert.equal(calls, 4);
  client.globalData.loggedIn = false;
  clock += 86400000;
  client.recordFamilyVisit('f1');
  assert.equal(calls, 4);
});

const { createService } = require('../cloudfunctions/youpuOpsApi/analytics-service');
function storageFixture(tables = {}) {
  const tablesByName = structuredClone(tables);
  let reads = 0;
  function operator(check) { return { check, and: other => operator(value => check(value) && other.check(value)) }; }
  const comparable = (actual, value) => value instanceof Date ? new Date(actual) : actual;
  const command = {
    gte: value => operator(actual => comparable(actual, value) >= value), gt: value => operator(actual => comparable(actual, value) > value),
    lt: value => operator(actual => comparable(actual, value) < value), lte: value => operator(actual => comparable(actual, value) <= value)
  };
  const matches = (row, where) => Object.entries(where || {}).every(([field, value]) => value && value.check ? value.check(row[field]) : row[field] === value);
  const rows = name => tablesByName[name] || (tablesByName[name] = []);
  const db = { collection: name => ({
    doc: id => ({ get: async () => ({ data: structuredClone(rows(name).find(row => row._id === id) || null) }),
      set: async ({ data }) => { const list = rows(name); const index = list.findIndex(row => row._id === id); const row = structuredClone({ ...data, _id: id }); if (index < 0) list.push(row); else list[index] = row; }
    }),
    where: condition => ({ orderBy: () => ({ limit: count => ({ get: async () => ({ data: structuredClone(rows(name).filter(row => matches(row, condition)).sort((a, b) => a.offset - b.offset).slice(0, count)) }) }) }) })
  }) };
  const listAll = async (name, where, limit) => { reads += 1; const result = rows(name).filter(row => matches(row, where)); if (result.length > limit) throw Object.assign(new Error('limit'), { code: 'RESULT_LIMIT_EXCEEDED' }); return structuredClone(result); };
  const listByIds = async (name, field, ids, where, limit) => (await listAll(name, where, limit)).filter(row => ids.includes(row[field]));
  return { db, command, listAll, listByIds, maybeGet: async (name, id) => (await db.collection(name).doc(id).get()).data, tables: tablesByName, reads: () => reads };
}

test('确认口径：10位新用户，6示例4真实2创建3加入，默认当天窗口', () => {
  const users = Array.from({ length: 10 }, (_, index) => ({ _id: 'u' + index, createdAt: time('2026-10-01'),
    ...(index < 6 ? { firstExampleViewedAt: time('2026-10-01') } : {}),
    ...(index < 4 ? { firstEnteredFamilyAt: time('2026-10-01') } : {}),
    ...(index < 2 ? { firstCreatedFamilyAt: time('2026-10-01') } : {}),
    ...(index < 3 ? { firstJoinedFamilyAt: time('2026-10-01') } : {}) }));
  const filters = analytics.range({ startDay: '2026-10-01', endDay: '2026-10-01' }, now);
  assert.equal(filters.window, 'day');
  const report = analytics.summarize({ users, trackingStartedAt: time('2026-09-01') }, filters);
  assert.deepEqual([report.totals.exampleRate, report.totals.enterRate, report.totals.createRate, report.totals.joinRate], [60, 40, 20, 30]);
  users[0].firstEnteredFamilyAt = '2026-10-01T16:00:00Z';
  assert.equal(analytics.summarize({ users, trackingStartedAt: time('2026-09-01') }, filters).totals.enterRate, 30);
});

test('历史加入补充、creator排除、viewer计数、重新加入首次时间、家人退出两个比例分离', async () => {
  const fixture = storageFixture({
    system_config: [{ _id: 'analytics', trackingStartedAt: time('2026-09-01') }],
    users: ['u1', 'u2', 'u3'].map(_id => ({ _id, createdAt: time('2026-10-01'), status: 'active' })),
    families: [{ _id: 'f1', creatorId: 'u1', createdAt: time('2026-10-01'), status: 'active' }],
    family_memberships: [
      { _id: 'm1', familyId: 'f1', userId: 'u1', joinedAt: time('2026-10-01'), role: 'admin', status: 'active' },
      { _id: 'm2', familyId: 'f1', userId: 'u2', firstJoinedAt: time('2026-10-02'), joinedAt: time('2026-10-03'), role: 'viewer', status: 'left' },
      { _id: 'm3', familyId: 'f1', userId: 'u3', joinedAt: time('2026-10-02'), role: 'viewer', status: 'active' }
    ]
  });
  const service = createService(fixture, () => now);
  const report = await service.summary({ startDay: '2026-10-01', endDay: '2026-10-03', window: '7d' });
  assert.equal(report.totals.createRate, 33.33); assert.equal(report.totals.joinedUsers, 2);
  assert.equal(report.totals.relativeRate, 100); assert.equal(report.totals.collaborationRate, 100);
  fixture.tables.family_memberships[2].status = 'left';
  const result = await service.load(analytics.range({ startDay: '2026-10-01', endDay: '2026-10-03', window: '7d' }, now));
  assert.equal(result.report.totals.relativeRate, 100); assert.equal(result.report.totals.collaborationRate, 0);
  assert.equal(result.details.joinedUsers[0].firstJoinedFamilyAt, time('2026-10-02'));
  assert.equal(result.report.users, undefined);
});

test('快照下钻稳定跨chunk翻页、汇总缓存不重复扫描、筛选绑定及24小时过期', async () => {
  let clock = now;
  const fixture = storageFixture({ system_config: [{ _id: 'analytics', trackingStartedAt: time('2026-09-01') }],
    users: Array.from({ length: 150 }, (_, index) => ({ _id: 'u' + String(index).padStart(3, '0'), createdAt: time('2026-10-01'), status: 'active', nickName: '秘密名字', openid: 'private-openid' })) });
  const service = createService(fixture, () => clock);
  const filters = { startDay: '2026-10-01', endDay: '2026-10-01', window: 'day', paymentMode: 'live' };
  const report = await service.summary(filters); const reads = fixture.reads();
  const cached = await service.summary(filters); assert.equal(cached.snapshotId, report.snapshotId); assert.equal(fixture.reads(), reads);
  fixture.tables.users.push({ _id: 'later', createdAt: time('2026-10-01') });
  const seen = []; let cursor = '';
  do {
    const page = await service.details({ ...filters, snapshotId: report.snapshotId, metric: 'newUsers', pageSize: 70, cursor });
    assert.equal(page.total, 150); seen.push(...page.items.map(row => row._id)); cursor = page.nextCursor;
    assert.ok(page.items.every(row => row.openid === undefined && row.nickName === undefined));
  } while (cursor);
  assert.equal(seen.length, 150); assert.equal(new Set(seen).size, 150);
  const request = { ...filters, snapshotId: report.snapshotId, metric: 'newUsers' };
  await assert.rejects(service.details({ ...request, paymentMode: 'mock' }), { code: 'ANALYTICS_INVALID_CURSOR' });
  await assert.rejects(service.details({ ...request, cursor: 'bad' }), { code: 'ANALYTICS_INVALID_CURSOR' });
  clock = new Date(now.getTime() + 86400001);
  await assert.rejects(service.details(request), { code: 'ANALYTICS_SNAPSHOT_EXPIRED' });
});

test('清理后的家谱与成员事实仍统计首次加入，当前协作排除已删除家谱', async () => {
  const fixture = storageFixture({ system_config: [{ _id: 'analytics', trackingStartedAt: time('2026-09-01') }],
    users: [{ _id: 'u1', createdAt: time('2026-10-01') }, { _id: 'u2', createdAt: time('2026-10-01') }],
    analytics_history: [
      { _id: 'family_f1', kind: 'family', entityId: 'f1', creatorId: 'u1', createdAt: time('2026-10-01'), status: 'deleted', cleaned: true },
      { _id: 'membership_m2', kind: 'membership', entityId: 'm2', userId: 'u2', familyId: 'f1', joinedAt: time('2026-10-01'), status: 'deleted' }
    ] });
  const report = await createService(fixture, () => now).load(analytics.range({ startDay: '2026-10-01', endDay: '2026-10-03' }, now));
  assert.equal(report.report.totals.newFamilies, 1); assert.equal(report.report.totals.relativeRate, 100); assert.equal(report.report.totals.collaborationRate, 0);
  assert.equal(report.report.totals.joinedUsers, 1); assert.equal(report.details.newFamilies[0].cleaned, true);
});

test('永久会员与有效期限同一家谱去重，支付用户在注销前后维持统计标识', async () => {
  const fixture = storageFixture({
    system_config: [{ _id: 'analytics', trackingStartedAt: time('2026-09-01') }],
    families: [{ _id: 'f1', creatorId: 'u1', status: 'active', proLifetime: true, proExpiresAt: new Date('2027-01-01') }],
    payment_orders: [
      { _id: 'o1', createdAt: time('2026-10-01'), paidAt: time('2026-10-01'), payerUserId: 'deleted_u1', payerAnalyticsId: 'u1', familyId: 'f1', priceCents: 1000, paymentMode: 'live' },
      { _id: 'o2', createdAt: time('2026-10-02'), paidAt: time('2026-10-02'), payerUserId: 'u1', familyId: 'f1', priceCents: 1000, paymentMode: 'live' }
    ] });
  const result = await createService(fixture, () => now).load(analytics.range({ startDay: '2026-10-01', endDay: '2026-10-03' }, now));
  assert.equal(result.report.totals.activeMemberFamilies, 1); assert.equal(result.report.totals.payingUsers, 1); assert.equal(result.report.totals.arppuCents, 2000);
});

test('注销用户的匿名审计仍排除创建者并与成员记录去重', async () => {
  const fixture = storageFixture({ system_config: [{ _id: 'analytics', trackingStartedAt: time('2026-09-01') }],
    users: [{ _id: 'owner', createdAt: time('2026-09-01'), status: 'deleted', anonymousActorId: 'anon_owner' }, { _id: 'relative', createdAt: time('2026-10-01'), status: 'deleted', anonymousActorId: 'anon_relative' }],
    families: [{ _id: 'f1', creatorId: 'owner', createdAt: time('2026-10-01'), status: 'active' }],
    family_memberships: [{ _id: 'm1', familyId: 'f1', userId: 'relative', joinedAt: time('2026-10-02'), status: 'left' }],
    audit_logs: [
      { _id: 'a1', familyId: 'f1', actorId: 'anon_owner', action: 'membership.join', createdAt: time('2026-10-01') },
      { _id: 'a2', familyId: 'f1', actorId: 'anon_relative', action: 'membership.join', createdAt: time('2026-10-01') }
    ] });
  const result = await createService(fixture, () => now).load(analytics.range({ startDay: '2026-10-01', endDay: '2026-10-03' }, now));
  assert.equal(result.report.totals.joinedUsers, 1); assert.equal(result.details.newFamilies[0].relativeCount, 1);
  assert.equal(result.details.newFamilies[0].firstRelativeJoinedAt, time('2026-10-01'));
});

test('同一个用户多份家谱分别计数，期间率按总分母而非日率平均', () => {
  const report = summarize({ families: [
    { _id: 'f1', creatorId: 'u1', createdAt: time('2026-10-01'), firstRelativeJoinedAt: time('2026-10-01'), activeRelativeCount: 3, status: 'active' },
    { _id: 'f2', creatorId: 'u1', createdAt: time('2026-10-01'), activeRelativeCount: 0, status: 'active' },
    { _id: 'f3', creatorId: 'u1', createdAt: time('2026-10-02'), firstRelativeJoinedAt: time('2026-10-02'), activeRelativeCount: 1, status: 'active' }
  ] }, { window: 'day' });
  assert.equal(report.totals.newFamilies, 3); assert.equal(report.totals.relativeRate, 66.67); assert.equal(report.totals.collaborationRate, 66.67);
});

test('前台停留跨北京时间零点后仍采集用户与正在展示的缓存页面', async () => {
  const source = fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8');
  const methods = source.slice(source.indexOf('  recordVisit: function'), source.indexOf('  getPersonDetail: function'));
  let clock = Date.parse('2026-10-01T15:59:59Z'); const calls = [];
  const page = { route: 'pages/example/index', data: { loading: false, example: {}, slug: 'fixture' } };
  const context = { Date: class extends Date { static now() { return clock; } }, getCurrentPages: () => [page], api: { call: async (_, payload) => { calls.push(payload.kind); } } };
  vm.runInNewContext('result = {' + methods + '};', context);
  const app = Object.assign(context.result, { globalData: { user: { _id: 'u1' }, loggedIn: true } });
  app.recordVisibleActivity(); app.recordVisibleActivity(); assert.deepEqual(calls, ['foreground', 'example']);
  clock += 2000; app.recordVisibleActivity(); assert.deepEqual(calls, ['foreground', 'example', 'foreground', 'example']);
  page.data.loading = true; clock += 86400000; app.recordVisibleActivity(); assert.equal(calls.length, 5);
});

test('超过读取上限明确报错，关联批次不允许拼成静默截断的数据', async () => {
  const fixture = storageFixture();
  const service = createService({ ...fixture, listByIds: async () => Array.from({ length: 20001 }, () => ({ _id: 'oversized' })) }, () => now);
  await assert.rejects(service.summary({ startDay: '2026-10-01', endDay: '2026-10-03' }), { code: 'RESULT_LIMIT_EXCEEDED' });
});

test('每日下钻按队列日、活跃日及支付日分别归属，与每行分子一致', async () => {
  const fixture = storageFixture({
    system_config: [{ _id: 'analytics', trackingStartedAt: time('2026-09-01') }],
    users: [{ _id: 'u1', createdAt: time('2026-10-01'), status: 'active', firstEnteredFamilyAt: time('2026-10-02') }],
    analytics_activity_daily: [{ _id: 'a1', day: '2026-10-01', kind: 'user', entityId: 'u1' }, { _id: 'a2', day: '2026-10-02', kind: 'user', entityId: 'u1' }],
    payment_orders: [{ _id: 'o1', createdAt: time('2026-10-01'), paidAt: time('2026-10-02'), paymentMode: 'live', payerUserId: 'u1', priceCents: 1500 }]
  });
  const service = createService(fixture, () => now); const filters = { startDay: '2026-10-01', endDay: '2026-10-02', window: '7d', paymentMode: 'live' };
  const report = await service.summary(filters);
  for (const [metric, date, expected] of [['enteredUsers', '2026-10-01', 1], ['enteredUsers', '2026-10-02', 0], ['activeUsers', '2026-10-01', 1], ['activeUsers', '2026-10-02', 1], ['paidOrders', '2026-10-01', 0], ['paidOrders', '2026-10-02', 1], ['payingUsers', '2026-10-02', 1]]) {
    const page = await service.details({ ...filters, metric, day: date, snapshotId: report.snapshotId });
    assert.equal(page.total, expected, metric + ':' + date); assert.equal(page.items.length, expected);
  }
  assert.equal(report.totals.activeUsers, 1); assert.equal(report.rows[0].dau, 1); assert.equal(report.rows[1].dau, 1);
  await assert.rejects(service.details({ ...filters, metric: 'newUsers', day: '2026-10-03', snapshotId: report.snapshotId }), { code: 'ANALYTICS_INVALID_RANGE' });
});

test('真实成员校验契约：显式家谱上报和旧客户端成功访问均采集，非成员拒绝', async () => {
  const userSource = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const membershipSource = userSource.slice(userSource.indexOf('async function requireMembership('), userSource.indexOf('function normalizePersonDateFields'));
  const captureSource = userSource.slice(userSource.indexOf('async function analyticsTrack('), userSource.indexOf('const handlers ='));
  const db = {}; const records = []; const user = { _id: 'u1', status: 'active' };
  const context = { db, ACTIVE_ROLES: ['admin', 'editor', 'viewer'], getOpenid: () => 'actor', userId: () => 'u1', cleanText: value => value || '',
    assert: (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); },
    requireActiveUser: async () => user, maybeGet: async () => user,
    getFamily: async (scope, familyId) => { assert.equal(scope, db); assert.equal(typeof familyId, 'string'); return { _id: familyId }; },
    getMembership: async (scope, familyId, openid) => { assert.equal(scope, db); assert.equal(openid, 'actor'); return familyId === 'f1' ? { role: 'viewer' } : null; },
    domain: { roleAllows: (role, roles) => roles.includes(role) }, analyticsTracker: { record: async (...args) => records.push(args) }
  };
  vm.runInNewContext(membershipSource + captureSource + '; visit = analyticsTrack; business = recordBusinessActivity;', context);
  await context.visit({ kind: 'family', familyId: 'f1' });
  await context.business('graph.get', { familyId: 'f1' }, {});
  await context.business('family.dashboard', { familyId: 'f1' }, {});
  await context.business('family.create', {}, { family: { _id: 'f1' } });
  assert.deepEqual(records.map(row => row.slice(1)), [['f1', true, false], ['f1', true, false], ['f1', true, false], ['f1', false, false]]);
  await assert.rejects(context.visit({ kind: 'family', familyId: 'other' }), { code: 'NO_FAMILY_ACCESS' });
  assert.equal(records.length, 4);
});

test('当天新用户转化不混入昨日用户的今日行为，同一名新用户完成行为才为100%', () => {
  const filters = analytics.range({ startDay: '2026-10-04', endDay: '2026-10-04' }, new Date('2026-10-04T04:00:00Z'));
  const users = [{ _id: 'today', createdAt: '2026-10-04T02:26:00Z' },
    { _id: 'yesterday', createdAt: '2026-10-03T12:19:07Z', firstExampleViewedAt: '2026-10-03T15:14:32Z', firstCreatedFamilyAt: '2026-10-04T02:56:15Z', firstEnteredFamilyAt: '2026-10-04T03:00:00Z' }];
  const input = { users, trackingStartedAt: '2026-10-03T10:00:00Z', families: [{ _id: 'f1', creatorId: 'yesterday', createdAt: '2026-10-04T02:56:15Z' }] };
  const before = analytics.summarize(input, filters).totals;
  assert.deepEqual([before.newUsers, before.newFamilies, before.exampleRate, before.createRate, before.enterRate], [1, 1, 0, 0, 0]);
  for (const field of ['firstExampleViewedAt', 'firstCreatedFamilyAt', 'firstEnteredFamilyAt']) users[0][field] = '2026-10-04T03:10:00Z';
  const after = analytics.summarize(input, filters).totals;
  assert.deepEqual([after.exampleRate, after.createRate, after.enterRate], [100, 100, 100]);
});
