const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runtime } = require('./helpers/counting-runtime');
const { createDatabase } = require('./helpers/membership-db');
const userId = 'u_' + crypto.createHash('sha256').update('fixture-actor').digest('hex').slice(0, 32);
function userFixture() {
  const db = createDatabase();
  db.put('users', userId, { status: 'active', firstEnteredFamilyAt: new Date(), firstExampleViewedAt: new Date() });
  db.put('families', 'f1', { status: 'active', name: '虚构家谱', contentRevision: 0 });
  db.put('family_memberships', 'fm_' + crypto.createHash('sha256').update('f1:fixture-actor').digest('hex').slice(0, 32),
    { familyId: 'f1', userId, status: 'active', role: 'admin' });
  return { db, h: runtime('cloudfunctions/youpuUserApi', db) };
}

test('后台真实路由分享漏斗只有三次批读，缺失记录按零处理', async () => {
  const db = createDatabase(); db.put('operators', 'op1', { authUid: 'fixture-actor', status: 'active', role: 'operator' });
  const h = runtime('cloudfunctions/youpuOpsApi', db);
  const result = await h.call({ action: 'dashboard.summary' });
  assert.equal(result.success, true, result.message);
  assert.equal(h.counts.operations.filter(row => row.collection === 'share_metrics_daily' && row.method === 'get').length, 3);
  assert.equal(result.data.shareFunnel.items.length, 4);
  assert.ok(result.data.shareFunnel.items.every(row => row.sent === 0));
});

test('后台真实路由 20 条家谱仅两次聚合，补零且角色拒绝不查业务数据', async () => {
  const db = createDatabase(); db.put('operators', 'op1', { authUid: 'fixture-actor', status: 'active', role: 'operator' });
  for (let i = 0; i < 20; i++) db.put('families', 'f' + i, { status: 'active', createdAt: new Date() });
  db.put('persons', 'p1', { familyId: 'f0', status: 'active' }); db.put('persons', 'p2', { familyId: 'f0', status: 'deleted' });
  db.put('family_memberships', 'm1', { familyId: 'f0', status: 'active' });
  const h = runtime('cloudfunctions/youpuOpsApi', db);
  const result = await h.call({ action: 'families.list', pageSize: 20 });
  assert.equal(result.success, true, result.message);
  assert.equal(h.counts.operations.filter(row => row.method === 'end').length, 2);
  const nonempty = result.data.items.find(row => row._id === 'f0');
  assert.equal(nonempty.memberCount, 1); assert.equal(nonempty.userCount, 1);
  assert.ok(result.data.items.filter(row => row._id !== 'f0').every(row => row.memberCount === 0 && row.userCount === 0));
  db.put('operators', 'op1', { authUid: 'fixture-actor', status: 'disabled', role: 'operator' });
  const before = h.counts.operations.length;
  assert.equal((await h.call({ action: 'families.list' })).code, 'NOT_OPERATOR');
  assert.deepEqual(h.counts.operations.slice(before).map(row => row.collection), ['operators']);
});

test('真实用户路由幂等完成一次写入、并发只生效一次，家谱版本合并更新', async () => {
  const { db, h } = userFixture();
  const input = { type: 'family.update', familyId: 'f1', name: '虚构新名称', requestId: 'same' };
  const results = await Promise.all([h.call({ ...input }), h.call({ ...input })]);
  assert.ok(results.every(row => row.success), JSON.stringify(results));
  assert.equal(db.get('families', 'f1').contentRevision, 1);
  assert.equal(db.all('audit_logs').length, 1); assert.equal(db.all('idempotency_records').length, 1);
  assert.equal(db.all('idempotency_records')[0].status, 'completed');
  assert.equal(h.counts.operations.filter(row => row.collection === 'families' && row.method === 'update').length, 1);
  assert.equal(h.counts.operations.filter(row => row.collection === 'idempotency_records' && ['update', 'set'].includes(row.method)).length, 1);
});

test('事务失败不遗留幂等结果或家谱计数，原键可重试；媒体准备一次写入', async () => {
  const { db, h } = userFixture();
  db.writeHook = async name => { if (name === 'audit_logs') throw new Error('fixture failure'); };
  const input = { type: 'family.update', familyId: 'f1', name: '虚构新名称', requestId: 'retry' };
  assert.equal((await h.call({ ...input })).success, false);
  assert.equal(db.all('idempotency_records').length, 0); assert.equal(db.get('families', 'f1').contentRevision, 0);
  db.writeHook = null;
  assert.equal((await h.call({ ...input })).success, true);
  const result = await h.call({ type: 'media.prepare', kind: 'user_avatar', requestId: 'upload' });
  assert.equal(result.success, true, result.message);
  assert.equal(db.get('media_assets', result.data.assetId).cloudPath, result.data.cloudPath);
  assert.equal(h.counts.operations.filter(row => row.collection === 'media_assets' && ['set', 'update', 'add'].includes(row.method)).length, 1);
});

const { miniapp } = require('./helpers/miniapp-runtime');
function clients() {
  const db = createDatabase(); let clock = Date.now(); const calls = [];
  db.put('users', userId, { status: 'active', firstEnteredFamilyAt: new Date(), firstExampleViewedAt: new Date() });
  db.put('families', 'f1', { status: 'active', personCount: 1, relationCount: 0 });
  db.put('family_memberships', 'fm_' + crypto.createHash('sha256').update('f1:fixture-actor').digest('hex').slice(0, 32), { familyId: 'f1', userId, status: 'active', role: 'admin' });
  db.put('persons', 'p1', { familyId: 'f1', status: 'active', name: '虚构成员', gender: 'male' });
  const now = () => clock;
  class Clock extends Date { static now() { return clock; } constructor(...args) { super(...(args.length ? args : [clock])); } }
  let server = runtime('cloudfunctions/youpuUserApi', db, { now, Date: Clock });
  const storage = new Map();
  const build = (override) => miniapp({ now, storage, call: async data => { calls.push(data.type); return override ? override(data) : server.call(data); } });
  return { db, build, now, storage, calls, server: () => server, advance: value => { clock += value; db.now = new Date(clock); },
    switchActor: actor => {
      const id = 'u_' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 32);
      db.put('users', id, { status: 'active' }); server = runtime('cloudfunctions/youpuUserApi', db, { actor, now, Date: Clock }); return id;
    } };
}

test('真实 API 的登录回执阻止重复统计；跨启动身份验证不读 users、不续期', async () => {
  const h = clients(); const first = h.build(); first.app.restoreLocalState();
  assert.equal(first.app.globalData.user, null);
  await first.app.ensureLogin(); first.app.recordVisibleActivity(); await Promise.resolve();
  assert.deepEqual(h.calls, ['auth.login']);
  const fetchedAt = first.app.loginUpdatedAt;
  h.advance(60000);
  const next = h.build(); next.app.restoreLocalState();
  assert.equal(next.app.globalData.user, null);
  const before = h.server().counts.operations.length;
  await next.app.ensureLogin();
  assert.equal(next.app.globalData.user._id, userId); assert.equal(next.app.loginUpdatedAt, fetchedAt);
  assert.equal(h.calls.at(-1), 'auth.identity');
  assert.equal(h.server().counts.operations.slice(before).filter(row => row.collection === 'users').length, 0);
  h.advance(86400000);
  await next.app.ensureLogin(); assert.equal(h.calls.at(-1), 'auth.login');
  first.close(); next.close();
});

test('冷启动切微信身份清除旧缓存；身份失败不显示旧资料；旧服务回退完整登录', async () => {
  const h = clients(); const first = h.build(); await first.app.ensureLogin();
  const oldKey = first.app.loginCacheKey(first.app.loginScope(), userId);
  const otherId = h.switchActor('another-fixture');
  const next = h.build(); next.app.restoreLocalState(); await next.app.ensureLogin();
  assert.equal(next.app.globalData.user._id, otherId); assert.equal(h.storage.has(oldKey), false);
  assert.deepEqual(h.calls.slice(-2), ['auth.identity', 'auth.login']);
  const offline = h.build(async () => { throw Object.assign(new Error('fixture offline'), { code: 'NETWORK' }); });
  offline.app.restoreLocalState(); await assert.rejects(offline.app.ensureLogin());
  assert.equal(offline.app.globalData.user, null); assert.equal(offline.app.getCurrentFamily(), null);
  const legacy = h.build(data => data.type === 'auth.identity' ? { success: false, code: 'UNKNOWN_ACTION', message: 'legacy' } : h.server().call(data));
  legacy.app.restoreLocalState(); await legacy.app.ensureLogin(); assert.equal(h.calls.at(-1), 'auth.login');
  first.close(); next.close(); offline.close(); legacy.close();
});

test('强制刷新不复用正在执行的身份恢复；损坏缓存与时钟回拨完整登录', async () => {
  const h = clients(); const first = h.build(); await first.app.ensureLogin();
  let resolveIdentity;
  const next = h.build(data => data.type === 'auth.identity' ? new Promise(resolve => { resolveIdentity = resolve; }) : h.server().call(data));
  next.app.restoreLocalState(); const normal = next.app.ensureLogin(); await Promise.resolve(); await Promise.resolve();
  const forced = next.app.ensureLogin({ force: true });
  resolveIdentity({ success: true, data: { userId } }); await Promise.all([normal, forced]);
  assert.equal(h.calls.filter(type => type === 'auth.login').length, 2);
  h.advance(-60000);
  const rollback = h.build(); rollback.app.restoreLocalState(); await rollback.app.ensureLogin(); assert.equal(h.calls.at(-1), 'auth.login');
  const key = rollback.app.loginCacheKey(rollback.app.loginScope(), userId); h.storage.set(key, { version: 1 });
  const corrupt = h.build(); corrupt.app.restoreLocalState(); await corrupt.app.ensureLogin(); assert.equal(h.calls.at(-1), 'auth.login');
  first.close(); next.close(); rollback.close(); corrupt.close();
});

test('图谱与两种状态合并并发，缓存原始年龄保留，5 分钟到期独立回源', async () => {
  const h = clients(); const client = h.build(); await client.app.ensureLogin();
  client.app.globalData.currentFamily = { _id: 'f1', status: 'active' };
  h.calls.length = 0;
  const graph = client.app.getGraph('f1');
  const rights = client.app.getMembershipStatus('f1'); const badge = client.app.refreshPendingBadge();
  const result = await Promise.all([graph, rights, badge]);
  assert.deepEqual(h.calls, ['graph.get']); assert.equal(result[2], 0);
  const entry = client.app.getCacheEntry('membershipStatus', 'staging|f1'); const at = entry.updatedAt;
  h.advance(60000); await client.app.getGraph('f1'); assert.equal(entry.updatedAt, at);
  h.advance(240000); await Promise.all([client.app.getMembershipStatus('f1'), client.app.refreshPendingBadge()]);
  assert.equal(h.calls.filter(type => type === 'membership.status').length, 1);
  assert.equal(h.calls.filter(type => type === 'change.pendingCount').length, 1);
  client.close();
});

test('冻结后的真实业务即时拒绝并清除 24 小时登录缓存，缓存不授予权限', async () => {
  const h = clients(); const client = h.build(); await client.app.ensureLogin();
  const key = client.app.loginCacheKey(client.app.loginScope(), userId); assert.ok(h.storage.has(key));
  h.db.put('users', userId, { status: 'frozen' });
  await assert.rejects(client.api.call('graph.get', { familyId: 'f1' }), { code: 'ACCOUNT_FROZEN' });
  assert.equal(h.storage.has(key), false); assert.equal(client.app.globalData.accountState, 'frozen'); assert.equal(client.app.globalData.loggedIn, false);
  h.db.put('users', userId, { status: 'active' }); await client.app.ensureLogin(); assert.equal(client.app.globalData.loggedIn, true);
  client.close();
});

test('查看者自己的历史申请仍可列出，但角标保持零；来源角色变化不丢弃刚验证的状态', async () => {
  const h = clients(); const client = h.build(); await client.app.ensureLogin();
  const id = 'fm_' + crypto.createHash('sha256').update('f1:fixture-actor').digest('hex').slice(0, 32);
  h.db.put('family_memberships', id, { familyId: 'f1', userId, status: 'active', role: 'viewer' });
  h.db.put('change_requests', 'old-request', { familyId: 'f1', createdBy: userId, status: 'pending', type: 'update_person', payload: {} });
  client.app.globalData.currentFamily = { _id: 'f1', currentRole: 'member', status: 'active' };
  const data = await client.app.getDashboard('f1');
  assert.equal(data.stats.pendingCount, 1); assert.equal(client.app._pendingBadgeCount, 0);
  client.app.setCurrentFamily(data.family);
  assert.equal(client.app.isCacheFresh('membershipStatus', 'staging|f1'), true);
  assert.equal(client.app._pendingBadgeUpdatedAt, h.now());
  assert.equal(client.app._badgeChangeTimer, undefined);
  client.close();
});

test('清理会话后的业务迟到响应不回填缓存、不写本机访问回执', async () => {
  const h = clients(); let release;
  const client = h.build(async data => {
    const response = await h.server().call(data);
    if (data.type === 'graph.get') await new Promise(resolve => { release = resolve; });
    return response;
  });
  await client.app.ensureLogin();
  const pending = client.api.call('graph.get', { familyId: 'f1' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  client.app.clearLocalData(); release();
  await assert.rejects(pending, { code: 'ACCOUNT_SESSION_CHANGED' });
  assert.equal(client.app.globalData.user, null);
  assert.equal([...h.storage.keys()].filter(key => key.startsWith('youpu_activity_')).length, 0);
  client.close();
});

test('看板五项完成度聚合严格保留原 truthiness 和四舍五入，0/99/100/101/500 人及超限', async () => {
  const samples = [{}, { name: '', gender: 'unknown', birthDate: null, avatarAssetId: false, bio: 0 },
    { name: '0', gender: 'female', birthDateInfo: {}, avatarAssetId: 'asset', birthPlace: '虚构地点' },
    { name: '虚构人', gender: false, birthDate: '2000-01-01', avatarAssetId: 0, bio: '' }, { name: 0, gender: 'male', birthDateInfo: '', bio: '虚构简介' }];
  for (const total of [0, 99, 100, 101, 500, 501]) {
    const { db, h } = userFixture(); const persons = Array.from({ length: total }, (_, i) => samples[i % samples.length]);
    persons.forEach((row, i) => db.put('persons', 'p' + i, { ...row, familyId: 'f1', status: 'active' }));
    db.put('persons', 'ignored', { familyId: 'f1', status: 'deleted', name: 'ignored' });
    const result = await h.call({ type: 'family.dashboard', familyId: 'f1' });
    if (total > 500) { assert.equal(result.code, 'RESULT_LIMIT_EXCEEDED'); continue; }
    assert.equal(result.success, true, result.message);
    const score = persons.reduce((sum, p) => sum + Boolean(p.name) + Boolean(p.gender && p.gender !== 'unknown') + Boolean(p.birthDate || p.birthDateInfo) + Boolean(p.avatarAssetId) + Boolean(p.bio || p.birthPlace), 0);
    assert.equal(result.data.stats.completion, total ? Math.round(score / (total * 5) * 100) : 0);
    assert.equal(h.counts.operations.filter(row => row.collection === 'persons' && row.method === 'end').length, 1);
    assert.equal(h.counts.operations.filter(row => row.collection === 'persons' && row.method === 'get').length, 0);
  }
});

test('升级时旧家谱选择在身份及服务端列表确认后恢复，其他账户不沿用', async () => {
  const h = clients();
  h.db.put('families', 'f2', { name: '虚构第二谱', status: 'active' });
  h.db.put('family_memberships', 'fm_' + crypto.createHash('sha256').update('f2:fixture-actor').digest('hex').slice(0, 32), { familyId: 'f2', userId, status: 'active', role: 'admin' });
  h.storage.set('youpu_user', { _id: userId, status: 'active' }); h.storage.set('youpu_current_family', { _id: 'f2', name: '旧名称' });
  const client = h.build(); client.app.restoreLocalState(); assert.equal(client.app.getCurrentFamily(), null);
  await client.app.loadFamilies(); assert.equal(client.app.getCurrentFamily()._id, 'f2'); assert.equal(client.app.getCurrentFamily().name, '虚构第二谱');
  const nextId = h.switchActor('other-account'); const next = h.build(); next.app.restoreLocalState(); await next.app.loadFamilies();
  assert.equal(next.app.globalData.user._id, nextId); assert.equal(next.app.getCurrentFamily(), null);
  client.close(); next.close();
});

test('旧会话迟到的冻结错误不能清掉已经确认的新账号', async () => {
  const h = clients(); let release; const gate = new Promise(resolve => { release = resolve; });
  const client = h.build(data => data.type === 'graph.get' ? gate : h.server().call(data));
  await client.app.ensureLogin(); const old = client.api.call('graph.get', { familyId: 'f1' });
  await new Promise(resolve => setImmediate(resolve));
  client.app.clearLocalData(); const nextId = h.switchActor('new-live-account'); await client.app.ensureLogin();
  release({ success: false, code: 'ACCOUNT_FROZEN', message: 'old actor frozen' });
  await assert.rejects(old, { code: 'ACCOUNT_SESSION_CHANGED' });
  assert.equal(client.app.globalData.user._id, nextId); assert.equal(client.app.globalData.accountState, 'active'); client.close();
});

test('登录缓存读写失败回退完整请求，成功业务及当前家谱不因落盘失败而失败', async () => {
  const h = clients(); const client = h.build();
  client.wx.getStorageSync = () => { throw new Error('storage unavailable'); };
  client.wx.setStorageSync = () => { throw new Error('storage unavailable'); };
  client.wx.removeStorageSync = () => { throw new Error('storage unavailable'); };
  client.app.restoreLocalState(); await client.app.ensureLogin();
  assert.equal(client.app.globalData.user._id, userId); await client.app.loadFamilies(); assert.equal(client.app.getCurrentFamily()._id, 'f1');
  client.app.setUser({ ...client.app.globalData.user, nickName: '虚构昵称' }); assert.equal(client.app.globalData.user.nickName, '虚构昵称'); client.close();
});

test('同一进程环境变化先清理旧登录与业务缓存，旧家谱不恢复', async () => {
  const h = clients(); const client = h.build(); await client.app.loadFamilies(); await client.app.getGraph('f1');
  const oldScope = client.app.loginScope(); const key = client.app.loginCacheKey(oldScope, userId);
  assert.ok(h.storage.has(key)); const version = client.app._sessionVersion || 0;
  client.app.globalData.env = 'second-fixture-environment';
  assert.equal(client.app.getCurrentFamily(), null); assert.equal(client.app.globalData.user, null);
  assert.ok(client.app._sessionVersion > version); assert.equal(h.storage.has(key), false); assert.equal(client.app.isCacheFresh('graph', 'f1'), false);
  await client.app.ensureLogin(); assert.equal(h.calls.at(-1), 'auth.login'); client.close();
});
