const test = require('node:test');
const assert = require('node:assert/strict');

function loadPage(relativePath, app) {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return app || {}; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve(relativePath);
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  return definition;
}

function createPage(definition, overrides) {
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data, overrides || {});
  page.setData = function (patch, callback) {
    Object.assign(page.data, patch);
    if (callback) callback();
  };
  return page;
}

function installWx() {
  const previousWx = global.wx;
  const previousSetTimeout = global.setTimeout;
  const calls = { enable: 0, disable: 0, toast: [], navigateBack: 0 };
  global.wx = {
    enableAlertBeforeUnload: function () { calls.enable += 1; },
    disableAlertBeforeUnload: function () { calls.disable += 1; },
    showToast: function (options) { calls.toast.push(options.title); },
    navigateBack: function () { calls.navigateBack += 1; }
  };
  global.setTimeout = function (callback) {
    callback();
    return 0;
  };
  return {
    calls: calls,
    restore: function () {
      global.wx = previousWx;
      global.setTimeout = previousSetTimeout;
    }
  };
}

test('成员头像独立保存，后续资料申请不重复携带头像', async function () {
  const wxState = installWx();
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const calls = [];
  api.call = function (type, payload) {
    calls.push({ type: type, payload: payload });
    return Promise.resolve({ pending: true });
  };
  const page = createPage(loadPage('../miniprogram/pages/edit-member/index'), {
    personId: 'person-1',
    familyId: 'family-1',
    name: '赵东明',
    gender: 'male',
    birthDate: '',
    birthPlace: '',
    bio: '',
    lifeStatus: 'unknown'
  });
  page._initialForm = {
    name: '赵东明', gender: 'male', birthDate: '', birthPlace: '', bio: '', lifeStatus: 'unknown'
  };

  await page.saveUploadedAvatar({
    assetId: 'asset-new', previewUrl: 'local-preview', moderationStatus: 'approved', ready: true
  });
  assert.deepEqual(calls[0], {
    type: 'person.update',
    payload: { personId: 'person-1', data: { avatarAssetId: 'asset-new' } }
  });
  assert.equal(page.data.avatarState, 'family-review');

  page.setFormData({ birthPlace: '浙江' });
  await page.submit();
  assert.deepEqual(calls[1], {
    type: 'person.update',
    payload: { personId: 'person-1', data: { birthPlace: '浙江' } }
  });

  api.call = previousCall;
  wxState.restore();
});

test('个人头像保存不会覆盖未保存名字', async function () {
  const wxState = installWx();
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const calls = [];
  const app = {
    setUser: function (user) { this.user = user; }
  };
  api.call = function (type, payload) {
    calls.push({ type: type, payload: payload });
    if (type === 'auth.updateAvatar') {
      return Promise.resolve({ user: { nickName: '旧名字', avatarAssetId: 'avatar-new' }, moderationStatus: 'approved' });
    }
    return Promise.resolve({ user: { nickName: payload.nickName, avatarAssetId: 'avatar-new' } });
  };
  const page = createPage(loadPage('../miniprogram/pages/profile/index', app), {
    nickName: '尚未保存的新名字',
    avatarUrl: '',
    avatarAssetId: '',
    hasNameChanges: true
  });
  page._initialNickName = '旧名字';

  await page.saveProfileAvatar({
    assetId: 'avatar-new', previewUrl: 'local-preview', moderationStatus: 'approved', ready: true
  });
  assert.deepEqual(calls[0], {
    type: 'auth.updateAvatar',
    payload: { avatarAssetId: 'avatar-new' }
  });
  assert.equal(page.data.nickName, '尚未保存的新名字');
  assert.equal(page.data.hasNameChanges, true);

  await page.saveProfile();
  assert.deepEqual(calls[1], {
    type: 'auth.updateProfile',
    payload: { nickName: '尚未保存的新名字' }
  });

  api.call = previousCall;
  wxState.restore();
});

test('新增成员选图不上传，最终提交时上传并绑定', async function () {
  const wxState = installWx();
  const api = require('../miniprogram/utils/api');
  const privacy = require('../miniprogram/utils/privacy');
  const previousCall = api.call;
  const previousUpload = api.uploadImage;
  const previousPrivacy = privacy.ensurePrivacyAuthorized;
  let uploads = 0;
  let createPayload = null;
  privacy.ensurePrivacyAuthorized = function () { return Promise.resolve(); };
  global.wx.chooseMedia = function () {
    return Promise.resolve({ tempFiles: [{ tempFilePath: '/tmp/avatar.jpg', size: 1234 }] });
  };
  api.uploadImage = function () {
    uploads += 1;
    return Promise.resolve({ assetId: 'asset-new', previewUrl: '/tmp/avatar.jpg', moderationStatus: 'pending', ready: false });
  };
  api.call = function (type, payload) {
    assert.equal(type, 'person.createRelated');
    createPayload = payload;
    return Promise.resolve({ pending: false });
  };
  const page = createPage(loadPage('../miniprogram/pages/add-member/index'), {
    familyId: 'family-1',
    anchorId: 'person-root',
    relationType: 'son',
    name: '赵小明',
    gender: 'male'
  });

  await page.chooseAvatar();
  assert.equal(uploads, 0);
  assert.equal(page.data.avatarStateText, '已选择，添加成员时一并上传');
  await page.submit();
  assert.equal(uploads, 1);
  assert.equal(createPayload.person.avatarAssetId, 'asset-new');
  assert.equal(page.data.hasUnsavedChanges, false);

  api.call = previousCall;
  api.uploadImage = previousUpload;
  privacy.ensurePrivacyAuthorized = previousPrivacy;
  wxState.restore();
});

test('人物创建失败后重试复用已上传头像', async function () {
  const wxState = installWx();
  const api = require('../miniprogram/utils/api');
  const previousCall = api.call;
  const previousUpload = api.uploadImage;
  let uploads = 0;
  let creates = 0;
  api.uploadImage = function () {
    uploads += 1;
    return Promise.resolve({ assetId: 'asset-retry', previewUrl: 'local', moderationStatus: 'approved', ready: true });
  };
  api.call = function () {
    creates += 1;
    if (creates === 1) return Promise.reject(new Error('人物创建失败'));
    return Promise.resolve({ pending: false });
  };
  const page = createPage(loadPage('../miniprogram/pages/add-member/index'), {
    familyId: 'family-1',
    anchorId: 'person-root',
    relationType: 'daughter',
    name: '赵小妹',
    gender: 'female',
    selectedAvatarPath: '/tmp/avatar.jpg',
    avatar: '/tmp/avatar.jpg',
    avatarState: 'selected',
    hasUnsavedChanges: true
  });

  await page.submit();
  await page.submit();
  assert.equal(uploads, 1);
  assert.equal(creates, 2);

  api.call = previousCall;
  api.uploadImage = previousUpload;
  wxState.restore();
});

test('表单状态只在脏数据存在时启用离开提醒', function () {
  const wxState = installWx();
  const formState = require('../miniprogram/utils/form-state');
  const page = {};
  formState.syncLeaveAlert(page, true, '尚未保存');
  formState.syncLeaveAlert(page, true, '尚未保存');
  assert.equal(wxState.calls.enable, 1);
  formState.syncLeaveAlert(page, false);
  assert.equal(wxState.calls.disable, 1);
  assert.equal(page._hasUnsavedChanges, false);
  wxState.restore();
});
