const order = require('./pdf-shared/spouse-order');
function createService({ db, listAll, mustGet, assert }) {
  const states = new WeakMap();
  async function snapshot(familyId) {
    const [persons, relations] = await Promise.all([listAll('persons', { familyId, status: 'active' }, 500), listAll('relations', { familyId, status: 'active' }, 2000)]);
    return { persons, relations };
  }
  async function persist(transaction, persons, changes) {
    for (const [id, ids] of changes) {
      await transaction.collection('persons').doc(id).update({ data: { spouseDisplayOrder: ids, updatedAt: db.serverDate() } });
      const person = persons.find(p => p._id === id); if (person) person.spouseDisplayOrder = ids;
    }
  }
  async function reorder(transaction, familyId, personId, ids, graph) {
    const changes = order.proposal(graph.persons, graph.relations, personId, ids);
    // Re-read every affected owner inside the family-version protected transaction.
    for (const id of changes.keys()) {
      const person = await mustGet(transaction, 'persons', id, 'PERSON_NOT_FOUND', '成员不存在');
      assert(person.familyId === familyId && person.status === 'active', 'GRAPH_CHANGED', '夫妻成员刚有变化，请刷新后重试');
    }
    await persist(transaction, graph.persons, changes);
  }
  async function added(transaction, familyId, relation, endpoints) {
    let state = states.get(transaction);
    if (!state && !endpoints.some(p => Array.isArray(p.spouseDisplayOrder) && p.spouseDisplayOrder.length)) return;
    if (!state) { state = await snapshot(familyId); states.set(transaction, state); }
    endpoints.forEach(p => { if (!state.persons.some(row => row._id === p._id)) state.persons.push(p); });
    state.relations = state.relations.filter(r => r._id !== relation._id).concat(relation);
    const membership = order.neighbors(state.persons, state.relations); const changes = new Map();
    endpoints.forEach(p => {
      const current = state.persons.find(row => row._id === p._id);
      if (current.spouseDisplayOrder && current.spouseDisplayOrder.length) changes.set(p._id, order.normalized(current, membership.get(p._id)));
    });
    const next = state.persons.map(p => changes.has(p._id) ? Object.assign({}, p, { spouseDisplayOrder: changes.get(p._id) }) : p);
    order.apply(next, state.relations);
    await persist(transaction, state.persons, changes);
  }
  async function removed(transaction, familyId, relations, removed) {
    const affected = new Set();
    removed.filter(r => r.type === 'spouse').forEach(r => { affected.add(r.fromPersonId); affected.add(r.toPersonId); });
    const remaining = relations.filter(r => !removed.some(item => item._id === r._id));
    for (const id of affected) {
      const p = await mustGet(transaction, 'persons', id, 'PERSON_NOT_FOUND', '成员不存在');
      if (p.status !== 'active' || !Array.isArray(p.spouseDisplayOrder)) continue;
      const members = new Set([id]);
      remaining.filter(r => r.type === 'spouse').forEach(r => { if (r.fromPersonId === id) members.add(r.toPersonId); if (r.toPersonId === id) members.add(r.fromPersonId); });
      const ids = order.normalized(p, members);
      await persist(transaction, [p], new Map([[id, ids]]));
    }
  }
  return { snapshot, reorder, added, removed };
}
module.exports = { createService };
