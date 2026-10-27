require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const profile = require('../miniprogram/utils/family-profile');
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(name = 'family-profile', overrides = {}) {
  let definition;
  const calls = [], navigation = [];
  const data = { family: { _id: 'family', name: '测试家谱', description: '', status: 'active', currentRole: 'admin' }, profile: { surname: '', ancestralHome: '', hallName: '', generationPoem: '', history: '', familyMotto: '', featuredSection: 'none' } };
  const app = { globalData: { user: { _id: 'actor' }, environment: 'staging', env: 'fixture', currentFamily: { _id: 'family' } }, getFamilyProfile: async () => structuredClone(data), applyFamilyUpdate: (...args) => calls.push(['apply', ...args]), ...overrides };
  const wx = { showModal: overrides.showModal || (async () => ({ confirm: true })), navigateBack: () => navigation.push('back'), navigateTo: args => navigation.push(args.url), showToast() {}, enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {}, stopPullDownRefresh() {}, redirectTo: args => navigation.push(args.url), pageScrollTo: args => { if (args.selector) navigation.push(args.selector); } };
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/' + name + '/index.js', 'utf8'), { Page: value => { definition = value; }, getApp: () => app, wx,
    require: key => key.includes('launch-ad') ? { wrap: value => value } : key.endsWith('/api') ? { call: async (type, input) => { calls.push([type, input]); if (overrides.call) return overrides.call(type, input); return { family: { ...data.family, ...input }, profile: { ...data.profile, ...input } }; }, userMessage: error => error.message } : key.endsWith('form-state') ? { syncLeaveAlert() {}, clearLeaveAlert() {} } : profile });
  const page = Object.assign({}, definition, { data: structuredClone(definition.data), setData(change) { Object.assign(this.data, change); } });
  page.onLoad({ familyId: 'family' });
  return { page, app, data, calls, navigation };
}
const input = (page, key, value) => page.inputField({ currentTarget: { dataset: { field: key } }, detail: { value } });
async function editing(overrides = {}) {
  const h = fixture('family-profile', overrides); await h.page.onShow(); await h.page.edit(); return h;
}
test('整页原位编辑所有字段，校验定位字段，保存服务端回显且不跳转', async () => {
  const h = await editing();
  assert.equal(h.page.data.editing, true);
  assert.deepEqual(Array.from(h.page.data.fields, f => f.key), ['name', 'description', 'surname', 'ancestralHome', 'hallName', 'generationPoem', 'familyMotto', 'history']);
  await h.page.save(); assert.equal(h.calls.length, 0);
  for (const field of profile.FIELDS) input(h.page, field.key, field.label + '\n资料');
  h.page.changeFeatured({ detail: { value: 3 } }); input(h.page, 'familyMotto', ''); await h.page.save();
  assert.equal(h.page.data.fieldError, 'familyMotto'); assert.equal(h.navigation.at(-1), '#field-familyMotto');
  input(h.page, 'familyMotto', '以诚待人\n和睦传家'); await h.page.save();
  assert.equal(h.calls[0][0], 'family.update'); assert.equal(h.calls[0][1].familyMotto, '以诚待人\n和睦传家');
  assert.equal(h.calls.filter(row => row[0] === 'apply').length, 1);
  assert.equal(h.page.data.editing, false); assert.equal(h.page.data.profile.familyMotto, '以诚待人\n和睦传家');
  assert.equal(h.page.data.family.name, '家谱名称\n资料'); assert.equal(h.navigation.includes('back'), false);
});
test('失败保留草稿，重试复用幂等键，保存期间不能取消或重复提交', async () => {
  let fail = true; const pending = deferred();
  const h = await editing({ call: async () => { if (fail) throw new Error('网络失败'); return pending.promise; } });
  input(h.page, 'history', '新历史'); await h.page.save();
  assert.equal(h.page.data.form.history, '新历史'); assert.equal(h.page.data.saveError, '网络失败');
  fail = false; const saving = h.page.save(); await h.page.save(); await h.page.cancel();
  assert.equal(h.page.data.editing, true); assert.equal(h.calls.filter(row => row[0] === 'family.update').length, 2);
  assert.equal(h.calls[0][1].idempotencyKey, h.calls[1][1].idempotencyKey);
  pending.resolve({ family: h.data.family, profile: { ...h.data.profile, history: '新历史' } }); await saving;
  assert.equal(h.page.data.profile.history, '新历史');
});
test('取消留在本页；确认前保留草稿，放弃后重进恢复原值', async () => {
  let confirm = false; const h = await editing({ showModal: async () => ({ confirm }) }); await h.page.cancel(); assert.equal(h.page.data.editing, false);
  await h.page.edit(); input(h.page, 'surname', '草稿'); await h.page.cancel();
  assert.equal(h.page.data.editing, true); assert.equal(h.page.data.form.surname, '草稿');
  confirm = true; await h.page.cancel();
  assert.equal(h.page.data.editing, false); await h.page.edit(); assert.equal(h.page.data.form.surname, '');
  assert.equal(h.navigation.length, 0); assert.equal(h.calls.length, 0);
});
test('编辑刷新不覆盖草稿，隐藏返回重查权限，失权禁止保存', async () => {
  const h = await editing(); input(h.page, 'history', '草稿'); h.data.profile.history = '远端内容';
  await h.page.onPullDownRefresh(); assert.equal(h.page.data.form.history, '草稿');
  h.page.onHide(); h.data.family.currentRole = 'viewer'; await h.page.onShow();
  assert.equal(h.page.data.form.history, '草稿'); assert.equal(h.page.data.canEdit, false);
  await h.page.save(); assert.equal(h.calls.length, 0);
});
test('账户或家谱变化禁止保存，迟到读取不落页面', async () => {
  const h = await editing(); input(h.page, 'history', '草稿');
  h.app.globalData.currentFamily = { _id: 'other' }; await h.page.save();
  assert.equal(h.calls.length, 0); assert.equal(h.page.data.canEdit, false);
  const late = deferred(); const read = fixture('family-profile', { getFamilyProfile: () => late.promise });
  const loading = read.page.onShow(); read.page.onHide(); late.resolve(read.data); await loading;
  assert.equal(read.page.data.family, null);
});
test('隐藏期间保存成功，返回同页阅读；切换账户后不回显旧结果', async () => {
  for (const changed of [false, true]) {
    const pending = deferred(); const h = await editing({ call: () => pending.promise });
    input(h.page, 'history', '新历史'); const saving = h.page.save(); h.page.onHide();
    pending.resolve({ family: h.data.family, profile: { ...h.data.profile, history: '新历史' } }); await saving;
    if (changed) h.app._sessionVersion = 1;
    await h.page.onShow();
    assert.equal(h.page.data.editing, changed); assert.equal(h.page.data.profile.history, changed ? '' : '新历史');
    if (changed) assert.equal(h.page.data.canEdit, false);
  }
});
test('阅读保留完整实际资料，未填写占位不进入编辑数据', async () => {
  const h = fixture(); await h.page.onShow();
  assert.deepEqual(Array.from(h.page.data.facts, item => [item.key, item.value]), [['surname', ''], ['ancestralHome', ''], ['hallName', '']]);
  Object.assign(h.data.profile, { history: '长'.repeat(3000), ancestralHome: '虚构地', generationPoem: '字辈', familyMotto: '家训\n第二行' });
  h.data.family.currentRole = 'viewer'; await h.page.retry();
  assert.equal(h.page.data.profile.history.length, 3000);
  await h.page.edit(); assert.equal(h.page.data.editing, false);
  assert.equal(h.page.jumpToSection, undefined);
  h.data.family.currentRole = 'admin'; await h.page.retry(); await h.page.edit();
  assert.equal(h.page.data.form.hallName, ''); assert.equal(h.page.data.form.history, '长'.repeat(3000));
});
test('旧编辑路由重定向统一页，编辑参数不能绕过角色限制', async () => {
  const legacy = fixture('family-profile-edit');
  assert.deepEqual(legacy.navigation, ['/pages/family-profile/index?familyId=family&edit=1']);
  for (const role of ['admin', 'member', 'viewer']) {
    const h = fixture(); h.page.onLoad({ familyId: 'family', edit: '1' }); h.data.family.currentRole = role;
    await h.page.onShow(); assert.equal(h.page.data.editing, role === 'admin');
  }
});

test('阅读模板保留简介与全部章节，原生按钮不使用默认居中宽度', () => {
  const template = fs.readFileSync('miniprogram/pages/family-profile/index.wxml', 'utf8');
  const reading = template.slice(0, template.indexOf('profile-edit-paper'));
  assert.match(reading, /profile-introduction[\s\S]*简介[\s\S]*family.description/);
  assert.doesNotMatch(reading, /profile-empty|wx:if="{{(?:facts.length|profile\.|family.description)/);
  for (const key of ['overview', 'generationPoem', 'familyMotto', 'history']) assert.ok(reading.includes('id="profile-' + key + '"'));
  assert.match(reading, /button plain="true" class="profile-records"/);
  assert.match(reading, /button plain="true" class="profile-text-button"/);
  assert.doesNotMatch(template, /profile-directory|jumpToSection/);
  for (const key of ['family.name', 'family.description', 'item.value', 'profile.generationPoem', 'profile.familyMotto', 'profile.history']) assert.ok(reading.includes(key + " || '未填写'"));
  assert.match(template, /class="submit-actions profile-edit-dock"[\s\S]*bindtap="save"/);
});


function management(role = 'admin') {
  let definition; let count = 0; let fail = false;
  const family = { _id: 'family', name: '测试', status: 'active', currentRole: role };
  const app = { loadFamilyPages: async () => ({ families: [family] }), getDashboard: async () => ({ family, collaborators: [{ _id: 'one', displayName: '家人', role }] }),
    getInvites: async (id, cursor) => { count++; if (fail) throw new Error('邀请读取失败'); return { items: [{ _id: cursor ? 'second' : 'first', role: 'viewer', expiresAt: null, maxUses: null, viewMode: 'full', displayStatus: 'active' }], hasMore: !cursor, nextCursor: cursor ? '' : 'next' }; }, invalidateCache() {}, invalidateInvites() {} };
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/family-manage/index.js', 'utf8'), { Page: value => { definition = value; }, getApp: () => app,
    wx: { showModal: async () => ({ confirm: true }), showToast() {} },
    require: key => key.includes('launch-ad') ? { wrap: value => value } : key.endsWith('/api') ? { call: async () => ({ revoked: true }), userMessage: error => error.message } : key.endsWith('/format') ? require('../miniprogram/utils/format') : { removeInvitation() {} } });
  const page = Object.assign({}, definition, { data: structuredClone(definition.data), setData(update, callback) { Object.assign(this.data, update); if (callback) callback(); } });
  page.onLoad({ familyId: 'family' });
  return { page, calls: () => count, fail: value => { fail = value; } };
}
test('邀请默认不读取，展开失败可独立重试、分页、折叠复用和撤销后保持展开', async () => {
  const h = management(); await h.page.onShow();
  assert.equal(h.calls(), 0); assert.equal(h.page.data.invitesExpanded, false);
  h.fail(true); await h.page.toggleInvites();
  assert.match(h.page.data.invitesError, /失败/); assert.equal(h.page.data.error, '');
  h.fail(false); await h.page.retryInvites();
  assert.equal(h.page.data.invitations.length, 1);
  await h.page.loadMoreInvites(); assert.equal(h.page.data.invitations.length, 2);
  const count = h.calls(); await h.page.toggleInvites(); await h.page.toggleInvites(); assert.equal(h.calls(), count);
  await h.page.revokeInvite({ currentTarget: { dataset: { id: 'first' } } });
  assert.equal(h.page.data.invitesExpanded, true); assert.equal(h.calls(), count + 1);
  const viewer = management('viewer'); await viewer.page.onShow(); await viewer.page.toggleInvites(); assert.equal(viewer.calls(), 0);
});
