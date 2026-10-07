require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness() {
  let definition; let nextId = 0; const storage = new Map(); const calls = []; const navigation = []; const timers = new Map(); let nextTimer = 0;
  const family = { _id: 'source', name: '字'.repeat(40), personCount: 3, relationCount: 2 };
  const app = { globalData: { user: { _id: 'actor' } }, ensureLogin: async () => {}, invalidateCache: () => {}, setCurrentFamily: value => { app.globalData.currentFamily = value; }, loadFamilyPages: async () => ({ families: [{ _id: 'copy', status: 'active', currentRole: 'admin' }] }) };
  const api = { requestId: () => 'request-' + ++nextId, userMessage: (error, fallback) => fallback, call: async function (type, payload) { calls.push({ type, payload }); if (type === 'family.dashboard') return { family }; if (type === 'family.copy.status') return { task: null }; return { taskId: 'task', requestId: payload.idempotencyKey, status: 'pending' }; } };
  const wx = {
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key), showToast: () => {},
    switchTab: value => navigation.push(value), navigateTo: value => navigation.push(value)
  };
  const context = { getApp: () => app, Page: value => { definition = value; }, require: name => name.includes('launch-ad') ? { wrap: value => value } : api, wx, setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/family-copy/index.js', 'utf8'), context);
  const page = Object.assign({}, definition); page.data = JSON.parse(JSON.stringify(definition.data)); page.setData = data => Object.assign(page.data, data);
  page.onLoad({ familyId: 'source' }); page._visible = true; page._version = 1;
  return { page, api, storage, calls, timers, navigation, app };
}

test('默认名称预留副本后缀，复制次数和缺失头像规则展示，入口三角色可见', async () => {
  const h = harness(); await h.page.loadPage();
  assert.equal(h.page.data.name.length, 40); assert.ok(h.page.data.name.endsWith('（副本）'));
  const emoji = harness();
  emoji.api.call = async type => type === 'family.dashboard' ? { family: { _id: 'source', name: '字'.repeat(35) + '😀abc' } } : { task: null };
  await emoji.page.loadPage();
  assert.equal(emoji.page.data.name, '字'.repeat(35) + '（副本）');
  const wxml = fs.readFileSync('miniprogram/pages/family-copy/index.wxml', 'utf8');
  assert.ok(wxml.includes('每天（北京时间）最多发起 3 次')); assert.ok(wxml.includes('再复制一份'));
  assert.ok(fs.readFileSync('miniprogram/pages/family-manage/index.wxml', 'utf8').includes('bindtap="copyFamily"'));
});

test('网络超时和不明服务错误保持同一幂等键，双击不重复提交，成功清理请求', async () => {
  for (const error of [Object.assign(new Error('timeout'), { code: 'CLOUD_FUNCTION_TIMEOUT' }), Object.assign(new Error('ambiguous commit'), { code: 'SERVER_ERROR', isBusinessError: true })]) {
    const h = harness(); await h.page.loadPage(); let reject;
    const original = h.api.call;
    h.api.call = (type, payload) => { if (type === 'family.copy.create') { h.calls.push({ type, payload }); return new Promise((resolve, fail) => { reject = fail; }); } return original(type, payload); };
    const first = h.page.createCopy(); await h.page.createCopy();
    assert.equal(h.calls.filter(c => c.type === 'family.copy.create').length, 1);
    reject(error); await first;
    assert.equal(h.page.data.uncertain, true); assert.equal(h.storage.size, 1);
    const key = h.calls.find(c => c.type === 'family.copy.create').payload.idempotencyKey;
    h.api.call = original;
    await h.page.createCopy();
    assert.equal(h.calls.filter(c => c.type === 'family.copy.create').at(-1).payload.idempotencyKey, key);
    assert.equal(h.storage.size, 0); assert.equal(h.page.data.running, true);
  }
});

test('离页停止轮询和迟到 UI 更新，回来通过服务端恢复已接受任务', async () => {
  const h = harness(); await h.page.loadPage(); let resolve;
  const original = h.api.call;
  h.api.call = (type, payload) => type === 'family.copy.create' ? new Promise(done => { resolve = done; }) : original(type, payload);
  const pending = h.page.createCopy(); h.page.onHide(); resolve({ taskId: 'accepted', status: 'pending' }); await pending;
  assert.equal(h.page.data.task, null); assert.equal(h.timers.size, 0);
  h.page._visible = true; h.page._version += 1;
  h.api.call = async (type, payload) => type === 'family.copy.status' ? { task: { taskId: 'accepted', status: 'processing' } } : original(type, payload);
  await h.page.loadPage(); assert.equal(h.page.data.task.taskId, 'accepted'); assert.equal(h.timers.size, 1);
  h.page.onUnload(); assert.equal(h.timers.size, 0);
});

test('未收到提交响应时重进匹配 requestId，解除不确定状态；状态读取失败禁止新建', async () => {
  const h = harness(); h.storage.set(h.page.storageKey(), { idempotencyKey: 'old-key', name: '未确认名称' });
  const original = h.api.call;
  h.api.call = async (type, payload) => type === 'family.copy.status' ? { task: { taskId: 'existing', requestId: 'old-key', status: 'completed', family: { _id: 'copy' } } } : original(type, payload);
  await h.page.loadPage(); assert.equal(h.page.data.uncertain, false); assert.equal(h.storage.size, 0);
  h.api.call = async (type, payload) => type === 'family.copy.status' ? Promise.reject(new Error('offline')) : original(type, payload);
  await h.page.loadPage(); const previous = h.calls.length; await h.page.createCopy(); assert.equal(h.calls.length, previous);
});

test('完成后主动切到新家谱的全谱视角，头像补充使用现有编辑页参数', async () => {
  const h = harness(); await h.page.loadPage();
  h.page.applyTask({ taskId: 'task', status: 'completed', family: { _id: 'copy' }, missingAvatars: [{ personId: 'person-copy', name: '家人', reason: 'unavailable' }] });
  assert.equal(h.navigation.length, 0);
  await h.page.openCopy({ currentTarget: { dataset: {} } });
  assert.equal(h.app.globalData.currentFamily._id, 'copy'); assert.equal(h.storage.get('youpu_pending_view').mode, 'full');
  assert.equal(h.navigation[0].url, '/pages/tree/index');
  await h.page.openCopy({ currentTarget: { dataset: { personId: 'person-copy' } } });
  assert.equal(h.navigation[1].url, '/pages/edit-member/index?id=person-copy');
  h.page.setData({ opening: true }); h.page.onHide(); h.page.onShow();
  assert.equal(h.page.data.opening, false, '从编辑页返回应恢复打开和补充按钮');
});

test('账户切换隔离提交结果和本地幂等请求，旧响应不能清除新账户的请求', async () => {
  const h = harness(); await h.page.loadPage(); let resolve;
  h.api.call = () => new Promise(done => { resolve = done; });
  const key = h.page.storageKey(); const pending = h.page.createCopy();
  h.app.globalData.user = { _id: 'new-actor' };
  const newKey = h.page.storageKey(); h.storage.set(newKey, { idempotencyKey: 'new-request', name: '新账户家谱' });
  resolve({ taskId: 'old-task', status: 'pending' }); await pending;
  assert.equal(h.page.data.task, null); assert.equal(h.storage.has(key), false); assert.equal(h.storage.get(newKey).idempotencyKey, 'new-request');
});
