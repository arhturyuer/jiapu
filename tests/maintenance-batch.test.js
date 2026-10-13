const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/membership-db');
const { countedDatabase } = require('./helpers/counting-runtime');
const batch = require('../cloudfunctions/youpuJobs/maintenance-batch');
function fixture(total) {
  const source = createDatabase(); const counts = { reads: 0, writes: 0, operations: [] };
  const db = countedDatabase(source, counts);
  source.put('families', 'f1', { status: 'deleting' });
  for (let i = 0; i < total; i++) source.put('payment_orders', 'o' + String(i).padStart(4, '0'), { familyId: 'f1', status: 'paid' });
  source.put('payment_orders', 'foreign', { familyId: 'other', status: 'paid' });
  return { db, source, counts, claim: { kind: 'family', familyId: 'f1' } };
}
test('同值更新 0/99/100/101/500 条按百条批量且稳定推进，不重复匹配第一页', async () => {
  for (const count of [0, 99, 100, 101, 500]) {
    const h = fixture(count);
    const actual = await batch.apply(h.db, 'payment_orders', { familyId: 'f1' }, { familyDeletedAt: 'fixture' }, 500, h.claim);
    assert.equal(actual, count); assert.equal(h.counts.writes, Math.ceil(count / 100));
    assert.equal(h.source.get('payment_orders', 'foreign').familyDeletedAt, undefined);
    assert.equal(h.source.all('payment_orders').filter(row => row.familyDeletedAt).length, count);
  }
});
test('选择和处理均受上限约束；回读任务拒绝归档谱；原条件变化不会误删', async () => {
  const h = fixture(101);
  assert.equal(await batch.apply(h.db, 'payment_orders', { familyId: 'f1' }, { familyDeletedAt: 'fixture' }, 99, h.claim), 99);
  assert.equal(h.counts.writes, 1);
  h.source.put('families', 'f1', { status: 'archived' });
  await assert.rejects(batch.apply(h.db, 'payment_orders', { familyId: 'f1' }, {}, 101, h.claim), { code: 'MAINTENANCE_BATCH_REJECTED' });
  assert.equal(h.counts.writes, 1);
  h.source.put('families', 'f1', { status: 'deleting' });
  h.source.put('persons', 'p1', { familyId: 'f1' });
  h.source.queryHook = async name => { if (name === 'persons') h.source.put('persons', 'p1', { familyId: 'other' }); };
  assert.equal(await batch.apply(h.db, 'persons', { familyId: 'f1' }, null, 100, h.claim, 'remove'), 0);
  assert.ok(h.source.get('persons', 'p1'));
});
test('101 条删除两批；恢复失败批次不重做成功批次；不扩展到期清理允许列表', async () => {
  const h = fixture(0); for (let i = 0; i < 101; i++) h.source.put('persons', 'p' + String(i).padStart(4, '0'), { familyId: 'f1' });
  assert.equal(await batch.apply(h.db, 'persons', { familyId: 'f1' }, null, 101, h.claim, 'remove'), 101);
  assert.equal(h.counts.writes, 2);
  await assert.rejects(batch.apply(h.db, 'users', { familyId: 'f1' }, null, 101, h.claim, 'remove'), { code: 'MAINTENANCE_BATCH_REJECTED' });
  const retry = fixture(101); let selections = 0;
  for (const row of retry.source.all('payment_orders').filter(row => row.familyId === 'f1')) retry.source.put('payment_orders', row._id, { ...row, status: 'pending' });
  retry.source.queryHook = async name => { if (name === 'payment_orders' && ++selections === 2) throw new Error('failure'); };
  await assert.rejects(batch.apply(retry.db, 'payment_orders', { familyId: 'f1', status: 'pending' }, { status: 'closed' }, 101, retry.claim));
  retry.source.queryHook = null;
  assert.equal(await batch.apply(retry.db, 'payment_orders', { familyId: 'f1', status: 'pending' }, { status: 'closed' }, 101, retry.claim), 1);
  assert.equal(retry.source.all('payment_orders').filter(row => row.status === 'closed').length, 101);
});
test('注销批处理需要同一用户的 processing 请求及 deleted 状态，其他条件拒绝', async () => {
  const h = fixture(0); const claim = { kind: 'account', requestId: 'r1', userId: 'u1' };
  h.source.put('users', 'u1', { status: 'deleted' }); h.source.put('account_deletion_requests', 'r1', { userId: 'u1', status: 'processing' });
  for (let i = 0; i < 101; i++) h.source.put('audit_logs', 'a' + String(i).padStart(4, '0'), { actorId: 'u1' });
  assert.equal(await batch.apply(h.db, 'audit_logs', { actorId: 'u1' }, { actorId: 'anon' }, 101, claim), 101);
  assert.equal(h.counts.writes, 2);
  await assert.rejects(batch.apply(h.db, 'audit_logs', { actorId: 'other' }, {}, 101, claim), { code: 'MAINTENANCE_BATCH_REJECTED' });
  h.source.put('account_deletion_requests', 'r1', { userId: 'u1', status: 'pending' }); h.source.put('audit_logs', 'a1', { actorId: 'u1' });
  await assert.rejects(batch.apply(h.db, 'audit_logs', { actorId: 'u1' }, {}, 101, claim), { code: 'MAINTENANCE_BATCH_REJECTED' });
});
