const assert = require('assert');
const graph = require('../miniprogram/utils/graph-layout');

const persons = [
  { _id: 'grandfather', name: '爷爷', gender: 'male', status: 'active' },
  { _id: 'grandmother', name: '奶奶', gender: 'female', status: 'active' },
  { _id: 'father', name: '父亲', gender: 'male', status: 'active' },
  { _id: 'mother', name: '母亲', gender: 'female', status: 'active' },
  { _id: 'child', name: '孩子', gender: 'female', status: 'active' }
];

const relations = [
  { _id: 'r1', type: 'spouse', fromPersonId: 'grandfather', toPersonId: 'grandmother', status: 'active' },
  { _id: 'r2', type: 'parent_child', fromPersonId: 'grandfather', toPersonId: 'father', status: 'active' },
  { _id: 'r3', type: 'parent_child', fromPersonId: 'grandmother', toPersonId: 'father', status: 'active' },
  { _id: 'r4', type: 'spouse', fromPersonId: 'father', toPersonId: 'mother', status: 'active' },
  { _id: 'r5', type: 'parent_child', fromPersonId: 'father', toPersonId: 'child', status: 'active' },
  { _id: 'r6', type: 'parent_child', fromPersonId: 'mother', toPersonId: 'child', status: 'active' }
];

const kinships = graph.calculateKinships(persons, relations, 'child');
assert.strictEqual(kinships.child, '当前成员');
assert.strictEqual(kinships.father, '父亲');
assert.strictEqual(kinships.mother, '母亲');
assert.strictEqual(kinships.grandfather, '爷爷');
assert.strictEqual(kinships.grandmother, '奶奶');

const full = graph.layoutGraph(persons, relations, { mode: 'full', viewpointId: '' });
assert.strictEqual(full.nodes.length, persons.length);
assert.strictEqual(full.lines.length, relations.length);
assert.ok(full.nodes.every(function (node) { return node.relationLabel === ''; }));
assert.ok(full.width >= 750);
assert.ok(full.height >= 900);

const perspective = graph.layoutGraph(persons, relations, { mode: 'perspective', viewpointId: 'child' });
assert.strictEqual(perspective.nodes.find(function (node) { return node._id === 'father'; }).relationLabel, '父亲');
assert.strictEqual(perspective.nodes.find(function (node) { return node._id === 'child'; }).isViewpoint, true);

console.log('graph layout tests passed');
