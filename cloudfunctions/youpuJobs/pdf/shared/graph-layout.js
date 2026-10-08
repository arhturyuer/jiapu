const HORIZONTAL_METRICS = {
  nodeWidth: 168,
  // This is the outer card height, including its avatar, name and status line.
  // Keep connection geometry aligned with the actual fixed-height mini-program card.
  nodeHeight: 164,
  coupleGap: 76,
  unitGap: 72,
  rootGap: 144,
  gapY: 280,
  marginX: 80,
  marginY: 80
};
const VERTICAL_METRICS = {
  nodeWidth: 88,
  nodeHeight: 164,
  coupleGap: 48,
  unitGap: 52,
  rootGap: 104,
  gapY: 280,
  marginX: 80,
  marginY: 80
};
const JUNCTION_RADIUS = 7;
const LINE_OVERLAP = 2;
const MAX_ANIMATED_CHILDREN = 12;
const FAMILY_RAIL_CLEARANCE = 24;
const FAMILY_RAIL_SPACING = 24;
const CROSSING_RADIUS = 7;
const kinship = require('./kinship');
const personGenderDisplay = require('./person-gender');
const childRank = require('./child-rank');
const personDate = require('./person-date');

function metricsForNameLayout(nameLayout) {
  return nameLayout === 'vertical' ? VERTICAL_METRICS : HORIZONTAL_METRICS;
}

function verticalDisplayName(name) {
  const characters = Array.from(String(name || '未命名'));
  const visible = characters.slice(0, 4).join('\n');
  return characters.length > 4 ? visible + '\n…' : visible;
}

function personGender(person) {
  return person && person.gender ? person.gender : 'unknown';
}

function comparePeople(a, b) {
  const dateA = (personDate.range(a, 'birth') || {}).start || '9999-99-99';
  const dateB = (personDate.range(b, 'birth') || {}).start || '9999-99-99';
  if (dateA !== dateB) return dateA.localeCompare(dateB);
  const nameOrder = (a.name || '').localeCompare(b.name || '', 'zh-CN');
  if (nameOrder) return nameOrder;
  return (a._id || '').localeCompare(b._id || '');
}

function comparePeopleByName(a, b) {
  const nameOrder = (a.name || '').localeCompare(b.name || '', 'zh-CN');
  if (nameOrder) return nameOrder;
  return (a._id || '').localeCompare(b._id || '');
}

function activeRelations(relations) {
  return (relations || []).filter(function (relation) {
    return relation.status !== 'deleted';
  });
}

function filterCollapsed(persons, relations, collapsedIds) {
  const collapsed = new Set(collapsedIds || []);
  if (!collapsed.size) return { persons: persons, relations: relations, hiddenCount: 0, hiddenByCollapsed: {} };
  const children = {};
  const spouses = {};
  persons.forEach(function (person) {
    children[person._id] = [];
    spouses[person._id] = [];
  });
  relations.forEach(function (relation) {
    if (relation.type === 'parent_child' && children[relation.fromPersonId]) {
      children[relation.fromPersonId].push(relation.toPersonId);
    }
    if (relation.type === 'spouse' && spouses[relation.fromPersonId] && spouses[relation.toPersonId]) {
      spouses[relation.fromPersonId].push(relation.toPersonId);
      spouses[relation.toPersonId].push(relation.fromPersonId);
    }
  });
  const hidden = new Set();
  const hiddenByCollapsed = {};
  collapsed.forEach(function (personId) {
    const branchHidden = new Set();
    const queue = (children[personId] || []).slice();
    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const current = queue[queueIndex];
      queueIndex += 1;
      if (branchHidden.has(current) || collapsed.has(current)) continue;
      branchHidden.add(current);
      hidden.add(current);
      (children[current] || []).forEach(function (childId) { queue.push(childId); });
      (spouses[current] || []).forEach(function (spouseId) { queue.push(spouseId); });
    }
    hiddenByCollapsed[personId] = branchHidden.size;
  });
  return {
    persons: persons.filter(function (person) { return !hidden.has(person._id); }),
    relations: relations.filter(function (relation) {
      return !hidden.has(relation.fromPersonId) && !hidden.has(relation.toPersonId);
    }),
    hiddenCount: hidden.size,
    hiddenByCollapsed: hiddenByCollapsed
  };
}

function createSpouseComponents(persons, relations) {
  const parent = {};
  persons.forEach(function (person) { parent[person._id] = person._id; });

  function find(id) {
    let current = id;
    while (parent[current] !== current) current = parent[current];
    while (parent[id] !== id) {
      const next = parent[id];
      parent[id] = current;
      id = next;
    }
    return current;
  }

  function union(firstId, secondId) {
    const firstRoot = find(firstId);
    const secondRoot = find(secondId);
    if (firstRoot !== secondRoot) parent[secondRoot] = firstRoot;
  }

  relations.forEach(function (relation) {
    if (relation.type === 'spouse' && parent[relation.fromPersonId] && parent[relation.toPersonId]) {
      union(relation.fromPersonId, relation.toPersonId);
    }
  });

  const membersByRoot = {};
  const componentByPerson = {};
  persons.forEach(function (person) {
    const root = find(person._id);
    componentByPerson[person._id] = root;
    if (!membersByRoot[root]) membersByRoot[root] = [];
    membersByRoot[root].push(person);
  });
  return { membersByRoot: membersByRoot, componentByPerson: componentByPerson };
}

function assignGenerations(persons, relations, components) {
  const roots = Object.keys(components.membersByRoot);
  const children = {};
  const indegree = {};
  const generationsByRoot = {};
  roots.forEach(function (root) {
    children[root] = [];
    indegree[root] = 0;
    generationsByRoot[root] = 0;
  });

  const edgeKeys = {};
  relations.forEach(function (relation) {
    if (relation.type !== 'parent_child') return;
    const fromRoot = components.componentByPerson[relation.fromPersonId];
    const toRoot = components.componentByPerson[relation.toPersonId];
    if (!fromRoot || !toRoot || fromRoot === toRoot) return;
    const key = fromRoot + '>' + toRoot;
    if (edgeKeys[key]) return;
    edgeKeys[key] = true;
    children[fromRoot].push(toRoot);
    indegree[toRoot] += 1;
  });

  const queue = roots.filter(function (root) { return indegree[root] === 0; });
  let index = 0;
  while (index < queue.length) {
    const root = queue[index];
    index += 1;
    children[root].forEach(function (childRoot) {
      generationsByRoot[childRoot] = Math.max(
        generationsByRoot[childRoot],
        generationsByRoot[root] + 1
      );
      indegree[childRoot] -= 1;
      if (indegree[childRoot] === 0) queue.push(childRoot);
    });
  }

  // Defensive fallback for inconsistent imported data. The write API rejects
  // ancestry cycles, but legacy data may still contain one.
  for (let pass = 0; pass < roots.length; pass += 1) {
    let changed = false;
    Object.keys(edgeKeys).forEach(function (key) {
      const pair = key.split('>');
      const next = generationsByRoot[pair[0]] + 1;
      if (next > generationsByRoot[pair[1]] && next <= roots.length) {
        generationsByRoot[pair[1]] = next;
        changed = true;
      }
    });
    if (!changed) break;
  }

  const result = {};
  // Place a shorter known lineage beside the corresponding generation of the
  // deeper lineage. Unknown ancestors leave space above, rather than shifting
  // a person's parents away from that person by several rows.
  queue.slice().reverse().forEach(function (root) {
    if (children[root].length) {
      generationsByRoot[root] = Math.min.apply(null, children[root].map(function (childRoot) {
        return generationsByRoot[childRoot] - 1;
      }));
    }
  });
  persons.forEach(function (person) {
    result[person._id] = generationsByRoot[components.componentByPerson[person._id]] || 0;
  });
  return result;
}

function orderSpouseMembers(members, relations) {
  if (members.length <= 1) return members.slice();
  if (members.length === 2) {
    return members.slice().sort(function (first, second) {
      const firstGender = personGender(first);
      const secondGender = personGender(second);
      if (firstGender === 'male' && secondGender !== 'male') return -1;
      if (secondGender === 'male' && firstGender !== 'male') return 1;
      return comparePeople(first, second);
    });
  }

  const ids = new Set(members.map(function (person) { return person._id; }));
  const degrees = {};
  members.forEach(function (person) { degrees[person._id] = 0; });
  relations.forEach(function (relation) {
    if (relation.type !== 'spouse' || !ids.has(relation.fromPersonId) || !ids.has(relation.toPersonId)) return;
    degrees[relation.fromPersonId] += 1;
    degrees[relation.toPersonId] += 1;
  });
  const ranked = members.slice().sort(function (first, second) {
    return degrees[second._id] - degrees[first._id] || comparePeople(first, second);
  });
  const hub = ranked.shift();
  const left = [];
  const right = [];
  ranked.forEach(function (person, index) {
    if (index % 2 === 0) left.unshift(person);
    else right.push(person);
  });
  return left.concat(hub, right);
}

function connectedPersonGroups(persons, relations) {
  const adjacency = {};
  const peopleById = {};
  persons.forEach(function (person) {
    adjacency[person._id] = [];
    peopleById[person._id] = person;
  });
  relations.forEach(function (relation) {
    if (!adjacency[relation.fromPersonId] || !adjacency[relation.toPersonId]) return;
    adjacency[relation.fromPersonId].push(relation.toPersonId);
    adjacency[relation.toPersonId].push(relation.fromPersonId);
  });

  const visited = {};
  const groups = [];
  persons.forEach(function (person) {
    if (visited[person._id]) return;
    const ids = [];
    const queue = [person._id];
    visited[person._id] = true;
    for (let index = 0; index < queue.length; index += 1) {
      const currentId = queue[index];
      ids.push(currentId);
      (adjacency[currentId] || []).forEach(function (nextId) {
        if (visited[nextId]) return;
        visited[nextId] = true;
        queue.push(nextId);
      });
    }
    groups.push(ids.map(function (id) { return peopleById[id]; }));
  });
  return groups.sort(function (first, second) {
    if (first.length !== second.length) return second.length - first.length;
    const firstPerson = first.slice().sort(comparePeople)[0];
    const secondPerson = second.slice().sort(comparePeople)[0];
    return comparePeople(firstPerson, secondPerson);
  });
}

function listGenerationState(persons, relations, components) {
  const roots = Object.keys(components.membersByRoot);
  const children = {};
  const indegree = {};
  const generationByRoot = {};
  const edgeKeys = {};
  roots.forEach(function (root) {
    children[root] = [];
    indegree[root] = 0;
    generationByRoot[root] = 0;
  });
  relations.forEach(function (relation) {
    if (relation.type !== 'parent_child') return;
    const parentRoot = components.componentByPerson[relation.fromPersonId];
    const childRoot = components.componentByPerson[relation.toPersonId];
    if (!parentRoot || !childRoot) return;
    if (parentRoot === childRoot) {
      edgeKeys[parentRoot + '>' + childRoot] = true;
      indegree[parentRoot] += 1;
      return;
    }
    const key = parentRoot + '>' + childRoot;
    if (edgeKeys[key]) return;
    edgeKeys[key] = true;
    children[parentRoot].push(childRoot);
    indegree[childRoot] += 1;
  });

  const queue = roots.filter(function (root) { return indegree[root] === 0; }).sort();
  const processed = {};
  for (let index = 0; index < queue.length; index += 1) {
    const root = queue[index];
    processed[root] = true;
    children[root].forEach(function (childRoot) {
      generationByRoot[childRoot] = Math.max(generationByRoot[childRoot], generationByRoot[root] + 1);
      indegree[childRoot] -= 1;
      if (indegree[childRoot] === 0) queue.push(childRoot);
    });
  }

  const generationByPerson = {};
  const unresolvedIds = {};
  persons.forEach(function (person) {
    const root = components.componentByPerson[person._id];
    if (processed[root]) generationByPerson[person._id] = generationByRoot[root] + 1;
    else unresolvedIds[person._id] = true;
  });
  return { generationByPerson: generationByPerson, unresolvedIds: unresolvedIds };
}

function chineseGeneration(value) {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value < 10) return digits[value];
  if (value === 10) return '十';
  if (value < 20) return '十' + digits[value % 10];
  if (value < 100) return digits[Math.floor(value / 10)] + '十' + digits[value % 10];
  return String(value);
}

function orderPeopleWithSpouses(persons, relations) {
  if (!persons.length) return [];
  const ids = new Set(persons.map(function (person) { return person._id; }));
  const visibleRelations = relations.filter(function (relation) {
    return ids.has(relation.fromPersonId) && ids.has(relation.toPersonId);
  });
  const components = createSpouseComponents(persons, visibleRelations);
  return Object.keys(components.membersByRoot).map(function (root) {
    const members = orderSpouseMembers(components.membersByRoot[root], visibleRelations);
    return { members: members, sortPerson: members.slice().sort(comparePeople)[0] };
  }).sort(function (first, second) {
    return comparePeople(first.sortPerson, second.sortPerson);
  }).reduce(function (ordered, unit) {
    return ordered.concat(unit.members);
  }, []);
}

function groupPersonsByGeneration(personsInput, relationsInput) {
  const persons = (personsInput || []).filter(function (person) { return person.status !== 'deleted'; });
  const personIds = new Set(persons.map(function (person) { return person._id; }));
  const relations = activeRelations(relationsInput).filter(function (relation) {
    return personIds.has(relation.fromPersonId) && personIds.has(relation.toPersonId);
  });
  if (!persons.length) return { groups: [], orderedPersons: [], generationByPerson: {} };

  const connectedGroups = connectedPersonGroups(persons, relations);
  const mainPersons = connectedGroups[0] || [];
  const mainIds = new Set(mainPersons.map(function (person) { return person._id; }));
  const mainRelations = relations.filter(function (relation) {
    return mainIds.has(relation.fromPersonId) && mainIds.has(relation.toPersonId);
  });
  const components = createSpouseComponents(mainPersons, mainRelations);
  const state = listGenerationState(mainPersons, mainRelations, components);
  const unresolvedIds = {};
  connectedGroups.slice(1).forEach(function (group) {
    group.forEach(function (person) { unresolvedIds[person._id] = true; });
  });
  Object.keys(state.unresolvedIds).forEach(function (personId) { unresolvedIds[personId] = true; });

  const personsByGeneration = {};
  persons.forEach(function (person) {
    if (unresolvedIds[person._id]) return;
    const generation = state.generationByPerson[person._id];
    if (!personsByGeneration[generation]) personsByGeneration[generation] = [];
    personsByGeneration[generation].push(person);
  });
  const groups = Object.keys(personsByGeneration).map(Number).sort(function (first, second) {
    return first - second;
  }).map(function (generation) {
    const members = orderPeopleWithSpouses(personsByGeneration[generation], relations);
    return {
      key: 'generation-' + generation,
      generation: generation,
      label: '第' + chineseGeneration(generation) + '代',
      persons: members
    };
  });

  const unresolvedPersons = persons.filter(function (person) { return unresolvedIds[person._id]; });
  if (unresolvedPersons.length) {
    groups.push({
      key: 'unresolved',
      generation: null,
      label: '辈分待确认',
      persons: orderPeopleWithSpouses(unresolvedPersons, relations)
    });
  }
  const generationByPerson = Object.assign({}, state.generationByPerson);
  Object.keys(unresolvedIds).forEach(function (personId) { generationByPerson[personId] = null; });
  return {
    groups: groups,
    orderedPersons: groups.reduce(function (ordered, group) { return ordered.concat(group.persons); }, []),
    generationByPerson: generationByPerson
  };
}

function sortPersonsByName(persons) {
  return (persons || []).slice().sort(comparePeopleByName);
}

function buildUnits(persons, relations, components, generations, metrics, childRanks) {
  const units = [];
  const unitsById = {};
  Object.keys(components.membersByRoot).forEach(function (root) {
    const members = orderSpouseMembers(components.membersByRoot[root], relations);
    const unit = {
      _id: root,
      generation: generations[members[0]._id] || 0,
      members: members,
      baseWidth: members.length * metrics.nodeWidth + Math.max(0, members.length - 1) * metrics.coupleGap,
      width: members.length * metrics.nodeWidth + Math.max(0, members.length - 1) * metrics.coupleGap,
      sortPerson: members.slice().sort(comparePeople)[0]
    };
    units.push(unit);
    unitsById[root] = unit;
  });

  const unitsByGeneration = {};
  units.forEach(function (unit) {
    if (!unitsByGeneration[unit.generation]) unitsByGeneration[unit.generation] = [];
    unitsByGeneration[unit.generation].push(unit);
  });

  const parentRoots = {};
  const childrenByRoot = {};
  const parentIdsByChildRoot = {};
  const parentsByMember = {};
  const spousePairs = {};
  units.forEach(function (unit) { childrenByRoot[unit._id] = []; });
  relations.forEach(function (relation) {
    if (relation.type === 'spouse') {
      spousePairs[pairKey(relation.fromPersonId, relation.toPersonId)] = true;
      return;
    }
    if (relation.type !== 'parent_child') return;
    const childRoot = components.componentByPerson[relation.toPersonId];
    const parentRoot = components.componentByPerson[relation.fromPersonId];
    if (!childRoot || !parentRoot || childRoot === parentRoot) return;
    if (!parentsByMember[relation.toPersonId]) parentsByMember[relation.toPersonId] = [];
    if (parentsByMember[relation.toPersonId].indexOf(parentRoot) < 0) parentsByMember[relation.toPersonId].push(parentRoot);
    if (!parentIdsByChildRoot[childRoot]) parentIdsByChildRoot[childRoot] = [];
    if (parentIdsByChildRoot[childRoot].indexOf(relation.fromPersonId) < 0) {
      parentIdsByChildRoot[childRoot].push(relation.fromPersonId);
    }
    if (!parentRoots[childRoot]) parentRoots[childRoot] = [];
    if (parentRoots[childRoot].indexOf(parentRoot) < 0) {
      parentRoots[childRoot].push(parentRoot);
      childrenByRoot[parentRoot].push(childRoot);
    }
  });

  const orderByRoot = {};
  Object.keys(unitsByGeneration).map(Number).sort(function (a, b) { return a - b; }).forEach(function (generation) {
    unitsByGeneration[generation].sort(function (first, second) {
      const firstParents = (parentRoots[first._id] || []).map(function (id) { return orderByRoot[id]; }).filter(function (value) { return value !== undefined; });
      const secondParents = (parentRoots[second._id] || []).map(function (id) { return orderByRoot[id]; }).filter(function (value) { return value !== undefined; });
      const firstScore = firstParents.length ? firstParents.reduce(function (sum, value) { return sum + value; }, 0) / firstParents.length : Infinity;
      const secondScore = secondParents.length ? secondParents.reduce(function (sum, value) { return sum + value; }, 0) / secondParents.length : Infinity;
      if (firstScore !== secondScore) return firstScore - secondScore;
      return comparePeople(first.sortPerson, second.sortPerson);
    });
    unitsByGeneration[generation].forEach(function (unit, index) { orderByRoot[unit._id] = index; });
  });
  const primaryParentByRoot = {};
  units.forEach(function (unit) {
    const candidates = (parentRoots[unit._id] || []).filter(function (parentRoot) {
      return unitsById[parentRoot] && unitsById[parentRoot].generation < unit.generation;
    }).sort(function (firstRoot, secondRoot) {
      const first = unitsById[firstRoot];
      const second = unitsById[secondRoot];
      return second.generation - first.generation || comparePeople(first.sortPerson, second.sortPerson);
    });
    if (candidates.length) primaryParentByRoot[unit._id] = candidates[0];
  });

  const primaryChildrenByRoot = {};
  units.forEach(function (unit) { primaryChildrenByRoot[unit._id] = []; });
  Object.keys(primaryParentByRoot).forEach(function (childRoot) {
    primaryChildrenByRoot[primaryParentByRoot[childRoot]].push(childRoot);
  });
  const familySourceByChildRoot = {};
  Object.keys(primaryParentByRoot).forEach(function (childRoot) {
    const parentRoot = primaryParentByRoot[childRoot];
    const members = unitsById[parentRoot].members;
    const memberOrder = {};
    members.forEach(function (member, index) { memberOrder[member._id] = index; });
    const parentIds = (parentIdsByChildRoot[childRoot] || []).filter(function (parentId) {
      return memberOrder[parentId] !== undefined;
    }).sort(function (firstId, secondId) {
      return memberOrder[firstId] - memberOrder[secondId] || firstId.localeCompare(secondId);
    });
    let pair = null;
    for (let firstIndex = 0; firstIndex < parentIds.length && !pair; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < parentIds.length; secondIndex += 1) {
        const key = pairKey(parentIds[firstIndex], parentIds[secondIndex]);
        if (spousePairs[key]) {
          pair = { key: key, order: (memberOrder[parentIds[firstIndex]] + memberOrder[parentIds[secondIndex]]) / 2 };
          break;
        }
      }
    }
    if (pair) {
      familySourceByChildRoot[childRoot] = { key: 'pair:' + pair.key, order: pair.order };
    } else if (parentIds.length) {
      familySourceByChildRoot[childRoot] = { key: 'single:' + parentIds[0], order: memberOrder[parentIds[0]] };
    } else {
      familySourceByChildRoot[childRoot] = { key: 'unknown:' + childRoot, order: members.length };
    }
  });
  Object.keys(primaryChildrenByRoot).forEach(function (root) {
    primaryChildrenByRoot[root].sort(function (firstRoot, secondRoot) {
      const firstSource = familySourceByChildRoot[firstRoot];
      const secondSource = familySourceByChildRoot[secondRoot];
      const firstSequence = unitsById[firstRoot].members.reduce(function (result, person) {
        const rank = childRanks[person._id];
        return rank && rank.childRankParentId && components.componentByPerson[rank.childRankParentId] === root
          ? Math.min(result, rank.childSequenceIndex)
          : result;
      }, Infinity);
      const secondSequence = unitsById[secondRoot].members.reduce(function (result, person) {
        const rank = childRanks[person._id];
        return rank && rank.childRankParentId && components.componentByPerson[rank.childRankParentId] === root
          ? Math.min(result, rank.childSequenceIndex)
          : result;
      }, Infinity);
      return firstSource.order - secondSource.order || firstSource.key.localeCompare(secondSource.key) ||
        firstSequence - secondSequence ||
        comparePeople(unitsById[firstRoot].sortPerson, unitsById[secondRoot].sortPerson);
    });
  });

  return {
    units: units,
    unitsById: unitsById,
    unitsByGeneration: unitsByGeneration,
    parentRoots: parentRoots,
    childrenByRoot: childrenByRoot,
    primaryParentByRoot: primaryParentByRoot,
    primaryChildrenByRoot: primaryChildrenByRoot,
    familySourceByChildRoot: familySourceByChildRoot,
    parentsByMember: parentsByMember
  };
}

// A spouse unit can have ancestors attached to EACH of its members. Reserve a
// port for each member's lineage, then align every parent unit with those ports.
// The primary tree is only the seed (and the sibling ordering), not ownership
// of a married couple by one of its ancestral families.
function positionAncestralFamilies(graph, metrics) {
  const levels = Object.keys(graph.unitsByGeneration).map(Number).sort(function (a, b) { return a - b; });
  const unitByPerson = {};
  graph.units.forEach(function (unit) {
    unit.members.forEach(function (member) { unitByPerson[member._id] = unit; });
  });
  function parentsOf(member) {
    return (graph.parentsByMember[member._id] || []).map(function (id) { return graph.unitsById[id]; })
      .filter(function (unit) { return unit.generation < unitByPerson[member._id].generation; })
      .sort(function (a, b) {
        const genderA = personGender(a.members[0]), genderB = personGender(b.members[0]);
        return (genderA === 'male' ? 0 : genderA === 'female' ? 1 : 2) -
          (genderB === 'male' ? 0 : genderB === 'female' ? 1 : 2) || a._id.localeCompare(b._id);
      });
  }
  const crossGenerationParentRoots = new Set();
  graph.units.forEach(function (parent) {
    const childGenerations = (graph.childrenByRoot[parent._id] || []).map(function (childRoot) {
      return graph.unitsById[childRoot].generation;
    });
    if (childGenerations.some(function (generation) { return generation > parent.generation + 1; }) ||
      childGenerations.some(function (generation) { return generation !== childGenerations[0]; })) {
      crossGenerationParentRoots.add(parent._id);
    }
  });
  const fullWidthParentRoots = new Set(crossGenerationParentRoots);
  const crossGenerationQueue = Array.from(crossGenerationParentRoots);
  for (let index = 0; index < crossGenerationQueue.length; index += 1) {
    (graph.childrenByRoot[crossGenerationQueue[index]] || []).forEach(function (childRoot) {
      if (fullWidthParentRoots.has(childRoot)) return;
      fullWidthParentRoots.add(childRoot);
      crossGenerationQueue.push(childRoot);
    });
  }
  levels.forEach(function (level) {
    graph.unitsByGeneration[level].forEach(function (unit) {
      // A single person's parents need space above that person, but that space
      // must not become the person's width. Otherwise every child inherits the
      // complete ancestral width and siblings are pushed to opposite edges.
      if (unit.members.length === 1) {
        unit.memberOffsets = {};
        unit.memberOffsets[unit.members[0]._id] = 0;
        unit.width = unit.baseWidth;
        return;
      }
      const ancestralMembers = unit.members.filter(function (member) { return parentsOf(member).length; });
      const needsLongConnectorClearance = unit.members.some(function (member) {
        return parentsOf(member).some(function (parent) { return fullWidthParentRoots.has(parent._id); });
      });
      if (ancestralMembers.length < 2 && !needsLongConnectorClearance) {
        unit.memberOffsets = {};
        unit.members.forEach(function (member, index) {
          unit.memberOffsets[member._id] = index * (metrics.nodeWidth + metrics.coupleGap);
        });
        unit.width = unit.baseWidth;
        return;
      }
      let cursor = 0;
      unit.memberOffsets = {};
      unit.members.forEach(function (member) {
        const parents = parentsOf(member);
        // Immediate parent cards may widen the gap inside this couple, but the
        // parents' own ancestry reservation normally stops at their row. When
        // the same ancestor is reached at different depths, keep the full span
        // so the long connector can be routed outside intermediate cards.
        const span = parents.reduce(function (sum, parent) {
          return sum + (fullWidthParentRoots.has(parent._id) ? parent.width : parent.baseWidth);
        }, 0) + Math.max(0, parents.length - 1) * metrics.unitGap;
        const width = Math.max(metrics.nodeWidth, span);
        unit.memberOffsets[member._id] = cursor + (width - metrics.nodeWidth) / 2;
        cursor += width + metrics.coupleGap;
      });
      unit.width = cursor - metrics.coupleGap;
    });
  });
  positionFamilySubtrees(graph, metrics);
  const mean = function (values) { return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length; };
  // Children are positioned before their ancestors. Sort whole sibling blocks
  // so the existing marriage grouping and child sequence remain contiguous.
  const targets = {};
  levels.slice().reverse().forEach(function (level) {
    const row = graph.unitsByGeneration[level];
    const blocks = {};
    row.forEach(function (unit) {
      const parentId = graph.primaryParentByRoot[unit._id];
      const key = parentId ? 'children:' + parentId : 'root:' + unit._id;
      if (!blocks[key]) blocks[key] = [];
      blocks[key].push(unit);
    });
    const blockKeys = Object.keys(blocks).sort(function (a, b) {
      function score(key) { return mean(blocks[key].map(function (unit) {
        return (targets[unit._id] ? mean(targets[unit._id]) : unit.x) + unit.width / 2;
      })); }
      return score(a) - score(b) || a.localeCompare(b);
    });
    row.length = 0;
    blockKeys.forEach(function (key) {
      const block = blocks[key], parentId = graph.primaryParentByRoot[block[0]._id];
      if (parentId) block.sort(function (a, b) {
        return graph.primaryChildrenByRoot[parentId].indexOf(a._id) - graph.primaryChildrenByRoot[parentId].indexOf(b._id);
      });
      block.forEach(function (unit) { row.push(unit); });
    });
    // Project desired positions onto non-overlapping ordered intervals.
    const desired = row.map(function (unit) { return targets[unit._id] ? mean(targets[unit._id]) : unit.x; });
    let right = -Infinity;
    row.forEach(function (unit, index) {
      unit.x = Math.max(desired[index], right);
      right = unit.x + unit.width + metrics.unitGap;
    });
    const shift = mean(row.map(function (unit, index) { return desired[index] - unit.x; }));
    row.forEach(function (unit) {
      unit.x += shift;
      unit.members.forEach(function (member) {
        const parents = parentsOf(member);
        const span = parents.reduce(function (sum, parent) { return sum + parent.width; }, 0) + Math.max(0, parents.length - 1) * metrics.unitGap;
        let left = unit.x + unit.memberOffsets[member._id] + metrics.nodeWidth / 2 - span / 2;
        parents.forEach(function (parent) {
          if (!targets[parent._id]) targets[parent._id] = [];
          targets[parent._id].push(left);
          left += parent.width + metrics.unitGap;
        });
      });
    });
  });
  const minX = Math.min.apply(null, graph.units.map(function (unit) { return unit.x; }));
  graph.units.forEach(function (unit) { unit.x += metrics.marginX - minX; });
  return Math.max(750, Math.max.apply(null, graph.units.map(function (unit) { return unit.x + unit.width; })) + metrics.marginX);
}

function positionFamilySubtrees(unitGraph, metrics) {
  const widths = {};

  function measure(root, visiting) {
    if (widths[root] !== undefined) return widths[root];
    if (visiting[root]) return unitGraph.unitsById[root].width;
    visiting[root] = true;
    const children = unitGraph.primaryChildrenByRoot[root] || [];
    const childrenWidth = children.reduce(function (sum, childRoot) {
      return sum + measure(childRoot, visiting);
    }, 0) + Math.max(0, children.length - 1) * metrics.unitGap;
    delete visiting[root];
    widths[root] = Math.max(unitGraph.unitsById[root].width, childrenWidth);
    return widths[root];
  }

  const roots = unitGraph.units.filter(function (unit) {
    return !unitGraph.primaryParentByRoot[unit._id];
  }).sort(function (first, second) {
    return comparePeople(first.sortPerson, second.sortPerson);
  });
  unitGraph.units.forEach(function (unit) { measure(unit._id, {}); });

  function place(root, left) {
    const unit = unitGraph.unitsById[root];
    const blockWidth = widths[root];
    unit.x = left + (blockWidth - unit.width) / 2;
    unit.subtreeWidth = blockWidth;
    const children = unitGraph.primaryChildrenByRoot[root] || [];
    if (!children.length) return;
    const childrenWidth = children.reduce(function (sum, childRoot) {
      return sum + widths[childRoot];
    }, 0) + Math.max(0, children.length - 1) * metrics.unitGap;
    let childLeft = left + (blockWidth - childrenWidth) / 2;
    children.forEach(function (childRoot) {
      place(childRoot, childLeft);
      childLeft += widths[childRoot] + metrics.unitGap;
    });
  }

  let rootLeft = metrics.marginX;
  roots.forEach(function (unit) {
    place(unit._id, rootLeft);
    rootLeft += widths[unit._id] + metrics.rootGap;
  });
  return Math.max(750, rootLeft - metrics.rootGap + metrics.marginX);
}

function createSegment(id, type, lineRole, x1, y1, x2, y2, options) {
  const optionsValue = options || {};
  const deltaX = x2 - x1;
  const deltaY = y2 - y1;
  const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  if (length < 1) return null;
  const angle = Math.atan2(deltaY, deltaX) * 180 / Math.PI;
  const overlap = optionsValue.overlap === false ? 0 : LINE_OVERLAP;
  const offsetX = deltaX / length * overlap / 2;
  const offsetY = deltaY / length * overlap / 2;
  return {
    _id: id,
    type: type,
    lineRole: lineRole,
    x1: x1,
    y1: y1,
    x2: x2,
    y2: y2,
    length: length,
    angle: angle,
    isFlow: Boolean(optionsValue.isFlow),
    isAnimatedFlow: Boolean(optionsValue.isAnimatedFlow),
    flowStep: typeof optionsValue.flowStep === 'number' ? optionsValue.flowStep : -1,
    flowRole: optionsValue.flowRole || '',
    familyKey: optionsValue.familyKey || '',
    relationIds: optionsValue.relationIds || [],
    railLane: typeof optionsValue.railLane === 'number' ? optionsValue.railLane : -1,
    style: 'left:' + (x1 - offsetX) + 'rpx;top:' + (y1 - offsetY) + 'rpx;width:' + (length + overlap) + 'rpx;transform:rotate(' + angle + 'deg);'
  };
}

function pairKey(firstId, secondId) {
  return firstId < secondId ? firstId + '|' + secondId : secondId + '|' + firstId;
}

function createSpouseConnections(nodesById, relations, selectedPersonId, metrics) {
  const lines = [];
  const junctions = [];
  const byPair = {};
  const spouseRelations = relations.filter(function (relation) { return relation.type === 'spouse'; });
  const spouseCounts = {};
  spouseRelations.forEach(function (relation) {
    spouseCounts[relation.fromPersonId] = (spouseCounts[relation.fromPersonId] || 0) + 1;
    spouseCounts[relation.toPersonId] = (spouseCounts[relation.toPersonId] || 0) + 1;
  });
  const nodesByRow = {};
  Object.keys(nodesById).forEach(function (id) {
    const node = nodesById[id];
    if (!nodesByRow[node.y]) nodesByRow[node.y] = [];
    nodesByRow[node.y].push(node);
  });
  Object.keys(nodesByRow).forEach(function (row) {
    nodesByRow[row].sort(function (first, second) { return first.x - second.x || first._id.localeCompare(second._id); });
  });

  const routes = spouseRelations.map(function (relation) {
    const first = nodesById[relation.fromPersonId];
    const second = nodesById[relation.toPersonId];
    if (!first || !second) return null;
    const left = first.x <= second.x ? first : second;
    const right = left === first ? second : first;
    const between = (nodesByRow[left.y] || []).filter(function (node) {
      return node._id !== left._id && node._id !== right._id &&
        node.x < right.x && node.x + metrics.nodeWidth > left.x + metrics.nodeWidth;
    });
    return { relation: relation, first: first, second: second, left: left, right: right, remote: between.length > 0 };
  }).filter(Boolean);

  const sidePorts = {};
  routes.forEach(function (route) {
    [route.left, route.right].forEach(function (node) {
      const direction = node === route.left ? 1 : -1;
      const key = node._id + ':' + direction;
      if (!sidePorts[key]) sidePorts[key] = [];
      sidePorts[key].push({ route: route, node: node, direction: direction });
    });
  });
  const maxSideCount = Math.max(1, ...Object.keys(sidePorts).map(function (key) { return sidePorts[key].length; }));
  const occupiedPorts = {};
  let maxPortLane = 0;
  routes.slice().sort(function (first, second) {
    return Number(first.remote) - Number(second.remote) || first.relation._id.localeCompare(second.relation._id);
  }).forEach(function (route) {
    const leftKey = route.left._id + ':1';
    const rightKey = route.right._id + ':-1';
    if (!occupiedPorts[leftKey]) occupiedPorts[leftKey] = new Set();
    if (!occupiedPorts[rightKey]) occupiedPorts[rightKey] = new Set();
    for (let lane = 0; lane < 2 * maxSideCount; lane += 1) {
      if (occupiedPorts[leftKey].has(lane) || occupiedPorts[rightKey].has(lane)) continue;
      occupiedPorts[leftKey].add(lane);
      occupiedPorts[rightKey].add(lane);
      route.portLane = lane;
      maxPortLane = Math.max(maxPortLane, lane);
      break;
    }
  });
  const portSpacing = Math.min(20, (metrics.nodeHeight - 36) / (2 * Math.ceil(maxPortLane / 2 || 1)));
  routes.forEach(function (route) {
    const lane = route.portLane;
    const offset = lane === 0 ? 0 : (lane % 2 ? -1 : 1) * Math.ceil(lane / 2) * portSpacing;
    route.portY = route.left.y + metrics.nodeHeight / 2 + offset;
  });
  routes.forEach(function (route) {
    const relation = route.relation;
    const key = pairKey(route.first._id, route.second._id);
    const familyKey = 'spouse:' + key;
    const relationIds = [relation._id];
    const startX = route.left.x + metrics.nodeWidth;
    const endX = route.right.x;
    const y = route.portY;
    // The card layer covers the middle of a remote couple's straight line.
    const line = createSegment('spouse-' + relation._id, 'spouse', 'spouse', startX, y, endX, y,
      { familyKey: familyKey, relationIds: relationIds });
    if (line) lines.push(line);
    let junctionX = (startX + endX) / 2;
    if (route.remote) {
      const hub = (spouseCounts[route.first._id] || 0) >= (spouseCounts[route.second._id] || 0) ? route.first : route.second;
      const remote = hub === route.left ? route.right : route.left;
      const row = nodesByRow[remote.y];
      const remoteIndex = row.findIndex(function (node) { return node._id === remote._id; });
      const neighbor = row[remoteIndex + (remote === route.left ? 1 : -1)];
      junctionX = remote === route.left
        ? (remote.x + metrics.nodeWidth + neighbor.x) / 2
        : (neighbor.x + metrics.nodeWidth + remote.x) / 2;
    } else {
      junctionX = (startX + endX) / 2;
    }
    const junction = {
      _id: 'junction-' + relation._id, x: junctionX, y: y,
      parentIds: [route.first._id, route.second._id],
      flowStarts: [[startX, y, junctionX, y], [endX, y, junctionX, y]],
      isActive: selectedPersonId === route.first._id || selectedPersonId === route.second._id
    };
    junction.style = 'left:' + (junction.x - JUNCTION_RADIUS) + 'rpx;top:' + (junction.y - JUNCTION_RADIUS) + 'rpx;';
    byPair[key] = junction;
    junctions.push(junction);
  });
  return { lines: lines, junctions: junctions, byPair: byPair };
}

function assignFamilyRailLanes(sourceGroups, nodesById, relations, metrics) {
  const spouseCounts = {};
  relations.forEach(function (relation) {
    if (relation.type !== 'spouse') return;
    spouseCounts[relation.fromPersonId] = (spouseCounts[relation.fromPersonId] || 0) + 1;
    spouseCounts[relation.toPersonId] = (spouseCounts[relation.toPersonId] || 0) + 1;
  });
  const groups = Object.keys(sourceGroups).map(function (groupKey) {
    const group = sourceGroups[groupKey];
    const childTop = group.children[0].y;
    const parentBottom = Math.max.apply(null, group.parentIds.map(function (parentId) {
      return nodesById[parentId].y + metrics.nodeHeight;
    }));
    const childCenters = group.children.map(function (child) { return group.childPorts[child._id]; });
    group.childTop = childTop;
    group.parentBottom = parentBottom;
    group.minX = Math.min.apply(null, childCenters.concat(group.source.x));
    group.maxX = Math.max.apply(null, childCenters.concat(group.source.x));
    group.rowKey = String(childTop);
    group.requiresDedicatedLane = group.parentIds.some(function (parentId) { return (spouseCounts[parentId] || 0) > 1; });
    return group;
  });
  const groupsByRow = {};
  groups.forEach(function (group) {
    if (!groupsByRow[group.rowKey]) groupsByRow[group.rowKey] = [];
    groupsByRow[group.rowKey].push(group);
  });

  const requiredShifts = [];
  Object.keys(groupsByRow).forEach(function (rowKey) {
    const rowGroups = groupsByRow[rowKey].sort(function (first, second) {
      return first.minX - second.minX || first.maxX - second.maxX || first._id.localeCompare(second._id);
    });
    const lanes = [];
    rowGroups.forEach(function (group) {
      let laneIndex = lanes.findIndex(function (lane) {
        return lane.every(function (other) {
          const intervalsOverlap = group.minX <= other.maxX + LINE_OVERLAP && other.minX <= group.maxX + LINE_OVERLAP;
          const sharedMultiSpouseParent = (group.requiresDedicatedLane || other.requiresDedicatedLane) &&
            group.parentIds.some(function (id) { return other.parentIds.indexOf(id) >= 0; });
          return !intervalsOverlap && !sharedMultiSpouseParent;
        });
      });
      if (laneIndex < 0) {
        laneIndex = lanes.length;
        lanes.push([]);
      }
      lanes[laneIndex].push(group);
      group.railLane = laneIndex;
    });

    // Reorder occupied lanes when it reduces vertical trunks or child drops
    // crossing another family's horizontal rail. Lane membership stays fixed.
    if (lanes.length > 1 && lanes.length <= 12 && rowGroups.length <= 48) {
      function insideRail(x, group) {
        return x > group.minX + CROSSING_RADIUS && x < group.maxX - CROSSING_RADIUS;
      }
      function crossingCost() {
        let count = 0;
        for (let upperIndex = 0; upperIndex < lanes.length; upperIndex += 1) {
          for (let lowerIndex = upperIndex + 1; lowerIndex < lanes.length; lowerIndex += 1) {
            lanes[upperIndex].forEach(function (upper) {
              lanes[lowerIndex].forEach(function (lower) {
                upper.children.forEach(function (child) {
                  if (insideRail(upper.childPorts[child._id], lower)) count += 1;
                });
                if (insideRail(lower.source.x, upper)) count += 1;
              });
            });
          }
        }
        return count;
      }
      let bestCost = crossingCost();
      for (let pass = 0; pass < lanes.length; pass += 1) {
        let improved = false;
        for (let index = 0; index < lanes.length - 1; index += 1) {
          const previous = lanes[index];
          lanes[index] = lanes[index + 1];
          lanes[index + 1] = previous;
          const cost = crossingCost();
          if (cost < bestCost) { bestCost = cost; improved = true; }
          else {
            lanes[index + 1] = lanes[index];
            lanes[index] = previous;
          }
        }
        if (!improved) break;
      }
      lanes.forEach(function (lane, index) {
        lane.forEach(function (group) { group.railLane = index; });
      });
    }

    const rowParentBottom = Math.max.apply(null, rowGroups.map(function (group) { return group.parentBottom; }));
    const childTop = rowGroups[0].childTop;
    const railUpperLimit = childTop;
    const available = railUpperLimit - rowParentBottom - FAMILY_RAIL_CLEARANCE * 2;
    const span = (lanes.length - 1) * FAMILY_RAIL_SPACING;
    if (available < span) requiredShifts.push({ childTop: childTop, extra: span - available });
    const firstRailY = rowParentBottom + FAMILY_RAIL_CLEARANCE + Math.max(0, available - span) / 2;
    rowGroups.forEach(function (group) {
      group.railY = firstRailY + group.railLane * FAMILY_RAIL_SPACING;
    });
  });
  return { groups: groups, requiredShifts: requiredShifts };
}

function createFamilyConnections(nodesById, relations, selectedPersonId, metrics) {
  const spouseConnections = createSpouseConnections(nodesById, relations, selectedPersonId, metrics);
  const lines = spouseConnections.lines;
  const junctions = spouseConnections.junctions;
  const spouseJunctions = spouseConnections.byPair;

  const parentsByChild = {};
  relations.forEach(function (relation) {
    if (relation.type !== 'parent_child' || !nodesById[relation.fromPersonId] || !nodesById[relation.toPersonId]) return;
    if (!parentsByChild[relation.toPersonId]) parentsByChild[relation.toPersonId] = [];
    parentsByChild[relation.toPersonId].push(relation);
  });

  const sourceGroups = {};
  Object.keys(parentsByChild).forEach(function (childId) {
    const childRelations = parentsByChild[childId];
    const parentIds = Array.from(new Set(childRelations.map(function (relation) { return relation.fromPersonId; })));
    let pairedParents = [];
    let pairedKey = '';
    for (let firstIndex = 0; firstIndex < parentIds.length && !pairedKey; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < parentIds.length; secondIndex += 1) {
        const key = pairKey(parentIds[firstIndex], parentIds[secondIndex]);
        if (spouseJunctions[key]) {
          pairedParents = [parentIds[firstIndex], parentIds[secondIndex]];
          pairedKey = key;
          break;
        }
      }
    }

    function addToGroup(key, source, ids) {
      const child = nodesById[childId];
      const rowKey = key + '@' + child.y;
      if (!sourceGroups[rowKey]) {
        sourceGroups[rowKey] = { _id: rowKey, source: source, parentIds: ids, children: [],
          childRelationIds: {}, childPorts: {} };
      }
      sourceGroups[rowKey].children.push(child);
      sourceGroups[rowKey].childRelationIds[childId] = childRelations.filter(function (relation) {
        return ids.indexOf(relation.fromPersonId) >= 0;
      }).map(function (relation) { return relation._id; });
    }

    if (pairedKey) {
      addToGroup('pair:' + pairedKey, spouseJunctions[pairedKey], pairedParents);
    }
    parentIds.forEach(function (parentId) {
      if (pairedParents.indexOf(parentId) >= 0) return;
      const parentNode = nodesById[parentId];
      addToGroup('single:' + parentId, {
        x: parentNode.x + metrics.nodeWidth / 2,
        y: parentNode.y + metrics.nodeHeight
      }, [parentId]);
    });
  });

  const childGroups = {};
  Object.keys(sourceGroups).forEach(function (groupKey) {
    const group = sourceGroups[groupKey];
    group.children.forEach(function (child) {
      if (!childGroups[child._id]) childGroups[child._id] = [];
      childGroups[child._id].push(group);
    });
  });
  Object.keys(childGroups).forEach(function (childId) {
    const groups = childGroups[childId].sort(function (first, second) { return first._id.localeCompare(second._id); });
    const child = nodesById[childId];
    const spacing = Math.min(12, (metrics.nodeWidth - 24) / Math.max(1, groups.length - 1));
    groups.forEach(function (group, index) {
      group.childPorts[childId] = child.x + metrics.nodeWidth / 2 + (index - (groups.length - 1) / 2) * spacing;
    });
  });

  const allocation = assignFamilyRailLanes(sourceGroups, nodesById, relations, metrics);
  const familyGroups = allocation.groups;
  familyGroups.forEach(function (group) {
    const groupKey = group._id;
    const source = group.source;
    const railY = group.railY;
    const relationIds = group.children.reduce(function (ids, child) {
      return ids.concat(group.childRelationIds[child._id] || []);
    }, []);
    let segment = createSegment('trunk-' + groupKey, 'parent', 'trunk', source.x, source.y, source.x, railY, {
      familyKey: groupKey,
      railLane: group.railLane,
      relationIds: relationIds
    });
    if (segment) lines.push(segment);
    segment = createSegment('rail-' + groupKey, 'parent', 'rail', group.minX, railY, group.maxX, railY, {
      familyKey: groupKey,
      railLane: group.railLane,
      relationIds: relationIds
    });
    if (segment) lines.push(segment);
    group.children.forEach(function (child) {
      const childX = group.childPorts[child._id];
      const drop = createSegment('drop-' + groupKey + '-' + child._id, 'parent', 'drop', childX, railY, childX, child.y, {
        familyKey: groupKey,
        railLane: group.railLane,
        relationIds: group.childRelationIds[child._id]
      });
      if (drop) lines.push(drop);
    });

    const activeChildren = group.children.filter(function (child) {
      return selectedPersonId && (selectedPersonId === child._id || group.parentIds.indexOf(selectedPersonId) >= 0);
    });
    if (activeChildren.length) {
      junctions.forEach(function (junction) {
        if (group.parentIds.every(function (id) { return junction.parentIds.indexOf(id) >= 0; })) junction.isActive = true;
      });
    }
    if (!activeChildren.length) return;
    const animatedChildren = activeChildren.slice().sort(function (first, second) {
      if (first._id === selectedPersonId) return -1;
      if (second._id === selectedPersonId) return 1;
      return first.x - second.x;
    }).slice(0, MAX_ANIMATED_CHILDREN);
    const animatedChildIds = {};
    animatedChildren.forEach(function (child) { animatedChildIds[child._id] = true; });
    const hasAnimatedPath = animatedChildren.length > 0;
    const hasParentIngress = source.flowStarts && source.flowStarts.length;
    if (hasParentIngress) {
      source.flowStarts.forEach(function (points, parentIndex) {
        const originFlow = createSegment(
          'flow-origin-' + selectedPersonId + '-' + groupKey + '-' + parentIndex,
          'parent',
          'spouse',
          points[0], points[1], points[2], points[3],
          {
            isFlow: true,
            isAnimatedFlow: hasAnimatedPath,
            flowStep: 0,
            flowRole: 'parent-origin',
            familyKey: groupKey,
            railLane: group.railLane
          }
        );
        if (originFlow) lines.push(originFlow);
      });
    }

    const trunkFlow = createSegment(
      'flow-trunk-' + selectedPersonId + '-' + groupKey,
      'parent',
      'trunk',
      source.x, source.y, source.x, railY,
      {
        isFlow: true,
        isAnimatedFlow: hasAnimatedPath,
        flowStep: hasParentIngress ? 1 : 0,
        flowRole: 'family-trunk',
        familyKey: groupKey,
        railLane: group.railLane
      }
    );
    if (trunkFlow) lines.push(trunkFlow);

    activeChildren.forEach(function (child) {
      const childX = group.childPorts[child._id];
      const path = [
        [source.x, railY, childX, railY],
        [childX, railY, childX, child.y]
      ];
      let nextFlowStep = hasParentIngress ? 2 : 1;
      path.forEach(function (points, segmentIndex) {
        const flow = createSegment(
          'flow-' + selectedPersonId + '-' + groupKey + '-' + child._id + '-' + segmentIndex,
          'parent',
          segmentIndex === 0 ? 'rail' : 'drop',
          points[0], points[1], points[2], points[3],
          {
            isFlow: true,
            isAnimatedFlow: Boolean(animatedChildIds[child._id]),
            flowStep: nextFlowStep,
            flowRole: segmentIndex === 0 ? 'child-rail' : 'child-drop',
            familyKey: groupKey,
            railLane: group.railLane
          }
        );
        if (flow) {
          lines.push(flow);
          nextFlowStep += 1;
        }
      });
    });
  });

  junctions.forEach(function (junction) {
    junction.style = 'left:' + (junction.x - JUNCTION_RADIUS) + 'rpx;top:' + (junction.y - JUNCTION_RADIUS) + 'rpx;';
  });
  return { lines: lines, junctions: junctions, requiredShifts: allocation.requiredShifts,
    requiredTopShift: 0 };
}

function findLineCrossings(lines) {
  const horizontal = lines.filter(function (line) { return !line.isFlow && Math.abs(line.y1 - line.y2) < 0.01; });
  const vertical = lines.filter(function (line) { return !line.isFlow && Math.abs(line.x1 - line.x2) < 0.01; });
  const seen = new Set();
  const crossings = [];
  horizontal.forEach(function (rail) {
    const minX = Math.min(rail.x1, rail.x2), maxX = Math.max(rail.x1, rail.x2);
    vertical.forEach(function (drop) {
      if (rail.familyKey === drop.familyKey) return;
      const minY = Math.min(drop.y1, drop.y2), maxY = Math.max(drop.y1, drop.y2);
      if (drop.x1 <= minX + CROSSING_RADIUS || drop.x1 >= maxX - CROSSING_RADIUS ||
        rail.y1 <= minY + CROSSING_RADIUS || rail.y1 >= maxY - CROSSING_RADIUS) return;
      const key = drop.x1.toFixed(2) + ':' + rail.y1.toFixed(2);
      if (seen.has(key)) return;
      seen.add(key);
      crossings.push({ _id: 'crossing-' + key, x: drop.x1, y: rail.y1,
        isSpouse: drop.lineRole === 'spouse',
        style: 'left:' + (drop.x1 - CROSSING_RADIUS) + 'rpx;top:' + (rail.y1 - CROSSING_RADIUS) + 'rpx;' });
    });
  });
  return crossings;
}

function layoutGraph(personsInput, relationsInput, options) {
  const optionsValue = options || {};
  const nameLayout = optionsValue.nameLayout === 'vertical' ? 'vertical' : 'horizontal';
  const metrics = Object.assign({}, metricsForNameLayout(nameLayout));
  if (optionsValue.mode === 'perspective') metrics.nodeHeight = nameLayout === 'vertical' ? 212 : 196;
  if (nameLayout === 'vertical' && optionsValue.mode === 'perspective') metrics.nodeWidth = 112;
  const activePersons = (personsInput || []).filter(function (person) { return person.status !== 'deleted'; }).slice().sort(function (a, b) { return a._id.localeCompare(b._id); });
  const personIds = new Set(activePersons.map(function (person) { return person._id; }));
  const active = activeRelations(relationsInput).filter(function (relation) {
    return personIds.has(relation.fromPersonId) && personIds.has(relation.toPersonId);
  }).slice().sort(function (a, b) {
    return a.type.localeCompare(b.type) || a.fromPersonId.localeCompare(b.fromPersonId) || a.toPersonId.localeCompare(b.toPersonId);
  });
  const childRanks = childRank.build(activePersons, active);
  const filtered = filterCollapsed(activePersons, active, optionsValue.collapsedIds || []);
  const persons = filtered.persons;
  const relations = filtered.relations;
  // Compute the complete layout before hiding branches so collapsing one side
  // cannot reverse the ordering of the other side's ancestors.
  const components = createSpouseComponents(activePersons, active);
  const generations = assignGenerations(activePersons, active, components);
  const unitGraph = buildUnits(activePersons, active, components, generations, metrics, childRanks.byPerson);
  const unitsByGeneration = unitGraph.unitsByGeneration;
  const generationKeys = Object.keys(unitsByGeneration).map(Number).sort(function (a, b) { return a - b; });
  const maxGeneration = generationKeys.length ? Math.max.apply(null, generationKeys) : 0;

  const hasMultipleLineages = unitGraph.units.some(function (unit) { return (unitGraph.parentRoots[unit._id] || []).length > 1; });
  let canvasWidth = hasMultipleLineages ? positionAncestralFamilies(unitGraph, metrics) : positionFamilySubtrees(unitGraph, metrics);
  let canvasHeight = Math.max(900, maxGeneration * metrics.gapY + metrics.nodeHeight + metrics.marginY * 2);
  const nodesById = {};
  const nodes = [];
  const visibleIds = new Set(persons.map(function (person) { return person._id; }));
  const kinshipDetails = optionsValue.mode === 'perspective'
    ? (optionsValue.kinshipDetails || kinship.calculateKinshipDetails(activePersons, active, optionsValue.viewpointId))
    : {};
  const kinships = {};
  Object.keys(kinshipDetails).forEach(function (id) { kinships[id] = kinshipDetails[id].label; });

  generationKeys.forEach(function (generation) {
    unitsByGeneration[generation].forEach(function (unit) {
      unit.members.forEach(function (person, memberIndex) {
        if (!visibleIds.has(person._id)) return;
        const x = unit.x + (unit.memberOffsets ? unit.memberOffsets[person._id] : memberIndex * (metrics.nodeWidth + metrics.coupleGap));
        const y = metrics.marginY + generation * metrics.gapY;
        const node = Object.assign({}, personGenderDisplay.decorate(person), childRanks.byPerson[person._id] || {}, {
          x: x,
          y: y,
          style: 'left:' + x + 'rpx;top:' + y + 'rpx;width:' + metrics.nodeWidth + 'rpx;height:' + metrics.nodeHeight + 'rpx;',
          verticalName: verticalDisplayName(person.name),
          relationLabel: kinships[person._id] || '',
          hasMultipleKinships: !!(kinshipDetails[person._id] && kinshipDetails[person._id].multiple),
          familySize: unit.members.length,
          hiddenDescendantCount: filtered.hiddenByCollapsed[person._id] || 0,
          isViewpoint: person._id === optionsValue.viewpointId,
          isSelected: person._id === optionsValue.selectedPersonId
        });
        nodesById[person._id] = node;
        nodes.push(node);
      });
    });
  });

  if (filtered.hiddenCount && nodes.length) {
    // Remove empty bands left by hidden subtrees without changing the relative
    // order established using the complete family. Fit-to-tree stays useful.
    function compactAxis(axis, minimum, maximumGap) {
      const values = Array.from(new Set(nodes.map(function (node) { return node[axis]; }))).sort(function (a, b) { return a - b; });
      const positions = {};
      let position = minimum;
      values.forEach(function (value, index) {
        if (index) position += Math.min(value - values[index - 1], maximumGap);
        positions[value] = position;
      });
      nodes.forEach(function (node) { node[axis] = positions[node[axis]]; });
    }
    compactAxis('x', metrics.marginX, metrics.nodeWidth + Math.max(metrics.unitGap, metrics.coupleGap));
    compactAxis('y', metrics.marginY, metrics.gapY);
    nodes.forEach(function (node) {
      node.style = 'left:' + node.x + 'rpx;top:' + node.y + 'rpx;width:' + metrics.nodeWidth + 'rpx;height:' + metrics.nodeHeight + 'rpx;';
    });
    canvasWidth = Math.max(750, Math.max.apply(null, nodes.map(function (node) { return node.x; })) + metrics.nodeWidth + metrics.marginX);
    canvasHeight = Math.max(900, Math.max.apply(null, nodes.map(function (node) { return node.y; })) + metrics.nodeHeight + metrics.marginY);
  }
  let connections = createFamilyConnections(nodesById, relations, optionsValue.selectedPersonId || '', metrics);
  const shiftsByRow = {};
  connections.requiredShifts.forEach(function (shift) {
    shiftsByRow[shift.childTop] = Math.max(shiftsByRow[shift.childTop] || 0, shift.extra);
  });
  const rowShifts = Object.keys(shiftsByRow).map(Number).sort(function (a, b) { return a - b; });
  const topShift = connections.requiredTopShift;
  if (rowShifts.length || topShift) {
    nodes.forEach(function (node) {
      const extra = rowShifts.reduce(function (sum, row) { return sum + (node.y >= row ? shiftsByRow[row] : 0); }, topShift);
      node.y += extra;
      node.style = 'left:' + node.x + 'rpx;top:' + node.y + 'rpx;width:' + metrics.nodeWidth + 'rpx;height:' + metrics.nodeHeight + 'rpx;';
    });
    canvasHeight += topShift + rowShifts.reduce(function (sum, row) { return sum + shiftsByRow[row]; }, 0);
    connections = createFamilyConnections(nodesById, relations, optionsValue.selectedPersonId || '', metrics);
  }
  const crossings = findLineCrossings(connections.lines);
  return {
    nodes: nodes,
    lines: connections.lines,
    junctions: connections.junctions,
    crossings: crossings,
    nameLayout: nameLayout,
    nodeWidth: metrics.nodeWidth,
    nodeHeight: metrics.nodeHeight,
    width: Math.ceil(canvasWidth),
    height: Math.ceil(canvasHeight),
    kinships: kinships,
    kinshipDetails: kinshipDetails,
    hiddenCount: filtered.hiddenCount
  };
}

function suggestCollapsedIds(personsInput, relationsInput, options) {
  const optionsValue = options || {};
  const limit = optionsValue.limit || 36;
  const activePersons = (personsInput || []).filter(function (person) { return person.status !== 'deleted'; });
  const relations = activeRelations(relationsInput);
  if (activePersons.length <= limit) return [];
  const components = createSpouseComponents(activePersons, relations);
  const generations = assignGenerations(activePersons, relations, components);
  const childParents = {};
  const children = {};
  activePersons.forEach(function (person) { children[person._id] = []; });
  relations.forEach(function (relation) {
    if (relation.type !== 'parent_child' || !children[relation.fromPersonId]) return;
    children[relation.fromPersonId].push(relation.toPersonId);
    if (!childParents[relation.toPersonId]) childParents[relation.toPersonId] = [];
    childParents[relation.toPersonId].push(relation.fromPersonId);
  });

  const protectedIds = {};
  if (optionsValue.focusId) {
    const queue = [optionsValue.focusId];
    protectedIds[optionsValue.focusId] = true;
    for (let index = 0; index < queue.length; index += 1) {
      (childParents[queue[index]] || []).forEach(function (parentId) {
        if (protectedIds[parentId]) return;
        protectedIds[parentId] = true;
        queue.push(parentId);
      });
    }
  }
  const protectedComponents = {};
  Object.keys(protectedIds).forEach(function (personId) {
    const root = components.componentByPerson[personId];
    if (root) protectedComponents[root] = true;
  });

  const candidateByComponent = {};
  activePersons.forEach(function (person) {
    if (!children[person._id].length || protectedIds[person._id]) return;
    const root = components.componentByPerson[person._id];
    if (protectedComponents[root]) return;
    if (!candidateByComponent[root]) candidateByComponent[root] = person;
  });
  const allCandidates = Object.keys(candidateByComponent).map(function (root) {
    return candidateByComponent[root];
  }).sort(function (first, second) {
    return (generations[first._id] || 0) - (generations[second._id] || 0) || comparePeople(first, second);
  });
  const candidates = allCandidates.filter(function (person) {
    return (generations[person._id] || 0) >= 2;
  }).concat(allCandidates.filter(function (person) {
    return (generations[person._id] || 0) < 2;
  }).sort(function (first, second) {
    return (generations[second._id] || 0) - (generations[first._id] || 0) || comparePeople(first, second);
  }));

  const collapsed = [];
  let visibleCount = activePersons.length;
  candidates.forEach(function (person) {
    if (visibleCount <= limit) return;
    const before = filterCollapsed(activePersons, relations, collapsed).hiddenCount;
    const next = collapsed.concat(person._id);
    const after = filterCollapsed(activePersons, relations, next).hiddenCount;
    if (after > before) {
      collapsed.push(person._id);
      visibleCount = activePersons.length - after;
    }
  });
  return collapsed;
}

function expandCollapsedIds(persons, relations, collapsedIds, targetPersonId) {
  return (collapsedIds || []).filter(function (collapsedId) {
    const result = filterCollapsed(persons || [], activeRelations(relations), [collapsedId]);
    return result.persons.some(function (person) { return person._id === targetPersonId; });
  });
}

module.exports = {
  layoutGraph: layoutGraph,
  calculateKinships: kinship.calculateKinships,
  filterCollapsed: filterCollapsed,
  groupPersonsByGeneration: groupPersonsByGeneration,
  sortPersonsByName: sortPersonsByName,
  suggestCollapsedIds: suggestCollapsedIds,
  expandCollapsedIds: expandCollapsedIds
};
