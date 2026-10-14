const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDatabase } = require('./helpers/membership-db');
const { runtime } = require('./helpers/counting-runtime');
function harness() {
  const db = createDatabase(); const uid = 'u_' + crypto.createHash('sha256').update('fixture-actor').digest('hex').slice(0, 32);
  db.put('users', uid, { status: 'active', firstEnteredFamilyAt: new Date() });
  db.put('families', 'family', { status: 'active', name: '虚构家谱', contentRevision: 1, relationRevision: 4 });
  db.put('family_memberships', 'fm_' + crypto.createHash('sha256').update('family:fixture-actor').digest('hex').slice(0, 32), { familyId: 'family', userId: uid, status: 'active', role: 'viewer' });
  db.put('persons', 'p', { familyId: 'family', status: 'active', name: '旧资料', gender: 'male' });
  return { db, h: runtime('cloudfunctions/youpuUserApi', db) };
}
test('graph.get 版本与人物资料一致，跨读取修改会重新取完整快照', async () => {
  const { db, h } = harness(); let changed = false;
  db.queryHook = name => {
    if (name === 'persons' && !changed) {
      changed = true; db.put('families', 'family', { ...db.get('families', 'family'), contentRevision: 2 });
      db.put('persons', 'p', { ...db.get('persons', 'p'), name: '新资料' });
    }
  };
  const result = await h.call({ type: 'graph.get', familyId: 'family' });
  assert.equal(result.success, true, result.message); assert.equal(result.data.contentRevision, 2);
  assert.equal(result.data.persons[0].name, '新资料'); assert.equal(result.data.relationRevision, 4);
});
test('持续修改最多读取三次，不返回混合版本', async () => {
  const { db, h } = harness(); let reads = 0;
  db.queryHook = name => { if (name === 'persons') { reads++; db.put('families', 'family', { ...db.get('families', 'family'), contentRevision: reads + 1 }); } };
  const result = await h.call({ type: 'graph.get', familyId: 'family' });
  assert.equal(result.success, false); assert.equal(result.code, 'GRAPH_CHANGED'); assert.equal(reads, 3);
});
