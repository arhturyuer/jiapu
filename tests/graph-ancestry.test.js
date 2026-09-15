const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../miniprogram/utils/graph-layout');

function fixture() {
  const persons = [], relations = [];
  function person(id, gender, name) { persons.push({ _id: id, name: name || id, gender: gender || 'male', status: 'active' }); }
  function edge(type, from, to) { relations.push({ _id: type + ':' + from + ':' + to, type, fromPersonId: from, toPersonId: to, status: 'active' }); }
  function parents(child, father, mother, married = true) {
    person(father, 'male'); person(mother, 'female');
    edge('parent_child', father, child); edge('parent_child', mother, child);
    if (married) edge('spouse', father, mother);
  }
  person('child');
  parents('child', 'father', 'mother');
  parents('father', 'pgf', 'pgm');
  parents('mother', 'mgf', 'mgm');
  return { persons, relations, person, edge, parents };
}
function layout(f, options) { return graph.layoutGraph(f.persons, f.relations, options || {}); }
function node(result, id) { return result.nodes.find(n => n._id === id); }
function center(result, id) { return node(result, id).x + result.nodeWidth / 2; }
function checkSides(result, child, father, mother) {
  assert.ok(center(result, father) < center(result, mother), father + ' must be left of ' + mother);
  assert.ok(center(result, child) >= center(result, father) && center(result, child) <= center(result, mother), child + ' must be below its parents');
  assert.equal(node(result, father).y, node(result, mother).y);
  assert.ok(node(result, father).y < node(result, child).y);
}
function geometry(result) {
  for (let i = 0; i < result.nodes.length; i++) for (let j = i + 1; j < result.nodes.length; j++) {
    const a = result.nodes[i], b = result.nodes[j];
    assert.ok(Math.abs(a.x - b.x) >= result.nodeWidth || Math.abs(a.y - b.y) >= result.nodeHeight, 'cards overlap: ' + a._id + ', ' + b._id);
  }
  for (const line of result.lines) {
    const x = Number(/left:([^r]+)rpx/.exec(line.style)[1]);
    const y = Number(/top:([^r]+)rpx/.exec(line.style)[1]);
    const length = Number(/width:([^r]+)rpx/.exec(line.style)[1]);
    const angle = Number(/rotate\(([^d]+)deg\)/.exec(line.style)[1]) * Math.PI / 180;
    const x2 = x + Math.cos(angle) * length, y2 = y + Math.sin(angle) * length;
    for (const card of result.nodes) {
      const crossed = Math.abs(y2 - y) < 1
        ? y > card.y + 2 && y < card.y + result.nodeHeight - 2 && Math.max(x, x2) > card.x + 2 && Math.min(x, x2) < card.x + result.nodeWidth - 2
        : x > card.x + 2 && x < card.x + result.nodeWidth - 2 && Math.max(y, y2) > card.y + 2 && Math.min(y, y2) < card.y + result.nodeHeight - 2;
      assert.equal(crossed, false, 'line crosses card: ' + line._id + ' -> ' + card._id);
    }
  }
}
function coordinates(result) { return Object.fromEntries(result.nodes.map(n => [n._id, [n.x, n.y]])); }

function addChildren(f, parentIds, children) {
  children.forEach(function (child) {
    f.person(child.id, child.gender || 'male');
    f.persons.find(function (person) { return person._id === child.id; }).birthDate = child.birthDate || '';
    parentIds.forEach(function (parentId) { f.edge('parent_child', parentId, child.id); });
  });
}

test('both ancestral families follow the correct spouse, in horizontal and vertical layouts', () => {
  const f = fixture();
  for (const nameLayout of ['horizontal', 'vertical']) {
    const result = layout(f, { nameLayout });
    checkSides(result, 'child', 'father', 'mother');
    checkSides(result, 'father', 'pgf', 'pgm');
    checkSides(result, 'mother', 'mgf', 'mgm');
    assert.ok(center(result, 'pgm') < center(result, 'mgf'));
    geometry(result);
  }
});

test('ancestor names and insertion order cannot swap the two lineages', () => {
  const f = fixture(), initial = coordinates(layout(f));
  f.persons.reverse(); f.relations.reverse();
  assert.deepEqual(coordinates(layout(f)), initial);
  f.persons.forEach(p => { if (p._id.endsWith('gf') || p._id.endsWith('gm')) p.name = '祖先改名' + (100 - p._id.charCodeAt(0)); });
  assert.deepEqual(coordinates(layout(f)), initial);
});

test('deeper lineages retain their sides and shorter lineages leave space above', () => {
  const f = fixture();
  f.parents('pgf', 'great-f', 'great-m');
  f.parents('great-f', 'older-f', 'older-m');
  const result = layout(f);
  checkSides(result, 'father', 'pgf', 'pgm');
  checkSides(result, 'mother', 'mgf', 'mgm');
  checkSides(result, 'pgf', 'great-f', 'great-m');
  assert.equal(node(result, 'pgf').y, node(result, 'mgf').y);
  assert.ok(node(result, 'mgf').y > node(result, 'older-f').y);
  geometry(result);
});

test('collapsing preserves lineage order; highlighting and changing viewpoint preserve coordinates', () => {
  const f = fixture(), original = layout(f);
  const folded = layout(f, { collapsedIds: ['father'] });
  const before = coordinates(original);
  for (const a of folded.nodes) for (const b of folded.nodes) {
    assert.equal(Math.sign(a.x - b.x), Math.sign(before[a._id][0] - before[b._id][0]));
    assert.equal(Math.sign(a.y - b.y), Math.sign(before[a._id][1] - before[b._id][1]));
  }
  assert.ok(folded.width <= original.width);
  geometry(folded);
  assert.deepEqual(coordinates(layout(f, { selectedPersonId: 'mother' })), before);
  const perspective = layout(f, { mode: 'perspective', viewpointId: 'child' });
  assert.deepEqual(coordinates(perspective), before);
  assert.equal(node(perspective, 'mgf').relationLabel, '外公');
});

test('parents without marriage, single parents and disconnected members remain visible', () => {
  const f = fixture();
  f.relations = f.relations.filter(r => r.type !== 'spouse');
  f.person('isolated', 'unknown');
  const result = layout(f);
  assert.equal(result.nodes.length, f.persons.length);
  checkSides(result, 'child', 'father', 'mother');
  geometry(result);
  f.relations = f.relations.filter(r => r.fromPersonId !== 'pgm');
  geometry(layout(f));
});

test('shared ancestors are rendered once and retain connections to both branches', () => {
  const f = fixture();
  f.parents('pgf', 'shared-f', 'shared-m');
  f.edge('parent_child', 'shared-f', 'mgf');
  f.edge('parent_child', 'shared-m', 'mgf');
  const result = layout(f);
  assert.equal(result.nodes.filter(n => n._id === 'shared-f').length, 1);
  for (const child of ['pgf', 'mgf']) assert.ok(result.lines.some(l => l.lineRole === 'drop' && l._id.endsWith('-' + child)));
  geometry(result);
});

test('shared ancestors reached at different depths keep long connections outside cards', () => {
  const f = fixture();
  f.parents('pgf', 'shared-f', 'shared-m');
  f.edge('parent_child', 'shared-f', 'mother');
  f.person('unknown-parent', 'unknown');
  f.edge('parent_child', 'unknown-parent', 'mother');
  geometry(layout(f, { selectedPersonId: 'mother' }));
});

test('extended descendants and separate marriages preserve child sequence', () => {
  const f = fixture();
  for (const id of ['uncle', 'aunt', 'sibling', 'other-spouse', 'other-child']) f.person(id, id === 'aunt' || id === 'other-spouse' ? 'female' : 'male');
  f.persons.find(p => p._id === 'child').birthDate = '1990-01-01';
  f.persons.find(p => p._id === 'sibling').birthDate = '1992-01-01';
  f.edge('parent_child', 'pgf', 'uncle'); f.edge('parent_child', 'pgm', 'uncle');
  f.edge('parent_child', 'mgf', 'aunt'); f.edge('parent_child', 'mgm', 'aunt');
  f.edge('parent_child', 'father', 'sibling'); f.edge('parent_child', 'mother', 'sibling');
  f.edge('spouse', 'father', 'other-spouse');
  f.edge('parent_child', 'father', 'other-child'); f.edge('parent_child', 'other-spouse', 'other-child');
  const result = layout(f);
  assert.ok(center(result, 'child') < center(result, 'sibling'));
  assert.equal(result.nodes.length, f.persons.length);
  geometry(result);
});

test('leaf children stay compact and centered below a family with two ancestral branches', () => {
  const f = fixture();
  addChildren(f, ['child'], [
    { id: 'older-child', birthDate: '2020-01-01' },
    { id: 'younger-child', birthDate: '2022-01-01' }
  ]);
  for (const nameLayout of ['horizontal', 'vertical']) {
    const result = layout(f, { nameLayout: nameLayout });
    const expectedDistance = result.nodeWidth + (nameLayout === 'vertical' ? 52 : 72);
    const olderX = center(result, 'older-child');
    const youngerX = center(result, 'younger-child');
    assert.equal(youngerX - olderX, expectedDistance);
    assert.equal((olderX + youngerX) / 2, center(result, 'child'));
    geometry(result);
  }
});

test('child spacing expands only for the child own spouse and descendant footprint', () => {
  const f = fixture();
  addChildren(f, ['child'], [
    { id: 'older-child', birthDate: '2020-01-01' },
    { id: 'younger-child', birthDate: '2022-01-01' }
  ]);
  f.person('older-spouse', 'female');
  f.person('grandchild-a', 'female');
  f.person('grandchild-b', 'male');
  f.edge('spouse', 'older-child', 'older-spouse');
  f.edge('parent_child', 'older-child', 'grandchild-a');
  f.edge('parent_child', 'older-spouse', 'grandchild-a');
  f.edge('parent_child', 'older-child', 'grandchild-b');
  f.edge('parent_child', 'older-spouse', 'grandchild-b');
  const result = layout(f, { nameLayout: 'vertical' });
  assert.ok(center(result, 'younger-child') - center(result, 'older-child') > 88 + 52);
  assert.ok(center(result, 'younger-child') - center(result, 'older-child') < 500);
  geometry(result);
});

test('a child couple does not inherit the grandparents ancestry reservation', () => {
  const f = fixture();
  f.person('child-spouse', 'female');
  f.edge('spouse', 'child', 'child-spouse');
  addChildren(f, ['child', 'child-spouse'], [
    { id: 'grandchild-a', birthDate: '2020-01-01' },
    { id: 'grandchild-b', birthDate: '2022-01-01' }
  ]);
  for (const nameLayout of ['horizontal', 'vertical']) {
    const result = layout(f, { nameLayout: nameLayout });
    const coupleDistance = result.nodeWidth + (nameLayout === 'vertical' ? 48 : 76);
    const childDistance = result.nodeWidth + (nameLayout === 'vertical' ? 52 : 72);
    assert.equal(center(result, 'child-spouse') - center(result, 'child'), coupleDistance);
    assert.equal(center(result, 'grandchild-b') - center(result, 'grandchild-a'), childDistance);
    assert.equal((center(result, 'grandchild-a') + center(result, 'grandchild-b')) / 2,
      (center(result, 'child') + center(result, 'child-spouse')) / 2);
    geometry(result);
  }
});

test('500-person ancestry graph remains within the existing one-second layout budget', () => {
  const f = fixture();
  for (let i = 0; f.persons.length < 499; i++) f.parents(f.persons[i]._id, 'extra-f-' + i, 'extra-m-' + i);
  const start = Date.now(), result = layout(f);
  assert.equal(result.nodes.length, f.persons.length);
  assert.ok(Date.now() - start < 1000);
  assert.ok(Number.isFinite(result.width) && Number.isFinite(result.height));
});
