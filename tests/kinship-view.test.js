const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const graph = require('../miniprogram/utils/graph-layout');
const kinship = require('../miniprogram/utils/kinship');

function family() {
  return {
    persons: [{ _id: 'me', name: '视角甲', gender: 'male' }, { _id: 'child', name: '孩子', gender: 'male' }, { _id: 'spouse', name: '儿媳', gender: 'female' }, { _id: 'inlaw', name: '亲家', gender: 'male' }],
    relations: [
      { _id: 'r1', type: 'parent_child', fromPersonId: 'me', toPersonId: 'child' },
      { _id: 'r2', type: 'spouse', fromPersonId: 'child', toPersonId: 'spouse' },
      { _id: 'r3', type: 'parent_child', fromPersonId: 'inlaw', toPersonId: 'spouse' }
    ]
  };
}
function pageInstance(pageName) {
  const previousApp = global.getApp;
  const previousPage = global.Page;
  let definition;
  global.getApp = () => ({});
  global.Page = page => { definition = page; };
  const modulePath = require.resolve('../miniprogram/pages/' + pageName + '/index');
  delete require.cache[modulePath];
  try { require(modulePath); } finally { global.getApp = previousApp; global.Page = previousPage; }
  const data = family();
  const calls = [];
  const instance = Object.assign({}, definition, { data: Object.assign({}, definition.data, { rawPersons: data.persons, rawRelations: data.relations, viewMode: 'perspective', viewpointId: 'me', viewpointName: '视角甲', nameLayout: 'horizontal', collapsedPersonIds: [] }) });
  instance.setData = function (patch, callback) { calls.push(patch); Object.assign(instance.data, patch); if (callback) callback(); };
  instance.fitGraph = function () {};
  return { instance, calls };
}

test('折叠不改变仍可见亲家公的称谓、路径和多重关系信息', () => {
  const { persons, relations } = family();
  const before = graph.layoutGraph(persons, relations, { mode: 'perspective', viewpointId: 'me' });
  const after = graph.layoutGraph(persons, relations, { mode: 'perspective', viewpointId: 'me', collapsedIds: ['me'] });
  assert.equal(after.nodes.length, 2);
  assert.equal(after.nodes.find(p => p._id === 'inlaw').relationLabel, '亲家公');
  assert.deepEqual(after.kinshipDetails.inlaw, before.kinshipDetails.inlaw);
  assert.deepEqual(after.kinshipDetails.inlaw.paths[0].personIds, ['me', 'child', 'spouse', 'inlaw']);
});

test('横竖排视角使用同一称谓，竖排节点和连线使用新增的高度', () => {
  const { persons, relations } = family();
  const horizontal = graph.layoutGraph(persons, relations, { mode: 'perspective', viewpointId: 'me' });
  const vertical = graph.layoutGraph(persons, relations, { mode: 'perspective', viewpointId: 'me', nameLayout: 'vertical' });
  assert.equal(vertical.nodeHeight, 212);
  assert.equal(vertical.nodeWidth, 112);
  assert.deepEqual(vertical.kinships, horizontal.kinships);
  assert.ok(vertical.nodes.every(p => p.style.includes('height:212rpx')));
  const full = graph.layoutGraph(persons, relations, { mode: 'full', nameLayout: 'vertical' });
  assert.equal(full.nodeHeight, 164);
  assert.deepEqual(full.kinshipDetails, {});
  assert.ok(full.nodes.every(p => p.relationLabel === ''));
  const parent = vertical.nodes.find(p => p._id === 'me');
  assert.ok(vertical.lines.some(line => line.lineRole === 'trunk' && line.style.includes('top:' + (parent.y + vertical.nodeHeight - 1) + 'rpx')), '连线含 1rpx 接缝重叠，应从实际卡片底部出发');
});

for (const pageName of ['tree', 'example']) {
  test(pageName + '：仅打开卡片时传路径，交互复用计算，视角和资料变化重算', () => {
    const { instance, calls } = pageInstance(pageName);
    instance.renderGraph('perspective', 'me', { preserveViewport: true });
    const first = instance._lastLayout.kinshipDetails;
    assert.equal(instance.data.selectedKinship, null);
    assert.ok(!JSON.stringify(calls.at(-1).nodes).includes('personIds'));
    assert.ok(!('kinshipDetails' in calls.at(-1)));
    instance.renderGraph('perspective', 'me', { preserveViewport: true, nameLayout: 'vertical', collapsedPersonIds: ['me'] });
    assert.strictEqual(instance._lastLayout.kinshipDetails, first);
    instance.openMemberActions({ currentTarget: { dataset: { id: 'inlaw' } } });
    assert.equal(instance.data.selectedKinship.entries[0].label, '亲家公');
    assert.equal(instance.data.selectedKinship.entries[0].pathText, '视角甲 → 孩子 → 儿媳 → 亲家');
    instance.data.rawPersons[3].name = '亲家新名';
    instance.openMemberActions({ currentTarget: { dataset: { id: 'inlaw' } } });
    assert.ok(instance.data.selectedKinship.entries[0].pathText.endsWith('亲家新名'));
    instance.renderGraph('perspective', 'child', { preserveViewport: true, statePatch: { viewMode: 'perspective', viewpointId: 'child' } });
    assert.notStrictEqual(instance._lastLayout.kinshipDetails, first);
    assert.equal(instance.data.selectedKinship.viewpointName, '孩子');
    assert.equal(instance.data.selectedKinship.entries[0].label, '岳父');
    instance.data.rawPersons[3].gender = 'female';
    instance.renderGraph('perspective', 'child', { preserveViewport: true });
    assert.equal(instance.data.selectedKinship.entries[0].label, '岳母');
    instance.renderGraph('full', '', { preserveViewport: true, statePatch: { viewMode: 'full', viewpointId: '' } });
    assert.equal(instance.data.selectedKinship, null);
    assert.ok(instance.data.nodes.every(p => !p.relationLabel));
  });
}

test('成员卡区分真实的多个称谓与资料不足，完整保留长路径', () => {
  const { persons, relations } = family();
  const details = kinship.calculateKinshipDetails(persons, relations, 'me', { maxStates: 1 });
  const card = kinship.memberKinshipCard(details, 'inlaw', '视角甲', persons);
  assert.equal(card.entries[0].description, '儿子的妻子的父亲');
  assert.equal(card.truncated, true);
  assert.equal(card.multiple, false);
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/templates/kinship-card.wxml'), 'utf8');
  assert.ok(wxml.includes('{{item.description}}') && wxml.includes('{{item.pathText}}') && wxml.includes('{{card.truncated}}'));
  for (const name of ['tree', 'example']) {
    const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/' + name + '/index.wxml'), 'utf8');
    const vertical = template.slice(template.indexOf('class="node-name node-name-vertical"'), template.indexOf('</block>', template.indexOf('class="node-name node-name-vertical"')));
    assert.ok(vertical.includes('item.relationLabel'));
    assert.ok(template.includes('item.hasMultipleKinships'));
    assert.ok(template.includes('is="kinship-card"'));
  }
});

test('500 人首次视角计算含词表冷启动小于 1 秒', () => {
  const script = `
    const k = require('./miniprogram/utils/kinship');
    const persons = [], relations = [];
    for (let i = 0; i < 500; i++) {
      persons.push({_id: 'p'+i, gender: i % 2 ? 'male' : 'female'});
      if (i) relations.push({_id: 'r'+i, type: 'parent_child', fromPersonId: 'p'+Math.floor((i-1)/2), toPersonId: 'p'+i});
    }
    const start = performance.now();
    const details = k.calculateKinshipDetails(persons, relations, 'p42');
    console.log(JSON.stringify({elapsed: performance.now()-start, count: Object.keys(details).length, truncated: details.p42.truncated}));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const measurement = JSON.parse(result.stdout);
  assert.equal(measurement.count, 500);
  assert.equal(measurement.truncated, false);
  assert.ok(measurement.elapsed < 1000, '首次计算耗时 ' + measurement.elapsed + 'ms');
});
