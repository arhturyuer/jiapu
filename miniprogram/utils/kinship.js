const MAX_KINSHIP_DEPTH = 8;
const MAX_PATH_CANDIDATES = 12;

function personGender(person) {
  return person && person.gender ? person.gender : 'unknown';
}

function birthParts(value) {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value || '');
  if (!match) return null;
  return { year: Number(match[1]), month: match[2] ? Number(match[2]) : 0, day: match[3] ? Number(match[3]) : 0 };
}

// Only distinguish older and younger when the saved dates prove it. A partial
// date in the same year must not turn a guess into a relationship label.
function ageOrder(reference, target) {
  const referenceDate = birthParts(reference && reference.birthDate);
  const targetDate = birthParts(target && target.birthDate);
  if (!referenceDate || !targetDate) return '';
  if (referenceDate.year !== targetDate.year) return targetDate.year < referenceDate.year ? 'older' : 'younger';
  if (!referenceDate.month || !referenceDate.day || !targetDate.month || !targetDate.day) return '';
  const referenceValue = referenceDate.month * 100 + referenceDate.day;
  const targetValue = targetDate.month * 100 + targetDate.day;
  if (referenceValue === targetValue) return '';
  return targetValue < referenceValue ? 'older' : 'younger';
}

function spouseLabel(reference, target) {
  if (personGender(reference) === 'female' && personGender(target) === 'male') return '丈夫';
  if (personGender(reference) === 'male' && personGender(target) === 'female') return '妻子';
  return '配偶';
}

function directRelationshipLabel(reference, target, role) {
  const gender = personGender(target);
  if (role === 'spouse') return spouseLabel(reference, target);
  if (role === 'parent') return gender === 'male' ? '父亲' : gender === 'female' ? '母亲' : '父母';
  if (role === 'child') return gender === 'male' ? '儿子' : gender === 'female' ? '女儿' : '子女';
  return '亲属';
}

function relationTypeLabel(anchor, relationType) {
  if (relationType === 'spouse') {
    const gender = personGender(anchor);
    return gender === 'male' ? '妻子' : gender === 'female' ? '丈夫' : '配偶';
  }
  return {
    father: '父亲', mother: '母亲', son: '儿子', daughter: '女儿'
  }[relationType] || '亲属';
}

function directStep(current, next, relation) {
  if (relation.type === 'spouse') return { kind: 'spouse', label: spouseLabel(current, next) };
  if (relation.toPersonId === current._id) return { kind: 'up', label: directRelationshipLabel(current, next, 'parent') };
  return { kind: 'down', label: directRelationshipLabel(current, next, 'child') };
}

function buildGraph(persons, relations) {
  const peopleById = {};
  const adjacency = {};
  (persons || []).forEach(function (person) {
    if (!person || person.status === 'deleted') return;
    peopleById[person._id] = person;
    adjacency[person._id] = [];
  });
  (relations || []).forEach(function (relation) {
    if (!relation || relation.status === 'deleted' || !adjacency[relation.fromPersonId] || !adjacency[relation.toPersonId]) return;
    adjacency[relation.fromPersonId].push({ id: relation.toPersonId, relation: relation });
    adjacency[relation.toPersonId].push({ id: relation.fromPersonId, relation: relation });
  });
  Object.keys(adjacency).forEach(function (id) {
    adjacency[id].sort(function (first, second) {
      return first.id.localeCompare(second.id) || first.relation.type.localeCompare(second.relation.type) || (first.relation._id || '').localeCompare(second.relation._id || '');
    });
  });
  return { peopleById: peopleById, adjacency: adjacency };
}

function siblingLabel(reference, target, prefix) {
  const order = ageOrder(reference, target);
  const gender = personGender(target);
  const stem = prefix || '';
  if (gender === 'male') {
    if (order === 'older') return stem ? stem + '哥' : '哥哥';
    if (order === 'younger') return stem ? stem + '弟' : '弟弟';
    return stem ? stem + '兄弟' : '兄弟';
  }
  if (gender === 'female') {
    if (order === 'older') return stem ? stem + '姐' : '姐姐';
    if (order === 'younger') return stem ? stem + '妹' : '妹妹';
    return stem ? stem + '姐妹' : '姐妹';
  }
  return stem ? stem + '亲' : '手足';
}

function parentSiblingLabel(parent, target) {
  const targetGender = personGender(target);
  if (personGender(parent) === 'male') {
    if (targetGender === 'female') return '姑妈';
    if (targetGender === 'male') {
      const order = ageOrder(parent, target);
      if (order === 'older') return '伯父';
      if (order === 'younger') return '叔叔';
      return '伯叔';
    }
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
    if (personGender(parentSibling) === 'male') {
      const order = ageOrder(parent, parentSibling);
      if (order === 'older') return '伯母';
      if (order === 'younger') return '婶婶';
      return '伯叔母';
    }
  }
  if (personGender(parent) === 'female') {
    if (personGender(parentSibling) === 'male') return '舅妈';
    if (personGender(parentSibling) === 'female') return '姨父';
  }
  return '父母手足的配偶';
}

function siblingSpouseLabel(viewpoint, sibling) {
  const order = ageOrder(viewpoint, sibling);
  if (personGender(sibling) === 'male') return order === 'older' ? '嫂子' : order === 'younger' ? '弟媳' : '兄弟的妻子';
  if (personGender(sibling) === 'female') return order === 'older' ? '姐夫' : order === 'younger' ? '妹夫' : '姐妹的丈夫';
  return '手足的配偶';
}

function specializedKinship(path, peopleById) {
  const ids = path.ids;
  const kinds = path.steps.map(function (step) { return step.kind; }).join('-');
  const viewpoint = peopleById[ids[0]];
  const target = peopleById[ids[ids.length - 1]];
  const targetGender = personGender(target);
  if (path.steps.length === 1) return path.steps[0].label;
  if (kinds === 'up-spouse') return directRelationshipLabel(viewpoint, target, 'parent');
  if (kinds === 'up-up') {
    const parent = peopleById[ids[1]];
    if (personGender(parent) === 'female') return targetGender === 'male' ? '外公' : targetGender === 'female' ? '外婆' : '外祖父母';
    return targetGender === 'male' ? '爷爷' : targetGender === 'female' ? '奶奶' : '祖父母';
  }
  if (kinds === 'up-down') return siblingLabel(viewpoint, target, '');
  if (kinds === 'down-up') return targetGender === 'male' ? '子女的另一位父亲' : targetGender === 'female' ? '子女的另一位母亲' : '子女的另一位家长';
  if (kinds === 'down-down') {
    const child = peopleById[ids[1]];
    const outside = personGender(child) === 'female' ? '外' : '';
    return targetGender === 'male' ? outside + '孙' : targetGender === 'female' ? outside + '孙女' : outside + '孙辈';
  }
  if (kinds === 'down-spouse') {
    const child = peopleById[ids[1]];
    return personGender(child) === 'male' ? '儿媳' : personGender(child) === 'female' ? '女婿' : '子女配偶';
  }
  if (kinds === 'spouse-up') {
    const spouse = peopleById[ids[1]];
    if (personGender(spouse) === 'female') return targetGender === 'male' ? '岳父' : targetGender === 'female' ? '岳母' : '岳父母';
    if (personGender(spouse) === 'male') return targetGender === 'male' ? '公公' : targetGender === 'female' ? '婆婆' : '公婆';
    return '配偶的父母';
  }
  if (kinds === 'up-up-down') return parentSiblingLabel(peopleById[ids[1]], target);
  if (kinds === 'up-down-down') {
    const sibling = peopleById[ids[2]];
    return personGender(sibling) === 'male'
      ? targetGender === 'male' ? '侄子' : targetGender === 'female' ? '侄女' : '侄辈'
      : targetGender === 'male' ? '外甥' : targetGender === 'female' ? '外甥女' : '外甥辈';
  }
  if (kinds === 'up-down-spouse') return siblingSpouseLabel(viewpoint, peopleById[ids[2]]);
  if (kinds === 'down-spouse-up') return targetGender === 'male' ? '亲家公' : targetGender === 'female' ? '亲家母' : '亲家';
  if (kinds === 'down-down-spouse') {
    const outside = personGender(peopleById[ids[1]]) === 'female' ? '外' : '';
    return targetGender === 'male' ? outside + '孙媳' : targetGender === 'female' ? outside + '孙女婿' : outside + '孙辈配偶';
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
    return siblingLabel(viewpoint, target, personGender(parent) === 'male' && personGender(parentSibling) === 'male' ? '堂' : '表');
  }
  if (kinds === 'up-up-down-spouse') return parentSiblingSpouseLabel(peopleById[ids[1]], peopleById[ids[3]]);
  return '亲属';
}

function pathScore(path) {
  const spouseCount = path.steps.filter(function (step) { return step.kind === 'spouse'; }).length;
  const genericCount = path.steps.filter(function (step) { return step.label === '配偶' || step.label === '父母' || step.label === '子女'; }).length;
  return [spouseCount, genericCount, path.ids.join('>')];
}

function comparePathScore(first, second) {
  const firstScore = pathScore(first);
  const secondScore = pathScore(second);
  if (firstScore[0] !== secondScore[0]) return firstScore[0] - secondScore[0];
  if (firstScore[1] !== secondScore[1]) return firstScore[1] - secondScore[1];
  return firstScore[2].localeCompare(secondScore[2]);
}

function sharedFallback(paths, labels, peopleById) {
  const kinds = paths.map(function (path) { return path.steps.map(function (step) { return step.kind; }).join('-'); });
  const target = peopleById[paths[0].ids[paths[0].ids.length - 1]];
  const gender = personGender(target);
  if (kinds.every(function (kind) { return kind === 'up-down'; })) return siblingLabel(null, target, '');
  if (kinds.every(function (kind) { return kind === 'up-up-down-down'; })) return gender === 'male' ? '堂表兄弟' : gender === 'female' ? '堂表姐妹' : '堂表亲';
  if (kinds.every(function (kind) { return kind === 'up-up'; })) return gender === 'male' ? '祖父' : gender === 'female' ? '祖母' : '祖父母';
  if (kinds.every(function (kind) { return kind === 'up-up-down'; })) return gender === 'male' ? '父母的兄弟' : gender === 'female' ? '父母的姐妹' : '父母的手足';
  if (labels.every(function (label) { return label === labels[0]; })) return labels[0];
  return '亲属';
}

function calculateKinships(persons, relations, viewpointId) {
  const result = {};
  if (!viewpointId) return result;
  const graph = buildGraph(persons, relations);
  if (!graph.peopleById[viewpointId]) return result;
  const queue = [{ id: viewpointId, ids: [viewpointId], steps: [] }];
  const distances = {};
  const candidates = {};
  distances[viewpointId] = 0;
  candidates[viewpointId] = [[]];
  result[viewpointId] = '当前成员';
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.steps.length >= MAX_KINSHIP_DEPTH) continue;
    (graph.adjacency[current.id] || []).forEach(function (edge) {
      if (current.ids.indexOf(edge.id) >= 0) return;
      const nextDepth = current.steps.length + 1;
      if (distances[edge.id] !== undefined && distances[edge.id] < nextDepth) return;
      const next = graph.peopleById[edge.id];
      const path = { id: edge.id, ids: current.ids.concat(edge.id), steps: current.steps.concat(directStep(graph.peopleById[current.id], next, edge.relation)) };
      if (distances[edge.id] === undefined) {
        distances[edge.id] = nextDepth;
        candidates[edge.id] = [];
      }
      const signature = path.ids.join('>');
      if (candidates[edge.id].some(function (candidate) { return candidate.signature === signature; })) return;
      if (candidates[edge.id].length >= MAX_PATH_CANDIDATES) return;
      candidates[edge.id].push({ signature: signature, path: path });
      queue.push(path);
    });
  }
  Object.keys(candidates).forEach(function (personId) {
    if (personId === viewpointId) return;
    const paths = candidates[personId].map(function (candidate) { return candidate.path; });
    const labels = paths.map(function (path) { return specializedKinship(path, graph.peopleById); });
    const distinctLabels = labels.filter(function (label, index) { return labels.indexOf(label) === index; });
    if (distinctLabels.length === 1) {
      result[personId] = distinctLabels[0];
      return;
    }
    const rankedPaths = paths.slice().sort(comparePathScore);
    const bestScore = pathScore(rankedPaths[0]);
    const nextScore = pathScore(rankedPaths[1]);
    if (bestScore[0] < nextScore[0] || (bestScore[0] === nextScore[0] && bestScore[1] < nextScore[1])) {
      result[personId] = specializedKinship(rankedPaths[0], graph.peopleById);
      return;
    }
    result[personId] = sharedFallback(paths, labels, graph.peopleById);
  });
  return result;
}

module.exports = {
  ageOrder: ageOrder,
  directRelationshipLabel: directRelationshipLabel,
  relationTypeLabel: relationTypeLabel,
  calculateKinships: calculateKinships
};
