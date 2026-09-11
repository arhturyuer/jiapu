const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../miniprogram/utils/api');

function loadPage(app) {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return app; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/display-settings/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function (patch, callback) { Object.assign(page.data, patch); if (callback) callback(); };
  return page;
}

test('显示设置加载旧偏好时补齐默认开启值', async function () {
  const previousCall = api.call;
  const app = { getCurrentFamily: function () { return { _id: 'family-default' }; } };
  const page = loadPage(app);
  let request = null;
  api.call = function (type, payload) {
    request = { type: type, payload: payload };
    return Promise.resolve({ family: { _id: 'family-1', name: '测试家谱' }, preference: { nameLayout: 'vertical' } });
  };
  try {
    page.onLoad({ familyId: 'family-1' });
    await Promise.resolve();
    assert.deepEqual(request, { type: 'family.getPreference', payload: { familyId: 'family-1' } });
    assert.equal(page.data.loading, false);
    assert.equal(page.data.nameLayout, 'vertical');
    assert.equal(page.data.showChildRankBadge, true);
    assert.equal(page.data.showGenderBadge, true);
    assert.equal(page.data.showGenderColors, true);
  } finally {
    api.call = previousCall;
  }
});

test('开关即时保存、保存期间锁定并使当前家谱缓存失效', async function () {
  const previousCall = api.call;
  const invalidations = [];
  const app = {
    getCurrentFamily: function () { return { _id: 'family-1' }; },
    invalidateCache: function (value) { invalidations.push(value); }
  };
  const page = loadPage(app);
  page.data.familyId = 'family-1';
  let resolveSave;
  const calls = [];
  api.call = function (type, payload) {
    calls.push({ type: type, payload: payload });
    return new Promise(function (resolve) { resolveSave = resolve; });
  };
  try {
    const saving = page.savePreference('showGenderBadge', false);
    assert.equal(page.data.showGenderBadge, false);
    assert.equal(page.data.saving, true);
    page.togglePreference({ currentTarget: { dataset: { field: 'showGenderColors' } }, detail: { value: false } });
    assert.equal(calls.length, 1);
    resolveSave({ preference: { nameLayout: 'horizontal', showChildRankBadge: true, showGenderBadge: false, showGenderColors: true } });
    await saving;
    assert.equal(page.data.saving, false);
    assert.deepEqual(calls[0], { type: 'family.setPreference', payload: { familyId: 'family-1', showGenderBadge: false } });
    assert.deepEqual(invalidations, [{ graph: 'family-1' }]);
  } finally {
    api.call = previousCall;
  }
});

test('显示设置保存失败时恢复原值并提示', async function () {
  const previousCall = api.call;
  const previousWx = global.wx;
  const toasts = [];
  const app = { getCurrentFamily: function () { return { _id: 'family-1' }; }, invalidateCache: function () {} };
  const page = loadPage(app);
  page.data.familyId = 'family-1';
  global.wx = { showToast: function (value) { toasts.push(value); } };
  api.call = function () { return Promise.reject(new Error('网络不可用')); };
  try {
    await page.savePreference('nameLayout', 'vertical');
    assert.equal(page.data.nameLayout, 'horizontal');
    assert.equal(page.data.saving, false);
    assert.equal(toasts[0].title, '网络不可用');
  } finally {
    api.call = previousCall;
    global.wx = previousWx;
  }
});

test('服务端显示偏好兼容旧文档并按字段合并', function () {
  const source = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.match(source, /showChildRankBadge: preference\.showChildRankBadge !== false/);
  assert.match(source, /showGenderBadge: preference\.showGenderBadge !== false/);
  assert.match(source, /showGenderColors: preference\.showGenderColors !== false/);
  assert.match(source, /const existing = await maybeGet\(transaction, 'user_family_preferences', id\)/);
  assert.match(source, /const preference = normalizeFamilyPreference\(existing\)/);
  assert.match(source, /assert\(typeof event\[field\] === 'boolean', 'INVALID_PREFERENCE'/);
  assert.match(source, /await requireMembership\(event\.familyId, ACTIVE_ROLES, db, openid\)/);
});
