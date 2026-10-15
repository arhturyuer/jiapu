const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const graph = require('../miniprogram/utils/graph-layout');
const snapshot = require('../miniprogram/utils/pdf-layout-snapshot');
const server = require('../cloudfunctions/youpuJobs/pdf/shared/pdf-layout-snapshot');
const source = require('../cloudfunctions/youpuUserApi/pdf-graph-source');
const siblingFixture = require('./helpers/sibling-rank-fixture');

test('v2 全谱姐妹排行与 PDF 一致，v1 历史快照保持原排行并兼容执行', () => {
  const data = siblingFixture();
  for (const binary of [true, false]) for (const nameLayout of ['horizontal', 'vertical']) {
    const client = clientRuntime(binary);
    for (const version of [1, 2]) {
      const value = JSON.parse(JSON.stringify(client.snapshot.create(data.persons, data.relations, nameLayout, 3, version)));
      const layout = server.restore(value, data.persons, data.relations, 3, nameLayout);
      const ranks = Object.fromEntries(layout.nodes.map(node => [node._id, node.childRankLabel]));
      assert.equal(value.version, version);
      assert.deepEqual(geometry(layout), geometry(client.graph.layoutGraph(data.persons, data.relations, { mode: 'full', nameLayout, rankVersion: version })));
      assert.deepEqual(['rong', 'ying', 'man'].map(id => ranks[id]), version === 1 ? ['长女', '次女', '长女'] : ['长女', '次女', '三女']);
      if (version === 2) {
        const row = value.nodes.find(row => value.ids[row[0]] === 'man');
        row[3] = value.ids.indexOf('father');
        assert.throws(() => server.restore(value, data.persons, data.relations, 3, nameLayout), { code: 'PDF_LAYOUT_INVALID' });
      }
    }
  }
});
function clientRuntime(binary) {
  const context = vm.createContext({}); const cache = new Map();
  if (binary) vm.runInContext("String.prototype.localeCompare = function(other) { const a = String(this), b = String(other); return a < b ? -1 : a > b ? 1 : 0; };", context);
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const fn = vm.runInContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', context);
    fn(name => load(path.resolve(path.dirname(file), name + '.js')), module, module.exports); return module.exports;
  }
  return { snapshot: load('miniprogram/utils/pdf-layout-snapshot.js'), graph: load('miniprogram/utils/graph-layout.js') };
}
function fixture() {
  const persons = [['father', '永志', 'male'], ['mother', '妻陈秀珍', 'female'], ['jun', '潘荣军', 'male'], ['gui', '潘荣桂', 'male'], ['daughter', '潘荣娟', 'female'], ['wife', '李春瑞', 'female'], ['child', '潘文巨', 'male']].map(row => ({ _id: row[0], name: row[1], gender: row[2] }));
  const relation = (id, type, a, b) => ({ _id: id, type, fromPersonId: a, toPersonId: b });
  const relations = [relation('sp-parent', 'spouse', 'father', 'mother'), relation('sp-jun', 'spouse', 'jun', 'wife')];
  for (const id of ['jun', 'gui', 'daughter']) for (const parent of ['father', 'mother']) relations.push(relation(parent + '-' + id, 'parent_child', parent, id));
  relations.push(relation('jun-child', 'parent_child', 'jun', 'child'), relation('wife-child', 'parent_child', 'wife', 'child'));
  return { persons, relations };
}
function geometry(layout) {
  return JSON.parse(JSON.stringify({ nodes: layout.nodes.map(n => [n._id, n.x, n.y, n.childRankLabel || '', n.childRankParentId || '']),
    size: [layout.width, layout.height, layout.nodeWidth, layout.nodeHeight],
    lines: layout.lines.filter(l => !l.isFlow).map(l => [l.lineRole, l.x1, l.y1, l.x2, l.y2]),
    junctions: layout.junctions.map(j => [j.x, j.y]), crossings: layout.crossings.map(c => [c.x, c.y, c.isSpouse]) }));
}
for (const binary of [true, false]) for (const nameLayout of ['horizontal', 'vertical']) test('跨运行环境复用完整布局：' + (binary ? '字符排序' : '中文排序') + '／' + nameLayout, () => {
  const data = fixture(); const client = clientRuntime(binary);
  const value = JSON.parse(JSON.stringify(client.snapshot.create(data.persons, data.relations, nameLayout, 5)));
  const full = client.graph.layoutGraph(data.persons, data.relations, { mode: 'full', nameLayout });
  const restored = server.restore(value, data.persons, data.relations, 5, nameLayout);
  assert.deepEqual(geometry(restored), geometry(full));
  assert.equal(restored.nodes.find(n => n._id === 'jun').childRankLabel, binary ? '长子' : '次子');
  if (binary) assert.equal(graph.layoutGraph(data.persons, data.relations, { mode: 'full', nameLayout }).nodes.find(n => n._id === 'jun').childRankLabel, '次子');
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes('潘荣军') && !serialized.includes('http') && !serialized.includes('style'));
});
test('PDF 绘制实际使用快照节点、排行及全部静态连线，横竖排仅改变文字绘制', () => {
  const { drawPoster } = require('../cloudfunctions/youpuJobs/pdf/poster');
  const data = fixture(); const client = clientRuntime(true);
  for (const nameLayout of ['horizontal', 'vertical']) {
    const value = JSON.parse(JSON.stringify(client.snapshot.create(data.persons, data.relations, nameLayout, 0)));
    const posterLayout = server.restore(value, data.persons, data.relations, 0, nameLayout);
    const rectangles = []; const points = []; const texts = [];
    const doc = new Proxy({}, { get(target, key) {
      if (key === 'roundedRect') return (...args) => { rectangles.push(args); return doc; };
      if (key === 'moveTo' || key === 'lineTo') return (...args) => { points.push([key, ...args]); return doc; };
      if (key === 'currentLineHeight') return () => 28;
      if (key === 'widthOfString') return text => text.length * 20;
      if (key === 'bufferedPageRange') return () => ({ count: 1 });
      return () => doc;
    } });
    const helper = (...args) => texts.push(args);
    drawPoster(doc, { ...data, name: '虚构对照', posterLayout }, { nameLayout, showGenderColors: true, showChildRankBadge: true }, {}, null, { text: helper, fitText: helper, verticalText: helper });
    const cards = rectangles.filter(row => row[2] === posterLayout.nodeWidth && row[3] === posterLayout.nodeHeight);
    assert.deepEqual(cards.map(row => row.slice(0, 4)), posterLayout.nodes.map(n => [n.x + 64, n.y + 260, posterLayout.nodeWidth, posterLayout.nodeHeight]));
    assert.deepEqual(points.slice(2), posterLayout.lines.flatMap(l => [['moveTo', l.x1 + 64, l.y1 + 260], ['lineTo', l.x2 + 64, l.y2 + 260]]).concat(posterLayout.crossings.flatMap(c => [['moveTo', c.x + 64, c.y + 253], ['lineTo', c.x + 64, c.y + 267]])));
    const jun = posterLayout.nodes.find(n => n._id === 'jun');
    assert.ok(texts.some(args => args[1] === '长子' && args[2] === jun.x + 52));
  }
});
test('资料版本／姓名方向不匹配和未知快照版本必须拒绝', () => {
  const data = fixture(); const value = snapshot.create(data.persons, data.relations, 'horizontal', 7);
  assert.throws(() => server.restore(value, data.persons, data.relations, 8, 'horizontal'), { code: 'PDF_GRAPH_CHANGED' });
  assert.throws(() => server.restore(value, data.persons, data.relations, 7, 'vertical'), { code: 'PDF_LAYOUT_INVALID' });
  assert.throws(() => snapshot.structure({ ...value, version: 999 }), { code: 'PDF_LAYOUT_UNSUPPORTED' });
});
test('遗漏／重复／越权 ID、隐藏成员、伪造连线或交点均拒绝', () => {
  const data = fixture(); const original = snapshot.create(data.persons, data.relations, 'horizontal', 0);
  for (const mutate of [v => v.ids[0] = 'foreign', v => v.ids[1] = v.ids[0], v => v.nodes.pop(), v => v.nodes[1][0] = v.nodes[0][0],
    v => v.nodes[0][1] = Infinity, v => v.nodes[1][1] = v.nodes[0][1], v => v.lines.pop(), v => v.lines[0][1] += 1,
    v => v.lines[0][5] = [9999], v => v.junctions.pop(), v => v.crossings.push([100, 100, 0]), v => v.routingOrder.push(['foreign']),
    v => v.orders.pop(), v => v.nodes.find(row => v.ids[row[0]] === 'jun')[3] = v.ids.indexOf('wife'), v => v.url = 'https://staging.invalid/']) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => server.restore(value, data.persons, data.relations, 0, 'horizontal'), { code: 'PDF_LAYOUT_INVALID' });
  }
});
test('明确日期和已设置手动排行不能被快照交换，重叠区间仍遵守原拓扑顺序', () => {
  for (const dates of [true, false]) {
    const persons = [{ _id: 'parent', name: '家长', gender: 'male' }, { _id: 'a', name: '甲', gender: 'male', birthDate: dates ? '1980' : '' }, { _id: 'b', name: '乙', gender: 'male', birthDate: dates ? '1990' : '' }];
    const relations = persons.slice(1).map((p, i) => ({ _id: 'r' + i, type: 'parent_child', fromPersonId: 'parent', toPersonId: p._id, childOrder: dates ? undefined : i }));
    const value = snapshot.create(persons, relations, 'horizontal', 0);
    value.orders[0][1].reverse();
    assert.throws(() => server.restore(value, persons, relations, 0, 'horizontal'), { code: 'PDF_LAYOUT_INVALID' });
  }
});
test('最近双亲口径与历史农历转换区间完整保留', () => {
  const { normalize } = require('../cloudfunctions/youpuJobs/pdf-export');
  const data = fixture();
  data.relations.find(r => r._id === 'mother-jun').updatedAt = '2026-10-13T00:00:00Z';
  data.persons.find(p => p._id === 'jun').birthDateInfo = { calendar: 'lunar', precision: 'year', year: 1980, month: null, day: null };
  data.persons.find(p => p._id === 'gui').birthDateInfo = { calendar: 'lunar', precision: 'year', year: 1990, month: null, day: null };
  const normalized = normalize(structuredClone(data), 500);
  const value = snapshot.create(normalized.persons, normalized.relations, 'horizontal', 0);
  const layout = server.restore(value, normalized.persons, normalized.relations, 0, 'horizontal');
  const jun = layout.nodes.find(n => n._id === 'jun');
  assert.equal(jun.childRankLabel, '长子'); assert.equal(jun.childRankParentId, 'mother');
  assert.match(jun.birthDateRange.start, /^1980-/);
  assert.equal(normalized.relations.find(r => r._id === 'mother-jun').updatedAt, '2026-10-13T00:00:00Z');
});
test('公开示例使用小程序相同资料投影，不引入隐藏日期、手动排行或头像', () => {
  const data = fixture(); data.persons[2].birthDateInfo = { calendar: 'lunar', year: 1980 }; data.persons[2].avatarAssetId = 'hidden';
  data.relations[2].childOrder = 9;
  const projected = source.exampleGraph(data);
  assert.equal(projected.persons[2].birthDateInfo, undefined); assert.equal(projected.persons[2].avatarAssetId, '');
  assert.equal(projected.relations[2].childOrder, undefined);
  const value = snapshot.create(projected.persons, projected.relations, 'horizontal', 1);
  const layout = server.restore(value, projected.persons, projected.relations, 1, 'horizontal');
  assert.equal(layout.nodes.length, data.persons.length);
});
for (const shape of ['binary', 'wide', 'deep', 'isolated']) test('500 人快照容量、序列化往返与几何完整性：' + shape, () => {
  const persons = Array.from({ length: 500 }, (_, i) => ({ _id: 'p' + i, name: i === 0 ? '同名家长' : '同名成员', gender: i % 2 ? 'male' : 'female' }));
  const relations = shape === 'isolated' ? [] : persons.slice(1).map((p, i) => ({ _id: 'r' + i, type: 'parent_child', fromPersonId: 'p' + (shape === 'wide' ? 0 : shape === 'deep' ? i : Math.floor(i / 2)), toPersonId: p._id }));
  const value = JSON.parse(JSON.stringify(snapshot.create(persons, relations, 'horizontal', 0)));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 400000);
  assert.deepEqual(geometry(server.restore(value, persons, relations, 0, 'horizontal')), geometry(graph.layoutGraph(persons, relations, { mode: 'full' })));
});
test('内存导出会话按入口隔离并只消费一次，导航不包含家谱快照', () => {
  const session = require('../miniprogram/utils/pdf-export-session');
  const data = fixture(); const before = JSON.stringify(data); let navigation;
  global.wx = { navigateTo: input => { navigation = input; }, showToast() {} };
  try {
    require('../miniprogram/utils/pdf-entry').open({ data: { currentFamily: { _id: 'family' }, rawPersons: data.persons, rawRelations: data.relations, contentRevision: 3, nameLayout: 'horizontal', viewMode: 'perspective', collapsedPersonIds: ['jun'], graphContentScale: 2 } }, 'family');
    assert.ok(navigation); assert.ok(!navigation.url.includes('潘') && !navigation.url.includes('nodes'));
    const key = new URL('https://staging.invalid' + navigation.url).searchParams.get('session');
    assert.equal(session.take('wrong'), null);
    const value = session.take(key); assert.equal(value.layoutSnapshot.ids.length, data.persons.length); assert.equal(value.layoutSnapshot.size[2], 168);
    assert.equal(session.take(key), null); assert.equal(JSON.stringify(data), before);
  } finally { delete global.wx; }
});
test('500 人／2000 条密集关系及最长 ID 完整往返，任务压缩后留足码图空间', () => {
  const persons = Array.from({ length: 500 }, (_, i) => ({ _id: String(i).padStart(80, 'p'), name: '同名成员', gender: i % 2 ? 'male' : 'female' }));
  const relations = [];
  for (let i = 0; i < 250; i++) for (let d = 1; d <= 6; d++) relations.push({ _id: ('sp-' + i + '-' + d).padStart(80, 'r'), type: 'spouse', fromPersonId: persons[i]._id, toPersonId: persons[(i + d) % 250]._id });
  for (let i = 250; i < 500; i++) for (let d = 0; d < 2; d++) relations.push({ _id: ('pc-' + i + '-' + d).padStart(80, 'r'), type: 'parent_child', fromPersonId: persons[(i - 250 + d) % 250]._id, toPersonId: persons[i]._id });
  const value = snapshot.create(persons, relations, 'horizontal', 0);
  assert.equal(relations.length, 2000); assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 768000);
  const { gzipSync } = require('node:zlib');
  assert.ok(gzipSync(Buffer.from(JSON.stringify(value))).toString('base64').length + 512000 < 900000);
  assert.equal(server.restore(value, persons, relations, 0, 'horizontal').nodes.length, 500);
});
