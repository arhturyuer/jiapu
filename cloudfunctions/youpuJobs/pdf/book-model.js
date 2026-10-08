const graph = require('./shared/graph-layout');
const childRank = require('./shared/child-rank');
function bookModel(snapshot) {
  const grouping = graph.groupPersonsByGeneration(snapshot.persons, snapshot.relations);
  const people = grouping.orderedPersons;
  const ids = new Map(people.map((person, index) => [person._id, 'P' + String(index + 1).padStart(3, '0')]));
  const byId = new Map(people.map(person => [person._id, person]));
  const families = new Map(); const used = new Set(); const edges = new Set();
  const spouseEdges = new Set(); const representedSpouses = new Set();
  const parents = new Map(); const children = new Map(); const spouses = new Map();
  const pair = (a, b) => JSON.stringify([a, b].sort());
  const append = (map, id, other) => { if (!map.has(id)) map.set(id, []); if (!map.get(id).includes(other)) map.get(id).push(other); };
  for (const relation of snapshot.relations) {
    if (relation.type === 'parent_child') {
      append(parents, relation.toPersonId, relation.fromPersonId);
      append(children, relation.fromPersonId, relation.toPersonId);
      edges.add(relation.fromPersonId + '>' + relation.toPersonId);
    } else {
      append(spouses, relation.fromPersonId, relation.toPersonId);
      append(spouses, relation.toPersonId, relation.fromPersonId);
      spouseEdges.add(pair(relation.fromPersonId, relation.toPersonId));
    }
  }
  const parentOrders = childRank.build(snapshot.persons, snapshot.relations).parentOrders;
  for (const person of people) {
    const list = (parents.get(person._id) || []).slice().sort((a, b) => ids.get(a).localeCompare(ids.get(b)));
    if (!list.length) continue;
    const key = JSON.stringify(list);
    if (!families.has(key)) families.set(key, { key, parents: list, children: [] });
    families.get(key).children.push(person._id);
    list.forEach(id => used.add(id)); used.add(person._id);
  }
  const units = [];
  for (const family of families.values()) {
    const order = parentOrders[family.parents[0]] || [];
    family.children.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    for (let index = 0; index < family.parents.length; index += 2) {
      const list = family.parents.slice(index, index + 2);
      const married = list.length === 2 && spouseEdges.has(pair(...list));
      if (married) representedSpouses.add(pair(...list));
      units.push({ ...family, key: family.key + ':' + index, parents: list, spouse: married });
    }
  }
  for (const key of spouseEdges) {
    const list = JSON.parse(key); list.forEach(id => used.add(id));
    if (!representedSpouses.has(key)) units.push({ key: 'spouse:' + key, parents: list, children: [], spouse: true });
  }
  people.filter(person => !used.has(person._id)).forEach(person => units.push({ key: 'person:' + person._id, parents: [person._id], children: [], spouse: false }));
  const generation = unit => Math.min(...unit.parents.map(id => grouping.generationByPerson[id] || Infinity));
  units.sort((a, b) => {
    const ga = generation(a); const gb = generation(b);
    if (ga !== gb) return ga < gb ? -1 : 1;
    return a.parents.map(id => ids.get(id)).join('|').localeCompare(b.parents.map(id => ids.get(id)).join('|')) || a.key.localeCompare(b.key);
  });
  const parentUnits = new Map();
  units.forEach(unit => unit.parents.forEach(id => { if (unit.children.length) append(parentUnits, id, unit.key); }));
  const sections = [];
  for (const unit of units) {
    if (!unit.children.length) sections.push({ ...unit, start: 0, total: 0 });
    for (let start = 0; start < unit.children.length; start += 8) sections.push({ ...unit, children: unit.children.slice(start, start + 8), start, total: unit.children.length });
  }
  return { grouping, people, ids, byId, units, sections, edges, spouseEdges, parents, children, spouses, parentUnits, parentOrders };
}
module.exports = { bookModel };
