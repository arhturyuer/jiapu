// Shared by the client and packaged cloud functions. Orders include the owner.
function active(row) { return row && row.status !== 'deleted'; }
function neighbors(persons, relations) {
  const byId = new Map(persons.filter(active).map(p => [p._id, p]));
  const result = new Map(Array.from(byId.keys()).map(id => [id, new Set([id])]));
  (relations || []).forEach(r => {
    if (!active(r) || r.type !== 'spouse' || !byId.has(r.fromPersonId) || !byId.has(r.toPersonId)) return;
    result.get(r.fromPersonId).add(r.toPersonId); result.get(r.toPersonId).add(r.fromPersonId);
  });
  return result;
}
function normalized(person, members) {
  if (!Array.isArray(person.spouseDisplayOrder) || !person.spouseDisplayOrder.length) return [];
  const kept = Array.from(new Set(person.spouseDisplayOrder.filter(id => members.has(id))));
  Array.from(members).sort().forEach(id => { if (!kept.includes(id)) kept.push(id); });
  return kept;
}
function apply(persons, relations, baseline) {
  const people = baseline || persons.filter(active);
  if (!persons.some(p => Array.isArray(p.spouseDisplayOrder) && p.spouseDisplayOrder.length)) return people.slice();
  const membership = neighbors(persons, relations);
  const byId = new Map(people.map(p => [p._id, p]));
  const outgoing = new Map(people.map(p => [p._id, new Set()]));
  const indegree = new Map(people.map(p => [p._id, 0]));
  persons.filter(active).forEach(p => {
    const order = normalized(p, membership.get(p._id) || new Set()).filter(id => byId.has(id));
    for (let i = 1; i < order.length; i++) {
      const from = order[i - 1]; const to = order[i];
      if (!outgoing.get(from).has(to)) { outgoing.get(from).add(to); indegree.set(to, indegree.get(to) + 1); }
    }
  });
  const remaining = new Set(people.map(p => p._id)); const result = [];
  while (remaining.size) {
    const next = people.find(p => remaining.has(p._id) && indegree.get(p._id) === 0);
    if (!next) {
      const ids = Array.from(remaining);
      const error = new Error('夫妻顺序与已保存的顺序冲突，请先调整相关人物：' + ids.slice(0, 4).map(id => byId.get(id).name || '未命名').join('、'));
      error.code = 'SPOUSE_ORDER_CONFLICT'; error.details = { personIds: ids }; throw error;
    }
    remaining.delete(next._id); result.push(next);
    outgoing.get(next._id).forEach(id => indegree.set(id, indegree.get(id) - 1));
  }
  return result;
}
function proposal(persons, relations, personId, orderedIds) {
  const membership = neighbors(persons, relations); const own = membership.get(personId);
  if (!own || own.size < 2) throw Object.assign(new Error('至少有一位配偶才需要调整夫妻顺序'), { code: 'SPOUSE_ORDER_NOT_NEEDED' });
  if (!Array.isArray(orderedIds) || orderedIds.length !== own.size || new Set(orderedIds).size !== own.size || orderedIds.some(id => !own.has(id))) {
    throw Object.assign(new Error('夫妻成员刚有变化，请刷新后重试'), { code: 'GRAPH_CHANGED' });
  }
  const changes = new Map();
  persons.forEach(p => {
    const group = membership.get(p._id);
    // Equivalent editors (including either member of a single couple) replace
    // the same constraint, rather than leaving contradictory duplicate orders.
    if (p._id === personId || (Array.isArray(p.spouseDisplayOrder) && group && group.size === own.size && Array.from(group).every(id => own.has(id)))) {
      changes.set(p._id, orderedIds.slice());
    }
  });
  const next = persons.map(p => changes.has(p._id) ? Object.assign({}, p, { spouseDisplayOrder: changes.get(p._id) }) : p);
  apply(next, relations);
  return changes;
}
module.exports = { neighbors, normalized, apply, proposal };
