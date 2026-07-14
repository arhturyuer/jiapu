const NODE_WIDTH = 168;
const NODE_HEIGHT = 116;
const GAP_X = 210;
const GAP_Y = 190;
const MARGIN_X = 80;
const MARGIN_Y = 80;

function personGender(person) {
  return person && person.gender ? person.gender : 'unknown';
}

function comparePeople(a, b) {
  const dateA = a.birthDate || '9999-99-99';
  const dateB = b.birthDate || '9999-99-99';
  if (dateA !== dateB) return dateA.localeCompare(dateB);
  return (a.name || '').localeCompare(b.name || '', 'zh-CN');
}

function activeRelations(relations) {
  return (relations || []).filter(function (relation) {
    return relation.status !== 'deleted';
  });
}

function filterCollapsed(persons, relations, collapsedIds) {
  const collapsed = new Set(collapsedIds || []);
  if (!collapsed.size) return { persons: persons, relations: relations, hiddenCount: 0 };
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
  const queue = [];
  collapsed.forEach(function (personId) {
    (children[personId] || []).forEach(function (childId) { queue.push(childId); });
  });
  while (queue.length) {
    const current = queue.shift();
    if (hidden.has(current) || collapsed.has(current)) continue;
    hidden.add(current);
    (children[current] || []).forEach(function (childId) { queue.push(childId); });
    (spouses[current] || []).forEach(function (spouseId) { queue.push(spouseId); });
  }
  return {
    persons: persons.filter(function (person) { return !hidden.has(person._id); }),
    relations: relations.filter(function (relation) {
      return !hidden.has(relation.fromPersonId) && !hidden.has(relation.toPersonId);
    }),
    hiddenCount: hidden.size
  };
}

function assignGenerations(persons, relations) {
  const generations = {};
  const parentIds = {};
  const children = {};
  const spouseRelations = [];

  persons.forEach(function (person) {
    children[person._id] = [];
  });

  relations.forEach(function (relation) {
    if (relation.type === 'parent_child') {
      parentIds[relation.toPersonId] = true;
      if (children[relation.fromPersonId]) {
        children[relation.fromPersonId].push(relation.toPersonId);
      }
    } else if (relation.type === 'spouse') {
      spouseRelations.push(relation);
    }
  });

  let roots = persons.filter(function (person) {
    return !parentIds[person._id];
  });
  if (!roots.length && persons.length) roots = [persons[0]];

  const queue = roots.map(function (person) {
    generations[person._id] = 0;
    return person._id;
  });

  while (queue.length) {
    const personId = queue.shift();
    (children[personId] || []).forEach(function (childId) {
      const nextGeneration = generations[personId] + 1;
      if (generations[childId] === undefined || generations[childId] < nextGeneration) {
        generations[childId] = nextGeneration;
        queue.push(childId);
      }
    });
  }

  for (let pass = 0; pass < persons.length; pass += 1) {
    spouseRelations.forEach(function (relation) {
      const fromGen = generations[relation.fromPersonId];
      const toGen = generations[relation.toPersonId];
      if (fromGen !== undefined && toGen === undefined) generations[relation.toPersonId] = fromGen;
      if (toGen !== undefined && fromGen === undefined) generations[relation.fromPersonId] = toGen;
    });
  }

  persons.forEach(function (person) {
    if (generations[person._id] === undefined) generations[person._id] = 0;
  });

  return generations;
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

function specializedKinship(path, peopleById) {
  const steps = path.steps;
  const ids = path.ids;
  if (steps.length === 1) return steps[0].label;

  if (steps.length === 2) {
    const first = steps[0].kind;
    const second = steps[1].kind;
    const middle = peopleById[ids[1]];
    const target = peopleById[ids[2]];
    const targetGender = personGender(target);

    if (first === 'up' && second === 'up') {
      if (personGender(middle) === 'female') {
        return targetGender === 'male' ? '外公' : targetGender === 'female' ? '外婆' : '外祖父母';
      }
      return targetGender === 'male' ? '爷爷' : targetGender === 'female' ? '奶奶' : '祖父母';
    }

    if (first === 'up' && second === 'down') {
      return targetGender === 'male' ? '兄弟' : targetGender === 'female' ? '姐妹' : '手足';
    }

    if (first === 'down' && second === 'down') {
      if (personGender(middle) === 'female') {
        return targetGender === 'male' ? '外孙' : targetGender === 'female' ? '外孙女' : '外孙辈';
      }
      return targetGender === 'male' ? '孙子' : targetGender === 'female' ? '孙女' : '孙辈';
    }

    if (first === 'down' && second === 'spouse') {
      return personGender(middle) === 'male' ? '儿媳' : personGender(middle) === 'female' ? '女婿' : '子女配偶';
    }
  }

  return steps.map(function (step) {
    return step.label;
  }).join('的');
}

function calculateKinships(persons, relations, viewpointId) {
  const result = {};
  if (!viewpointId) return result;

  const graph = buildAdjacency(persons, relations);
  const queue = [{ id: viewpointId, ids: [viewpointId], steps: [] }];
  const visited = {};
  visited[viewpointId] = true;
  result[viewpointId] = '当前成员';

  while (queue.length) {
    const current = queue.shift();
    if (current.steps.length >= 5) continue;

    (graph.adjacency[current.id] || []).forEach(function (edge) {
      if (visited[edge.id]) return;
      const step = directStep(current.id, edge.id, edge.relation, graph.peopleById);
      const nextPath = {
        id: edge.id,
        ids: current.ids.concat(edge.id),
        steps: current.steps.concat(step)
      };
      visited[edge.id] = true;
      result[edge.id] = specializedKinship(nextPath, graph.peopleById);
      queue.push(nextPath);
    });
  }

  return result;
}

function createLine(fromNode, toNode, type, relationId) {
  let x1 = fromNode.x + NODE_WIDTH / 2;
  let y1 = fromNode.y + NODE_HEIGHT / 2;
  let x2 = toNode.x + NODE_WIDTH / 2;
  let y2 = toNode.y + NODE_HEIGHT / 2;

  if (type === 'parent_child') {
    y1 = fromNode.y + NODE_HEIGHT;
    y2 = toNode.y;
  }

  const deltaX = x2 - x1;
  const deltaY = y2 - y1;
  const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  const angle = Math.atan2(deltaY, deltaX) * 180 / Math.PI;

  return {
    _id: relationId,
    type: type,
    style: 'left:' + x1 + 'rpx;top:' + y1 + 'rpx;width:' + length + 'rpx;transform:rotate(' + angle + 'deg);'
  };
}

function layoutGraph(personsInput, relationsInput, options) {
  const optionsValue = options || {};
  const activePersons = (personsInput || []).filter(function (person) {
    return person.status !== 'deleted';
  });
  const active = activeRelations(relationsInput);
  const filtered = filterCollapsed(activePersons, active, optionsValue.collapsedIds || []);
  const persons = filtered.persons;
  const relations = filtered.relations;
  const generations = assignGenerations(persons, relations);
  const groups = {};
  let maxGeneration = 0;

  persons.forEach(function (person) {
    const generation = generations[person._id];
    maxGeneration = Math.max(maxGeneration, generation);
    if (!groups[generation]) groups[generation] = [];
    groups[generation].push(person);
  });

  Object.keys(groups).forEach(function (key) {
    groups[key].sort(comparePeople);
  });

  let maxCount = 1;
  Object.keys(groups).forEach(function (key) {
    maxCount = Math.max(maxCount, groups[key].length);
  });

  let canvasWidth = Math.max(750, (maxCount - 1) * GAP_X + NODE_WIDTH + MARGIN_X * 2);
  let canvasHeight = Math.max(900, maxGeneration * GAP_Y + NODE_HEIGHT + MARGIN_Y * 2);
  const nodesById = {};
  const nodes = [];
  const kinships = optionsValue.mode === 'perspective'
    ? calculateKinships(persons, relations, optionsValue.viewpointId)
    : {};

  Object.keys(groups).forEach(function (key) {
    const row = groups[key];
    const rowWidth = (row.length - 1) * GAP_X + NODE_WIDTH;
    const startX = (canvasWidth - rowWidth) / 2;
    row.forEach(function (person, index) {
      const x = startX + index * GAP_X;
      const y = MARGIN_Y + Number(key) * GAP_Y;
      const node = Object.assign({}, person, {
        x: x,
        y: y,
        style: 'left:' + x + 'rpx;top:' + y + 'rpx;',
        relationLabel: kinships[person._id] || '',
        isViewpoint: person._id === optionsValue.viewpointId
      });
      nodesById[person._id] = node;
      nodes.push(node);
    });
  });

  if (optionsValue.mode === 'perspective' && nodesById[optionsValue.viewpointId]) {
    const viewpoint = nodesById[optionsValue.viewpointId];
    let offsetX = canvasWidth / 2 - (viewpoint.x + NODE_WIDTH / 2);
    let offsetY = Math.max(0, 320 - (viewpoint.y + NODE_HEIGHT / 2));
    let minX = Infinity;

    nodes.forEach(function (node) {
      minX = Math.min(minX, node.x + offsetX);
    });
    if (minX < MARGIN_X) offsetX += MARGIN_X - minX;

    nodes.forEach(function (node) {
      node.x += offsetX;
      node.y += offsetY;
      node.style = 'left:' + node.x + 'rpx;top:' + node.y + 'rpx;';
    });

    const maxX = Math.max.apply(null, nodes.map(function (node) { return node.x + NODE_WIDTH; }));
    const maxY = Math.max.apply(null, nodes.map(function (node) { return node.y + NODE_HEIGHT; }));
    canvasWidth = Math.max(canvasWidth, maxX + MARGIN_X);
    canvasHeight = Math.max(canvasHeight, maxY + MARGIN_Y);
  }

  const lines = relations.map(function (relation) {
    const fromNode = nodesById[relation.fromPersonId];
    const toNode = nodesById[relation.toPersonId];
    if (!fromNode || !toNode) return null;
    return createLine(fromNode, toNode, relation.type, relation._id);
  }).filter(Boolean);

  return {
    nodes: nodes,
    lines: lines,
    width: Math.ceil(canvasWidth),
    height: Math.ceil(canvasHeight),
    kinships: kinships,
    hiddenCount: filtered.hiddenCount
  };
}

module.exports = {
  layoutGraph: layoutGraph,
  calculateKinships: calculateKinships,
  filterCollapsed: filterCollapsed
};
