const NODE_WIDTH = 168;
const NODE_HEIGHT = 116;
const COUPLE_GAP = 76;
const UNIT_GAP = 72;
const ROOT_GAP = 144;
const GAP_Y = 232;
const MARGIN_X = 80;
const MARGIN_Y = 80;
const MAX_KINSHIP_DEPTH = 8;
const JUNCTION_RADIUS = 7;
const LINE_OVERLAP = 2;
const MAX_ANIMATED_CHILDREN = 12;

function personGender(person) {
  return person && person.gender ? person.gender : 'unknown';
}

function comparePeople(a, b) {
  const dateA = a.birthDate || '9999-99-99';
  const dateB = b.birthDate || '9999-99-99';
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
  persons.forEach(function (person) {
    result[person._id] = generationsByRoot[components.componentByPerson[person._id]] || 0;
  });
  return result;
}

function directStep(currentId, nextId, relation, peopleById) {
  const nextPerson = peopleById[nextId];
  if (relation.type === 'spouse') {
    const gender = personGender(nextPerson);
    return {
      kind: 'spouse',
      label: gender === 'male' ? '丈夫' : gender === 'female' ? '妻子' : '配偶'
    };
  }

  if (relation.type === 'parent_child' && relation.toPersonId === currentId) {
    const gender = personGender(nextPerson);
    return {
      kind: 'up',
      label: gender === 'male' ? '父亲' : gender === 'female' ? '母亲' : '父母'
    };
  }

  const gender = personGender(nextPerson);
  return {
    kind: 'down',
    label: gender === 'male' ? '儿子' : gender === 'female' ? '女儿' : '子女'
  };
}

function buildAdjacency(persons, relations) {
  const peopleById = {};
  const adjacency = {};
  persons.forEach(function (person) {
    peopleById[person._id] = person;
    adjacency[person._id] = [];
  });

  relations.forEach(function (relation) {
    if (!adjacency[relation.fromPersonId] || !adjacency[relation.toPersonId]) return;
    adjacency[relation.fromPersonId].push({ id: relation.toPersonId, relation: relation });
    adjacency[relation.toPersonId].push({ id: relation.fromPersonId, relation: relation });
  });
  return { adjacency: adjacency, peopleById: peopleById };
}

function ageOrder(reference, target) {
  if (!reference || !target || !reference.birthDate || !target.birthDate) return '';
  if (reference.birthDate === target.birthDate) return '';
  return target.birthDate < reference.birthDate ? 'older' : 'younger';
}

function siblingLabel(reference, target, prefix) {
  const order = ageOrder(reference, target);
  const gender = personGender(target);
  const stem = prefix || '';
  if (gender === 'male') {
    if (order === 'older') return stem ? stem + '哥' : '哥哥';
    if (order === 'younger') return stem ? stem + '弟' : '弟弟';
    return stem + '兄弟';
  }
  if (gender === 'female') {
    if (order === 'older') return stem ? stem + '姐' : '姐姐';
    if (order === 'younger') return stem ? stem + '妹' : '妹妹';
    return stem + '姐妹';
  }
  return stem ? stem + '亲' : '手足';
}

function parentSiblingLabel(parent, target) {
  const targetGender = personGender(target);
  if (personGender(parent) === 'male') {
    if (targetGender === 'female') return '姑妈';
    const order = ageOrder(parent, target);
    if (order === 'older') return '伯父';
    if (order === 'younger') return '叔叔';
    return '伯叔';
  }
  if (personGender(parent) === 'female') {
    if (targetGender === 'male') return '舅舅';
    if (targetGender === 'female') return '姨妈';
  }
  return targetGender === 'male' ? '父母的兄弟' : targetGender === 'female' ? '父母的姐妹' : '父母的手足';
}

function parentSiblingSpouseLabel(parent, parentSibling) {
  if (personGender(parent) === 'male') {
    if (personGender(parentSibling) === 'female') return '姑父';
    const order = ageOrder(parent, parentSibling);
    if (order === 'older') return '伯母';
    if (order === 'younger') return '婶婶';
    return '伯叔母';
  }
  if (personGender(parent) === 'female') {
    if (personGender(parentSibling) === 'male') return '舅妈';
    if (personGender(parentSibling) === 'female') return '姨父';
  }
  return '父母手足的配偶';
}

function siblingSpouseLabel(viewpoint, sibling) {
  const order = ageOrder(viewpoint, sibling);
  if (personGender(sibling) === 'male') {
    if (order === 'older') return '嫂子';
    if (order === 'younger') return '弟媳';
    return '兄弟的妻子';
  }
  if (personGender(sibling) === 'female') {
    if (order === 'older') return '姐夫';
    if (order === 'younger') return '妹夫';
    return '姐妹的丈夫';
  }
  return '手足的配偶';
}

function specializedKinship(path, peopleById) {
  const steps = path.steps;
  const ids = path.ids;
  const kinds = steps.map(function (step) { return step.kind; }).join('-');
  const viewpoint = peopleById[ids[0]];
  const target = peopleById[ids[ids.length - 1]];
  const targetGender = personGender(target);
  if (steps.length === 1) return steps[0].label;

  if (kinds === 'up-up') {
    const parent = peopleById[ids[1]];
    if (personGender(parent) === 'female') {
      return targetGender === 'male' ? '外公' : targetGender === 'female' ? '外婆' : '外祖父母';
    }
    return targetGender === 'male' ? '爷爷' : targetGender === 'female' ? '奶奶' : '祖父母';
  }
  if (kinds === 'up-down') return siblingLabel(viewpoint, target, '');
  if (kinds === 'down-down') {
    const child = peopleById[ids[1]];
    if (personGender(child) === 'female') {
      return targetGender === 'male' ? '外孙' : targetGender === 'female' ? '外孙女' : '外孙辈';
    }
    return targetGender === 'male' ? '孙子' : targetGender === 'female' ? '孙女' : '孙辈';
  }
  if (kinds === 'down-spouse') {
    const child = peopleById[ids[1]];
    return personGender(child) === 'male' ? '儿媳' : personGender(child) === 'female' ? '女婿' : '子女配偶';
  }
  if (kinds === 'spouse-up') {
    const spouse = peopleById[ids[1]];
    if (personGender(spouse) === 'female') {
      return targetGender === 'male' ? '岳父' : targetGender === 'female' ? '岳母' : '岳父母';
    }
    if (personGender(spouse) === 'male') {
      return targetGender === 'male' ? '公公' : targetGender === 'female' ? '婆婆' : '公婆';
    }
  }
  if (kinds === 'up-up-down') return parentSiblingLabel(peopleById[ids[1]], target);
  if (kinds === 'up-down-down') {
    const sibling = peopleById[ids[2]];
    if (personGender(sibling) === 'male') {
      return targetGender === 'male' ? '侄子' : targetGender === 'female' ? '侄女' : '侄辈';
    }
    return targetGender === 'male' ? '外甥' : targetGender === 'female' ? '外甥女' : '外甥辈';
  }
  if (kinds === 'up-down-spouse') return siblingSpouseLabel(viewpoint, peopleById[ids[2]]);
  if (kinds === 'down-spouse-up') {
    return targetGender === 'male' ? '亲家公' : targetGender === 'female' ? '亲家母' : '亲家';
  }
  if (kinds === 'down-down-spouse') {
    const child = peopleById[ids[1]];
    const grandchild = peopleById[ids[2]];
    const outside = personGender(child) === 'female' ? '外' : '';
    return personGender(grandchild) === 'male' ? outside + '孙媳' : outside + '孙女婿';
  }
  if (kinds === 'down-down-down') {
    const outside = personGender(peopleById[ids[1]]) === 'female' ? '外' : '';
    return targetGender === 'male' ? outside + '曾孙' : targetGender === 'female' ? outside + '曾孙女' : outside + '曾孙辈';
  }
  if (kinds === 'up-up-up') {
    const outside = personGender(peopleById[ids[1]]) === 'female' || personGender(peopleById[ids[2]]) === 'female';
    return targetGender === 'male' ? (outside ? '外曾祖父' : '曾祖父') : targetGender === 'female' ? (outside ? '外曾祖母' : '曾祖母') : '曾祖辈';
  }
  if (kinds === 'up-up-down-down') {
    const parent = peopleById[ids[1]];
    const parentSibling = peopleById[ids[3]];
    const prefix = personGender(parent) === 'male' && personGender(parentSibling) === 'male' ? '堂' : '表';
    return siblingLabel(viewpoint, target, prefix);
  }
  if (kinds === 'up-up-down-spouse') {
    return parentSiblingSpouseLabel(peopleById[ids[1]], peopleById[ids[3]]);
  }

  return steps.map(function (step) { return step.label; }).join('的');
}

function calculateKinships(persons, relations, viewpointId) {
  const result = {};
  if (!viewpointId) return result;
  const graph = buildAdjacency(persons, relations);
  if (!graph.peopleById[viewpointId]) return result;

  const queue = [{ id: viewpointId, ids: [viewpointId], steps: [] }];
  const distances = {};
  const candidates = {};
  distances[viewpointId] = 0;
  candidates[viewpointId] = [[]];
  result[viewpointId] = '当前成员';

  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (current.steps.length >= MAX_KINSHIP_DEPTH) continue;

    (graph.adjacency[current.id] || []).forEach(function (edge) {
      if (current.ids.indexOf(edge.id) >= 0) return;
      const nextDepth = current.steps.length + 1;
      if (distances[edge.id] !== undefined && distances[edge.id] < nextDepth) return;
      const step = directStep(current.id, edge.id, edge.relation, graph.peopleById);
      const nextPath = {
        id: edge.id,
        ids: current.ids.concat(edge.id),
        steps: current.steps.concat(step)
      };
      if (distances[edge.id] === undefined) {
        distances[edge.id] = nextDepth;
        candidates[edge.id] = [];
      }
      const signature = nextPath.ids.join('>');
      if (candidates[edge.id].some(function (item) { return item.signature === signature; })) return;
      if (candidates[edge.id].length >= 3) return;
      candidates[edge.id].push({ signature: signature, path: nextPath });
      queue.push(nextPath);
    });
  }

  Object.keys(candidates).forEach(function (personId) {
    if (personId === viewpointId) return;
    const labels = [];
    candidates[personId].forEach(function (candidate) {
      const label = specializedKinship(candidate.path, graph.peopleById);
      if (labels.indexOf(label) < 0) labels.push(label);
    });
    result[personId] = labels.length === 1 ? labels[0] : '多重亲属关系';
  });

  const connected = {};
  const connectedQueue = [viewpointId];
  connected[viewpointId] = true;
  for (let index = 0; index < connectedQueue.length; index += 1) {
    (graph.adjacency[connectedQueue[index]] || []).forEach(function (edge) {
      if (connected[edge.id]) return;
      connected[edge.id] = true;
      connectedQueue.push(edge.id);
    });
  }
  Object.keys(connected).forEach(function (personId) {
    if (!result[personId]) result[personId] = '远亲';
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

function buildUnits(persons, relations, components, generations) {
  const units = [];
  const unitsById = {};
  Object.keys(components.membersByRoot).forEach(function (root) {
    const members = orderSpouseMembers(components.membersByRoot[root], relations);
    const unit = {
      _id: root,
      generation: generations[members[0]._id] || 0,
      members: members,
      width: members.length * NODE_WIDTH + Math.max(0, members.length - 1) * COUPLE_GAP,
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
  units.forEach(function (unit) { childrenByRoot[unit._id] = []; });
  relations.forEach(function (relation) {
    if (relation.type !== 'parent_child') return;
    const childRoot = components.componentByPerson[relation.toPersonId];
    const parentRoot = components.componentByPerson[relation.fromPersonId];
    if (!childRoot || !parentRoot || childRoot === parentRoot) return;
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
  Object.keys(primaryChildrenByRoot).forEach(function (root) {
    primaryChildrenByRoot[root].sort(function (firstRoot, secondRoot) {
      return comparePeople(unitsById[firstRoot].sortPerson, unitsById[secondRoot].sortPerson);
    });
  });

  return {
    units: units,
    unitsById: unitsById,
    unitsByGeneration: unitsByGeneration,
    parentRoots: parentRoots,
    childrenByRoot: childrenByRoot,
    primaryParentByRoot: primaryParentByRoot,
    primaryChildrenByRoot: primaryChildrenByRoot
  };
}

function positionFamilySubtrees(unitGraph) {
  const widths = {};

  function measure(root, visiting) {
    if (widths[root] !== undefined) return widths[root];
    if (visiting[root]) return unitGraph.unitsById[root].width;
    visiting[root] = true;
    const children = unitGraph.primaryChildrenByRoot[root] || [];
    const childrenWidth = children.reduce(function (sum, childRoot) {
      return sum + measure(childRoot, visiting);
    }, 0) + Math.max(0, children.length - 1) * UNIT_GAP;
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
    }, 0) + Math.max(0, children.length - 1) * UNIT_GAP;
    let childLeft = left + (blockWidth - childrenWidth) / 2;
    children.forEach(function (childRoot) {
      place(childRoot, childLeft);
      childLeft += widths[childRoot] + UNIT_GAP;
    });
  }

  let rootLeft = MARGIN_X;
  roots.forEach(function (unit) {
    place(unit._id, rootLeft);
    rootLeft += widths[unit._id] + ROOT_GAP;
  });
  return Math.max(750, rootLeft - ROOT_GAP + MARGIN_X);
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
    isFlow: Boolean(optionsValue.isFlow),
    isAnimatedFlow: Boolean(optionsValue.isAnimatedFlow),
    flowStep: typeof optionsValue.flowStep === 'number' ? optionsValue.flowStep : -1,
    flowRole: optionsValue.flowRole || '',
    style: 'left:' + (x1 - offsetX) + 'rpx;top:' + (y1 - offsetY) + 'rpx;width:' + (length + overlap) + 'rpx;transform:rotate(' + angle + 'deg);'
  };
}

function pairKey(firstId, secondId) {
  return firstId < secondId ? firstId + '|' + secondId : secondId + '|' + firstId;
}

function createFamilyConnections(nodesById, relations, selectedPersonId) {
  const lines = [];
  const junctions = [];
  const spouseJunctions = {};
  const spouseRelations = relations.filter(function (relation) { return relation.type === 'spouse'; });

  spouseRelations.forEach(function (relation) {
    const first = nodesById[relation.fromPersonId];
    const second = nodesById[relation.toPersonId];
    if (!first || !second) return;
    const left = first.x <= second.x ? first : second;
    const right = left === first ? second : first;
    const startX = left.x + NODE_WIDTH;
    const endX = right.x;
    const y = left.y + NODE_HEIGHT / 2;
    const key = pairKey(first._id, second._id);
    const junction = {
      _id: 'junction-' + relation._id,
      x: (startX + endX) / 2,
      y: y,
      parentIds: [first._id, second._id],
      flowStarts: [
        [startX, y, (startX + endX) / 2, y],
        [endX, y, (startX + endX) / 2, y]
      ],
      isActive: selectedPersonId === first._id || selectedPersonId === second._id
    };
    junction.style = 'left:' + (junction.x - JUNCTION_RADIUS) + 'rpx;top:' + (junction.y - JUNCTION_RADIUS) + 'rpx;';
    spouseJunctions[key] = junction;
    const spouseLine = createSegment('spouse-' + relation._id, 'spouse', 'spouse', startX, y, endX, y);
    if (spouseLine) lines.push(spouseLine);
    junctions.push(junction);
  });

  const parentsByChild = {};
  relations.forEach(function (relation) {
    if (relation.type !== 'parent_child' || !nodesById[relation.fromPersonId] || !nodesById[relation.toPersonId]) return;
    if (!parentsByChild[relation.toPersonId]) parentsByChild[relation.toPersonId] = [];
    parentsByChild[relation.toPersonId].push(relation.fromPersonId);
  });

  const sourceGroups = {};
  Object.keys(parentsByChild).forEach(function (childId) {
    const parentIds = parentsByChild[childId];
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
        sourceGroups[rowKey] = { _id: rowKey, source: source, parentIds: ids, children: [] };
      }
      sourceGroups[rowKey].children.push(child);
    }

    if (pairedKey) {
      addToGroup('pair:' + pairedKey, spouseJunctions[pairedKey], pairedParents);
    }
    parentIds.forEach(function (parentId) {
      if (pairedParents.indexOf(parentId) >= 0) return;
      const parentNode = nodesById[parentId];
      addToGroup('single:' + parentId, {
        x: parentNode.x + NODE_WIDTH / 2,
        y: parentNode.y + NODE_HEIGHT
      }, [parentId]);
    });
  });

  Object.keys(sourceGroups).forEach(function (groupKey) {
    const group = sourceGroups[groupKey];
    const source = group.source;
    const childTop = group.children[0].y;
    const parentBottom = Math.max.apply(null, group.parentIds.map(function (parentId) {
      return nodesById[parentId].y + NODE_HEIGHT;
    }));
    const railY = Math.min(childTop - 40, parentBottom + Math.max(40, (childTop - parentBottom) * 0.44));
    const childCenters = group.children.map(function (child) { return child.x + NODE_WIDTH / 2; });
    const minX = Math.min.apply(null, childCenters.concat(source.x));
    const maxX = Math.max.apply(null, childCenters.concat(source.x));
    let segment = createSegment('trunk-' + groupKey, 'parent', 'trunk', source.x, source.y, source.x, railY);
    if (segment) lines.push(segment);
    segment = createSegment('rail-' + groupKey, 'parent', 'rail', minX, railY, maxX, railY);
    if (segment) lines.push(segment);
    group.children.forEach(function (child) {
      const childX = child.x + NODE_WIDTH / 2;
      const drop = createSegment('drop-' + groupKey + '-' + child._id, 'parent', 'drop', childX, railY, childX, child.y);
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
            flowRole: 'parent-origin'
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
        flowRole: 'family-trunk'
      }
    );
    if (trunkFlow) lines.push(trunkFlow);

    activeChildren.forEach(function (child) {
      const childX = child.x + NODE_WIDTH / 2;
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
            flowRole: segmentIndex === 0 ? 'child-rail' : 'child-drop'
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
  return { lines: lines, junctions: junctions };
}

function layoutGraph(personsInput, relationsInput, options) {
  const optionsValue = options || {};
  const activePersons = (personsInput || []).filter(function (person) { return person.status !== 'deleted'; });
  const active = activeRelations(relationsInput);
  const filtered = filterCollapsed(activePersons, active, optionsValue.collapsedIds || []);
  const persons = filtered.persons;
  const relations = filtered.relations;
  const components = createSpouseComponents(persons, relations);
  const generations = assignGenerations(persons, relations, components);
  const unitGraph = buildUnits(persons, relations, components, generations);
  const unitsByGeneration = unitGraph.unitsByGeneration;
  const generationKeys = Object.keys(unitsByGeneration).map(Number).sort(function (a, b) { return a - b; });
  const maxGeneration = generationKeys.length ? Math.max.apply(null, generationKeys) : 0;

  let canvasWidth = positionFamilySubtrees(unitGraph);
  let canvasHeight = Math.max(900, maxGeneration * GAP_Y + NODE_HEIGHT + MARGIN_Y * 2);
  const nodesById = {};
  const nodes = [];
  const kinships = optionsValue.mode === 'perspective'
    ? calculateKinships(persons, relations, optionsValue.viewpointId)
    : {};

  generationKeys.forEach(function (generation) {
    unitsByGeneration[generation].forEach(function (unit) {
      unit.members.forEach(function (person, memberIndex) {
        const x = unit.x + memberIndex * (NODE_WIDTH + COUPLE_GAP);
        const y = MARGIN_Y + generation * GAP_Y;
        const node = Object.assign({}, person, {
          x: x,
          y: y,
          style: 'left:' + x + 'rpx;top:' + y + 'rpx;',
          relationLabel: kinships[person._id] || '',
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

  const connections = createFamilyConnections(nodesById, relations, optionsValue.selectedPersonId || '');
  return {
    nodes: nodes,
    lines: connections.lines,
    junctions: connections.junctions,
    width: Math.ceil(canvasWidth),
    height: Math.ceil(canvasHeight),
    kinships: kinships,
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
  calculateKinships: calculateKinships,
  filterCollapsed: filterCollapsed,
  groupPersonsByGeneration: groupPersonsByGeneration,
  sortPersonsByName: sortPersonsByName,
  suggestCollapsedIds: suggestCollapsedIds,
  expandCollapsedIds: expandCollapsedIds
};
