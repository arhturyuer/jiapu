require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const api = require('../miniprogram/utils/api');
const environment = require('../miniprogram/config/env');
const { createService } = require('../cloudfunctions/youpuUserApi/staging-account-reset');
const hash = (value, length) => crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
const oldId = 'u_' + hash('test-openid', 32);
const context = { OPENID: 'test-openid', ENV: 'cloud1-unit-test-staging' };

function enable(t) {
  for (const [key, value] of Object.entries({ STAGING_ACCOUNT_RESET_ENV: context.ENV, STAGING_ACCOUNT_RESET_ENABLED: '1', TCB_ENV: context.ENV, SCF_NAMESPACE: '' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}
function harness() {
  let rows = {
    users: [{ _id: oldId, openid: context.OPENID, status: 'active', nickName: '测试名字', avatarAssetId: 'old-avatar' }],
    families: [{ _id: 'sole', status: 'active', adminCount: 1 }, { _id: 'shared', status: 'active', adminCount: 2 }],
    family_memberships: [
      { _id: 'one', familyId: 'sole', userId: oldId, role: 'admin', status: 'active' },
      { _id: 'two', familyId: 'shared', userId: oldId, role: 'admin', status: 'active' },
      { _id: 'peer', familyId: 'shared', userId: 'other-user', role: 'admin', status: 'active' }
    ],
    invitations: [{ _id: 'old-link', createdBy: oldId, status: 'active' }, { _id: 'peer-link', createdBy: 'other-user', status: 'active' }],
    user_family_preferences: [{ _id: 'old-pref', userId: oldId, familyId: 'sole' }],
    system_config: [], idempotency_records: [], account_deletion_requests: [], audit_logs: []
  };
  let calls = 0;
  let token = 0;
  let failure = '';
  const removed = { remove: true };
  function scope(transaction = false) {
    return { collection(name) {
      calls += 1;
      if (failure === name) throw new Error('DATABASE_OFFLINE');
      const table = rows[name] || (rows[name] = []);
      return {
        where(condition) {
          assert.equal(transaction, false, 'CloudBase 事务不支持 where');
          let count = Infinity;
          return { limit(value) { count = value; return this; }, async get() {
            return { data: structuredClone(table.filter(row => Object.entries(condition).every(([key, value]) => row[key] === value)).slice(0, count)) };
          } };
        },
        doc(id) { return {
          async get() { const row = table.find(row => row._id === id); return { data: row ? structuredClone(row) : null }; },
          async set({ data }) { const index = table.findIndex(row => row._id === id); const row = { ...data, _id: id }; if (index < 0) table.push(row); else table[index] = row; },
          async update({ data }) { const row = table.find(row => row._id === id); assert.ok(row); for (const [key, value] of Object.entries(data)) { if (value === removed) delete row[key]; else row[key] = value; } }
        }; },
        async add({ data }) { table.push({ ...data, _id: 'audit-' + table.length }); }
      };
    } };
  }
  const db = { ...scope(), serverDate: () => new Date('2026-10-03T00:00:00Z'), async runTransaction(callback) {
    const original = structuredClone(rows);
    try { return await callback(scope(true)); } catch (error) { rows = original; throw error; }
  } };
  const service = createService({ db, command: { remove: () => removed }, hash, randomToken: () => 'token-' + (++token),
    assert(condition, code, message) { if (!condition) throw Object.assign(new Error(message), { code }); },
    async listAll(name, condition, limit) {
      const result = await db.collection(name).where(condition).limit(limit + 1).get();
      if (result.data.length > limit) throw Object.assign(new Error('RESULT_LIMIT_EXCEEDED'), { code: 'RESULT_LIMIT_EXCEEDED' });
      return result.data;
    }
  });
  return { service, get rows() { return rows; }, get calls() { return calls; }, fail(name) { failure = name; } };
}
function request(extra) { return { envVersion: 'develop', requestId: 'reset-one', expectedUserId: oldId, ...extra }; }

test('测试账户重置注销旧身份、建立空白身份，归档唯一管理员家谱并保留其他管理员家谱', async t => {
  enable(t);
  const h = harness();
  const result = await h.service.reset(context, request());
  assert.notEqual(result.userId, oldId);
  assert.equal(result.archivedFamilies, 1);
  const previous = h.rows.users.find(row => row._id === oldId);
  assert.equal(previous.status, 'deleted');
  assert.equal(previous.openid, undefined);
  assert.equal(previous.nickName, '');
  const fresh = h.rows.users.find(row => row._id === result.userId);
  assert.equal(fresh.status, 'active');
  assert.equal(fresh.nickName, '');
  assert.equal(fresh.avatarAssetId, '');
  assert.equal(fresh.openid, context.OPENID);
  assert.equal(h.rows.family_memberships.filter(row => row.userId === fresh._id).length, 0);
  assert.equal(h.rows.user_family_preferences.filter(row => row.userId === fresh._id).length, 0);
  assert.equal(h.rows.families[0].status, 'archived');
  assert.equal(h.rows.families[1].status, 'active');
  assert.equal(h.rows.families[1].adminCount, 1);
  assert.equal(h.rows.family_memberships[2].status, 'active');
  assert.equal(h.rows.invitations[0].status, 'revoked');
  assert.equal(h.rows.invitations[1].status, 'active');
  const resolved = await h.service.run(context, async () => h.service.currentUserId(context.OPENID, oldId));
  assert.equal(resolved, fresh._id);
  assert.equal(h.service.currentUserId(context.OPENID, oldId), oldId, '请求外不泄漏身份');
});

test('超时重试幂等，多次重置后重放旧请求也不会注销当前新身份', async t => {
  enable(t);
  const h = harness();
  const first = await h.service.reset(context, request());
  assert.deepEqual(await h.service.reset(context, request()), first);
  const second = await h.service.reset(context, request({ expectedUserId: first.userId, requestId: 'reset-two' }));
  assert.deepEqual(await h.service.reset(context, request()), first);
  assert.equal(h.rows.users.find(row => row._id === second.userId).status, 'active');
  assert.equal(h.rows.users.length, 3);
  await assert.rejects(h.service.reset(context, request({ requestId: 'stale-new-request' })), { code: 'TEST_ACCOUNT_CHANGED' });
});

test('服务端拒绝 production、未开启、环境不匹配、缺少身份以及非 develop，拒绝前不访问数据库', async t => {
  enable(t);
  const h = harness();
  for (const invalid of [{ ...context, ENV: 'cloud1-d5gs5yj4l283d9c6d' }, { ...context, ENV: '' }, { ...context, OPENID: '' }]) {
    await assert.rejects(h.service.reset(invalid, request()));
  }
  for (const envVersion of ['release', 'trial', '', 'unknown']) await assert.rejects(h.service.reset(context, request({ envVersion })));
  process.env.STAGING_ACCOUNT_RESET_ENABLED = '0';
  await assert.rejects(h.service.reset(context, request()));
  process.env.STAGING_ACCOUNT_RESET_ENABLED = '1';
  process.env.STAGING_ACCOUNT_RESET_ENV = 'cloud1-d5gs5yj4l283d9c6d';
  await assert.rejects(h.service.reset({ ...context, ENV: process.env.STAGING_ACCOUNT_RESET_ENV }, request()));
  assert.equal(h.calls, 0);
});

test('冷静期可立即重置并取消原任务，冻结或正在执行注销的账户不得绕过限制', async t => {
  enable(t);
  const h = harness();
  h.rows.users[0].status = 'pending_delete';
  h.rows.account_deletion_requests.push({ _id: 'del_' + oldId, status: 'pending', userId: oldId });
  await h.service.reset(context, request());
  assert.equal(h.rows.account_deletion_requests[0].status, 'cancelled');
  for (const status of ['frozen', 'deleted']) {
    const other = harness(); other.rows.users[0].status = status;
    await assert.rejects(other.service.reset(context, request()), { code: 'ACCOUNT_UNAVAILABLE' });
  }
  const processing = harness();
  processing.rows.account_deletion_requests.push({ _id: 'del_' + oldId, status: 'processing' });
  await assert.rejects(processing.service.reset(context, request()), { code: 'DELETION_ALREADY_PROCESSING' });
});

test('数据库失败和数量超过限制回滚，不能以缺失身份为由重新连回旧账户', async t => {
  enable(t);
  const h = harness();
  const before = structuredClone(h.rows);
  h.fail('audit_logs');
  await assert.rejects(h.service.reset(context, request()), /DATABASE_OFFLINE/);
  assert.deepEqual(h.rows, before);
  h.fail('system_config');
  await assert.rejects(h.service.run(context, () => null), /DATABASE_OFFLINE/);
  const many = harness();
  for (let i = 0; i < 101; i += 1) many.rows.invitations.push({ _id: 'link-' + i, createdBy: oldId, status: 'active' });
  await assert.rejects(many.service.reset(context, request()), { code: 'RESULT_LIMIT_EXCEEDED' });
  assert.equal(many.rows.users[0].status, 'active');
  const budget = harness();
  for (let i = 0; i < 44; i += 1) budget.rows.invitations.push({ _id: 'budget-' + i, createdBy: oldId, status: 'active' });
  await assert.rejects(budget.service.reset(context, request()), { code: 'TEST_RESET_TOO_LARGE' });
  assert.equal(budget.rows.users[0].status, 'active');
});

test('staging 身份作用域隔离并发请求，未开启的正式契约不读取身份指针', async t => {
  enable(t);
  const h = harness();
  const fresh = await h.service.reset(context, request());
  const values = await Promise.all([h.service.run(context, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return h.service.currentUserId(context.OPENID, oldId);
  }), h.service.run({ OPENID: 'another-openid', ENV: context.ENV }, async () => {
    await Promise.resolve();
    return h.service.currentUserId('another-openid', 'fallback');
  })]);
  assert.deepEqual(values, [fresh.userId, 'u_' + hash('another-openid', 32)]);
  process.env.STAGING_ACCOUNT_RESET_ENABLED = '0';
  assert.equal(await h.service.run(context, () => h.service.currentUserId(context.OPENID, oldId)), fresh.userId, '禁用新重置仍保留已重置身份');
  process.env.STAGING_ACCOUNT_RESET_ENV = '';
  const calls = h.calls;
  assert.equal(await h.service.run(context, () => h.service.currentUserId(context.OPENID, oldId)), oldId);
  assert.equal(h.calls, calls);
});

function pageHarness(t, version = 'develop') {
  const storage = new Map([['youpu_user', { _id: oldId }], ['youpu_example_display_preference_first', true], ['unrelated_key', true]]);
  const visits = [];
  const previousWx = global.wx;
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: version } }),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key), getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    removeTabBarBadge() {}, disableAlertBeforeUnload() {},
    showModal: () => Promise.resolve({ confirm: true }), showToast() {},
    reLaunch(options) { visits.push(options); return Promise.resolve(); }
  };
  t.after(() => { global.wx = previousWx; });
  function load(file, callbackName, app) {
    const previous = global[callbackName];
    const previousGetApp = global.getApp;
    let definition;
    global[callbackName] = value => { definition = value; };
    global.getApp = () => app;
    const resolved = require.resolve('../' + file);
    delete require.cache[resolved]; require(resolved);
    global[callbackName] = previous; global.getApp = previousGetApp;
    return definition;
  }
  const app = load('miniprogram/app', 'App');
  app.globalData = { ...app.globalData, environment: 'staging', env: environment.environments.staging.cloudEnv, runtimeVersion: version, accountState: 'active', user: { _id: oldId }, currentFamily: { _id: 'sole' } };
  const page = load('miniprogram/pages/profile/index', 'Page', app);
  page.data = { ...page.data, loading: false, user: { _id: oldId }, nickName: '测试名字' };
  page.setData = patch => Object.assign(page.data, patch);
  return { page, app, storage, visits };
}

test('我的页仅独立 staging develop 显示入口，隐藏版本点击也不调用接口', async t => {
  for (const version of ['trial', 'release', '', 'unknown']) {
    const h = pageHarness(t, version);
    h.page.loadPage = () => Promise.resolve();
    h.app.refreshPendingBadge = () => Promise.resolve();
    h.page.onShow();
    assert.equal(h.page.data.showTestReset, false);
    const mocked = t.mock.method(api, 'call', () => { throw new Error('不得请求'); });
    await h.page.resetTestAccount();
    assert.equal(mocked.mock.callCount(), 0);
    mocked.mock.restore();
  }
  const h = pageHarness(t);
  h.page.loadPage = () => Promise.resolve(); h.app.refreshPendingBadge = () => Promise.resolve();
  h.page.onShow(); assert.equal(h.page.data.showTestReset, true);
  h.app.globalData.env = 'different'; h.page.onShow(); assert.equal(h.page.data.showTestReset, false);
});

test('取消不注销；失败保留身份，重试复用幂等键；成功清空本机记录并重新启动首页', async t => {
  const h = pageHarness(t);
  const calls = [];
  let fail = true;
  t.mock.method(api, 'call', async (type, payload) => { calls.push({ type, ...payload }); if (fail) throw new Error('OFFLINE'); return { reset: true }; });
  global.wx.showModal = () => Promise.resolve({ confirm: false });
  await h.page.resetTestAccount(); assert.equal(calls.length, 0);
  global.wx.showModal = () => Promise.resolve({ confirm: true });
  await h.page.resetTestAccount(); assert.equal(h.app.globalData.user._id, oldId);
  assert.equal(h.visits.length, 0);
  fail = false;
  await h.page.resetTestAccount();
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.equal(h.app.globalData.user, null); assert.equal(h.app.globalData.currentFamily, null);
  assert.equal(h.app.globalData.accountState, 'active'); assert.equal(h.app.globalData.deletion, null);
  assert.equal(h.storage.size, 1); assert.equal(h.storage.get('unrelated_key'), true);
  assert.equal(h.visits[0].url, '/pages/tree/index');
});

test('连续点击仅执行一次，重进失败后的重试不重复注销新账户', async t => {
  const h = pageHarness(t);
  let finish;
  const mocked = t.mock.method(api, 'call', () => new Promise(resolve => { finish = resolve; }));
  global.wx.reLaunch = () => Promise.reject(new Error('NAV_FAILED'));
  const first = h.page.resetTestAccount();
  await Promise.resolve();
  await h.page.resetTestAccount();
  assert.equal(mocked.mock.callCount(), 1);
  finish({ reset: true }); await first;
  global.wx.reLaunch = options => { h.visits.push(options); return Promise.resolve(); };
  await h.page.resetTestAccount();
  assert.equal(mocked.mock.callCount(), 1);
  assert.equal(h.visits.length, 1);
});

test('重置期间的迟到登录和家庭缓存响应不能写回旧账户', async t => {
  const h = pageHarness(t);
  let loginResolve;
  let graphResolve;
  t.mock.method(api, 'call', type => new Promise(resolve => { if (type === 'auth.login') loginResolve = resolve; else graphResolve = resolve; }));
  const login = h.app.ensureLogin({ force: true });
  const graph = h.app.getGraph('sole');
  await Promise.resolve();
  const loginError = assert.rejects(login, { code: 'ACCOUNT_SESSION_CHANGED' });
  const graphError = assert.rejects(graph, { code: 'ACCOUNT_SESSION_CHANGED' });
  h.app.clearTestSession();
  loginResolve({ user: { _id: oldId }, accountState: 'active' });
  graphResolve({ family: { _id: 'sole' }, persons: [] });
  await Promise.all([loginError, graphError]);
  assert.equal(h.app.globalData.user, null);
  assert.equal(h.app.loginPromise, null);
  assert.deepEqual(h.app.dataCache.graph, {});
});

test('云函数入口先拒绝错误环境再限流，旧身份的迟到 mutation 不会作用于新身份', async t => {
  enable(t);
  const h = harness();
  const root = path.resolve(__dirname, '..');
  let activeContext = { ...context, ENV: 'cloud1-d5gs5yj4l283d9c6d' };
  const sandbox = { exports: {}, process, Buffer, console: { log() {}, error() {} }, require(name) {
    if (name === 'wx-server-sdk') return { init() {}, database: () => ({ command: {} }), getWXContext: () => activeContext };
    if (name === './staging-account-reset') return { createService: () => h.service };
    return name.startsWith('.') ? require(path.join(root, 'cloudfunctions/youpuUserApi', name)) : require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8'), sandbox);
  const result = await sandbox.exports.main({ type: 'account.resetTest', ...request() });
  assert.equal(result.code, 'TEST_RESET_UNAVAILABLE'); assert.equal(h.calls, 0);
  const fresh = await h.service.reset(context, request());
  activeContext = context;
  const scopedIds = await h.service.run(context, () => [sandbox.membershipId('shared', context.OPENID), sandbox.preferenceId('shared', context.OPENID)]);
  assert.notEqual(scopedIds[0], 'fm_' + hash('shared:' + context.OPENID, 32));
  assert.notEqual(scopedIds[1], 'fp_' + hash('shared:' + context.OPENID, 32));
  assert.equal(sandbox.membershipId('shared', context.OPENID), 'fm_' + hash('shared:' + context.OPENID, 32), '原身份算法不变');
  const late = await sandbox.exports.main({ type: 'family.create', testActorId: oldId });
  assert.equal(late.code, 'ACCOUNT_SESSION_CHANGED');
  assert.equal(h.rows.users.find(row => row._id === fresh.userId).status, 'active');
});
