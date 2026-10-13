// Secret-authenticated, staging-only probe of downloaded function helpers.
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');
const requestContext = require('./request-context');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const realDb = cloud.database();
const PRODUCTION = 'cloud1-d5gs5yj4l283d9c6d';
const ARTIFACTS = new Set(['analytics_reports', 'analytics_snapshots', 'analytics_snapshot_items', 'analytics_daily']);

function check(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
function extract(source, names, className) {
  const parts = [];
  if (className) {
    const start = source.indexOf('class ' + className + ' extends Error');
    check(start >= 0, 'PROBE_SOURCE_BOUNDARY');
    parts.push(source.slice(start, source.indexOf('\n}', start) + 2));
  }
  for (const name of names) {
    const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
    check(match, 'PROBE_SOURCE_BOUNDARY');
    parts.push(source.slice(match.index, source.indexOf('\n}', match.index) + 2));
  }
  return parts.join('\n');
}

function countedDb(counts, run, prefix = '') {
  function wrap(target, name) {
    return new Proxy(target, { get(object, key) {
      const value = object[key];
      if (key === 'collection') return collection => wrap(value.call(object, collection), collection);
      if (key === 'runTransaction') return callback => value.call(object, transaction => callback(wrap(transaction)));
      if (key === 'doc') return id => wrap(value.call(object, prefix && ARTIFACTS.has(name) ? prefix + '_' + id : id), name);
      if (['where', 'limit', 'skip', 'orderBy', 'field'].includes(key)) return (...args) => wrap(value.apply(object, args), name);
      if (['get', 'count', 'set', 'update', 'remove', 'add'].includes(key)) return (...args) => {
        counts[['get', 'count'].includes(key) ? 'reads' : 'writes']++;
        if (prefix && ARTIFACTS.has(name) && ['set', 'add'].includes(key)) args[0] = { ...args[0], data: { ...args[0].data, probeRun: run } };
        return value.apply(object, args);
      };
      return typeof value === 'function' ? value.bind(object) : value;
    } });
  }
  return wrap(realDb);
}

function identity(run) {
  const actor = 'calls_probe_' + run;
  const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
  const familyId = 'calls_probe_' + run + '_family';
  return { actor, userId: 'u_' + hash(actor), familyId, membershipId: 'fm_' + hash(familyId + ':' + actor),
    preferenceId: 'fp_' + hash(familyId + ':' + actor), prefix: 'calls_probe_' + run };
}

function userHelpers(phase, f, counts) {
  const source = fs.readFileSync('./' + phase + '-user/index.js', 'utf8');
  const db = countedDb(counts);
  const context = { db, _: db.command, crypto, requestContext,
    domain: require('./' + phase + '-user/domain'), commerce: require('./' + phase + '-user/commerce'),
    personDate: require('./' + phase + '-user/person-date'),
    cloud: { getWXContext: () => ({ OPENID: f.actor }) },
    testAccounts: { currentUserId: (_, id) => id, identityKey: openid => openid },
    ACTIVE_ROLES: ['admin', 'member', 'viewer'], GRAPH_PERSON_LIMIT: 500, GRAPH_RELATION_LIMIT: 2000 };
  vm.runInNewContext(extract(source, ['assert', 'cleanText', 'hash', 'userId', 'membershipId', 'preferenceId', 'getOpenid',
    'maybeGet', 'mustGet', 'listAll', 'ensureUser', 'requireActiveUser', 'getFamily', 'getMembership', 'requireMembership',
    'publicAccount', 'publicFamily', 'normalizeFamilyPreference', 'profileMissingFields', 'authLogin',
    'changePendingCount', 'membershipStatus', 'graphGet', 'recordBusinessActivity'], 'BusinessError'), context);
  context.analytics = require('./' + phase + '-user/analytics');
  context.analyticsTracker = require('./' + phase + '-user/analytics').createTracker(db);
  return context;
}

async function seed(f, run) {
  const at = new Date();
  for (const [name, id, data] of [
    ['users', f.userId, { status: 'active', openid: f.actor, createdAt: at, firstEnteredFamilyAt: at, firstExampleViewedAt: at }],
    ['families', f.familyId, { status: 'active', creatorId: f.userId, name: '虚构优化验收家谱', createdAt: at, personCount: 3, relationCount: 2 }],
    ['family_memberships', f.membershipId, { familyId: f.familyId, userId: f.userId, role: 'admin', status: 'active', joinedAt: at }],
    ['user_family_preferences', f.preferenceId, {}],
    ['system_config', f.prefix + '_analytics', { trackingStartedAt: new Date(at.getTime() - 7 * 86400000) }]
  ]) await realDb.collection(name).doc(id).set({ data: { ...data, probeRun: run } });
  for (let i = 0; i < 3; i++) {
    await realDb.collection('persons').doc(f.prefix + '_person_' + i).set({ data: {
      familyId: f.familyId, name: '虚构成员' + i, gender: 'male', lifeStatus: 'living', status: 'active', probeRun: run
    } });
    if (i) await realDb.collection('relations').doc(f.prefix + '_relation_' + i).set({ data: {
      familyId: f.familyId, type: 'parent_child', fromPersonId: f.prefix + '_person_0', toPersonId: f.prefix + '_person_' + i, status: 'active', probeRun: run
    } });
  }
}

async function readRows(name, where) { return (await realDb.collection(name).where(where).limit(100).get()).data || []; }
async function clean(f, run) {
  for (const name of ['persons', 'relations', 'idempotency_records', ...ARTIFACTS]) {
    while (true) {
      const rows = await readRows(name, { probeRun: run });
      if (!rows.length) break;
      await realDb.collection(name).where(realDb.command.and([{ probeRun: run }, { _id: realDb.command.in(rows.map(row => row._id)) }])).remove();
    }
    check((await readRows(name, { probeRun: run })).length === 0, 'PROBE_CLEANUP_INCOMPLETE');
  }
  for (const kind of [['user', f.userId], ['family', f.familyId]]) {
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const id = 'a_' + crypto.createHash('sha256').update(kind[0] + ':' + date + ':' + kind[1]).digest('hex').slice(0, 40);
    await realDb.collection('analytics_activity_daily').doc(id).remove();
  }
  for (const [name, id] of [['user_family_preferences', f.preferenceId], ['family_memberships', f.membershipId],
    ['families', f.familyId], ['users', f.userId], ['system_config', f.prefix + '_analytics']]) await realDb.collection(name).doc(id).remove();
}

async function measure(phase, f, run) {
  const rows = [];
  const counts = { reads: 0, writes: 0 };
  const context = userHelpers(phase, f, counts);
  // Both versions see the same established daily facts. Compare the redundant
  // reads after daily capture has already succeeded, not first-visit writes.
  const user = (await realDb.collection('users').doc(f.userId).get()).data;
  await context.analyticsTracker.record(user, '', false, false);
  await context.analyticsTracker.record(user, f.familyId, false, false);
  await context.analyticsTracker.record(user, f.familyId, true, false);
  for (const [action, handler, payload] of [
    ['auth.login', context.authLogin, {}], ['change.pendingCount', context.changePendingCount, { familyId: f.familyId }],
    ['membership.status', context.membershipStatus, { familyId: f.familyId }], ['graph.get', context.graphGet, { familyId: f.familyId }]
  ]) {
    counts.reads = 0; counts.writes = 0;
    await requestContext.run(async () => {
      const data = await handler(payload);
      if (action === 'graph.get') check(data.persons.length === 3 && data.relations.length === 2, 'PROBE_GRAPH_MISMATCH');
      await context.recordBusinessActivity(action, payload, data);
    });
    rows.push({ phase, scenario: action, ...counts });
  }
  await realDb.collection('users').doc(f.userId).update({ data: { status: 'frozen' } });
  let rejected;
  try { await requestContext.run(() => context.changePendingCount({ familyId: f.familyId })); }
  catch (error) { rejected = error.code; }
  check(rejected === 'ACCOUNT_FROZEN', 'PROBE_FROZEN_ALLOWED');
  await realDb.collection('users').doc(f.userId).update({ data: { status: 'active' } });

  const opsDb = countedDb(counts, run, f.prefix + '_' + phase);
  const operator = { db: opsDb, _: opsDb.command, Buffer, OpsError: class extends Error {}, assert: check,
    cleanText: value => String(value || ''), chunks: (values, size) => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size)) };
  vm.runInNewContext(extract(fs.readFileSync('./' + phase + '-ops/index.js', 'utf8'), ['listAll', 'listByIds']), operator);
  const restrict = where => ({ ...where, probeRun: run });
  const service = require('./' + phase + '-ops/analytics-service').createService({ db: opsDb, command: opsDb.command,
    listAll: (name, where, limit) => operator.listAll(name, restrict(where), limit),
    listByIds: (name, field, ids, where, limit) => operator.listByIds(name, field, ids, restrict(where), limit),
    maybeGet: async (name, id) => {
      try { return (await opsDb.collection(name).doc(name === 'system_config' && id === 'analytics' ? f.prefix + '_analytics' : id).get()).data; }
      catch (error) { if (/does not exist|not.?found/i.test(error.message || error.errMsg || '')) return null; throw error; }
    }
  }, () => new Date(clock));
  let clock = Date.now();
  const day = new Date(clock + 8 * 3600000).toISOString().slice(0, 10);
  const filters = { startDay: day, endDay: day, window: 'day', paymentMode: 'mock' };
  const initial = await service.summary(filters);
  check(initial.totals.newUsers === 1, 'PROBE_REPORT_FIXTURE_MISMATCH');
  clock += 31000; counts.reads = 0; counts.writes = 0;
  const repeated = await service.summary(filters);
  rows.push({ phase, scenario: 'report-repeat-after-31s', ...counts, sameSnapshot: initial.snapshotId === repeated.snapshotId });
  const detail = await service.details({ ...filters, snapshotId: initial.snapshotId, metric: 'newUsers', pageSize: 20 });
  check(detail.total === 1 && detail.items[0]._id === f.userId && detail.asOf === initial.asOf, 'PROBE_SNAPSHOT_MISMATCH');

  const jobs = { db: countedDb(counts), retentionCleanup: require('./retention-cleanup') };
  vm.runInNewContext(extract(fs.readFileSync('./' + phase + '-jobs/index.js', 'utf8'), ['removeMany']), jobs);
  const expired = new Date(Date.now() - 1000);
  for (let offset = 0; offset < 102; offset += 20) {
    const writes = await Promise.allSettled(Array.from({ length: Math.min(20, 102 - offset) }, (_, i) => {
      const index = offset + i;
      return realDb.collection('idempotency_records').doc(f.prefix + '_expired_' + index).set({ data: {
        actorId: f.userId, action: 'probe.retention', requestId: f.prefix + '_expired_' + index, status: 'completed',
        probeRun: run, expiresAt: index === 101 ? new Date(Date.now() + 86400000) : expired
      } });
    }));
    // A rejected write must not leave other writes running after cleanup.
    const rejected = writes.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
  counts.reads = 0; counts.writes = 0;
  const removed = await jobs.removeMany('idempotency_records', { probeRun: run, expiresAt: realDb.command.lt(new Date()) }, 101);
  check(removed === 101, 'PROBE_RETENTION_COUNT');
  rows.push({ phase, scenario: 'cleanup-101-expired', ...counts });
  check((await realDb.collection('idempotency_records').doc(f.prefix + '_expired_101').get()).data, 'PROBE_FUTURE_DELETED');
  await realDb.collection('idempotency_records').doc(f.prefix + '_expired_101').remove();
  return rows;
}

exports.main = async event => {
  const target = process.env.PROBE_ENV;
  const actual = process.env.TCB_ENV || process.env.SCF_NAMESPACE || (cloud.getWXContext() || {}).ENV;
  check(target && target !== PRODUCTION && actual === target, 'PROBE_ENV_REJECTED');
  check(event && event.secret === process.env.PROBE_SECRET && event.run === process.env.PROBE_RUN && /^[a-f0-9]{12}$/.test(event.run), 'PROBE_UNAUTHORIZED');
  const f = identity(event.run);
  if (event.action === 'cleanup') { await clean(f, event.run); return { success: true, cleaned: true }; }
  check(event.action === 'run', 'PROBE_ACTION_REJECTED');
  const rows = [];
  try {
    await seed(f, event.run);
    for (const phase of ['baseline', 'after']) rows.push(...await measure(phase, f, event.run));
    return { success: true, rows, checks: ['graph-shape', 'frozen-account', 'snapshot-details', 'unexpired-record'], cleaned: true };
  } finally { await clean(f, event.run); }
};
