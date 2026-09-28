const PERSON_MIN = 3;
const PERSON_MAX = 200;
const RELATION_MIN = 2;
const RELATION_MAX = 400;

function text(value) {
  return String(value || '').trim();
}

function rowLabel(scope, rowIndex) {
  const title = scope === 'person' ? '人物表' : '关系表';
  return `${title}第 ${rowIndex + 1} 行（Excel 第 ${rowIndex + 2} 行）`;
}

function rowList(scope, indexes) {
  const title = scope === 'person' ? '人物表' : '关系表';
  const dataRows = indexes.map((index) => index + 1).join('、');
  const sheetRows = indexes.map((index) => index + 2).join('、');
  return `${title}第 ${dataRows} 行（Excel 第 ${sheetRows} 行）`;
}

function issue(code, scope, field, message, rowIndex, relatedRows) {
  const result = { code, scope, field, message };
  if (Number.isInteger(rowIndex)) {
    result.rowIndex = rowIndex;
    result.sheetRow = rowIndex + 2;
  }
  if (Array.isArray(relatedRows) && relatedRows.length) result.relatedRows = relatedRows;
  return result;
}

function endpointName(relation, side, personById) {
  const id = text(relation[`${side}PersonId`]);
  const person = personById.get(id);
  if (person) return text(person.name);
  return text(relation[`${side}Name`] || relation[`${side}PersonName`]);
}

function findPath(adjacency, startId, targetId, excludedIndex) {
  const visited = new Set();
  function visit(id, nodeIds, relationIndexes) {
    if (id === targetId) return { nodeIds, relationIndexes };
    if (visited.has(id)) return null;
    visited.add(id);
    const edges = adjacency.get(id) || [];
    for (const edge of edges) {
      if (edge.index === excludedIndex) continue;
      const found = visit(edge.to, nodeIds.concat(edge.to), relationIndexes.concat(edge.index));
      if (found) return found;
    }
    return null;
  }
  return visit(startId, [startId], []);
}

/**
 * Validate the editable example-family shape without mutating or normalizing it.
 * rowIndex and relatedRows are zero-based; messages contain both visible data-row
 * numbers and spreadsheet row numbers.
 */
export function validateExampleContent(content) {
  const source = content || {};
  const persons = Array.isArray(source.persons) ? source.persons : [];
  const relations = Array.isArray(source.relations) ? source.relations : [];
  const issues = [];
  const personById = new Map();
  const nameRows = new Map();

  if (persons.length < PERSON_MIN) {
    issues.push(issue('EXAMPLE_MIN_PERSONS', 'content', 'persons', `示例家谱至少需要 ${PERSON_MIN} 位人物，当前仅 ${persons.length} 位`));
  }
  if (persons.length > PERSON_MAX) {
    issues.push(issue('EXAMPLE_MAX_PERSONS', 'content', 'persons', `示例家谱最多支持 ${PERSON_MAX} 位人物，当前有 ${persons.length} 位，请删除超出的 ${persons.length - PERSON_MAX} 位`));
  }

  persons.forEach((person, index) => {
    const id = text(person && person._id);
    const name = text(person && person.name);
    if (id) personById.set(id, person);
    if (!name) {
      issues.push(issue('EXAMPLE_PERSON_NAME_REQUIRED', 'person', 'name', `${rowLabel('person', index)}缺少姓名`, index));
      return;
    }
    const rows = nameRows.get(name) || [];
    rows.push(index);
    nameRows.set(name, rows);
  });

  nameRows.forEach((indexes, name) => {
    if (indexes.length < 2) return;
    const message = `${rowList('person', indexes)}的姓名重复：“${name}”；姓名必须唯一`;
    issues.push(issue('EXAMPLE_PERSON_NAME_DUPLICATE', 'person', 'name', message, indexes[0], indexes));
  });

  if (relations.length < RELATION_MIN) {
    issues.push(issue('EXAMPLE_MIN_RELATIONS', 'content', 'relations', `示例家谱至少需要 ${RELATION_MIN} 条关系，当前仅 ${relations.length} 条`));
  }
  if (relations.length > RELATION_MAX) {
    issues.push(issue('EXAMPLE_MAX_RELATIONS', 'content', 'relations', `示例家谱最多支持 ${RELATION_MAX} 条关系，当前有 ${relations.length} 条，请删除超出的 ${relations.length - RELATION_MAX} 条`));
  }

  const relationGroups = new Map();
  const parentEdges = [];
  relations.forEach((relation, index) => {
    const type = text(relation && relation.type);
    const fromId = text(relation && relation.fromPersonId);
    const toId = text(relation && relation.toPersonId);
    const fromPerson = personById.get(fromId);
    const toPerson = personById.get(toId);
    const fromName = endpointName(relation || {}, 'from', personById);
    const toName = endpointName(relation || {}, 'to', personById);

    if (!['parent_child', 'spouse'].includes(type)) {
      issues.push(issue('EXAMPLE_INVALID_RELATION', 'relation', 'type', `${rowLabel('relation', index)}的关系类型“${type || '空'}”无效`, index));
    }
    if (!fromPerson) {
      issues.push(issue('EXAMPLE_RELATION_PERSON_NOT_FOUND', 'relation', 'fromPersonId', `${rowLabel('relation', index)}的起始人物“${fromName || '未填写'}”未在人物表中唯一匹配`, index));
    }
    if (!toPerson) {
      issues.push(issue('EXAMPLE_RELATION_PERSON_NOT_FOUND', 'relation', 'toPersonId', `${rowLabel('relation', index)}的结束人物“${toName || '未填写'}”未在人物表中唯一匹配`, index));
    }
    if (fromPerson && toPerson && fromId === toId) {
      issues.push(issue('EXAMPLE_INVALID_RELATION', 'relation', 'toPersonId', `${rowLabel('relation', index)}的起始和结束都是“${fromName}”，不能与自己建立关系`, index));
    }

    if (['parent_child', 'spouse'].includes(type) && fromPerson && toPerson && fromId !== toId) {
      const endpoints = type === 'spouse' && fromId > toId ? [toId, fromId] : [fromId, toId];
      const key = `${type}:${endpoints.join(':')}`;
      const indexes = relationGroups.get(key) || [];
      indexes.push(index);
      relationGroups.set(key, indexes);
      if (type === 'parent_child') parentEdges.push({ index, from: fromId, to: toId });
    }
  });

  relationGroups.forEach((indexes) => {
    if (indexes.length < 2) return;
    const first = relations[indexes[0]];
    const fromName = endpointName(first, 'from', personById);
    const toName = endpointName(first, 'to', personById);
    const typeText = first.type === 'spouse' ? '伴侣' : '父母 → 子女';
    const message = `${rowList('relation', indexes)}重复定义了“${fromName} ${typeText} ${toName}”`;
    issues.push(issue('EXAMPLE_RELATION_DUPLICATE', 'relation', 'relation', message, indexes[0], indexes));
  });

  const adjacency = new Map();
  parentEdges.forEach((edge) => {
    const entries = adjacency.get(edge.from) || [];
    entries.push(edge);
    adjacency.set(edge.from, entries);
  });
  const cycleKeys = new Set();
  parentEdges.forEach((edge) => {
    const path = findPath(adjacency, edge.to, edge.from, edge.index);
    if (!path) return;
    const indexes = [edge.index].concat(path.relationIndexes);
    const key = indexes.slice().sort((left, right) => left - right).join(':');
    if (cycleKeys.has(key)) return;
    cycleKeys.add(key);
    const nodeIds = [edge.from].concat(path.nodeIds);
    const names = nodeIds.map((id) => text(personById.get(id)?.name) || '未命名人物');
    const sortedIndexes = indexes.slice().sort((left, right) => left - right);
    const message = `${rowList('relation', sortedIndexes)}形成祖先循环：${names.join(' → ')}`;
    issues.push(issue('EXAMPLE_RELATION_CYCLE', 'relation', 'relation', message, sortedIndexes[0], sortedIndexes));
  });

  return issues;
}

export function issuesForRow(issues, scope, rowIndex) {
  return (issues || []).filter((item) => item.scope === scope && (
    item.rowIndex === rowIndex || (Array.isArray(item.relatedRows) && item.relatedRows.includes(rowIndex))
  ));
}

export function groupValidationIssues(issues) {
  return {
    person: (issues || []).filter((item) => item.scope === 'person'),
    relation: (issues || []).filter((item) => item.scope === 'relation'),
    content: (issues || []).filter((item) => item.scope === 'content')
  };
}
