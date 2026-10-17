const nodePresentation = require('./node-presentation');

// Keep descendant branches fixed; only tuck childless spouse units into the
// unused space beside them. All ordering and ancestry reservations come from
// the complete graph, before any branches are hidden.
function compact(graph, relations, metrics, connect) {
  const runs = [];
  Object.keys(graph.unitsByGeneration).forEach(function (level) {
    const row = graph.unitsByGeneration[level].slice().sort(function (a, b) { return a.x - b.x; });
    const groups = [];
    row.forEach(function (unit) {
      const parent = graph.primaryParentByRoot[unit._id];
      const source = graph.familySourceByChildRoot[unit._id];
      const key = parent && source ? parent + '\0' + source.key : 'root:' + unit._id;
      const previous = groups[groups.length - 1];
      if (previous && previous.key === key) previous.units.push(unit);
      else groups.push({ key: key, units: [unit] });
    });
    groups.forEach(function (group) {
      const units = group.units;
      if (!units.some(function (unit) { return graph.childrenByRoot[unit._id].length; })) return;
      function movable(unit) {
        // A spouse with a second ancestral family must retain that family's
        // alignment. Such units act as additional fixed boundaries.
        return !graph.childrenByRoot[unit._id].length && graph.parentRoots[unit._id].length === 1;
      }
      let index = 0;
      while (index < units.length) {
        if (!movable(units[index])) { index += 1; continue; }
        const start = index;
        while (index < units.length && movable(units[index])) index += 1;
        const members = units.slice(start, index);
        const left = units[start - 1]; const right = units[index];
        const width = members.reduce(function (sum, unit) { return sum + unit.width; }, 0) + (members.length - 1) * metrics.unitGap;
        const minimum = left ? left.x + left.width + metrics.unitGap : -Infinity;
        const maximum = right ? right.x - metrics.unitGap - width : Infinity;
        if (minimum > maximum) continue;
        let x = left && right ? (minimum + maximum) / 2 : left ? minimum : maximum;
        const changes = members.map(function (unit) {
          const change = { unit: unit, before: unit.x, target: x };
          x += unit.width + metrics.unitGap;
          return change;
        });
        if (changes.some(function (change) { return Math.abs(change.target - change.before) > 0.01; })) runs.push(changes);
      }
    });
  });
  if (!runs.length) return;

  const nodes = {};
  const unitByPerson = {};
  graph.units.forEach(function (unit) {
    unit.members.forEach(function (person) {
      unitByPerson[person._id] = unit;
      nodes[person._id] = { _id: person._id, x: unit.x + unit.memberOffsets[person._id],
        y: metrics.marginY + unit.generation * metrics.gapY,
        width: nodePresentation.width(person.name, metrics.nodeWidth, metrics.nameLayout === 'vertical', metrics.legacyGeometry) };
    });
  });
  function update(unit) {
    unit.members.forEach(function (person) { nodes[person._id].x = unit.x + unit.memberOffsets[person._id]; });
  }
  const baseline = connect(nodes, relations, '', metrics).lines.filter(function (line) { return line.lineRole !== 'spouse'; });
  const ids = Object.keys(nodes);
  function crosses(line, node) {
    return line.y1 === line.y2
      ? line.y1 > node.y + 2 && line.y1 < node.y + metrics.nodeHeight - 2 &&
        Math.max(line.x1, line.x2) > node.x + 2 && Math.min(line.x1, line.x2) < node.x + node.width - 2
      : line.x1 > node.x + 2 && line.x1 < node.x + node.width - 2 &&
        Math.max(line.y1, line.y2) > node.y + 2 && Math.min(line.y1, line.y2) < node.y + metrics.nodeHeight - 2;
  }
  function conflicts(lines) {
    const result = new Map();
    lines.forEach(function (line) {
      if (line.lineRole === 'spouse') return;
      ids.forEach(function (id) {
        if (crosses(line, nodes[id])) result.set(line._id + '\0' + id, { line: line, id: id });
      });
    });
    return result;
  }
  const existing = conflicts(baseline);
  // Stop before crossing an existing ancestor wire, even when there is empty
  // space on its far side. Incoming drops terminate above their own card.
  runs.forEach(function (changes) {
    changes.forEach(function (change) {
      let target = change.target;
      change.unit.members.forEach(function (person) {
        const node = nodes[person._id]; const offset = change.unit.memberOffsets[person._id];
        baseline.forEach(function (line) {
          if (Math.max(line.y1, line.y2) <= node.y + 2 || Math.min(line.y1, line.y2) >= node.y + metrics.nodeHeight - 2) return;
          const low = Math.min(line.x1, line.x2) - offset - node.width - 2;
          const high = Math.max(line.x1, line.x2) - offset + 2;
          if (target > change.before && change.before <= low && target > low) target = low;
          if (target < change.before && change.before >= high && target < high) target = high;
        });
      });
      change.unit.x = target;
      update(change.unit);
    });
    const row = graph.unitsByGeneration[changes[0].unit.generation].slice().sort(function (a, b) {
      const originalA = changes.find(function (change) { return change.unit === a; });
      const originalB = changes.find(function (change) { return change.unit === b; });
      return (originalA ? originalA.before : a.x) - (originalB ? originalB.before : b.x);
    });
    if (row.some(function (unit, i) { return i && row[i - 1].x + row[i - 1].width + metrics.unitGap > unit.x + 0.01; })) {
      changes.forEach(function (change) { change.unit.x = change.before; update(change.unit); });
    }
  });
  // New rail lane assignments can affect distant ancestors too. Restore the
  // involved run if rerouting introduced a card crossing, then validate again.
  const relationById = {};
  relations.forEach(function (relation) { relationById[relation._id] = relation; });
  let pending = runs.filter(function (changes) { return changes.some(function (change) { return change.unit.x !== change.before; }); });
  while (pending.length) {
    const invalid = Array.from(conflicts(connect(nodes, relations, '', metrics).lines).entries())
      .filter(function (entry) { return !existing.has(entry[0]); });
    if (!invalid.length) break;
    const involved = new Set();
    invalid.forEach(function (entry) {
      involved.add(unitByPerson[entry[1].id]);
      entry[1].line.relationIds.forEach(function (id) {
        const relation = relationById[id];
        if (relation) { involved.add(unitByPerson[relation.fromPersonId]); involved.add(unitByPerson[relation.toPersonId]); }
      });
    });
    let rejected = pending.filter(function (changes) { return changes.some(function (change) { return involved.has(change.unit); }); });
    if (!rejected.length) rejected = pending; // A distant rail lane changed.
    rejected.forEach(function (changes) { changes.forEach(function (change) { change.unit.x = change.before; update(change.unit); }); });
    pending = pending.filter(function (changes) { return rejected.indexOf(changes) < 0; });
  }
}

module.exports = { compact: compact };
