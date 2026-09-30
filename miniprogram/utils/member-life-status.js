const graphLayout = require('./graph-layout');
const personDate = require('./person-date');

function defaultStatus(persons, relations, anchorId, relationType, today) {
  const people = (persons || []).filter(function (person) { return person.status !== 'deleted'; });
  const active = (relations || []).filter(function (relation) { return relation.status !== 'deleted'; });
  if (!people.some(function (person) { return person._id === anchorId; })) return 'living';
  if (relationType === 'father' || relationType === 'mother') {
    const descendants = new Set([anchorId]);
    for (let index = 0, ids = [anchorId]; index < ids.length; index += 1) {
      active.forEach(function (relation) {
        if (relation.type === 'parent_child' && relation.fromPersonId === ids[index] && !descendants.has(relation.toPersonId)) {
          descendants.add(relation.toPersonId);
          ids.push(relation.toPersonId);
        }
      });
    }
    if (people.some(function (person) { return descendants.has(person._id) && personDate.definitelyAtLeast(person, 80, today); })) return 'deceased';
  }
  const adjacent = {};
  active.forEach(function (relation) {
    if (!adjacent[relation.fromPersonId]) adjacent[relation.fromPersonId] = [];
    if (!adjacent[relation.toPersonId]) adjacent[relation.toPersonId] = [];
    adjacent[relation.fromPersonId].push(relation.toPersonId);
    adjacent[relation.toPersonId].push(relation.fromPersonId);
  });
  const connected = new Set([anchorId]);
  const queue = [anchorId];
  for (let index = 0; index < queue.length; index += 1) {
    (adjacent[queue[index]] || []).forEach(function (id) {
      if (connected.has(id)) return;
      connected.add(id);
      queue.push(id);
    });
  }
  const lineagePeople = people.filter(function (person) { return connected.has(person._id); });
  const lineageRelations = active.filter(function (relation) {
    return connected.has(relation.fromPersonId) && connected.has(relation.toPersonId);
  });
  const grouped = graphLayout.groupPersonsByGeneration(lineagePeople, lineageRelations);
  const anchorGeneration = grouped.generationByPerson[anchorId];
  if (!Number.isInteger(anchorGeneration)) return 'living';
  const generations = Object.values(grouped.generationByPerson).filter(Number.isInteger);
  const youngest = Math.max.apply(null, generations);
  const offset = relationType === 'father' || relationType === 'mother' ? -1
    : relationType === 'son' || relationType === 'daughter' ? 1 : 0;
  return youngest - (anchorGeneration + offset) >= 6 ? 'deceased' : 'living';
}

module.exports = { defaultStatus };
