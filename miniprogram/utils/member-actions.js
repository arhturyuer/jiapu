const kinship = require('./kinship');

const RELATION_TYPES = ['father', 'mother', 'spouse', 'son', 'daughter', 'sibling'];

function activeRelation(relation) {
  return relation && (!relation.status || relation.status === 'active');
}

function describe(person, persons, relations) {
  const personId = person && person._id;
  const peopleById = {};
  (persons || []).forEach(function (item) { peopleById[item._id] = item; });
  let childCount = 0;
  let hasFather = false;
  let hasMother = false;
  (relations || []).forEach(function (relation) {
    if (!activeRelation(relation) || relation.type !== 'parent_child') return;
    if (relation.fromPersonId === personId && peopleById[relation.toPersonId]) childCount += 1;
    if (relation.toPersonId !== personId) return;
    const parent = peopleById[relation.fromPersonId];
    if (parent && parent.gender === 'male') hasFather = true;
    if (parent && parent.gender === 'female') hasMother = true;
  });
  return {
    childCount: childCount,
    hasChildren: childCount > 0,
    hasMultipleChildren: childCount >= 2,
    relationOptions: RELATION_TYPES.filter(function (type) {
      return (type !== 'father' || !hasFather) && (type !== 'mother' || !hasMother);
    }).map(function (type) {
      return { key: type, label: kinship.relationTypeLabel(person, type) };
    })
  };
}

module.exports = { describe: describe };
