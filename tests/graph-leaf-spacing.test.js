const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../miniprogram/utils/graph-layout');
const snapshot = require('../miniprogram/utils/pdf-layout-snapshot');
const fixture = require('./helpers/leaf-spacing-fixture');

function node(layout, id) { return layout.nodes.find(n => n._id === id); }
function positions(layout, ids) { return ids.map(id => { const n = node(layout, id); return [id, n.x, n.y, n.width]; }); }
function gap(layout, a, b) { return node(layout, b).x - node(layout, a).x - node(layout, a).width; }
function layout(f, options) { return graph.layoutGraph(f.persons, f.relations, options); }
function halfSiblings(branch = 'b') {
  const f = fixture([], ['a', 'b', 'c']);
  for (const id of ['mother-a', 'mother-b']) {
    f.person(id, '母亲'); f.persons.find(p => p._id === id).gender = 'female';
    f.edge('root', id, 'spouse');
  }
  f.edge('mother-a', 'a');
  for (const id of ['b', 'c']) f.edge('mother-b', id);
  f.children(branch);
  return f;
}
function ranks(result) {
  return result.nodes.map(n => [n._id, n.childRankParentId, n.childRankLabel, n.childSequenceIndex]);
}
function geometry(result) {
  for (const a of result.nodes) for (const b of result.nodes) {
    if (a._id === b._id) continue;
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'overlapping cards: ' + a._id + '/' + b._id);
  }
  for (const line of result.lines.filter(l => l.lineRole !== 'spouse')) for (const card of result.nodes) {
    const crossed = line.y1 === line.y2
      ? line.y1 > card.y + 2 && line.y1 < card.y + card.height - 2 && Math.max(line.x1, line.x2) > card.x + 2 && Math.min(line.x1, line.x2) < card.x + card.width - 2
      : line.x1 > card.x + 2 && line.x1 < card.x + card.width - 2 && Math.max(line.y1, line.y2) > card.y + 2 && Math.min(line.y1, line.y2) < card.y + card.height - 2;
    assert.equal(crossed, false, line._id + ' crosses ' + card._id);
  }
}

for (const nameLayout of ['horizontal', 'vertical']) {
  const spacing = nameLayout === 'horizontal' ? 72 : 52;
  for (const branch of ['a', 'b']) test(nameLayout + ': half siblings tuck across mothers beside descendant branch ' + branch, () => {
    const f = halfSiblings(branch);
    const original = layout(f, { nameLayout, geometryVersion: 2 });
    const result = layout(f, { nameLayout });
    assert.ok(gap(original, 'a', 'b') > 1000);
    assert.equal(gap(result, 'a', 'b'), spacing);
    assert.equal(gap(result, 'b', 'c'), spacing);
    const fixed = f.persons.map(p => p._id).filter(id => !['a', 'b', 'c'].includes(id) || id === branch);
    assert.deepEqual(positions(result, fixed), positions(original, fixed));
    assert.deepEqual(ranks(result), ranks(original));
    for (const [mother, children] of [['mother-a', ['a']], ['mother-b', ['b', 'c']]]) {
      const rails = result.lines.filter(l => l.lineRole === 'rail' && l.familyKey.startsWith('pair:' + mother + '|root@'));
      assert.equal(rails.length, 1);
      assert.deepEqual(rails[0].relationIds.slice().sort(), children.flatMap(id => ['parent_child:' + mother + ':' + id, 'parent_child:root:' + id]).sort());
      const before = original.lines.find(l => l._id === rails[0]._id);
      assert.ok(rails[0].length <= before.length);
    }
    geometry(result);
    f.children(branch === 'a' ? 'b' : 'a');
    const added = layout(f, { nameLayout });
    assert.ok(gap(added, 'a', 'b') > spacing);
    geometry(added);
  });

  test(nameLayout + ': half siblings preserve spouses, long names, view state and PDF snapshots', () => {
    const f = halfSiblings();
    f.person('wife', '复姓长姓名测试'); f.persons.find(p => p._id === 'wife').gender = 'female';
    f.edge('a', 'wife', 'spouse');
    const result = layout(f, { nameLayout });
    assert.equal(gap(result, 'wife', 'b'), spacing);
    assert.equal(gap(result, 'a', 'wife'), nameLayout === 'horizontal' ? 76 : 48);
    const ids = result.nodes.map(n => n._id);
    assert.deepEqual(positions(layout(f, { nameLayout, selectedPersonId: 'a' }), ids), positions(result, ids));
    const perspective = layout(f, { nameLayout, mode: 'perspective', viewpointId: 'a' });
    assert.equal(gap(perspective, 'wife', 'b'), spacing);
    geometry(perspective);
    const folded = layout(f, { nameLayout, collapsedIds: ['b'] });
    assert.equal(folded.hiddenCount, 20);
    assert.equal(gap(folded, 'wife', 'b'), spacing);
    geometry(folded);
    const value = snapshot.create(f.persons, f.relations, nameLayout, 0);
    for (const source of ['../cloudfunctions/youpuUserApi/pdf-shared/', '../cloudfunctions/youpuJobs/pdf/shared/']) {
      const server = require(source + 'graph-layout');
      assert.deepEqual(server.layoutGraph(f.persons, f.relations, { nameLayout }), result);
      const restored = require(source + 'pdf-layout-snapshot').restore(value, f.persons, f.relations, 0, nameLayout);
      assert.deepEqual(positions(restored, ids), positions(result, ids));
      assert.deepEqual(restored.lines, result.lines);
    }
    const legacy = snapshot.create(f.persons, f.relations, nameLayout, 0, 2);
    const oldLayout = layout(f, { nameLayout, geometryVersion: 2 });
    for (const restore of [snapshot, require('../cloudfunctions/youpuUserApi/pdf-shared/pdf-layout-snapshot'), require('../cloudfunctions/youpuJobs/pdf/shared/pdf-layout-snapshot')]) {
      assert.deepEqual(positions(restore.restore(legacy, f.persons, f.relations, 0, nameLayout), ids), positions(oldLayout, ids));
    }
    f.persons.reverse(); f.relations.reverse();
    assert.deepEqual(layout(f, { nameLayout }), result);
    geometry(result);
  });

  test(nameLayout + ': children of different fathers in one spouse component do not tuck together', () => {
    const f = halfSiblings();
    f.person('other-father', '另一父亲'); f.edge('other-father', 'mother-b', 'spouse');
    f.relations = f.relations.filter(r => !(r.fromPersonId === 'root' && ['b', 'c'].includes(r.toPersonId)));
    for (const id of ['b', 'c']) f.edge('other-father', id);
    const original = layout(f, { nameLayout, geometryVersion: 2 });
    const result = layout(f, { nameLayout });
    assert.deepEqual(positions(result, ['a', 'b']), positions(original, ['a', 'b']));
    assert.ok(gap(result, 'a', 'b') > spacing);
    geometry(result);
  });

  for (const branch of ['a', 'b', 'c']) test(nameLayout + ': childless siblings tuck beside ' + branch + ' without moving its descendants', () => {
    const f = fixture([branch]);
    const result = layout(f, { nameLayout });
    assert.equal(gap(result, 'a', 'b'), spacing);
    assert.equal(gap(result, 'b', 'c'), spacing);
    const legacy = require('./fixtures/leaf-spacing-legacy-v3.json');
    if (nameLayout === 'vertical' && branch === 'b') {
      const before = snapshot.restore(legacy, f.persons, f.relations, 0, nameLayout);
      const fixed = f.persons.map(p => p._id).filter(id => id !== 'a' && id !== 'c');
      assert.deepEqual(positions(result, fixed), positions(before, fixed));
      assert.equal(gap(before, 'a', 'b'), 1382);
    }
    geometry(result);
  });

  test(nameLayout + ': all leaves stay compact; leaf runs on both sides retain sequence and spouses', () => {
    const f = fixture([], ['a', 'b', 'c', 'd', 'e']);
    const allLeaves = layout(f, { nameLayout });
    for (const [a, b] of [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']]) assert.equal(gap(allLeaves, a, b), spacing);
    f.children('c');
    f.person('wife', '复姓长姓名测试'); f.edge('b', 'wife', 'spouse');
    const result = layout(f, { nameLayout });
    for (const [a, b] of [['a', 'b'], ['wife', 'c'], ['c', 'd'], ['d', 'e']]) assert.equal(gap(result, a, b), spacing);
    assert.equal(gap(result, 'b', 'wife'), nameLayout === 'horizontal' ? 76 : 48);
    assert.equal(result.nodes.length, f.persons.length);
    geometry(result);
  });

  test(nameLayout + ': two descendant branches remain separated and intermediate leaves center in the gap', () => {
    const f = fixture(['a', 'e'], ['a', 'b', 'c', 'd', 'e']);
    const result = layout(f, { nameLayout });
    const original = layout(f, { nameLayout, geometryVersion: 2 });
    const fixedIds = f.persons.map(p => p._id).filter(id => !['b', 'c', 'd'].includes(id));
    assert.deepEqual(positions(result, fixedIds), positions(original, fixedIds));
    assert.equal(gap(result, 'b', 'c'), spacing);
    assert.equal(gap(result, 'c', 'd'), spacing);
    assert.ok(Math.abs(gap(result, 'a', 'b') - gap(result, 'd', 'e')) < 0.01);
    const left = result.nodes.filter(n => n._id.startsWith('a-child-'));
    const right = result.nodes.filter(n => n._id.startsWith('e-child-'));
    assert.ok(Math.max(...left.map(n => n.x + n.width)) + spacing <= Math.min(...right.map(n => n.x)));
    f.children('b');
    const added = layout(f, { nameLayout });
    assert.ok(gap(added, 'a', 'b') > spacing);
    geometry(added);
    geometry(result);
  });

  test(nameLayout + ': selection, perspective and input order preserve the sibling packing', () => {
    const f = fixture();
    const full = layout(f, { nameLayout });
    const ids = f.persons.map(p => p._id);
    assert.deepEqual(positions(layout(f, { nameLayout, selectedPersonId: 'b' }), ids), positions(full, ids));
    const perspective = layout(f, { nameLayout, mode: 'perspective', viewpointId: 'c' });
    assert.equal(gap(perspective, 'a', 'b'), spacing);
    assert.equal(gap(perspective, 'b', 'c'), spacing);
    f.persons.reverse(); f.relations.reverse();
    assert.deepEqual(positions(layout(f, { nameLayout }), ids), positions(full, ids));
    const folded = layout(f, { nameLayout, collapsedIds: ['b'] });
    assert.equal(folded.hiddenCount, 20);
    assert.ok(node(folded, 'a').x < node(folded, 'b').x && node(folded, 'b').x < node(folded, 'c').x);
    geometry(folded);
  });

  test(nameLayout + ': browser, API and PDF worker agree on the new full geometry', () => {
    const f = fixture();
    const full = layout(f, { nameLayout });
    const value = snapshot.create(f.persons, f.relations, nameLayout, 0);
    for (const server of [require('../cloudfunctions/youpuUserApi/pdf-shared/pdf-layout-snapshot'), require('../cloudfunctions/youpuJobs/pdf/shared/pdf-layout-snapshot')]) {
      const restored = server.restore(value, f.persons, f.relations, 0, nameLayout);
      assert.deepEqual(positions(restored, value.ids), positions(full, value.ids));
      assert.deepEqual(restored.lines, full.lines);
    }
    geometry(full);
  });

  test(nameLayout + ': separate marriages retain their wires while leaves center between descendant branches', () => {
    const f = fixture();
    f.person('other-parent', '另一家长'); f.edge('root', 'other-parent', 'spouse');
    f.person('d', '成员丁', '1974-01-01'); f.person('e', '成员戊', '1975-01-01');
    for (const id of ['d', 'e']) { f.edge('root', id); f.edge('other-parent', id); }
    f.children('d', 12);
    const result = layout(f, { nameLayout });
    assert.equal(gap(result, 'a', 'b'), spacing);
    assert.equal(gap(result, 'b', 'c'), gap(result, 'c', 'd'));
    assert.equal(gap(result, 'd', 'e'), spacing);
    assert.ok(node(result, 'c').x < node(result, 'd').x);
    const rails = result.lines.filter(l => l.lineRole === 'rail');
    assert.ok(rails.some(l => l.familyKey.startsWith('single:root')));
    assert.ok(rails.some(l => l.familyKey.startsWith('pair:')));
    geometry(result);
  });

  test(nameLayout + ': a spouse with another ancestral family keeps its alignment', () => {
    const f = fixture();
    f.person('wife', '配偶'); f.edge('a', 'wife', 'spouse');
    f.person('other-parent', '另一家长'); f.edge('other-parent', 'wife');
    f.edge('root', 'b-child-0'); // Shared ancestor reached at different depths.
    const result = layout(f, { nameLayout });
    const original = layout(f, { nameLayout, geometryVersion: 2 });
    assert.deepEqual(positions(result, ['a', 'wife']), positions(original, ['a', 'wife']));
    assert.equal(result.nodes.filter(n => n._id === 'root').length, 1);
    geometry(result);
  });
}

test('old v3 PDF restores its original wide positions instead of running the new layout', () => {
  const f = fixture(); const legacy = require('./fixtures/leaf-spacing-legacy-v3.json');
  for (const server of [snapshot, require('../cloudfunctions/youpuUserApi/pdf-shared/pdf-layout-snapshot'), require('../cloudfunctions/youpuJobs/pdf/shared/pdf-layout-snapshot')]) {
    const restored = server.restore(legacy, f.persons, f.relations, 0, 'vertical');
    assert.equal(gap(restored, 'a', 'b'), 1382);
    assert.equal(gap(restored, 'b', 'c'), 1382);
  }
});

function safetyFixture() {
  const units = ['a', 'b', 'c'].map((id, i) => ({ _id: id, generation: 1, x: 80 + i * 720, width: 88,
    members: [{ _id: id, name: '成员' }], memberOffsets: { [id]: 0 } }));
  return { units, unitsByGeneration: { 1: units }, primaryParentByRoot: { a: 'p', b: 'p', c: 'p' },
    familySourceByChildRoot: { a: { key: 'single:p' }, b: { key: 'single:p' }, c: { key: 'single:p' } },
    childrenByRoot: { a: [], b: ['child'], c: [] }, parentRoots: { a: ['p'], b: ['p'], c: ['p'] } };
}
const metrics = { nodeWidth: 88, nodeHeight: 164, unitGap: 52, gapY: 280, marginY: 80, nameLayout: 'vertical' };
test('ancestor transit wires limit inward movement at the nearest safe boundary', () => {
  const f = safetyFixture();
  const wire = { _id: 'long-drop', lineRole: 'drop', x1: 400, x2: 400, y1: 80, y2: 1000, relationIds: [] };
  require('../miniprogram/utils/graph-leaf-spacing').compact(f, [], metrics, () => ({ lines: [wire] }));
  assert.equal(f.units[0].x + 88, 398);
  assert.equal(f.units[1].x, 800);
  assert.equal(f.units[2].x, 940);
});
test('unsafe rerouting restores the affected run while keeping another safe run compact', () => {
  const f = safetyFixture(); let count = 0;
  require('../miniprogram/utils/graph-leaf-spacing').compact(f, [], metrics, nodes => {
    count++;
    return { lines: count === 1 ? [] : [{ _id: 'rerouted', lineRole: 'trunk', x1: 700, x2: 700, y1: 80, y2: 1000, relationIds: [] }] };
  });
  assert.equal(f.units[0].x, 80);
  assert.equal(f.units[1].x, 800);
  assert.equal(f.units[2].x, 940);
});
