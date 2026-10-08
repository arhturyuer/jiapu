const dictionary = require('./kinship-dictionary');
const personDate = require('./person-date');
const MAX_PATH_CANDIDATES = 64;
const MAX_SEARCH_STATES = 100000;

function personGender(person) {
  return person && (person.gender === 'male' || person.gender === 'female') ? person.gender : 'unknown';
}

// Compare the entire possible interval of a partial date, not a guessed day.
function birthInterval(value) {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value || '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 0;
  const day = match[3] ? Number(match[3]) : 0;
  if (!year || (match[2] && (month < 1 || month > 12))) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (match[3] && (day < 1 || day > days[month - 1])) return null;
  return [year * 10000 + (month || 1) * 100 + (day || 1), year * 10000 + (month || 12) * 100 + (day || days[(month || 12) - 1])];
}

function ageOrder(reference, target) {
  const first = personDate.range(reference, 'birth');
  const second = personDate.range(target, 'birth');
  if (!first || !second) return '';
  return second.end < first.start ? 'older' : second.start > first.end ? 'younger' : '';
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
  if (relationType === 'spouse') return personGender(anchor) === 'male' ? '妻子' : personGender(anchor) === 'female' ? '丈夫' : '配偶';
  return { father: '父亲', mother: '母亲', son: '儿子', daughter: '女儿', sibling: '兄弟姐妹' }[relationType] || '亲属';
}

function siblingToken(reference, target) {
  const gender = personGender(target);
  if (gender === 'unknown') return 'sibling';
  const order = ageOrder(reference, target);
  return (order === 'older' ? 'o' : order === 'younger' ? 'l' : 'x') + (gender === 'male' ? 'b' : 's');
}

const TOKEN_LABELS = { f: '父亲', m: '母亲', s: '儿子', d: '女儿', h: '丈夫', w: '妻子', ob: '哥哥', lb: '弟弟', xb: '兄弟', os: '姐姐', ls: '妹妹', xs: '姐妹', parent: '家长', child: '子女', partner: '配偶', sibling: '手足' };
const DEFAULT_LABELS = {
  ob: '哥哥', lb: '弟弟', os: '姐姐', ls: '妹妹', xb: '兄弟', xs: '姐妹',
  'f,f': '爷爷', 'f,m': '奶奶', 'm,f': '外公', 'm,m': '外婆',
  'f,xb': '伯叔', 'f,ob': '伯父', 'f,lb': '叔叔', 'f,xs': '姑妈', 'm,xb': '舅舅', 'm,xs': '姨妈',
  'f,ob,w': '伯母', 'f,lb,w': '婶婶', 'f,xb,w': '伯叔母', 'f,xs,h': '姑父', 'm,xb,w': '舅妈', 'm,xs,h': '姨父',
  'ob,w': '嫂子', 'lb,w': '弟媳', 'xb,w': '兄弟的妻子', 'os,h': '姐夫', 'ls,h': '妹夫', 'xs,h': '姐妹的丈夫',
  's,s': '孙子', 's,d': '孙女', 'd,s': '外孙', 'd,d': '外孙女',
  's,s,w': '孙媳', 's,d,h': '孙女婿', 'd,s,w': '外孙媳', 'd,d,h': '外孙女婿',
  'm,f,xs': '姑姥', 'm,f,xs,s': '表舅', 'm,f,xs,d': '表姨',
  'w,f': '岳父', 'w,m': '岳母', 'h,f': '公公', 'h,m': '婆婆',
  'xb,s': '侄子', 'xb,d': '侄女', 'xs,s': '外甥', 'xs,d': '外甥女',
  'xb,s,s': '侄孙', 'xb,s,d': '侄孙女', 'xs,s,s': '甥孙', 'xs,s,d': '甥孙女'
};

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function buildGraph(persons, relations) {
  const people = Object.create(null);
  const adjacency = Object.create(null);
  (persons || []).forEach(function (person) {
    if (!person || !person._id || person.status === 'deleted') return;
    people[person._id] = person;
    adjacency[person._id] = [];
  });
  (relations || []).forEach(function (relation) {
    if (!relation || relation.status === 'deleted' || !['parent_child', 'spouse'].includes(relation.type)) return;
    const from = relation.fromPersonId;
    const to = relation.toPersonId;
    if (from === to || !people[from] || !people[to]) return;
    function add(a, b, kind) {
      const gender = personGender(people[b]);
      const token = kind === 'up' ? (gender === 'male' ? 'f' : gender === 'female' ? 'm' : 'parent')
        : kind === 'down' ? (gender === 'male' ? 's' : gender === 'female' ? 'd' : 'child')
          : spouseLabel(people[a], people[b]) === '丈夫' ? 'h' : spouseLabel(people[a], people[b]) === '妻子' ? 'w' : 'partner';
      adjacency[a].push({ id: b, kind: kind, token: token, relationId: relation._id || relation.type + ':' + from + ':' + to });
    }
    add(from, to, relation.type === 'spouse' ? 'spouse' : 'down');
    add(to, from, relation.type === 'spouse' ? 'spouse' : 'up');
  });
  Object.keys(adjacency).forEach(function (id) {
    adjacency[id].sort(function (a, b) { return compareText(a.id, b.id) || compareText(a.kind, b.kind) || compareText(a.relationId, b.relationId); });
  });
  return { people: people, adjacency: adjacency };
}

function rootPath(id) { return { id: id, ids: [id], steps: [], tokens: [], tokenIds: [], code: '' }; }
function extendPath(path, edge, graph) {
  const steps = path.steps.concat(edge);
  const tokens = path.tokens.slice();
  const tokenIds = path.tokenIds.slice();
  const previous = path.steps[path.steps.length - 1];
  // Both steps refer to this very same saved parent. Distinct IDs ensure this
  // is another child, never a text-only cancellation or a guessed co-parent.
  if (previous && previous.kind === 'up' && edge.kind === 'down') {
    tokens[tokens.length - 1] = siblingToken(graph.people[path.ids[path.ids.length - 2]], graph.people[edge.id]);
    tokenIds[tokenIds.length - 1] = edge.id;
  } else {
    tokens.push(edge.token);
    tokenIds.push(edge.id);
  }
  return { id: edge.id, ids: path.ids.concat(edge.id), steps: steps, tokens: tokens, tokenIds: tokenIds, code: tokens.join(',') };
}

function isBlood(path) {
  let descending = false;
  return path.steps.every(function (step) {
    if (step.kind === 'spouse') return false;
    if (step.kind === 'down') descending = true;
    return !(descending && step.kind === 'up');
  });
}

function pathClass(path) { return path.steps.length === 1 ? 'direct' : isBlood(path) ? 'blood' : path.steps.some(function (s) { return s.kind === 'spouse'; }) ? 'affinal' : 'related'; }
function description(path) { return path.tokens.map(function (token) { return TOKEN_LABELS[token]; }).join('的'); }

function namedLabel(path, graph) {
  const tokens = path.tokens;
  const viewpoint = graph.people[path.ids[0]];
  const target = graph.people[path.id];
  if (path.steps.length === 1) return directRelationshipLabel(viewpoint, target, path.steps[0].kind === 'up' ? 'parent' : path.steps[0].kind === 'down' ? 'child' : 'spouse');
  const code = path.code;
  const neutral = tokens.map(dictionary.neutralToken).join(',');
  if (DEFAULT_LABELS[code]) return DEFAULT_LABELS[code];
  if (DEFAULT_LABELS[neutral]) return DEFAULT_LABELS[neutral];
  // Keep the established broad 堂/表 convention for first cousins.
  if (/^[fm],[olx][bs],[sd]$/.test(code)) {
    const prefix = tokens[0] === 'f' && /b$/.test(tokens[1]) ? '堂' : '表';
    const gender = personGender(target);
    const order = ageOrder(viewpoint, target);
    return prefix + (gender === 'male' ? order === 'older' ? '哥' : order === 'younger' ? '弟' : '兄弟' : order === 'older' ? '姐' : order === 'younger' ? '妹' : '姐妹');
  }
  let generation = 0;
  let relativeIndex = tokens.length - 1;
  if (tokens[relativeIndex] === 'h' || tokens[relativeIndex] === 'w') relativeIndex -= 1;
  tokens.slice(0, relativeIndex + 1).forEach(function (token) { generation += token === 'f' || token === 'm' ? 1 : token === 's' || token === 'd' ? -1 : 0; });
  const relative = graph.people[path.tokenIds[relativeIndex]];
  let reference = viewpoint;
  let referenceGeneration = 0;
  // A father's cousin is compared with the father, a spouse's cousin with
  // the spouse. Never compare an older generation with the viewpoint's age.
  for (let index = 0; index < relativeIndex; index += 1) {
    const token = tokens[index];
    if (index === 0 && (token === 'h' || token === 'w')) reference = graph.people[path.tokenIds[index]];
    else if ((token === 'f' || token === 'm') && referenceGeneration < generation) {
      referenceGeneration += 1;
      reference = graph.people[path.tokenIds[index]];
    } else break;
  }
  const order = referenceGeneration === generation ? ageOrder(reference, relative) : '';
  if (order && /^(s|d)$/.test(tokens[relativeIndex])) {
    const aged = tokens.slice();
    aged[relativeIndex] += order === 'older' ? '&o' : '&l';
    const label = dictionary.lookup(aged, personGender(viewpoint));
    if (label) return label;
  }
  return dictionary.lookup(tokens, personGender(viewpoint));
}

function fallbackLabel(path, graph) {
  const gender = personGender(graph.people[path.id]);
  if (path.steps.every(function (s) { return s.kind === 'up'; }) && path.steps.length > 3) return '第' + path.steps.length + '代祖先';
  if (path.steps.every(function (s) { return s.kind === 'down'; }) && path.steps.length > 3) return '第' + path.steps.length + '代后裔';
  if (path.steps.length === 2 && path.steps[0].kind === 'down' && path.steps[1].kind === 'up') return gender === 'male' ? '子女的另一位父亲' : gender === 'female' ? '子女的另一位母亲' : '子女的另一位家长';
  return description(path);
}

function candidate(path, graph) {
  const label = namedLabel(path, graph);
  const unknown = path.tokens.some(function (t) { return ['parent', 'child', 'partner', 'sibling'].includes(t); });
  const ageUnknown = path.tokens.some(function (t) { return t === 'xb' || t === 'xs'; });
  return { label: label || fallbackLabel(path, graph), category: pathClass(path), named: !!label, code: path.code, distance: path.steps.length,
    description: description(path), paths: [{ personIds: path.ids, relationIds: path.steps.map(function (s) { return s.relationId; }) }],
    reason: unknown ? '部分成员性别未明确，按已录入关系展示' : !label ? '暂无可确定的专门称谓，展示已录入的关系路径' : ageUnknown ? '部分长幼信息不足，未推定年龄顺序' : '' };
}

function rank(a, b) {
  const classes = { direct: 0, blood: 1, affinal: 2, related: 3 };
  return classes[a.category] - classes[b.category] || a.distance - b.distance || Number(b.named) - Number(a.named) || compareText(a.code, b.code) || compareText(a.label, b.label);
}

// Full connectivity has no depth cap. Keep one deterministic real path even
// when the finite dictionary cannot name it or specialized search is capped.
function connectedPaths(graph, viewpointId, bloodOnly) {
  const paths = Object.create(null);
  const queue = [rootPath(viewpointId)];
  paths[viewpointId] = queue[0];
  const seen = new Set([viewpointId + ':up']);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    graph.adjacency[current.id].forEach(function (edge) {
      if (current.ids.includes(edge.id)) return;
      if (bloodOnly && (edge.kind === 'spouse' || (current.steps.some(function (s) { return s.kind === 'down'; }) && edge.kind === 'up'))) return;
      const phase = bloodOnly && (edge.kind === 'down' || current.steps.some(function (s) { return s.kind === 'down'; })) ? 'down' : 'up';
      const signature = edge.id + ':' + phase;
      if (seen.has(signature)) return;
      seen.add(signature);
      const next = extendPath(current, edge, graph);
      if (!paths[edge.id]) paths[edge.id] = next;
      queue.push(next);
    });
  }
  return paths;
}

function calculateKinshipDetails(persons, relations, viewpointId, limits) {
  const graph = buildGraph(persons, relations);
  const result = {};
  if (!graph.people[viewpointId]) return result;
  const maxCandidates = limits && limits.maxCandidates || MAX_PATH_CANDIDATES;
  const maxStates = limits && limits.maxStates || MAX_SEARCH_STATES;
  const connected = connectedPaths(graph, viewpointId, false);
  const blood = connectedPaths(graph, viewpointId, true);
  const candidates = Object.create(null);
  const signatures = Object.create(null);
  let truncated = false;
  function collect(path) {
    const id = path.id;
    if (id === viewpointId) return;
    const item = candidate(path, graph);
    if (!candidates[id]) { candidates[id] = []; signatures[id] = new Set(); }
    const signature = JSON.stringify(item.paths[0]);
    if (signatures[id].has(signature)) return;
    if (signatures[id].size >= maxCandidates) { truncated = true; return; }
    signatures[id].add(signature);
    const existing = candidates[id].find(function (entry) { return entry.code === item.code && entry.label === item.label && entry.category === item.category; });
    if (existing) existing.paths.push(item.paths[0]); else candidates[id].push(item);
  }
  Object.keys(connected).sort(compareText).forEach(function (id) { collect(connected[id]); if (blood[id]) collect(blood[id]); });
  const queue = [rootPath(viewpointId)];
  const queued = Object.create(null);
  queued[viewpointId] = 1;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const edges = graph.adjacency[current.id];
    for (let e = 0; e < edges.length; e += 1) {
      const edge = edges[e];
      if (current.ids.includes(edge.id)) continue;
      const next = extendPath(current, edge, graph);
      // An up step may become a sibling token on the next saved down step.
      const siblingPrefix = edge.kind === 'up' && ['xb', 'xs'].some(function (token) {
        return dictionary.hasPrefix(next.tokens.slice(0, -1).concat(token));
      });
      if (!dictionary.hasPrefix(next.tokens) && !siblingPrefix) continue;
      if (queue.length >= maxStates || (queued[next.id] || 0) >= maxCandidates) { truncated = true; continue; }
      queued[next.id] = (queued[next.id] || 0) + 1;
      queue.push(next);
      collect(next);
    }
  }
  Object.keys(graph.people).sort(compareText).forEach(function (id) {
    if (id === viewpointId) { result[id] = { label: '当前成员', category: 'self', alternatives: [], paths: [], description: '当前查看视角', reason: '', multiple: false, truncated: truncated }; return; }
    const items = (candidates[id] || []).sort(rank);
    if (!items.length) { result[id] = { label: '暂未建立关系', category: 'unconnected', alternatives: [], paths: [], description: '已录入资料中没有连接到当前视角的关系路径', reason: '', multiple: false, truncated: false }; return; }
    // Merge same labels, including both parents' evidence for one sibling.
    const distinct = [];
    items.forEach(function (item) {
      const existing = distinct.find(function (other) { return other.label === item.label && other.category === item.category; });
      if (existing) existing.paths = existing.paths.concat(item.paths); else distinct.push(Object.assign({}, item));
    });
    const main = distinct[0];
    const alternatives = distinct.slice(1).filter(function (item) { return item.named; });
    result[id] = Object.assign({}, main, { alternatives: alternatives, multiple: alternatives.length > 0, truncated: truncated });
  });
  return result;
}

function calculateKinships(persons, relations, viewpointId) {
  const details = calculateKinshipDetails(persons, relations, viewpointId);
  const result = {};
  Object.keys(details).forEach(function (id) { result[id] = details[id].label; });
  return result;
}

// Caller-owned cache; its content signature also catches in-place date, gender,
// relation and deletion edits. UI-only choices never enter this signature.
function createKinshipCache() {
  let previousKey;
  let previous;
  return function (persons, relations, viewpointId) {
    const key = JSON.stringify([viewpointId, (persons || []).map(function (p) { return p && [p._id, p.gender, p.birthDate, p.birthDateInfo, p.birthDateRange, p.status]; }),
      (relations || []).map(function (r) { return r && [r._id, r.type, r.fromPersonId, r.toPersonId, r.status]; })]);
    if (key !== previousKey) { previous = calculateKinshipDetails(persons, relations, viewpointId); previousKey = key; }
    return previous;
  };
}

function memberKinshipCard(details, personId, viewpointName, persons) {
  const detail = details && details[personId];
  if (!detail) return null;
  const names = Object.create(null);
  (persons || []).forEach(function (p) { names[p._id] = p.name || '未命名成员'; });
  const entries = [detail].concat(detail.alternatives).map(function (item, index) {
    const proof = item.paths[0];
    return { key: String(index), label: item.label, description: item.description,
      pathText: proof ? proof.personIds.map(function (id) { return names[id] || '未命名成员'; }).join(' → ') : '', reason: item.reason };
  });
  return { viewpointName: viewpointName, entries: entries, truncated: detail.truncated, multiple: detail.multiple };
}

module.exports = { ageOrder: ageOrder, directRelationshipLabel: directRelationshipLabel, relationTypeLabel: relationTypeLabel,
  calculateKinships: calculateKinships, calculateKinshipDetails: calculateKinshipDetails, createKinshipCache: createKinshipCache, memberKinshipCard: memberKinshipCard };
