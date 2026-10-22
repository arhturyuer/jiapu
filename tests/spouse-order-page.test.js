require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/api');
const panel = require('../miniprogram/utils/spouse-order-panel');
const describe = require('../miniprogram/utils/member-actions').describe;
function fixture() {
  const app = { invalidateFamilyData() {} };
  const persons = [{ _id: 'self', name: '本人', gender: 'male' }, { _id: 'wife', name: '配偶', gender: 'female', birthDate: '1900-01-01' }];
  const relations = [{ _id: 'r', type: 'spouse', fromPersonId: 'self', toPersonId: 'wife' }];
  const page = { ...panel(app), data: { canEdit: true, currentFamily: { _id: 'family' }, relationRevision: 7, selectedPerson: persons[0], rawPersons: persons, rawRelations: relations }, setData(patch) { Object.assign(this.data, patch); }, loadPage: async () => {} };
  return { page, persons, relations };
}
test('单配偶入口可用，本人标记与移动边界、取消无副作用', () => {
  const { page, persons, relations } = fixture();
  assert.equal(describe(persons[0], persons, relations).hasSpouse, true);
  assert.equal(describe(persons[1], persons, relations).hasSpouse, true);
  page.openSpouseOrderSheet();
  assert.deepEqual(page._spouseIds, ['self', 'wife']);
  assert.equal(page.data.spouseItems[0].isSelf, true);
  assert.equal(page.data.spouseItems[0].canMoveUp, false);
  assert.equal(page.data.spouseItems[1].canMoveDown, false);
  page.moveSpouseOrder({ currentTarget: { dataset: { id: 'self', direction: 'down' } } });
  assert.deepEqual(page._spouseIds, ['wife', 'self']);
  assert.equal(page.data.spouseDirty, true);
  assert.equal(persons[0].spouseDisplayOrder, undefined);
  page.closeSpouseOrderSheet();
  page.openSpouseOrderSheet(); assert.deepEqual(page._spouseIds, ['self', 'wife']);
  page.data.canEdit = false; page.closeSpouseOrderSheet(); page.openSpouseOrderSheet();
  assert.equal(page.data.showSpouseOrder, false);
});
test('保存包含本人与打开时的关系版本，重复点击只提交一次，成员提交后关闭', async t => {
  const { page } = fixture(); let captured; let resolve;
  t.mock.method(api, 'call', (type, payload) => { captured = { type, payload }; return new Promise(r => { resolve = r; }); });
  const previous = global.wx; global.wx = { showToast() {} }; t.after(() => { global.wx = previous; });
  page.openSpouseOrderSheet(); page.moveSpouseOrder({ currentTarget: { dataset: { id: 'self', direction: 'down' } } });
  page.data.relationRevision = 9;
  const saving = page.saveSpouseOrder(); assert.equal(page.saveSpouseOrder(), undefined);
  assert.deepEqual(captured, { type: 'relation.reorderSpouses', payload: { familyId: 'family', personId: 'self', orderedPersonIds: ['wife', 'self'], relationRevision: 7 } });
  resolve({ pending: true }); await saving;
  assert.equal(page.data.showSpouseOrder, false);
});
test('保存失败保留草稿、冲突展示人物说明，离页后忽略迟到结果', async t => {
  const { page } = fixture(); let resolve; const modals = [];
  const previous = global.wx; global.wx = { showToast() {}, showModal: value => modals.push(value) }; t.after(() => { global.wx = previous; });
  t.mock.method(api, 'call', async () => { throw Object.assign(new Error('冲突人物：虚构甲、虚构乙'), { code: 'SPOUSE_ORDER_CONFLICT' }); });
  page.openSpouseOrderSheet(); page.moveSpouseOrder({ currentTarget: { dataset: { id: 'self', direction: 'down' } } });
  await page.saveSpouseOrder();
  assert.equal(page.data.spouseDirty, true); assert.equal(page.data.spouseSaving, false);
  assert.match(modals[0].content, /虚构甲/);
  t.mock.method(api, 'call', () => new Promise(r => { resolve = r; }));
  const saved = page.saveSpouseOrder(); page._spouseDisposed = true; resolve({ pending: false }); await saved;
  assert.equal(page.data.showSpouseOrder, true);
});
