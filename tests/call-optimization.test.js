const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const requestContext = require('../cloudfunctions/youpuUserApi/request-context');
const cleanup = require('../cloudfunctions/youpuJobs/retention-cleanup');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function client(options = {}) {
  const storage = options.storage || new Map();
  let clock = options.clock || Date.parse('2026-10-12T01:00:00Z');
  const calls = [];
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key), setTabBarBadge() {}, removeTabBarBadge() {}
  };
  const ledger = { module: { exports: {} }, wx };
  vm.runInNewContext(read('miniprogram/utils/activity-ledger.js'), ledger);
  let app;
  const family = { _id: 'f1', status: 'active', currentRole: 'admin' };
  const context = {
    wx, console, setTimeout, clearTimeout, Date: class extends Date { static now() { return clock; } },
    App: value => { app = value; },
    require: name => {
      if (name === './utils/activity-ledger') return ledger.module.exports;
      if (name === './utils/profile-image-cache') return { clear() {} };
      if (name === './utils/api') return { clearMediaUrlCache() {}, call(type, payload) {
        calls.push({ type, payload });
        if (options.call) return options.call(type, payload, clock);
        if (type === 'auth.login') return Promise.resolve({ user: { _id: 'u1' }, accountState: 'active' });
        if (type === 'membership.status') return Promise.resolve({ family, membership: { active: false } });
        if (type === 'change.pendingCount') return Promise.resolve({ count: 3 });
        return Promise.resolve({ recorded: true });
      } };
      if (name === './config/env') return { active: 'staging', environments: { staging: { cloudEnv: 'fixture' } } };
      return {};
    }
  };
  vm.runInNewContext(read('miniprogram/app.js'), context);
  app.globalData.user = { _id: 'u1' };
  app.globalData.loggedIn = true;
  app.globalData.accountState = 'active';
  app.globalData.currentFamily = family;
  return { app, calls, storage, advance: ms => { clock += ms; }, clock: () => clock };
}

test('20 次切页共享角标、权益和登录；5 分钟状态与 24 小时登录独立到期', async () => {
  const h = client();
  for (let i = 0; i < 20; i++) await Promise.all([h.app.ensureLogin(), h.app.refreshPendingBadge(), h.app.getMembershipStatus('f1')]);
  const count = type => h.calls.filter(call => call.type === type).length;
  assert.equal(count('auth.login'), 1); assert.equal(count('change.pendingCount'), 1); assert.equal(count('membership.status'), 1);
  h.advance(60000);
  await Promise.all([h.app.ensureLogin(), h.app.refreshPendingBadge(), h.app.getMembershipStatus('f1')]);
  assert.equal(count('membership.status'), 1); assert.equal(count('change.pendingCount'), 1); assert.equal(count('auth.login'), 1);
  h.advance(240000);
  await Promise.all([h.app.ensureLogin(), h.app.refreshPendingBadge(), h.app.getMembershipStatus('f1')]);
  assert.equal(count('membership.status'), 2); assert.equal(count('change.pendingCount'), 2); assert.equal(count('auth.login'), 1);
  h.advance(86400000 - 300000); await h.app.ensureLogin(); assert.equal(count('auth.login'), 2);
  await h.app.ensureLogin({ force: true }); assert.equal(count('auth.login'), 3);
});

test('角标强制刷新和看板回填；环境、账号、家谱切换隔离缓存', async () => {
  const h = client();
  await h.app.refreshPendingBadge();
  h.app.setPendingBadgeCount('f1', 8);
  assert.equal(await h.app.refreshPendingBadge(), 8);
  assert.equal(h.calls.length, 1);
  await h.app.refreshPendingBadge({ force: true }); assert.equal(h.calls.length, 2);
  h.app.globalData.environment = 'other'; await h.app.refreshPendingBadge(); assert.equal(h.calls.length, 2);
  assert.equal(h.app.globalData.user, null); assert.equal(h.app.globalData.currentFamily, null);
  h.app.globalData.user = { _id: 'u1' }; h.app.globalData.currentFamily = { _id: 'f1', status: 'active', currentRole: 'admin' };
  await h.app.refreshPendingBadge(); assert.equal(h.calls.length, 3);
  h.app.globalData.user = { _id: 'u2' }; await h.app.refreshPendingBadge(); assert.equal(h.calls.length, 4);
  h.app.setCurrentFamily({ _id: 'f2', status: 'active' }); await h.app.refreshPendingBadge(); assert.equal(h.calls.length, 5);
});

test('权益在到期前截短缓存，写入失效和迟到结果不会恢复旧权益', async () => {
  const replies = [];
  const h = client({ call: () => new Promise(resolve => replies.push(resolve)) });
  const first = h.app.getMembershipStatus('f1');
  await Promise.resolve();
  const concurrent = h.app.getMembershipStatus('f1'); assert.equal(replies.length, 1);
  h.app.invalidateMembershipStatus('f1');
  const next = h.app.getMembershipStatus('f1'); await Promise.resolve();
  assert.equal(replies.length, 2);
  replies[0]({ family: { _id: 'f1' }, membership: { active: false } });
  replies[1]({ family: { _id: 'f1' }, membership: { active: true, expiresAt: new Date(h.clock() + 1000).toISOString() } });
  for (const result of await Promise.all([first, concurrent, next])) assert.equal(result.membership.active, true);
  h.advance(1000);
  const expired = h.app.getMembershipStatus('f1'); await Promise.resolve(); assert.equal(replies.length, 3);
  replies[2]({ membership: { active: false } }); await expired;
});

test('切换用户、环境或重置后权益请求迟到时拒绝返回旧状态', async () => {
  for (const change of [h => { h.app.globalData.user = { _id: 'u2' }; }, h => { h.app.globalData.environment = 'other'; }, h => h.app.clearLocalData()]) {
    let resolve;
    const h = client({ call: () => new Promise(done => { resolve = done; }) });
    const pending = h.app.getMembershipStatus('f1'); await Promise.resolve();
    const rejected = assert.rejects(pending, { code: 'ACCOUNT_SESSION_CHANGED' });
    change(h); resolve({ membership: { active: true } }); await rejected;
  }
});

test('成功的每日统计跨启动去重，失败、换用户、换环境、跨日仍正确上报', async () => {
  const h = client();
  h.app.recordFamilyVisit('f1'); await Promise.resolve(); await Promise.resolve();
  const restarted = client({ storage: h.storage, clock: h.clock() });
  restarted.app.recordFamilyVisit('f1'); assert.equal(restarted.calls.length, 0);
  restarted.app.globalData.user = { _id: 'u2' };
  restarted.app.recordFamilyVisit('f1'); assert.equal(restarted.calls.length, 1);
  restarted.app.globalData.environment = 'other'; restarted.app.recordFamilyVisit('f1'); assert.equal(restarted.calls.length, 2);
  restarted.advance(86400000); restarted.app.recordFamilyVisit('f1'); assert.equal(restarted.calls.length, 3);
  const failing = client({ storage: new Map(), call: () => Promise.reject(new Error('offline')) });
  failing.app.recordFamilyVisit('f1'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const retry = client({ storage: failing.storage }); retry.app.recordFamilyVisit('f1'); assert.equal(retry.calls.length, 1);
});

test('注销/重置和跨日迟到统计响应不得写入成功标记', async () => {
  let resolve;
  const h = client({ call: () => new Promise(done => { resolve = done; }) });
  h.app.recordFamilyVisit('f1'); h.app.clearLocalData(); resolve({ recorded: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.storage.size, 0);
  const next = client({ storage: h.storage, call: () => new Promise(done => { resolve = done; }) });
  next.app.recordFamilyVisit('f1'); next.advance(86400000); resolve({ recorded: true });
  await Promise.resolve(); await Promise.resolve(); assert.equal(next.storage.size, 0);
});

test('更换独立 staging ID 时，同一账号和事件不继承旧环境成功标记', async () => {
  const first = client(); first.app.globalData.env = 'staging-one';
  first.app.recordFamilyVisit('f1'); await Promise.resolve(); await Promise.resolve();
  const other = client({ storage: first.storage }); other.app.globalData.env = 'staging-two';
  other.app.recordFamilyVisit('f1'); assert.equal(other.calls.length, 1);
  const restored = client({ storage: first.storage }); restored.app.globalData.env = 'staging-one';
  restored.app.recordFamilyVisit('f1'); assert.equal(restored.calls.length, 0);
});

function declaration(source, name) {
  const pattern = new RegExp('^(?:async )?function ' + name + '\\(', 'm');
  const match = pattern.exec(source);
  assert.ok(match, name);
  return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}

test('真实广告查询逻辑跨页面共享权益，回填家谱不会让刚获取的缓存自失效', async () => {
  const h = client({ call: async type => type === 'membership.status' ? {
    family: { _id: 'f1', status: 'active', currentRole: 'admin', membership: { active: false } }, membership: { active: false }
  } : { count: 0 } });
  const context = { commerceConfig: { resolveBanner: () => 'ad-fixture' }, api: {}, memberLayout: {} };
  const source = read('miniprogram/utils/ad-access.js');
  vm.runInNewContext(['eligible', 'fields', 'hide', 'familyStatus', 'refresh', 'memberKey'].map(name => declaration(source, name)).join('\n'), context);
  const page = () => ({ data: {}, setData(patch) { Object.assign(this.data, patch); } });
  const pages = [page(), page(), page()];
  for (let i = 0; i < 20; i++) await context.refresh(pages[i % 3], h.app, i % 2 ? 'treeTop' : 'profile', h.app.getCurrentFamily());
  assert.equal(h.calls.filter(row => row.type === 'membership.status').length, 1);
  h.advance(300000);
  await context.refresh(pages[0], h.app, 'treeTop', h.app.getCurrentFamily());
  assert.equal(h.calls.filter(row => row.type === 'membership.status').length, 2);
});

function userHelpers() {
  const source = read('cloudfunctions/youpuUserApi/index.js');
  let reads = 0;
  const tables = { users: { u1: { _id: 'u1', status: 'active' } }, families: { f1: { _id: 'f1', status: 'active' } },
    family_memberships: { m1: { _id: 'm1', userId: 'u1', status: 'active', role: 'admin' } } };
  const db = { collection: name => ({ doc: id => ({ get: async () => { reads += 1; return { data: tables[name] && tables[name][id] }; } }),
    where: () => ({ count: async () => { reads += 1; return { total: 1 }; } }) }) };
  const context = { db, requestContext, analytics: require('../cloudfunctions/youpuUserApi/analytics'), getOpenid: () => 'actor', userId: () => 'u1', membershipId: () => 'm1',
    ACTIVE_ROLES: ['admin', 'member', 'viewer'], cleanText: value => value || '', publicAccount: value => value,
    domain: { roleAllows: (role, roles) => roles.includes(role) }, analyticsTracker: { record: async () => {} },
    assert: (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); },
    BusinessError: class extends Error { constructor(code, message) { super(message); this.code = code; } } };
  vm.runInNewContext(['maybeGet', 'mustGet', 'ensureUser', 'requireActiveUser', 'getFamily', 'getMembership', 'requireMembership',
    'authLogin', 'changePendingCount', 'recordBusinessActivity'].map(name => declaration(source, name)).join('\n'), context);
  return { context, tables, reads: () => reads };
}

test('同请求角标及统计补采集只读一次用户、家谱、成员；新请求重新鉴权', async () => {
  const h = userHelpers();
  for (let i = 0; i < 2; i++) await requestContext.run(async () => {
    await h.context.changePendingCount({ familyId: 'f1' });
    await h.context.recordBusinessActivity('change.pendingCount', { familyId: 'f1' }, {});
  });
  assert.equal(h.reads(), 8); // 4 reads per invocation, previously 7.
  h.tables.users.u1.status = 'frozen';
  await assert.rejects(requestContext.run(() => h.context.changePendingCount({ familyId: 'f1' })), { code: 'ACCOUNT_FROZEN' });
});

test('登录复用用户读；事务鉴权不进入普通请求上下文；变更后补采集重新读', async () => {
  const h = userHelpers();
  await requestContext.run(async () => { await h.context.authLogin(); await h.context.recordBusinessActivity('auth.login', {}, {}); });
  assert.equal(h.reads(), 1);
  await requestContext.run(async () => {
    const transaction = { collection: h.context.db.collection };
    await h.context.requireMembership('f1', ['admin'], transaction, 'actor');
    assert.equal(requestContext.access('f1', 'u1'), null);
    await h.context.requireActiveUser('actor'); await h.context.requireMembership('f1', ['admin'], h.context.db, 'actor');
    requestContext.invalidate(); h.tables.family_memberships.m1.status = 'left';
    let captured;
    h.context.analyticsTracker.record = async (_, familyId) => { captured = familyId; };
    await h.context.recordBusinessActivity('membership.leave', { familyId: 'f1' }, {});
    assert.equal(captured, '');
  });
});

test('热实例并发调用的用户和家谱鉴权对象互不共享', async () => {
  let release;
  const pause = new Promise(resolve => { release = resolve; });
  const first = requestContext.run(async () => {
    requestContext.rememberUser({ _id: 'a' });
    requestContext.rememberAccess({ family: { _id: 'f', status: 'active' }, membership: { userId: 'a' } });
    await pause;
    assert.equal(requestContext.user('b'), undefined);
    assert.equal(requestContext.access('f', 'a').membership.userId, 'a');
  });
  await requestContext.run(async () => { assert.equal(requestContext.user('a'), undefined); requestContext.rememberUser({ _id: 'b' }); });
  release(); await first; assert.equal(requestContext.user('a'), undefined);
});

function cleanupDb(rows, beforeRemove) {
  const counts = { get: 0, remove: 0 };
  const matches = (row, condition) => condition.and ? condition.and.every(part => matches(row, part))
    : Object.entries(condition).every(([field, value]) => value.in ? value.in.includes(row[field]) : value.lt !== undefined ? row[field] < value.lt : row[field] === value);
  const db = { command: { and: and => ({ and }), in: ids => ({ in: ids }) }, collection: () => ({ where: condition => {
    let limit = 100;
    const query = { limit: value => { limit = value; return query; },
      get: async () => { counts.get += 1; return { data: rows.filter(row => matches(row, condition)).slice(0, limit).map(row => ({ ...row })) }; },
      remove: async () => {
        counts.remove += 1; if (beforeRemove) beforeRemove(rows);
        let removed = 0;
        for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], condition)) { rows.splice(i, 1); removed++; }
        return { stats: { removed } };
      } };
    return query;
  } }) };
  return { db, counts };
}

test('清理限定显式 ID、原过期条件、100 条批次及总量，其他业务集合拒绝', async () => {
  const rows = Array.from({ length: 230 }, (_, i) => ({ _id: 'old-' + i, expiresAt: 1, run: 'fixture' }));
  rows.push({ _id: 'future', expiresAt: 200, run: 'fixture' }, { _id: 'other', expiresAt: 1, run: 'other' });
  const h = cleanupDb(rows);
  assert.equal(await cleanup.removeExpired(h.db, 'idempotency_records', { expiresAt: { lt: 100 }, run: 'fixture' }, 150), 150);
  assert.deepEqual(h.counts, { get: 2, remove: 2 });
  assert.equal(rows.length, 82);
  assert.ok(rows.find(row => row._id === 'future')); assert.ok(rows.find(row => row._id === 'other'));
  await assert.rejects(cleanup.removeExpired(h.db, 'persons', { expiresAt: { lt: 100 } }, 10), /RETENTION_BATCH_REJECTED/);
});

test('选中后延期记录不删除，零删除不会无限循环', async () => {
  const rows = [{ _id: 'extended', expiresAt: 1 }, { _id: 'expired', expiresAt: 1 }];
  const h = cleanupDb(rows, records => { records.find(row => row._id === 'extended').expiresAt = 200; });
  assert.equal(await cleanup.removeExpired(h.db, 'analytics_reports', { expiresAt: { lt: 100 } }, 10), 1);
  assert.deepEqual(rows.map(row => row._id), ['extended']);
  const zero = cleanupDb([{ _id: 'extended', expiresAt: 1 }], records => { records[0].expiresAt = 200; });
  assert.equal(await cleanup.removeExpired(zero.db, 'rate_limits', { expiresAt: { lt: 100 } }, 10), 0);
  assert.deepEqual(zero.counts, { get: 1, remove: 1 });
});

test('后台缓存合并相同筛选并发，不叠加服务端快照年龄，失败允许重试', async () => {
  const source = read('admin/src/report-cache.js');
  const { createReportCache } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let clock = Date.parse('2026-10-12T01:00:00Z'); let calls = 0; let fail = false;
  const load = createReportCache(async () => { calls++; if (fail) throw new Error('offline'); return { asOf: new Date(clock - 60000).toISOString(), snapshotId: 's' + calls }; }, () => clock);
  const filters = { startDay: '2026-10-12', endDay: '2026-10-12', window: 'day', paymentMode: 'live' };
  const first = await Promise.all([load(filters), load(filters)]); assert.equal(calls, 1); assert.equal(first[0], first[1]);
  clock += 239999; await load(filters); assert.equal(calls, 1);
  clock += 1; await load(filters); assert.equal(calls, 2);
  await load({ ...filters, paymentMode: 'mock' }); assert.equal(calls, 3);
  fail = true; await assert.rejects(load({ ...filters, window: '7d' }), /offline/);
  fail = false; await load({ ...filters, window: '7d' }); assert.equal(calls, 5);
});

test('云端调用优化探针在生产或错误密钥下先拒绝，未进行任何数据库操作', async () => {
  const source = read('deployment/call-optimization-staging-probe.js');
  let operations = 0;
  const environment = { PROBE_ENV: 'cloud1-d5gs5yj4l283d9c6d', TCB_ENV: 'cloud1-d5gs5yj4l283d9c6d', PROBE_SECRET: 'fixture', PROBE_RUN: '123456abcdef' };
  const context = { exports: {}, process: { env: environment }, require: name => {
    if (name === 'wx-server-sdk') return { init() {}, database: () => ({ collection() { operations++; } }) };
    if (name === './request-context') return requestContext;
    return require(name);
  } };
  vm.runInNewContext(source, context);
  await assert.rejects(context.exports.main({ action: 'run', secret: 'fixture', run: '123456abcdef' }), { code: 'PROBE_ENV_REJECTED' });
  environment.PROBE_ENV = environment.TCB_ENV = 'cloud1-test-staging';
  await assert.rejects(context.exports.main({ action: 'run', secret: 'wrong', run: '123456abcdef' }), { code: 'PROBE_UNAUTHORIZED' });
  assert.equal(operations, 0);
});
