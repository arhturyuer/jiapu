require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../miniprogram/utils/api');
const exampleDisplayPreference = require('../miniprogram/utils/example-display-preference');

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

test('显示设置加载新用户默认偏好', async function () {
  const previousCall = api.call;
  const app = { getCurrentFamily: function () { return { _id: 'family-default' }; } };
  const page = loadPage(app);
  let request = null;
  api.call = function (type, payload) {
    request = { type: type, payload: payload };
    return Promise.resolve({ family: { _id: 'family-1', name: '测试家谱' }, preference: { nameLayout: 'horizontal', showChildRankBadge: false, showGenderBadge: false, showGenderColors: true } });
  };
  try {
    page.onLoad({ familyId: 'family-1' });
    await Promise.resolve();
    assert.deepEqual(request, { type: 'family.getPreference', payload: { familyId: 'family-1' } });
    assert.equal(page.data.loading, false);
    assert.equal(page.data.nameLayout, 'horizontal');
    assert.equal(page.data.showChildRankBadge, false);
    assert.equal(page.data.showGenderBadge, false);
    assert.equal(page.data.showGenderColors, true);
    assert.equal(page.data.autoCollapseEnabled, true);
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
    assert.equal(toasts[0].title, '设置保存失败，请重试');
  } finally {
    api.call = previousCall;
    global.wx = previousWx;
  }
});

test('示例显示设置仅使用按示例隔离的本地偏好', async function () {
  const previousCall = api.call;
  const previousWx = global.wx;
  const storage = {
    youpu_example_name_layout_demo: 'vertical'
  };
  const app = { getCurrentFamily: function () { return { _id: 'family-1' }; } };
  const page = loadPage(app);
  global.wx = {
    getStorageSync: function (key) { return storage[key]; },
    setStorageSync: function (key, value) { storage[key] = value; }
  };
  api.call = function () { throw new Error('示例设置不应请求云端'); };
  try {
    await page.onLoad({ exampleSlug: 'demo' });
    assert.equal(page.data.isExample, true);
    assert.equal(page.data.family.name, '示例家谱');
    assert.equal(page.data.nameLayout, 'vertical');
    await page.savePreference('showGenderBadge', false);
    assert.deepEqual(storage[exampleDisplayPreference.EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX + 'demo'], {
      nameLayout: 'vertical',
      showChildRankBadge: false,
      showGenderBadge: false,
      showGenderColors: true,
      autoCollapseEnabled: true
    });
    assert.equal(exampleDisplayPreference.get('other').nameLayout, 'horizontal');
    assert.equal(exampleDisplayPreference.get('other').showChildRankBadge, false);
    assert.equal(exampleDisplayPreference.get('other').showGenderBadge, false);
  } finally {
    api.call = previousCall;
    global.wx = previousWx;
  }
});

test('示例设置保存后立即刷新上一张示例家谱画布', async function () {
  const previousWx = global.wx;
  const previousGetCurrentPages = global.getCurrentPages;
  const storage = {};
  const refreshed = [];
  const app = { getCurrentFamily: function () { return null; } };
  const page = loadPage(app);
  global.wx = {
    getStorageSync: function (key) { return storage[key]; },
    setStorageSync: function (key, value) { storage[key] = value; }
  };
  global.getCurrentPages = function () { return [{ applyDisplayPreference: function (preference) { refreshed.push(preference); } }, {}]; };
  try {
    await page.onLoad({ exampleSlug: 'demo' });
    await page.savePreference('nameLayout', 'vertical');
    assert.deepEqual(refreshed, [{
      nameLayout: 'vertical',
      showChildRankBadge: false,
      showGenderBadge: false,
      showGenderColors: true,
      autoCollapseEnabled: true
    }]);
  } finally {
    global.wx = previousWx;
    global.getCurrentPages = previousGetCurrentPages;
  }
});

test('服务端为新用户返回新默认值，为已有偏好保留旧默认语义', function () {
  const source = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/youpuUserApi/index.js'), 'utf8');
  assert.match(source, /const hasSavedPreference = Boolean\(value\)/);
  assert.match(source, /showChildRankBadge: hasSavedPreference \? preference\.showChildRankBadge !== false : false/);
  assert.match(source, /showGenderBadge: hasSavedPreference \? preference\.showGenderBadge !== false : false/);
  assert.match(source, /showGenderColors: preference\.showGenderColors !== false/);
  assert.match(source, /autoCollapseEnabled: preference\.autoCollapseEnabled !== false/);
  assert.match(source, /const existing = await maybeGet\(transaction, 'user_family_preferences', id\)/);
  assert.match(source, /const preference = normalizeFamilyPreference\(existing\)/);
  assert.match(source, /assert\(typeof event\[field\] === 'boolean', 'INVALID_PREFERENCE'/);
  assert.match(source, /await requireMembership\(event\.familyId, ACTIVE_ROLES, db, openid\)/);
});

test('示例家谱显示偏好归一化兼容旧字段默认值', function () {
  assert.deepEqual(exampleDisplayPreference.normalize(null), {
    nameLayout: 'horizontal',
    showChildRankBadge: false,
    showGenderBadge: false,
    showGenderColors: true,
    autoCollapseEnabled: true
  });
  assert.deepEqual(exampleDisplayPreference.normalize({ nameLayout: 'vertical' }), {
    nameLayout: 'vertical',
    showChildRankBadge: true,
    showGenderBadge: true,
    showGenderColors: true,
    autoCollapseEnabled: true
  });
  assert.equal(exampleDisplayPreference.normalize({ autoCollapseEnabled: false }).autoCollapseEnabled, false);
});

test('无发布版本的旧示例沿用本地偏好优先规则，首次修改保留其他默认项', function () {
  const previousWx = global.wx;
  const storage = {};
  const defaults = { nameLayout: 'vertical', showChildRankBadge: true, showGenderBadge: true, showGenderColors: false, autoCollapseEnabled: false };
  global.wx = {
    getStorageSync: function (key) { return storage[key]; },
    setStorageSync: function (key, value) { storage[key] = value; }
  };
  try {
    assert.deepEqual(exampleDisplayPreference.get('demo', defaults), defaults);
    const saved = exampleDisplayPreference.saveField('demo', 'showGenderBadge', false, defaults);
    assert.deepEqual(saved, { ...defaults, showGenderBadge: false });
    assert.deepEqual(exampleDisplayPreference.get('demo', { ...defaults, nameLayout: 'horizontal' }), saved);
    assert.deepEqual(exampleDisplayPreference.get('other', defaults), defaults);
    storage.youpu_example_name_layout_legacy = 'vertical';
    assert.equal(exampleDisplayPreference.get('legacy', { ...defaults, nameLayout: 'horizontal' }).nameLayout, 'vertical');
    storage.youpu_example_name_layout_legacy = 'horizontal';
    assert.equal(exampleDisplayPreference.get('legacy', defaults).nameLayout, 'horizontal');
  } finally {
    global.wx = previousWx;
  }
});

test('示例发布新版本后旧设备采用新默认值，随后个人修改仅在当前版本生效', function () {
  const previousWx = global.wx;
  const storage = {
    youpu_example_display_preference_demo: {
      nameLayout: 'horizontal', showChildRankBadge: false, showGenderBadge: false,
      showGenderColors: true, autoCollapseEnabled: true
    },
    youpu_example_name_layout_demo: 'vertical'
  };
  const oldDefaults = { nameLayout: 'horizontal', autoCollapseEnabled: true };
  const newDefaults = { nameLayout: 'horizontal', autoCollapseEnabled: false };
  global.wx = {
    getStorageSync: function (key) { return storage[key]; },
    setStorageSync: function (key, value) { storage[key] = value; }
  };
  try {
    assert.equal(exampleDisplayPreference.get('demo', newDefaults, 1).autoCollapseEnabled, false);
    assert.equal(exampleDisplayPreference.get('demo', newDefaults, 1).nameLayout, 'horizontal');
    const changed = exampleDisplayPreference.saveField('demo', 'autoCollapseEnabled', true, newDefaults, 1);
    assert.equal(changed.autoCollapseEnabled, true);
    assert.equal(exampleDisplayPreference.get('demo', newDefaults, 1).autoCollapseEnabled, true);
    assert.equal(exampleDisplayPreference.get('demo', newDefaults, 2).autoCollapseEnabled, false);
    assert.equal(exampleDisplayPreference.get('demo', oldDefaults, 2).autoCollapseEnabled, true);
  } finally {
    global.wx = previousWx;
  }
});

test('示例设置页按已发布版本忽略旧本地智能收起值', async function () {
  const previousWx = global.wx;
  const previousGetCurrentPages = global.getCurrentPages;
  const storage = { youpu_example_display_preference_demo: { autoCollapseEnabled: true } };
  global.wx = { getStorageSync: function (key) { return storage[key]; }, setStorageSync: function (key, value) { storage[key] = value; } };
  global.getCurrentPages = function () {
    return [{ data: { example: { slug: 'demo', title: '虚构示例', publishedVersion: 3, defaultDisplayPreference: { autoCollapseEnabled: false } } } }, {}];
  };
  try {
    const page = loadPage({ getCurrentFamily: function () { return null; } });
    await page.onLoad({ exampleSlug: 'demo' });
    assert.equal(page.data.autoCollapseEnabled, false);
    await page.savePreference('autoCollapseEnabled', true);
    assert.equal(exampleDisplayPreference.get('demo', { autoCollapseEnabled: false }, 3).autoCollapseEnabled, true);
  } finally {
    global.wx = previousWx;
    global.getCurrentPages = previousGetCurrentPages;
  }
});

test('示例设置页显示当前示例的发布默认值', async function () {
  const previousWx = global.wx;
  const previousGetCurrentPages = global.getCurrentPages;
  const defaults = { nameLayout: 'vertical', showChildRankBadge: true, showGenderBadge: false, showGenderColors: false, autoCollapseEnabled: false };
  global.wx = { getStorageSync: function () { return undefined; } };
  global.getCurrentPages = function () { return [{ data: { example: { slug: 'demo', title: '虚构示例', defaultDisplayPreference: defaults } } }, {}]; };
  try {
    const page = loadPage({ getCurrentFamily: function () { return null; } });
    await page.onLoad({ exampleSlug: 'demo' });
    assert.equal(page.data.family.name, '虚构示例');
    assert.equal(page.data.nameLayout, 'vertical');
    assert.equal(page.data.showChildRankBadge, true);
    assert.equal(page.data.showGenderColors, false);
    assert.equal(page.data.autoCollapseEnabled, false);
  } finally {
    global.wx = previousWx;
    global.getCurrentPages = previousGetCurrentPages;
  }
});

test('智能收起开关保存 false 并按家谱使缓存失效', async function () {
  const previousCall = api.call;
  const invalidations = [];
  const app = {
    getCurrentFamily: function () { return { _id: 'family-1' }; },
    invalidateCache: function (value) { invalidations.push(value); }
  };
  const page = loadPage(app);
  page.data.familyId = 'family-1';
  api.call = function (type, payload) {
    assert.equal(type, 'family.setPreference');
    assert.deepEqual(payload, { familyId: 'family-1', autoCollapseEnabled: false });
    return Promise.resolve({ preference: { autoCollapseEnabled: false } });
  };
  try {
    await page.savePreference('autoCollapseEnabled', false);
    assert.equal(page.data.autoCollapseEnabled, false);
    assert.deepEqual(invalidations, [{ graph: 'family-1' }]);
  } finally {
    api.call = previousCall;
  }
});
