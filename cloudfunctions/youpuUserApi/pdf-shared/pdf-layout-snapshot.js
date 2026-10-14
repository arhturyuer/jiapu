const graph = require('./graph-layout');
const childRank = require('./child-rank');
const ROLES = ['spouse', 'trunk', 'rail', 'drop'];
const KEYS = ['version', 'sourceRevision', 'nameLayout', 'size', 'ids', 'relationIds', 'nodes', 'orders', 'routingOrder', 'lines', 'junctions', 'crossings', 'coordinates', 'families'];
const MESSAGE = '家谱图已变化，请返回家谱刷新后重新生成';
function check(value) {
  if (!value) throw Object.assign(new Error(MESSAGE), { code: 'PDF_LAYOUT_INVALID' });
}
function list(value, limit) { check(Array.isArray(value) && value.length <= limit); return value; }
function tuple(value, length) { check(Array.isArray(value) && value.length === length); return value; }
function index(value, length) { check(Number.isInteger(value) && value >= 0 && value < length); return value; }
function number(value) { check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000000); }
function strings(value, limit, length) {
  list(value, limit).forEach(function (id) { check(typeof id === 'string' && id.length > 0 && id.length <= length); });
  check(new Set(value).size === value.length);
}
function routingKeys(layout, ids, relationIds) {
  return Array.from(new Set(ids.concat(relationIds, layout.lines.filter(function (line) { return line.lineRole !== 'spouse'; }).map(function (line) { return line.familyKey; }))));
}
function compact(value, layout) {
  const coordinates = []; const positions = new Map();
  function coordinate(number) {
    if (!positions.has(number)) { positions.set(number, coordinates.length); coordinates.push(number); }
    return positions.get(number);
  }
  value.nodes = value.nodes.map(function (row) { return [row[0], coordinate(row[1]), coordinate(row[2]), row[3]]; });
  value.lines = value.lines.map(function (row) { return [row[0], coordinate(row[1]), coordinate(row[2]), coordinate(row[3]), coordinate(row[4]), row[5]]; });
  value.junctions = value.junctions.map(function (row) { return [coordinate(row[0]), coordinate(row[1]), row[2]]; });
  value.crossings = value.crossings.map(function (row) { return [coordinate(row[0]), coordinate(row[1]), row[2]]; });
  value.coordinates = coordinates;
  value.families = Array.from(new Set(layout.lines.filter(function (line) { return line.lineRole !== 'spouse'; }).map(function (line) { return line.familyKey; })));
  const keys = Array.from(new Set(value.ids.concat(value.relationIds, value.families)));
  const indices = new Map(keys.map(function (key, i) { return [key, i]; }));
  value.routingOrder = value.routingOrder.map(function (group) { return group.map(function (key) { return indices.get(key); }); });
  return value;
}
function expand(value) {
  list(value.coordinates, 70000).forEach(number);
  strings(value.families, 16000, 256);
  strings(value.ids, 500, 80); strings(value.relationIds, 2000, 80);
  const keys = Array.from(new Set(value.ids.concat(value.relationIds, value.families)));
  function coordinate(i) { index(i, value.coordinates.length); return value.coordinates[i]; }
  return Object.assign({}, value, {
    nodes: list(value.nodes, 500).map(function (row) { tuple(row, 4); return [row[0], coordinate(row[1]), coordinate(row[2]), row[3]]; }),
    lines: list(value.lines, 16000).map(function (row) { tuple(row, 6); return [row[0], coordinate(row[1]), coordinate(row[2]), coordinate(row[3]), coordinate(row[4]), row[5]]; }),
    junctions: list(value.junctions, 2000).map(function (row) { tuple(row, 3); return [coordinate(row[0]), coordinate(row[1]), row[2]]; }),
    crossings: list(value.crossings, 32000).map(function (row) { tuple(row, 3); return [coordinate(row[0]), coordinate(row[1]), row[2]]; }),
    routingOrder: list(value.routingOrder, 18500).map(function (group) { return list(group, 18500).map(function (i) { index(i, keys.length); return keys[i]; }); })
  });
}
function packWires(layout, ids, relationIds) {
  const people = new Map(ids.map(function (id, i) { return [id, i]; }));
  const relations = new Map(relationIds.map(function (id, i) { return [id, i]; }));
  return {
    lines: layout.lines.filter(function (line) { return !line.isFlow; }).map(function (line) {
      return [ROLES.indexOf(line.lineRole), line.x1, line.y1, line.x2, line.y2,
        line.relationIds.map(function (id) { return relations.get(id); }).sort(function (a, b) { return a - b; })];
    }),
    junctions: layout.junctions.map(function (item) {
      return [item.x, item.y, item.parentIds.map(function (id) { return people.get(id); }).sort(function (a, b) { return a - b; })];
    }),
    crossings: layout.crossings.map(function (item) { return [item.x, item.y, item.isSpouse ? 1 : 0]; })
  };
}
function create(persons, relations, nameLayout, sourceRevision, rankVersion) {
  const version = rankVersion === undefined ? 2 : rankVersion;
  const layout = graph.layoutGraph(persons, relations, { mode: 'full', nameLayout: nameLayout, collapsedIds: [], selectedPersonId: '', contentScale: 1, rankVersion: version });
  const ids = layout.nodes.map(function (node) { return node._id; });
  const people = new Map(ids.map(function (id, i) { return [id, i]; }));
  // Preserve the exact input order used by the client's wire algorithm too.
  const active = relations.filter(function (r) { return r.status !== 'deleted' && people.has(r.fromPersonId) && people.has(r.toPersonId); }).slice().sort(function (a, b) {
    return a.type.localeCompare(b.type) || a.fromPersonId.localeCompare(b.fromPersonId) || a.toPersonId.localeCompare(b.toPersonId);
  });
  const relationIds = active.map(function (r) { return r._id; });
  const parentOrders = childRank.build(persons, active).parentOrders;
  const routingOrder = [];
  routingKeys(layout, ids, relationIds).sort(function (a, b) { return a.localeCompare(b); }).forEach(function (key) {
    const previous = routingOrder[routingOrder.length - 1];
    if (previous && previous[0].localeCompare(key) === 0) previous.push(key);
    else routingOrder.push([key]);
  });
  const snapshot = Object.assign({
    version: version, sourceRevision: sourceRevision, nameLayout: layout.nameLayout,
    size: [layout.width, layout.height, layout.nodeWidth, layout.nodeHeight], ids: ids, relationIds: relationIds,
    nodes: layout.nodes.map(function (node, i) { return [i, node.x, node.y, node.childRankParentId ? people.get(node.childRankParentId) : -1]; }),
    orders: Object.keys(parentOrders).map(function (id) { return [people.get(id), parentOrders[id].map(function (child) { return people.get(child); })]; }),
    routingOrder: routingOrder
  }, packWires(layout, ids, relationIds));
  compact(snapshot, layout); structure(snapshot);
  return snapshot;
}
function structure(value) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  if (value.version !== 1 && value.version !== 2) throw Object.assign(new Error('请更新小程序后重新生成家谱图'), { code: 'PDF_LAYOUT_UNSUPPORTED' });
  check(Object.keys(value).length === KEYS.length && Object.keys(value).every(function (key) { return KEYS.indexOf(key) >= 0; }));
  const encoded = value;
  value = expand(value);
  check(Number.isSafeInteger(value.sourceRevision) && value.sourceRevision >= 0);
  check(value.nameLayout === 'horizontal' || value.nameLayout === 'vertical');
  tuple(value.size, 4).forEach(number);
  check(value.size[0] >= 750 && value.size[1] >= 900 && value.size[2] === (value.nameLayout === 'vertical' ? 88 : 168) && value.size[3] === 164);
  strings(value.ids, 500, 80); check(value.ids.length > 0);
  strings(value.relationIds, 2000, 80);
  check(list(value.nodes, 500).length === value.ids.length);
  const seen = new Set();
  value.nodes.forEach(function (row) {
    tuple(row, 4); index(row[0], value.ids.length); check(!seen.has(row[0])); seen.add(row[0]);
    number(row[1]); number(row[2]);
    check(row[1] + value.size[2] <= value.size[0] && row[2] + value.size[3] <= value.size[1]);
    if (row[3] !== -1) index(row[3], value.ids.length);
  });
  const parents = new Set();
  list(value.orders, 500).forEach(function (row) {
    tuple(row, 2); index(row[0], value.ids.length); check(!parents.has(row[0])); parents.add(row[0]);
    list(row[1], 500).forEach(function (i) { index(i, value.ids.length); }); check(new Set(row[1]).size === row[1].length);
  });
  const routing = new Set();
  list(value.routingOrder, 18500).forEach(function (group) {
    check(list(group, 18500).length > 0);
    group.forEach(function (key) { check(typeof key === 'string' && key.length <= 256 && !routing.has(key)); routing.add(key); });
  });
  check(routing.size <= 18500);
  list(value.lines, 16000).forEach(function (row) {
    tuple(row, 6); index(row[0], ROLES.length);
    row.slice(1, 5).forEach(number);
    check(row[1] <= value.size[0] && row[3] <= value.size[0] && row[2] <= value.size[1] && row[4] <= value.size[1]);
    check(row[1] === row[3] || row[2] === row[4]);
    list(row[5], 2000).forEach(function (i) { index(i, value.relationIds.length); });
    check(row[5].length > 0 && new Set(row[5]).size === row[5].length);
  });
  list(value.junctions, 2000).forEach(function (row) {
    tuple(row, 3); number(row[0]); number(row[1]); tuple(row[2], 2).forEach(function (i) { index(i, value.ids.length); });
  });
  list(value.crossings, 32000).forEach(function (row) { tuple(row, 3); number(row[0]); number(row[1]); check(row[2] === 0 || row[2] === 1); });
  // The API gzip-compresses this private geometry before storing the task.
  try { check(encodeURIComponent(JSON.stringify(encoded)).replace(/%[A-F\d]{2}|./g, 'x').length <= 768000); }
  catch (error) { check(false); }
  return encoded;
}
function validateOrder(items, orderedIds) {
  check(items.length === orderedIds.length && items.every(function (item) { return orderedIds.indexOf(item.person._id) >= 0; }));
  const byId = new Map(items.map(function (item, i) { return [item.person._id, i]; }));
  const outgoing = items.map(function () { return []; });
  const indegree = items.map(function () { return 0; });
  for (let a = 0; a < items.length; a += 1) for (let b = a + 1; b < items.length; b += 1) {
    const order = childRank.comparableDateOrder(items[a].person, items[b].person);
    if (!order) continue;
    const from = order < 0 ? a : b; const to = order < 0 ? b : a;
    outgoing[from].push(to); indegree[to] += 1;
  }
  const available = new Set();
  indegree.forEach(function (value, i) { if (!value) available.add(i); });
  orderedIds.forEach(function (id) {
    const chosen = byId.get(id); check(available.has(chosen));
    available.forEach(function (i) { check(childRank.compareFallback(items[i], items[chosen], true) >= 0); });
    available.delete(chosen);
    outgoing[chosen].forEach(function (i) { indegree[i] -= 1; if (!indegree[i]) available.add(i); });
  });
}
function sameRows(actual, expected) {
  check(actual.length === expected.length);
  const a = actual.map(function (row) { return JSON.stringify(row); }).sort(); const b = expected.map(function (row) { return JSON.stringify(row); }).sort();
  check(a.every(function (row, i) { return row === b[i]; }));
}
function restore(value, persons, relations, sourceRevision, nameLayout) {
  structure(value);
  value = expand(value);
  if (value.sourceRevision !== sourceRevision) throw Object.assign(new Error(MESSAGE), { code: 'PDF_GRAPH_CHANGED' });
  check(value.nameLayout === nameLayout);
  const people = new Map(persons.map(function (person) { return [person._id, person]; }));
  const relationMap = new Map(relations.map(function (relation) { return [relation._id, relation]; }));
  check(people.size === persons.length && relationMap.size === relations.length);
  check(people.size === value.ids.length && relationMap.size === value.relationIds.length);
  value.ids.forEach(function (id) { check(people.has(id)); });
  const orderedRelations = value.relationIds.map(function (id) { check(relationMap.has(id)); return relationMap.get(id); });
  const byParent = childRank.activeItems(persons, relations);
  const parentOrders = Object.create(null); const parentChoices = Object.create(null);
  value.orders.forEach(function (row) {
    const id = value.ids[row[0]]; check(byParent[id]);
    const ids = row[1].map(function (i) { return value.ids[i]; });
    validateOrder(Object.keys(byParent[id].childrenById).map(function (childId) { return byParent[id].childrenById[childId]; }), ids);
    parentOrders[id] = ids;
  });
  check(Object.keys(parentOrders).length === Object.keys(byParent).length);
  value.nodes.forEach(function (row) { if (row[3] !== -1) parentChoices[value.ids[row[0]]] = value.ids[row[3]]; });
  const ranks = childRank.build(persons, orderedRelations, { parentOrders: parentOrders, parentChoices: parentChoices, legacyParentPriority: value.version === 1 }).byPerson;
  const nodes = value.nodes.map(function (row) {
    const id = value.ids[row[0]]; const rank = ranks[id];
    check((rank ? rank.childRankParentId : '') === (row[3] === -1 ? '' : value.ids[row[3]]));
    return Object.assign({}, people.get(id), rank || {}, { x: row[1], y: row[2] });
  });
  // Reject overlapping cards; a client cannot hide a member behind another.
  nodes.forEach(function (a, i) { nodes.slice(i + 1).forEach(function (b) {
    check(a.x + value.size[2] <= b.x || b.x + value.size[2] <= a.x || a.y + value.size[3] <= b.y || b.y + value.size[3] <= a.y);
  }); });
  const positions = new Map(nodes.map(function (node) { return [node._id, node]; }));
  relations.forEach(function (relation) {
    const parent = positions.get(relation.fromPersonId); const child = positions.get(relation.toPersonId);
    check(parent && child && relation.fromPersonId !== relation.toPersonId);
    check(relation.type === 'spouse' ? parent.y === child.y : relation.type === 'parent_child' && parent.y < child.y);
  });
  const routing = new Map();
  value.routingOrder.forEach(function (group, i) { group.forEach(function (key) { routing.set(key, i); }); });
  const wires = graph.connectionsForNodes(nodes, orderedRelations, nameLayout, function (a, b) {
    check(routing.has(a) && routing.has(b)); return routing.get(a) - routing.get(b);
  });
  check(!wires.requiredShifts.length && !wires.requiredTopShift);
  const allowedKeys = routingKeys(wires, value.ids, value.relationIds);
  check(allowedKeys.length === routing.size && allowedKeys.every(function (key) { return routing.has(key); }));
  const packed = packWires(wires, value.ids, value.relationIds);
  sameRows(value.lines, packed.lines); sameRows(value.junctions, packed.junctions); sameRows(value.crossings, packed.crossings);
  return Object.assign({ nodes: nodes, width: value.size[0], height: value.size[1], nodeWidth: value.size[2], nodeHeight: value.size[3], nameLayout: nameLayout }, wires);
}
module.exports = { create: create, structure: structure, restore: restore };
