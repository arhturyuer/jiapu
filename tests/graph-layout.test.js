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
assert.ok(full.lines.length >= relations.length);
assert.strictEqual(full.junctions.length, 2);
assert.ok(full.nodes.every(function (node) { return node.relationLabel === ''; }));
assert.ok(full.width >= 750);
assert.ok(full.height >= 900);

const fatherNode = full.nodes.find(function (node) { return node._id === 'father'; });
const motherNode = full.nodes.find(function (node) { return node._id === 'mother'; });
assert.strictEqual(fatherNode.y, motherNode.y, '夫妻必须位于同一代');
assert.strictEqual(Math.abs(fatherNode.x - motherNode.x), 168 + 76, '夫妻卡片应紧邻排列');

const selected = graph.layoutGraph(persons, relations, {
  mode: 'full',
  viewpointId: '',
  selectedPersonId: 'child'
});
assert.ok(selected.lines.every(function (line) {
  return ['spouse', 'trunk', 'rail', 'drop'].indexOf(line.lineRole) >= 0;
}), '所有关系线都应携带明确的视觉语义');
assert.ok(selected.lines.some(function (line) { return line.isFlow; }), '选中成员后应生成亲子方向动画层');
assert.ok(selected.junctions.some(function (junction) { return junction.isActive; }), '选中的家庭连接点应高亮');
assert.strictEqual(selected.lines.filter(function (line) {
  return line.isFlow && line.flowRole === 'parent-origin';
}).length, 2, '双亲家庭的动画应分别从父母两侧流向夫妻连接点');
assert.ok(selected.lines.some(function (line) {
  return line.isFlow && line.flowRole === 'family-trunk' && line.flowStep === 1;
}), '动画到达夫妻连接点后应继续流向子女轨道');
const selectedChildRail = selected.lines.find(function (line) {
  return line.isFlow && line.flowRole === 'child-rail';
});
const selectedChildDrop = selected.lines.find(function (line) {
  return line.isFlow && line.flowRole === 'child-drop';
});
assert.ok(selectedChildDrop, '动画最后应沿落线进入子女卡片');
assert.strictEqual(
  selectedChildDrop.flowStep,
  selectedChildRail ? selectedChildRail.flowStep + 1 : 2,
  '落线动画应紧接实际存在的横轨，居中子女不应空等一个动画阶段'
);
assert.ok(selected.lines.filter(function (line) { return line.isFlow; }).every(function (line) {
  return line._id.indexOf('child') >= 0 && line.isAnimatedFlow;
}), '小家庭的高亮线应使用包含选中成员的动画标识并全部播放');

const singleParent = graph.layoutGraph(
  [
    { _id: 'single-parent', name: '父亲', gender: 'male', status: 'active' },
    { _id: 'single-child', name: '孩子', gender: 'female', status: 'active' }
  ],
  [
    { _id: 'single-relation', type: 'parent_child', fromPersonId: 'single-parent', toPersonId: 'single-child', status: 'active' }
  ],
  { mode: 'full', selectedPersonId: 'single-child' }
);
assert.strictEqual(singleParent.lines.filter(function (line) {
  return line.isFlow && line.flowRole === 'parent-origin';
}).length, 0, '单亲家庭不应生成不存在的伴侣入口动画');
assert.ok(singleParent.lines.some(function (line) {
  return line.isFlow && line.flowRole === 'family-trunk' && line.flowStep === 0;
}), '单亲家庭应从父母节点下方直接开始动画');
assert.ok(singleParent.lines.some(function (line) {
  return line.isFlow && line.flowRole === 'child-drop' && line.flowStep >= 1;
}), '单亲家庭动画仍应沿落线进入子女节点');

const perspective = graph.layoutGraph(persons, relations, { mode: 'perspective', viewpointId: 'child' });
assert.strictEqual(perspective.nodes.find(function (node) { return node._id === 'father'; }).relationLabel, '父亲');
assert.strictEqual(perspective.nodes.find(function (node) { return node._id === 'child'; }).isViewpoint, true);

const extendedPersons = [
  { _id: 'me', name: '我', gender: 'male', birthDate: '1990-01-01' },
  { _id: 'wife', name: '妻子', gender: 'female', birthDate: '1991-01-01' },
  { _id: 'father-in-law', name: '岳父', gender: 'male', birthDate: '1960-01-01' },
  { _id: 'father', name: '父亲', gender: 'male', birthDate: '1962-01-01' },
  { _id: 'grandfather', name: '爷爷', gender: 'male', birthDate: '1935-01-01' },
  { _id: 'uncle', name: '叔叔', gender: 'male', birthDate: '1965-01-01' },
  { _id: 'cousin', name: '堂弟', gender: 'male', birthDate: '1993-01-01' }
];
const extendedRelations = [
  { _id: 'e1', type: 'spouse', fromPersonId: 'me', toPersonId: 'wife' },
  { _id: 'e2', type: 'parent_child', fromPersonId: 'father-in-law', toPersonId: 'wife' },
  { _id: 'e3', type: 'parent_child', fromPersonId: 'father', toPersonId: 'me' },
  { _id: 'e4', type: 'parent_child', fromPersonId: 'grandfather', toPersonId: 'father' },
  { _id: 'e5', type: 'parent_child', fromPersonId: 'grandfather', toPersonId: 'uncle' },
  { _id: 'e6', type: 'parent_child', fromPersonId: 'uncle', toPersonId: 'cousin' }
];
const extendedKinships = graph.calculateKinships(extendedPersons, extendedRelations, 'me');
assert.strictEqual(extendedKinships['father-in-law'], '岳父');
assert.strictEqual(extendedKinships.uncle, '叔叔');
assert.strictEqual(extendedKinships.cousin, '堂弟');

const branchPersons = [
  { _id: 'root-f', name: '祖父', gender: 'male' },
  { _id: 'root-m', name: '祖母', gender: 'female' },
  { _id: 'left', name: '长子', gender: 'male', birthDate: '1970-01-01' },
  { _id: 'right', name: '次子', gender: 'male', birthDate: '1972-01-01' },
  { _id: 'left-wife', name: '长媳', gender: 'female' },
  { _id: 'grandchild', name: '孙辈', gender: 'female' }
];
const branchRelations = [
  { _id: 'b1', type: 'spouse', fromPersonId: 'root-f', toPersonId: 'root-m' },
  { _id: 'b2', type: 'parent_child', fromPersonId: 'root-f', toPersonId: 'left' },
  { _id: 'b3', type: 'parent_child', fromPersonId: 'root-f', toPersonId: 'right' },
  { _id: 'b4', type: 'spouse', fromPersonId: 'left', toPersonId: 'left-wife' },
  { _id: 'b5', type: 'parent_child', fromPersonId: 'left', toPersonId: 'grandchild' }
];
const branchLayout = graph.layoutGraph(branchPersons, branchRelations, { mode: 'full' });
const rootLeft = branchLayout.nodes.find(function (node) { return node._id === 'root-f'; });
const rootRight = branchLayout.nodes.find(function (node) { return node._id === 'root-m'; });
const rootCenter = (rootLeft.x + 84 + rootRight.x + 84) / 2;
const childCenters = ['left', 'left-wife', 'right'].map(function (id) {
  return branchLayout.nodes.find(function (node) { return node._id === id; }).x + 84;
});
assert.ok(rootCenter > Math.min.apply(null, childCenters) && rootCenter < Math.max.apply(null, childCenters), '父母组合应居中落在子女分支范围内');

const folded = graph.layoutGraph(branchPersons, branchRelations, { mode: 'full', collapsedIds: ['left'] });
assert.strictEqual(folded.nodes.find(function (node) { return node._id === 'left'; }).hiddenDescendantCount, 1);
assert.strictEqual(folded.hiddenCount, 1);

console.log('graph layout tests passed');
