function textOrder(first, second) {
  return String(first || '').localeCompare(String(second || ''), 'zh-CN');
}

function dateInterval(value) {
  const text = String(value || '').trim();
  let match = /^(\d{4})$/.exec(text);
  if (match) {
    const year = Number(match[1]);
    return { start: Date.UTC(year, 0, 1), end: Date.UTC(year, 11, 31), text: text };
  }
  match = /^(\d{4})-(\d{2})$/.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return { start: Date.UTC(year, month - 1, 1), end: Date.UTC(year, month, 0), text: text };
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { start: timestamp, end: timestamp, text: text };
}

function comparableDateOrder(first, second) {
  const firstInterval = dateInterval(first && first.birthDate);
  const secondInterval = dateInterval(second && second.birthDate);
  if (!firstInterval || !secondInterval) return 0;
  if (firstInterval.end < secondInterval.start) return -1;
  if (secondInterval.end < firstInterval.start) return 1;
  return 0;
}

function relationNumber(relation, field, fallback) {
  if (!relation || relation[field] === undefined || relation[field] === null || relation[field] === '') return fallback;
  const value = Number(relation && relation[field]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function timestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) return value.getTime();
  if (value.$date) return timestamp(value.$date);
  if (Number.isFinite(Number(value.seconds))) return Number(value.seconds) * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1000000);
  if (Number.isFinite(Number(value._seconds))) return Number(value._seconds) * 1000 + Math.floor(Number(value._nanoseconds || 0) / 1000000);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareFallback(first, second) {
  const firstOrder = relationNumber(first.relation, 'childOrder', Infinity);
  const secondOrder = relationNumber(second.relation, 'childOrder', Infinity);
  if (firstOrder !== secondOrder) return firstOrder - secondOrder;
  const firstGender = first.person && first.person.gender;
  const secondGender = second.person && second.person.gender;
  const firstGenderOrder = firstGender === 'male' ? 0 : firstGender === 'female' ? 1 : 2;
  const secondGenderOrder = secondGender === 'male' ? 0 : secondGender === 'female' ? 1 : 2;
  if (firstGenderOrder !== secondGenderOrder) return firstGenderOrder - secondGenderOrder;
  const firstHasDate = Boolean(dateInterval(first.person && first.person.birthDate));
  const secondHasDate = Boolean(dateInterval(second.person && second.person.birthDate));
  if (firstHasDate !== secondHasDate) return firstHasDate ? -1 : 1;
  return textOrder(first.person && first.person.name, second.person && second.person.name)
    || textOrder(first.person && first.person._id, second.person && second.person._id);
}

function compareChildren(first, second) {
  return comparableDateOrder(first.person, second.person) || compareFallback(first, second);
}

function orderChildren(items) {
  const rows = (items || []).slice();
  if (rows.length < 2) return rows;
  const outgoing = rows.map(function () { return []; });
  const indegree = rows.map(function () { return 0; });
  for (let first = 0; first < rows.length; first += 1) {
    for (let second = first + 1; second < rows.length; second += 1) {
      const order = comparableDateOrder(rows[first].person, rows[second].person);
      if (!order) continue;
      const from = order < 0 ? first : second;
      const to = order < 0 ? second : first;
      outgoing[from].push(to);
      indegree[to] += 1;
    }
  }
  const available = [];
  indegree.forEach(function (value, index) { if (!value) available.push(index); });
  const result = [];
  while (available.length) {
    available.sort(function (first, second) { return compareFallback(rows[first], rows[second]); });
    const current = available.shift();
    result.push(rows[current]);
    outgoing[current].forEach(function (next) {
      indegree[next] -= 1;
      if (!indegree[next]) available.push(next);
    });
  }
  return result.length === rows.length ? result : rows.sort(compareFallback);
}

function chineseNumber(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (number < 10) return digits[number];
  if (number < 20) return '十' + (number % 10 ? digits[number % 10] : '');
  if (number < 100) return digits[Math.floor(number / 10)] + '十' + (number % 10 ? digits[number % 10] : '');
  if (number < 1000) {
    const hundreds = Math.floor(number / 100);
    const remainder = number % 100;
    if (!remainder) return digits[hundreds] + '百';
    return digits[hundreds] + '百' + (remainder < 10 ? '零' : '') + chineseNumber(remainder);
  }
  return String(number);
}

function rankLabel(gender, index) {
  const suffix = gender === 'male' ? '子' : gender === 'female' ? '女' : '';
  if (!suffix || index < 1) return '';
  if (index === 1) return '长' + suffix;
  if (index === 2) return '次' + suffix;
  return chineseNumber(index) + suffix;
}

function activeItems(persons, relations) {
  const peopleById = {};
  (persons || []).forEach(function (person) {
    if (person && person.status !== 'deleted') peopleById[person._id] = person;
  });
  const byParent = {};
  (relations || []).forEach(function (relation) {
    if (!relation || relation.status === 'deleted' || relation.type !== 'parent_child') return;
    const parent = peopleById[relation.fromPersonId];
    const child = peopleById[relation.toPersonId];
    if (!parent || !child) return;
    if (!byParent[parent._id]) byParent[parent._id] = { parent: parent, childrenById: {} };
    byParent[parent._id].childrenById[child._id] = { person: child, relation: relation };
  });
  return byParent;
}

function build(persons, relations) {
  const byParent = activeItems(persons, relations);
  const candidatesByChild = {};
  const parentOrders = {};
  const parentRanks = {};
  Object.keys(byParent).forEach(function (parentId) {
    const group = byParent[parentId];
    const ordered = orderChildren(Object.keys(group.childrenById).map(function (childId) {
      return group.childrenById[childId];
    }));
    parentOrders[parentId] = ordered.map(function (item) { return item.person._id; });
    parentRanks[parentId] = {};
    if (ordered.length < 2) return;
    const genderCounts = { male: 0, female: 0 };
    ordered.forEach(function (item, sequenceIndex) {
      const gender = item.person.gender;
      if (gender !== 'male' && gender !== 'female') return;
      genderCounts[gender] += 1;
      const relation = item.relation;
      const manualAt = timestamp(relation.childOrderUpdatedAt);
      const relationAt = Math.max(timestamp(relation.updatedAt), timestamp(relation.createdAt));
      parentRanks[parentId][item.person._id] = {
        label: rankLabel(gender, genderCounts[gender]),
        rankNumber: genderCounts[gender],
        sequenceIndex: sequenceIndex
      };
      if (!candidatesByChild[item.person._id]) candidatesByChild[item.person._id] = [];
      candidatesByChild[item.person._id].push({
        label: rankLabel(gender, genderCounts[gender]),
        rankNumber: genderCounts[gender],
        sequenceIndex: sequenceIndex,
        parentId: parentId,
        parentName: group.parent.name || '未命名家长',
        manualAt: manualAt,
        relationAt: relationAt
      });
    });
  });

  const byPerson = {};
  Object.keys(candidatesByChild).forEach(function (childId) {
    const candidates = candidatesByChild[childId].sort(function (first, second) {
      const firstManual = first.manualAt > 0;
      const secondManual = second.manualAt > 0;
      if (firstManual !== secondManual) return firstManual ? -1 : 1;
      if (first.manualAt !== second.manualAt) return second.manualAt - first.manualAt;
      if (first.relationAt !== second.relationAt) return second.relationAt - first.relationAt;
      return textOrder(first.parentId, second.parentId);
    });
    const selected = candidates[0];
    byPerson[childId] = {
      childRankLabel: selected.label,
      childRankNumber: selected.rankNumber,
      childSequenceIndex: selected.sequenceIndex,
      childRankParentId: selected.parentId,
      childRankParentName: selected.parentName,
      childRankBasisText: '按' + selected.parentName + '的子女排行',
      childRankConflict: candidates.some(function (candidate) { return candidate.label !== selected.label; })
    };
  });
  return { byPerson: byPerson, parentOrders: parentOrders, parentRanks: parentRanks };
}

function canSwap(first, second) {
  return comparableDateOrder(first && first.person, second && second.person) === 0;
}

module.exports = {
  build: build,
  canSwap: canSwap,
  compareChildren: compareChildren,
  orderChildren: orderChildren,
  comparableDateOrder: comparableDateOrder,
  dateInterval: dateInterval,
  rankLabel: rankLabel
};
