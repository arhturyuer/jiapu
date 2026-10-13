require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const api = require('../miniprogram/utils/api');
const clientDate = require('../miniprogram/utils/person-date');
const serverDate = require('../cloudfunctions/youpuUserApi/person-date');
const domain = require('../cloudfunctions/youpuUserApi/domain');
const { createDatabase } = require('./helpers/membership-db');

function info(calendar, precision, year, month, day, isLeapMonth) {
  return { calendar, precision, year, month: month || null, day: day || null, isLeapMonth: Boolean(isLeapMonth) };
}

function sourcePart(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

function server(role = 'admin') {
  const db = createDatabase();
  // CloudBase flattens a plain update object into child paths. Those paths
  // cannot be created under null; command.set replaces the entire field.
  db.writeHook = async function (name, id, data, transactional) {
    if (name !== 'persons' || !transactional) return;
    const previous = db.get(name, id);
    for (const field of ['birthDateInfo', 'deathDateInfo', 'birthDateRange', 'deathDateRange']) {
      const value = data[field];
      if (previous && previous[field] === null && value && typeof value === 'object' && !value.op) {
        throw Object.assign(new Error('Cannot create child field under null'), { code: 'DATABASE_REQUEST_FAILED' });
      }
    }
  };
  const context = {
    db, _: db.command, personDate: serverDate, domain, requestContext: require('../cloudfunctions/youpuUserApi/request-context'),
    cleanDate: domain.cleanDate, cleanText: domain.cleanText,
    assert: function (condition, code, message) { if (!condition) throw Object.assign(new Error(message), { code }); },
    getOpenid: () => 'fake-actor', userId: () => 'fake-user',
    hash: (value, length) => crypto.createHash('sha256').update(value).digest('hex').slice(0, length),
    idempotencyId: (actor, action, id) => 'fake-idem-' + id,
    maybeGet: async (scope, name, id) => (await scope.collection(name).doc(id).get()).data || null,
    mustGet: async (scope, name, id) => {
      const value = (await scope.collection(name).doc(id).get()).data;
      if (!value) throw Object.assign(new Error('missing fixture'), { code: 'PERSON_NOT_FOUND' });
      return value;
    },
    requireActiveUser: async () => {},
    requireMembership: async () => {
      context.assert(['admin', 'member'].includes(role), 'NO_PERMISSION', 'no permission');
      return { family: db.get('families', 'fake-family'), membership: { role, displayName: '' } };
    },
    testAccounts: { usesTestIdentity: () => true }, cloud: { getWXContext: () => ({}) },
    requireOwnedMedia: async () => {}, moderateText: async () => {},
    notificationTemplateIds: () => ({}), recordNotificationEvent: async () => {}
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/youpuUserApi/index.js'), 'utf8');
  vm.runInNewContext([
    sourcePart(source, 'function cleanGender(', '\nfunction cleanPersonIds('),
    sourcePart(source, 'function publicPerson(', '\nfunction profileMissingFields('),
    sourcePart(source, 'function normalizePersonDateFields(', '\nasync function requireOwnedMedia('),
    sourcePart(source, 'function publicFamilyCounters(', '\nasync function createPersonTx('),
    sourcePart(source, 'async function personUpdate(', '\nasync function personDelete('),
    sourcePart(source, 'async function changeReview(', '\nfunction invitationState(')
  ].join('\n'), context);
  db.put('users', 'fake-user', { status: 'active' });
  db.put('families', 'fake-family', { status: 'active', contentRevision: 0 });
  db.put('persons', 'fake-person', {
    familyId: 'fake-family', name: '虚构成员', gender: 'male', lifeStatus: 'deceased', status: 'active',
    birthDate: '', deathDate: '', birthDateInfo: null, deathDateInfo: null
  });
  return { db, context, update: context.personUpdate, review: context.changeReview, setRole: value => { role = value; } };
}

async function pageFor(t, role = 'admin', elderMode = false) {
  const service = server(role);
  const calls = { requests: [], toasts: [], cache: [], badge: 0 };
  const previous = { wx: global.wx, Page: global.Page, getApp: global.getApp };
  const app = {
    getPersonDetail: async () => ({ person: service.context.publicPerson(service.db.get('persons', 'fake-person')), currentRole: role }),
    applyPersonUpdate: (familyId, person) => calls.cache.push(person),
    refreshPendingBadge: async () => { calls.badge++; }
  };
  global.wx = { showToast: options => calls.toasts.push(options.title), navigateBack: () => {},
    enableAlertBeforeUnload: () => {}, disableAlertBeforeUnload: () => {} };
  global.getApp = () => app;
  let definition;
  global.Page = value => { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/edit-member/index');
  delete require.cache[modulePath];
  require(modulePath);
  const page = Object.assign({}, definition, { data: structuredClone(definition.data) });
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
  page.data.personId = 'fake-person';
  page.data.elderMode = elderMode;
  let nextId = 0;
  t.mock.method(api, 'call', async function (type, payload) {
    assert.equal(type, 'person.update');
    calls.requests.push(payload);
    return service.update(Object.assign({ requestId: 'save-' + ++nextId }, payload));
  });
  t.mock.method(api, 'getMediaUrls', async () => ({}));
  t.mock.method(api, 'getMediaStates', async () => ({}));
  t.after(() => { page.onUnload(); Object.assign(global, previous); });
  await page.loadPerson();
  return { page, service, calls };
}

function changeDates(page, values) {
  const patch = {};
  for (const [field, value] of Object.entries(values)) patch[field === 'birthDateInfo' ? 'birthDraft' : 'deathDraft'] = clientDate.fromPerson({ [field]: value }, field === 'birthDateInfo' ? 'birth' : 'death');
  page.setFormData(patch);
}

const birth = [info('lunar', 'day', 1991, 1, 1), info('solar', 'day', 1991, 1, 1)];
const death = [info('solar', 'day', 2012, 1, 1), info('lunar', 'year', 2012)];
const cases = birth.map((value, i) => ['出生-' + i, { birthDateInfo: value }])
  .concat(death.map((value, i) => ['离世-' + i, { deathDateInfo: value }]))
  .concat(birth.flatMap((b, i) => death.map((d, j) => ['组合-' + i + '-' + j, { birthDateInfo: b, deathDateInfo: d }])));

for (const [label, values] of cases) {
  test('编辑页管理员保存并回读用户日期案例：' + label, async function (t) {
    const { page, service, calls } = await pageFor(t);
    changeDates(page, values);
    await page.submit();
    assert.equal(calls.requests.length, 1);
    const stored = service.db.get('persons', 'fake-person');
    for (const [field, value] of Object.entries(values)) assert.deepEqual(stored[field], value);
    assert.equal(page.data.hasFormChanges, false);
    assert.equal(page.data.saveError, '');
    assert.equal(calls.cache.length, 1);
    await page.loadPerson();
    for (const [field, value] of Object.entries(values)) assert.deepEqual(clientDate.toInfo(page.data[field === 'birthDateInfo' ? 'birthDraft' : 'deathDraft']).info, value);
  });
}

test('清空日期及切换健在会清除日期原值和派生区间', async function (t) {
  const { page, service } = await pageFor(t);
  changeDates(page, { birthDateInfo: birth[0], deathDateInfo: death[0] });
  await page.submit();
  page.setFormData({ birthDraft: clientDate.emptyDraft() });
  page.chooseLifeStatus({ currentTarget: { dataset: { status: 'living' } } });
  await page.submit();
  const stored = service.db.get('persons', 'fake-person');
  for (const prefix of ['birth', 'death']) {
    assert.equal(stored[prefix + 'Date'], '');
    assert.equal(stored[prefix + 'DateInfo'], null);
    assert.equal(stored[prefix + 'DateRange'], null);
  }
  assert.equal(stored.lifeStatus, 'living');
  page.chooseLifeStatus({ currentTarget: { dataset: { status: 'deceased' } } });
  changeDates(page, { deathDateInfo: death[1] });
  await page.submit();
  assert.equal(service.db.get('persons', 'fake-person').deathDateInfo.precision, 'year');
});

for (const elderMode of [false, true]) {
  test('日期业务错误保留资料并支持修正重试，长辈模式=' + elderMode, async function (t) {
    const { page, service, calls } = await pageFor(t, 'admin', elderMode);
    changeDates(page, { birthDateInfo: birth[1], deathDateInfo: info('solar', 'day', 1980, 1, 1) });
    await page.submit();
    assert.match(page.data.saveError, /离世时间不能早于出生/);
    assert.equal(page.data.hasFormChanges, true);
    assert.equal(page.data.submitting, false);
    assert.equal(page.data.deathDraft.year, '1980');
    assert.equal(service.db.get('persons', 'fake-person').birthDateInfo, null);
    changeDates(page, { deathDateInfo: death[0] });
    assert.equal(page.data.saveError, '');
    await page.submit();
    assert.equal(page.data.hasFormChanges, false);
    assert.equal(calls.requests.length, 2);
  });
}

test('无效农历被服务端拒绝且不写入，合法闰月保留', async function (t) {
  const { page, service } = await pageFor(t);
  changeDates(page, { birthDateInfo: info('lunar', 'day', 2023, 2, 30, true) });
  await page.submit();
  assert.match(page.data.saveError, /日期和闰月/);
  assert.equal(page.data.birthDraft.day, '30');
  assert.equal(service.db.get('persons', 'fake-person').birthDateInfo, null);
  changeDates(page, { birthDateInfo: info('lunar', 'day', 2023, 2, 1, true) });
  await page.submit();
  assert.equal(service.db.get('persons', 'fake-person').birthDateInfo.isLeapMonth, true);
});

test('未知写入异常回滚，安全提示含问题编号且可重试', async function (t) {
  const { page, service, calls } = await pageFor(t);
  changeDates(page, { birthDateInfo: birth[0] });
  service.db.writeHook = async function (name) {
    if (name === 'audit_logs') throw Object.assign(new Error('database internal secret'), { code: 'SERVER_ERROR', requestId: 'safe-problem-id' });
  };
  await page.submit();
  assert.equal(page.data.saveProblemId, 'safe-problem-id');
  assert.equal(page.data.saveError, '暂时无法保存，请稍后重试');
  assert.doesNotMatch(calls.toasts.join(''), /database|internal|secret/);
  assert.equal(service.db.get('persons', 'fake-person').birthDateInfo, null);
  assert.equal(service.db.all('idempotency_records').length, 0);
  assert.equal(service.db.get('families', 'fake-family').contentRevision, 0);
  service.db.writeHook = null;
  await page.submit();
  assert.equal(page.data.saveProblemId, '');
  assert.equal(page.data.hasFormChanges, false);
});

test('普通成员日期修改进入审核，人物原值保持且刷新角标', async function (t) {
  const { page, service, calls } = await pageFor(t, 'member');
  changeDates(page, { birthDateInfo: birth[0], deathDateInfo: death[1] });
  await page.submit();
  assert.equal(service.db.get('persons', 'fake-person').birthDateInfo, null);
  const requests = service.db.all('change_requests');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].payload.changes.birthDateInfo, birth[0]);
  assert.deepEqual(requests[0].payload.changes.deathDateInfo, death[1]);
  assert.equal(calls.cache.length, 0);
  assert.equal(calls.badge, 1);
  assert.match(calls.toasts[0], /管理员审核/);
  service.setRole('admin');
  await service.review({ changeRequestId: requests[0]._id, decision: 'approve', requestId: 'approve-date' });
  const approved = service.db.get('persons', 'fake-person');
  assert.deepEqual(approved.birthDateInfo, birth[0]);
  assert.deepEqual(approved.deathDateInfo, death[1]);
  assert.equal(service.db.get('change_requests', requests[0]._id).status, 'approved');
});

test('旧记录缺少日期字段及已有空日期区间均可补全，重放请求不重复写入', async function () {
  const service = server();
  service.db.put('persons', 'fake-person', { familyId: 'fake-family', name: '虚构成员', gender: 'male', lifeStatus: 'deceased', status: 'active', birthDateRange: null, deathDateRange: null });
  const request = { personId: 'fake-person', data: { birthDateInfo: birth[0], deathDateInfo: death[1] }, requestId: 'missing-fields' };
  await service.update(request);
  await service.update(request);
  assert.deepEqual(service.db.get('persons', 'fake-person').birthDateInfo, birth[0]);
  assert.equal(service.db.all('audit_logs').length, 1);
  assert.equal(service.db.get('families', 'fake-family').contentRevision, 1);
});

test('旧公历字段请求仍可写入，修改非日期字段不清空结构化日期', async function () {
  const service = server();
  await service.update({ personId: 'fake-person', data: { birthDate: '1991-01-01', deathDate: '2012' }, requestId: 'legacy' });
  assert.equal(service.db.get('persons', 'fake-person').birthDate, '1991-01-01');
  await service.update({ personId: 'fake-person', data: { birthDateInfo: birth[0] }, requestId: 'structured' });
  await service.update({ personId: 'fake-person', data: { birthPlace: '虚构籍贯' }, requestId: 'other-fields' });
  assert.deepEqual(service.db.get('persons', 'fake-person').birthDateInfo, birth[0]);
});

test('普通模式与长辈模式共用可见保存错误，问题编号可选中', function () {
  const template = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/edit-member/index.wxml'), 'utf8');
  assert.match(template, /wx:if="\{\{saveError\}\}"/);
  assert.match(template, /saveProblemId[\s\S]*selectable="true"/);
  assert.doesNotMatch(template, /wx:if="\{\{elderMode && saveError\}\}"/);
});
