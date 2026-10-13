// Restricted to a secret-authenticated independent staging environment.
const cloud = require('wx-server-sdk');
const crypto = require('node:crypto');
const path = require('node:path');
const { runtime, countedDatabase } = require('./counting-runtime');
const fs = require('node:fs');
const vm = require('node:vm');
const { miniapp } = require('./miniapp-runtime');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const instanceId = crypto.randomBytes(8).toString('hex');
const production = 'cloud1-d5gs5yj4l283d9c6d';
const digest = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
function canonical(value) {
  if (value && typeof value.toISOString === 'function') return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function check(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
function fixture(run, phase) {
  const actor = 'db_calls_' + run + '_' + phase;
  const prefix = actor;
  return { actor, prefix, userId: 'u_' + digest(actor), familyId: prefix + '_f0',
    membershipId: 'fm_' + digest(prefix + '_f0:' + actor), run, phase };
}
async function put(name, id, data, f) { await db.collection(name).doc(id).set({ data: { ...data, probeRun: f.run } }); }
async function seed(f) {
  const at = new Date('2026-10-01T01:00:00Z');
  await put('users', f.userId, { status: 'active', createdAt: at, firstEnteredFamilyAt: at, firstExampleViewedAt: at }, f);
  await put('operators', f.prefix + '_operator', { authUid: f.actor, status: 'active', role: 'operator' }, f);
  for (let i = 0; i < 20; i++) await put('families', f.prefix + '_f' + i,
    { status: 'active', name: '虚构验收家谱', creatorId: f.userId, personCount: i ? 0 : 3, relationCount: i ? 0 : 2, createdAt: at, contentRevision: 0 }, f);
  await put('family_memberships', f.membershipId, { familyId: f.familyId, userId: f.userId, status: 'active', role: 'admin' }, f);
  for (let i = 0; i < 3; i++) {
    await put('persons', f.prefix + '_p' + i, { familyId: f.familyId, status: 'active', name: '虚构成员', gender: 'male' }, f);
    if (i) await put('relations', f.prefix + '_r' + i, { familyId: f.familyId, status: 'active', type: 'parent_child', fromPersonId: f.prefix + '_p0', toPersonId: f.prefix + '_p' + i }, f);
  }
}
function metrics(h) { const { reads, writes, transactions, commits, retries, functions, operations } = h.counts; return { reads, writes, transactions, commits, retries, functions, businessReads: operations.filter(row => row.segment === 'business' && row.collection !== 'system_config' && ['get', 'count', 'end'].includes(row.method)).length,
  collections: Object.fromEntries([...new Set(operations.map(row => row.collection))].map(name => [name, operations.filter(row => row.collection === name)])) }; }
async function measure(phase, f, kind, scenario, requests) {
  const h = runtime(path.join(__dirname, phase + '-' + kind), db, { actor: f.actor, environment: process.env.PROBE_ENV });
  const started = Date.now(); const results = [];
  for (const request of requests) {
    const result = await h.call(request);
    check(result.success, result.code || 'PROBE_BUSINESS_FAILED');
    results.push(result.data);
  }
  return { phase, scenario, ...metrics(h), elapsedMs: Date.now() - started, results };
}
async function clientScenario(phase, f, scenario) {
  let started = Date.now();
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } constructor(...args) { super(...(args.length ? args : [clock])); } }
  const h = runtime(path.join(__dirname, phase + '-user'), db, { actor: f.actor, environment: process.env.PROBE_ENV, now: () => clock, Date: Clock });
  const pending = []; const storage = new Map(); const calls = [];
  const build = () => miniapp({ sourceRoot: path.join(__dirname, phase + '-client'), environment: process.env.PROBE_ENV, now: () => clock, storage,
    call: data => { calls.push(data.type); const operation = h.call(data); pending.push(operation); return operation; } });
  async function drain() { await Promise.all(pending); await new Promise(resolve => setImmediate(resolve)); }
  const client = build(); client.app.restoreLocalState(); await client.app.ensureLogin();
  client.app.recordVisibleActivity(); await drain();
  if (scenario === 'client-cold-login') {
    const resumed = build(); resumed.app.restoreLocalState();
    for (const key of ['reads', 'writes', 'transactions', 'commits', 'retries', 'functions']) h.counts[key] = 0;
    h.counts.operations.length = 0; calls.length = 0; started = Date.now();
    await resumed.app.ensureLogin(); await drain(); resumed.close();
  } else {
    await client.app.loadFamilies();
    await client.app.getGraph(f.familyId);
    await drain();
    if (scenario === 'client-states5min') {
      for (const key of ['reads', 'writes', 'transactions', 'commits', 'retries', 'functions']) h.counts[key] = 0;
      h.counts.operations.length = 0; calls.length = 0; started = Date.now();
      for (let i = 0; i < 20; i++) {
        await Promise.all([client.app.ensureLogin(), client.app.getMembershipStatus(f.familyId), client.app.refreshPendingBadge()]);
        clock += 15000;
      }
    } else if (scenario === 'client-journey') {
      await client.app.loadFamilyPages(true);
      await client.app.getDashboard(f.familyId);
      await client.app.getProfileData(() => client.app.ensureLogin().then(data => ({ user: data.user })));
      await client.app.getPersonDetail(f.prefix + '_p0');
      const updated = await client.api.call('person.update', { personId: f.prefix + '_p0', data: { bio: '虚构资料更新' }, idempotencyKey: 'journey-edit' });
      if (!client.app.handleFamilyMutation) client.app.applyPersonUpdate(f.familyId, updated.person);
      await client.app.getGraph(f.familyId);
    } else if (scenario === 'client-review') {
      await client.app.loadFamilyPages(true);
      await client.app.getDashboard(f.familyId);
      await client.api.call('change.review', { changeRequestId: f.prefix + '_change', decision: 'approve', idempotencyKey: 'journey-review' });
      if (!client.app.handleFamilyMutation) {
        client.app.invalidateFamilyData(f.familyId);
        client.app.refreshPendingBadge({ force: true }).catch(() => {});
      }
      await client.app.loadFamilyPages(true, { force: phase === 'before' });
      await client.app.getDashboard(f.familyId, { force: true });
      await client.app.getGraph(f.familyId);
    }
    await drain();
  }
  client.close();
  return { phase, scenario, ...metrics(h), elapsedMs: Date.now() - started, calls };
}

async function maintenanceScenario(phase, f, method) {
  const name = method === 'update' ? 'payment_orders' : 'notifications';
  const counts = { reads: 0, writes: 0, functions: 0, transactions: 0, commits: 0, retries: 0, operations: [] };
  const counted = countedDatabase(db, counts);
  await db.collection('families').doc(f.familyId).update({ data: { status: 'deleting' } });
  for (let offset = 0; offset < 101; offset += 25) {
    const writes = await Promise.allSettled(Array.from({ length: Math.min(25, 101 - offset) }, (_, j) => put(name, f.prefix + '_' + method + '_' + String(offset + j).padStart(4, '0'), { familyId: f.familyId, status: 'paid' }, f)));
    const failed = writes.find(row => row.status === 'rejected'); if (failed) throw failed.reason;
  }
  let processed; const started = Date.now();
  if (phase === 'before') {
    const source = fs.readFileSync(path.join(__dirname, 'before-jobs/index.js'), 'utf8');
    const functionName = method === 'update' ? 'updateManyStable' : 'removeMany';
    const start = source.indexOf('async function ' + functionName + '(');
    const end = source.indexOf('\nasync function ', start + 10);
    const context = { db: counted, retentionCleanup: { supports: () => false } };
    vm.runInNewContext(source.slice(start, end) + ';this.run = ' + functionName + ';', context);
    processed = method === 'update' ? await context.run(name, { familyId: f.familyId }, { familyDeletedAt: new Date() }, 101) : await context.run(name, { familyId: f.familyId }, 101);
  } else {
    processed = await require('./after-jobs/maintenance-batch').apply(counted, name, { familyId: f.familyId }, { familyDeletedAt: new Date() }, 101, { kind: 'family', familyId: f.familyId }, method);
  }
  check(processed === 101, 'PROBE_MAINTENANCE_RESULT');
  check(method === 'update' ? (await db.collection(name).where({ probeRun: f.run, familyId: f.familyId }).count()).total === 101
    : !(await db.collection(name).where({ probeRun: f.run, familyId: f.familyId }).limit(1).get()).data.length, 'PROBE_MAINTENANCE_STATE');
  await db.collection('families').doc(f.familyId).update({ data: { status: 'active' } });
  return { phase, scenario: 'maintenance101-' + method, scope: 'deployed-helper-sdk', ...metrics({ counts }), elapsedMs: Date.now() - started };
}
async function reportScenario(phase, f, asOf) {
  // A vacant fictitious day prevents overwriting an existing staging aggregate.
  const date = new Date(Date.UTC(1900, 0, 1) + parseInt(f.run.slice(0, 6), 16) % 30000 * 86400000).toISOString().slice(0, 10);
  check(!(await db.collection('analytics_daily').where({ day: date }).limit(1).get()).data.length, 'PROBE_REPORT_DAY_OCCUPIED');
  await db.collection('users').doc(f.userId).update({ data: { createdAt: new Date(date + 'T01:00:00Z') } });
  await db.collection('families').where({ probeRun: f.run, creatorId: f.userId }).update({ data: { createdAt: new Date(date + 'T01:00:00Z') } });
  const row = await measure(phase, f, 'ops', 'report-build', [{ action: 'analytics.summary', startDay: date, endDay: date, asOf, window: 'asOf' }]);
  const report = row.results[0]; check(report.totals.newUsers === 1 && report.totals.newFamilies === 20, 'PROBE_REPORT_TOTALS');
  await db.collection('analytics_snapshots').doc(report.snapshotId).update({ data: { probeRun: f.run } });
  const reports = (await db.collection('analytics_reports').where({ 'report.snapshotId': report.snapshotId }).limit(1).get()).data;
  check(reports.length === 1, 'PROBE_REPORT_CACHE');
  await db.collection('analytics_reports').doc(reports[0]._id).update({ data: { probeRun: f.run } });
  await db.collection('analytics_daily').where({ day: date }).update({ data: { probeRun: f.run } });
  for (const metric of Object.keys((await db.collection('analytics_snapshots').doc(report.snapshotId).get()).data.counts)) {
    await db.collection('analytics_snapshot_items').where({ group: report.snapshotId + ':' + metric }).update({ data: { probeRun: f.run } });
  }
  const h = runtime(path.join(__dirname, phase + '-ops'), db, { actor: f.actor, environment: process.env.PROBE_ENV });
  const page = await h.call({ action: 'analytics.details', snapshotId: report.snapshotId, ...report.filters, metric: 'newFamilies', pageSize: 20 });
  check(page.success && page.data.total === 20 && page.data.items.length === 20 && page.data.asOf === report.asOf, 'PROBE_REPORT_DETAIL');
  const cached = await h.call({ action: 'analytics.summary', startDay: date, endDay: date, asOf, window: 'asOf' });
  check(cached.success && cached.data.snapshotId === report.snapshotId, 'PROBE_REPORT_SNAPSHOT_CHANGED');
  return row;
}

async function clean(run) {
  const f = ['before', 'after'].map(phase => fixture(run, phase));
  for (const name of ['users', 'operators', 'families', 'family_memberships', 'persons', 'relations', 'change_requests', 'media_assets', 'audit_logs', 'idempotency_records', 'rate_limits', 'analytics_activity_daily', 'payment_orders', 'notifications', 'analytics_reports', 'analytics_snapshots', 'analytics_snapshot_items', 'analytics_daily']) {
    let where;
    if (['users', 'operators', 'families', 'family_memberships', 'persons', 'relations', 'change_requests', 'payment_orders', 'notifications', 'analytics_reports', 'analytics_snapshots', 'analytics_snapshot_items', 'analytics_daily'].includes(name)) where = { probeRun: run };
    else if (name === 'media_assets') where = { ownerId: db.command.in(f.map(row => row.userId)) };
    else if (name === 'audit_logs') where = { actorId: db.command.in(f.map(row => row.userId)) };
    else if (name === 'analytics_activity_daily') where = { entityId: db.command.in(f.flatMap(row => [row.userId, row.familyId])) };
    else where = { actorId: db.command.in(f.map(row => row.userId)) };
    while (true) {
      const rows = (await db.collection(name).where(where).limit(100).get()).data || [];
      if (!rows.length) break;
      const removed = await db.collection(name).where(db.command.and([where, { _id: db.command.in(rows.map(row => row._id)) }])).remove();
      check(removed.stats && removed.stats.removed > 0, 'PROBE_CLEANUP_STALLED');
    }
    check((await db.collection(name).where(where).limit(1).get()).data.length === 0, 'PROBE_CLEANUP_INCOMPLETE');
  }
  return true;
}
exports.main = async function (event) {
  const actual = process.env.TCB_ENV || process.env.SCF_NAMESPACE || (cloud.getWXContext() || {}).ENV;
  check(actual && actual !== production && actual === process.env.PROBE_ENV, 'PROBE_ENV_REJECTED');
  check(event && event.secret === process.env.PROBE_SECRET && event.run === process.env.PROBE_RUN, 'PROBE_UNAUTHORIZED');
  if (event.action === 'cleanup') {
    check(Array.isArray(event.previousRuns || []) && (event.previousRuns || []).every(run => /^[a-f0-9]{12}$/.test(run)), 'PROBE_CLEANUP_RUN_REJECTED');
    for (const previous of event.previousRuns || []) await clean(previous);
    return { success: true, cleaned: await clean(event.run) };
  }
  check(event.action === 'run', 'PROBE_ACTION_REJECTED');
  check(!event.phase || ['before', 'after'].includes(event.phase), 'PROBE_PHASE_REJECTED');
  const rows = []; const asOf = event.asOf || new Date().toISOString();
  for (const phase of event.phase ? [event.phase] : ['before', 'after']) {
    const f = fixture(event.run, phase); await seed(f);
    rows.push(await measure(phase, f, 'ops', 'funnel', [{ action: 'dashboard.summary' }]));
    // Restrict the list to this fixture by querying an independently tagged status.
    await db.collection('families').where({ probeRun: f.run, creatorId: f.userId }).update({ data: { status: f.prefix } });
    rows.push(await measure(phase, f, 'ops', 'families20', [{ action: 'families.list', status: f.prefix, pageSize: 20 }]));
    await db.collection('families').where({ probeRun: f.run, creatorId: f.userId }).update({ data: { status: 'active' } });
    rows.push(await measure(phase, f, 'user', 'family-save-replay', [0, 1].map(() => ({ type: 'family.update', familyId: f.familyId, name: '虚构更新名称', requestId: 'fixture-save' }))));
    const concurrent = runtime(path.join(__dirname, phase + '-user'), db, { actor: f.actor, environment: process.env.PROBE_ENV });
    const concurrentResult = await Promise.all([0, 1].map(() => concurrent.call({ type: 'family.update', familyId: f.familyId, name: '虚构并发更新', requestId: 'concurrent-save' })));
    check(concurrentResult.some(row => row.success), 'PROBE_CONCURRENT_FAILED');
    const replay = await concurrent.call({ type: 'family.update', familyId: f.familyId, name: '虚构并发更新', requestId: 'concurrent-save' });
    check(replay.success, 'PROBE_CONCURRENT_REPLAY_FAILED');
    const winner = concurrentResult.find(row => row.success);
    check(JSON.stringify(canonical(winner.data)) === JSON.stringify(canonical(replay.data)), 'PROBE_CONCURRENT_REPLAY_DIFFERENT_' + phase);
    check((await db.collection('audit_logs').where({ actorId: f.userId, action: 'family.update' }).count()).total === 2, 'PROBE_CONCURRENT_DUPLICATE');
    const afterConcurrent = (await db.collection('families').doc(f.familyId).get()).data;
    check(afterConcurrent.contentRevision === 2, 'PROBE_CONCURRENT_REVISION');
    rows.push({ phase, scenario: 'concurrent-same-key', ...metrics(concurrent), informational: true, concurrentCodes: concurrentResult.map(row => row.success ? 'OK' : row.code), replayConfirmed: true });
    rows.push(await measure(phase, f, 'user', 'media-prepare', [{ type: 'media.prepare', kind: 'user_avatar', requestId: 'fixture-upload' }]));
    if (Number(process.env.PROBE_STAGE || 1) >= 2) {
      rows.push(await measure(phase, f, 'user', 'graph-status-bundle', phase === 'before'
        ? [{ type: 'graph.get', familyId: f.familyId }, { type: 'membership.status', familyId: f.familyId }, { type: 'change.pendingCount', familyId: f.familyId }]
        : [{ type: 'graph.get', familyId: f.familyId, includeStatus: true }]));
      rows.push(await clientScenario(phase, f, 'client-cold-login'));
      rows.push(await clientScenario(phase, f, 'client-states5min'));
      rows.push(await clientScenario(phase, f, 'client-journey'));
      await put('change_requests', f.prefix + '_change', { familyId: f.familyId, type: 'update_person', status: 'pending', createdBy: f.userId,
        payload: { personId: f.prefix + '_p0', changes: { bio: '虚构审核更新' } } }, f);
      rows.push(await clientScenario(phase, f, 'client-review'));
      check((await db.collection('persons').doc(f.prefix + '_p0').get()).data.bio === '虚构审核更新', 'PROBE_REVIEW_RESULT');
    }
    if (Number(process.env.PROBE_STAGE || 1) >= 3) {
      for (let offset = 3; offset < 500; offset += 25) {
        const writes = await Promise.allSettled(Array.from({ length: Math.min(25, 500 - offset) }, (_, j) => {
          const i = offset + j;
          return put('persons', f.prefix + '_p' + i, { familyId: f.familyId, status: 'active', name: i % 2 ? '' : '虚构成员', gender: 'unknown', birthDateInfo: i % 3 ? null : {}, avatarAssetId: i % 5 ? '' : 'fixture', birthPlace: i % 7 ? '' : '虚构地点' }, f);
        }));
        const failed = writes.find(row => row.status === 'rejected'); if (failed) throw failed.reason;
      }
      rows.push(await measure(phase, f, 'user', 'dashboard500', [{ type: 'family.dashboard', familyId: f.familyId }]));
      for (const method of ['update', 'remove']) rows.push(await maintenanceScenario(phase, f, method));
      rows.push(await reportScenario(phase, f, asOf));
    }
    const family = (await db.collection('families').doc(f.familyId).get()).data;
    check(family.contentRevision === (Number(process.env.PROBE_STAGE || 1) >= 2 ? 4 : 2), 'PROBE_REVISION_MISMATCH');
    const audits = (await db.collection('audit_logs').where({ actorId: f.userId, action: 'family.update' }).limit(10).get()).data;
    check(audits.length === 2, 'PROBE_DUPLICATE_AUDIT');
    for (const role of ['member', 'viewer']) {
      await db.collection('family_memberships').doc(f.membershipId).update({ data: { role } });
      const access = runtime(path.join(__dirname, phase + '-user'), db, { actor: f.actor, environment: process.env.PROBE_ENV });
      const graph = await access.call({ type: 'graph.get', familyId: f.familyId, includeStatus: true });
      check(graph.success && graph.data.currentRole === role, 'PROBE_ROLE_READ_FAILED');
      check((await access.call({ type: 'family.update', familyId: f.familyId, name: '拒绝角色写入', requestId: 'role-' + role })).code === 'NO_PERMISSION', 'PROBE_ROLE_WRITE_ALLOWED');
    }
    await db.collection('family_memberships').doc(f.membershipId).update({ data: { role: 'admin' } });
    await db.collection('users').doc(f.userId).update({ data: { status: 'frozen' } });
    const h = runtime(path.join(__dirname, phase + '-user'), db, { actor: f.actor, environment: process.env.PROBE_ENV });
    check((await h.call({ type: 'family.update', familyId: f.familyId, name: '拒绝虚构修改', requestId: 'frozen' })).code === 'ACCOUNT_FROZEN', 'PROBE_FROZEN_ALLOWED');
    await clean(event.run);
  }
  for (const scenario of ['dashboard500', 'report-build']) {
    const before = rows.find(row => row.phase === 'before' && row.scenario === scenario);
    const after = rows.find(row => row.phase === 'after' && row.scenario === scenario);
    if (before && after) {
      const extract = row => scenario === 'dashboard500' ? row.results[0].stats : { totals: row.results[0].totals, rows: row.results[0].rows, sku: row.results[0].sku, filters: row.results[0].filters, asOf: row.results[0].asOf };
      check(JSON.stringify(extract(before)) === JSON.stringify(extract(after)), 'PROBE_RESULT_DIFFERENT_' + scenario);
    }
  }
  return { success: true, rows, instanceId };
};
