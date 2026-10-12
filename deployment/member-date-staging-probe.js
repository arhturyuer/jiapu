// Temporary, secret-authenticated probe of downloaded staging API code.
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');
const domain = require('./domain');
const personDate = require('./person-date');
const stagingAccounts = require('./staging-account-reset');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const productionEnv = 'cloud1-d5gs5yj4l283d9c6d';
const names = [
  'assert', 'cleanText', 'cleanDate', 'cleanGender', 'assertKnownGender', 'assertGenderChangeAllowed',
  'cleanLifeStatus', 'hash', 'documentData', 'randomToken', 'userId', 'membershipId', 'idempotencyId',
  'getOpenid', 'maybeGet', 'mustGet', 'listAll', 'ensureUser', 'requireActiveUser', 'getFamily',
  'getMembership', 'requireMembership', 'publicPerson', 'normalizePersonDateFields', 'clearDeathDate',
  'assertPersonDates', 'changesAffectPersonDates', 'normalizePerson', 'normalizePersonChanges',
  'requireOwnedMedia', 'moderateText', 'audit', 'mutate', 'personUpdate', 'changeReview',
  'notificationEventId', 'recordNotificationEvent'
];

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function extract(source) {
  const declarations = Array.from(source.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gm));
  const classStart = source.indexOf('class BusinessError extends Error {');
  check(classStart >= 0, 'PROBE_SOURCE_BOUNDARY');
  const parts = [source.slice(classStart, source.indexOf('\nfunction assert(', classStart))];
  for (const name of names) {
    const index = declarations.findIndex(match => match[1] === name);
    check(index >= 0, 'PROBE_SOURCE_BOUNDARY');
    const start = declarations[index].index;
    const bodyStart = source.indexOf('\n', start);
    const end = source.indexOf('\n}', bodyStart);
    check(end > start, 'PROBE_SOURCE_BOUNDARY');
    parts.push(source.slice(start, end + 2));
  }
  // Old staging snapshots remain usable for reproducing the pre-fix failure.
  const helper = declarations.find(match => match[1] === 'personUpdateData');
  if (helper) parts.push(source.slice(helper.index, source.indexOf('\n}', helper.index) + 2));
  return parts.join('\n');
}

function fixture(run) {
  const prefix = 'member_date_probe_' + run;
  return { prefix, actor: prefix + '_actor', familyId: prefix + '_family', personId: prefix + '_person' };
}

function contextFor(f, env) {
  const fakeContext = { OPENID: f.actor, ENV: env };
  const context = {
    db, _: db.command, crypto, domain, personDate, process,
    cloud: { getWXContext: () => fakeContext, openapi: cloud.openapi },
    // Notifications are outside the date transaction under test.
    notificationTemplateIds: () => ({}), ACTIVE_ROLES: ['admin', 'member', 'viewer']
  };
  vm.runInNewContext(extract(fs.readFileSync('./source-index.js', 'utf8')), context);
  context.testAccounts = stagingAccounts.createService({
    db, command: db.command, assert: context.assert, hash: context.hash,
    randomToken: context.randomToken, listAll: context.listAll
  });
  return context;
}

async function rows(name, where) {
  return (await db.collection(name).where(where).limit(100).get()).data || [];
}

async function cleanup(f, context) {
  const actorId = context.userId(f.actor);
  for (const [name, where] of [
    ['audit_logs', { familyId: f.familyId }], ['change_requests', { familyId: f.familyId }],
    ['idempotency_records', { actorId }]
  ]) {
    const found = await rows(name, where);
    check(found.length < 100, 'PROBE_CLEANUP_LIMIT');
    for (const row of found) await db.collection(name).doc(row._id).remove();
    check((await rows(name, where)).length === 0, 'PROBE_CLEANUP_INCOMPLETE');
  }
  for (const [name, id] of [
    ['persons', f.personId], ['family_memberships', context.membershipId(f.familyId, f.actor)],
    ['families', f.familyId], ['users', actorId], ['system_config', f.prefix]
  ]) {
    if (await context.maybeGet(db, name, id)) await db.collection(name).doc(id).remove();
  }
}

function info(calendar, precision, year, month, day) {
  return { calendar, precision, year, month: month || null, day: day || null, isLeapMonth: false };
}

exports.main = async function (event) {
  const env = process.env.PROBE_ENV;
  const actual = cloud.getWXContext() || {};
  check(env && env !== productionEnv && (process.env.TCB_ENV || process.env.SCF_NAMESPACE || actual.ENV) === env, 'PROBE_ENV_REJECTED');
  check(event && event.secret === process.env.PROBE_SECRET && event.run === process.env.PROBE_RUN && /^[a-f0-9]{12}$/.test(event.run), 'PROBE_UNAUTHORIZED');
  const f = fixture(event.run);
  const context = contextFor(f, env);
  if (event.action === 'cleanup') { await cleanup(f, context); return { success: true, cleaned: true }; }
  check(event.action === 'run', 'PROBE_ACTION_REJECTED');
  const outcomes = [];
  let cleaned = false;
  try {
    await db.collection('system_config').doc(f.prefix).set({ data: { kind: 'staging_member_date_probe' } });
    await db.collection('users').doc(context.userId(f.actor)).set({ data: { status: 'active', openid: f.actor } });
    await db.collection('families').doc(f.familyId).set({ data: { status: 'active', contentRevision: 0 } });
    await db.collection('family_memberships').doc(context.membershipId(f.familyId, f.actor)).set({ data: {
      familyId: f.familyId, userId: context.userId(f.actor), role: 'admin', status: 'active', displayName: ''
    } });
    const birth = [info('lunar', 'day', 1991, 1, 1), info('solar', 'day', 1991, 1, 1)];
    const death = [info('solar', 'day', 2012, 1, 1), info('lunar', 'year', 2012)];
    const cases = birth.map((value, i) => ['birth-' + i, { birthDateInfo: value }])
      .concat(death.map((value, i) => ['death-' + i, { deathDateInfo: value }]))
      .concat(birth.flatMap((b, i) => death.map((d, j) => ['combined-' + i + '-' + j, { birthDateInfo: b, deathDateInfo: d }])));
    for (const [label, data] of cases) {
      await db.collection('persons').doc(f.personId).set({ data: {
        familyId: f.familyId, name: '虚构成员', gender: 'male', lifeStatus: 'deceased', status: 'active',
        birthDate: '', deathDate: '', birthDateInfo: null, deathDateInfo: null
      } });
      const requestId = f.prefix + '_' + label;
      try {
        const result = await context.personUpdate({ personId: f.personId, data, requestId });
        const stored = await context.mustGet(db, 'persons', f.personId);
        check(result.pending === false, 'PROBE_UNEXPECTED_PENDING');
        for (const field of Object.keys(data)) check(JSON.stringify(stored[field]) === JSON.stringify(data[field]), 'PROBE_READBACK_MISMATCH');
        outcomes.push({ label, requestId, fields: Object.keys(data), success: true });
      } catch (error) {
        // Log only error classification and SDK diagnostics without payloads.
        const diagnostic = String(error.errMsg || error.message || '').replace(/cloud1-[a-z0-9]+/g, '<env>');
        const reason = /\$date|\$timestamp|operator|dot|field|transaction|update|conflict|invalid|type/i.test(diagnostic)
          ? diagnostic.slice(0, 400) : '';
        outcomes.push({ label, requestId, fields: Object.keys(data), success: false, code: error.code || 'SERVER_ERROR', reason });
      }
    }
    if (outcomes.every(row => row.success)) {
      async function scenario(label, fields, action) {
        try { await action(); outcomes.push({ label, fields, success: true }); }
        catch (error) { outcomes.push({ label, fields, success: false, code: error.code || 'SERVER_ERROR' }); }
      }
      async function update(label, data) {
        return context.personUpdate({ personId: f.personId, data, requestId: f.prefix + '_' + label });
      }
      async function stored() { return context.mustGet(db, 'persons', f.personId); }
      await scenario('clear-dates', ['birthDateInfo', 'deathDateInfo'], async function () {
        await update('clear', { birthDateInfo: null, deathDateInfo: null });
        const value = await stored();
        for (const prefix of ['birth', 'death']) check(value[prefix + 'DateInfo'] === null && value[prefix + 'DateRange'] === null && value[prefix + 'Date'] === '', 'PROBE_CLEAR_MISMATCH');
      });
      await scenario('restore-and-living', ['birthDateInfo', 'deathDateInfo', 'lifeStatus'], async function () {
        await update('restore', { birthDateInfo: birth[0], deathDateInfo: death[1] });
        await update('living', { lifeStatus: 'living' });
        const value = await stored();
        check(value.lifeStatus === 'living' && value.deathDateInfo === null && value.deathDateRange === null && value.deathDate === '', 'PROBE_LIVING_MISMATCH');
      });
      await scenario('invalid-lunar-rejected', ['birthDateInfo'], async function () {
        let code;
        try { await update('invalid-lunar', { birthDateInfo: { ...info('lunar', 'day', 2023, 2, 30), isLeapMonth: true } }); }
        catch (error) { code = error.code; }
        check(code === 'INVALID_PERSON_DATE', 'PROBE_INVALID_LUNAR_ALLOWED');
        check(JSON.stringify((await stored()).birthDateInfo) === JSON.stringify(birth[0]), 'PROBE_REJECTION_WROTE_DATE');
      });
      await scenario('death-before-birth-rejected', ['deathDateInfo', 'lifeStatus'], async function () {
        let code;
        try { await update('invalid-order', { deathDateInfo: info('solar', 'day', 1980, 1, 1), lifeStatus: 'deceased' }); }
        catch (error) { code = error.code; }
        check(code === 'PERSON_DEATH_BEFORE_BIRTH', 'PROBE_DATE_ORDER_ALLOWED');
        check((await stored()).lifeStatus === 'living', 'PROBE_REJECTION_WROTE_STATUS');
      });
      await scenario('legacy-request', ['birthDate', 'deathDate', 'lifeStatus'], async function () {
        await update('legacy', { birthDate: '1991-01-01', deathDate: '2012', lifeStatus: 'deceased' });
        const value = await stored();
        check(value.birthDate === '1991-01-01' && value.deathDate === '2012' && value.birthDateInfo === null, 'PROBE_LEGACY_MISMATCH');
      });
      await scenario('member-review-approval', ['birthDateInfo', 'deathDateInfo'], async function () {
        const membership = db.collection('family_memberships').doc(context.membershipId(f.familyId, f.actor));
        await membership.update({ data: { role: 'member' } });
        const pending = await update('member-submit', { birthDateInfo: birth[0], deathDateInfo: death[1] });
        check(pending.pending === true && (await stored()).birthDateInfo === null, 'PROBE_MEMBER_WROTE_DIRECTLY');
        await membership.update({ data: { role: 'admin' } });
        await context.changeReview({ decision: 'approve', changeRequestId: pending.requestId, requestId: f.prefix + '_approve' });
        const value = await stored();
        check(JSON.stringify(value.birthDateInfo) === JSON.stringify(birth[0]) && JSON.stringify(value.deathDateInfo) === JSON.stringify(death[1]), 'PROBE_APPROVAL_MISMATCH');
      });
      await scenario('unchanged-dates-and-replay', ['lifeStatus'], async function () {
        await update('other', { lifeStatus: 'unknown' });
        await update('other', { lifeStatus: 'unknown' });
        check(JSON.stringify((await stored()).birthDateInfo) === JSON.stringify(birth[0]), 'PROBE_UNTOUCHED_DATE_CHANGED');
        check((await rows('idempotency_records', { actorId: context.userId(f.actor), requestId: f.prefix + '_other' })).length === 1, 'PROBE_REPLAY_DUPLICATED');
      });
    }
    return { success: true, outcomes };
  } finally {
    await cleanup(f, context);
    cleaned = true;
    console.log(JSON.stringify({ action: 'member_date_probe', checks: outcomes.length, passed: outcomes.filter(row => row.success).length, cleaned }));
  }
};
