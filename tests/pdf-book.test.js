const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const PDFDocument = require('node:module').createRequire(path.resolve(__dirname, '../cloudfunctions/youpuJobs/pdf/render.js'))('pdfkit');
const { prepareBook } = require('../cloudfunctions/youpuJobs/pdf/book');
const { bookModel } = require('../cloudfunctions/youpuJobs/pdf/book-model');
const { wrapText, pageBounds, MM } = require('../cloudfunctions/youpuJobs/pdf/book-layout');
const { render } = require('../cloudfunctions/youpuJobs/pdf/render');
const font = path.resolve(__dirname, '../cloudfunctions/youpuJobs/pdf/fonts/NotoSansCJKsc-Regular.otf');
function document() { return new PDFDocument({ autoFirstPage: false }).font(font); }
function fixture(count, shape = 'binary') {
  const persons = Array.from({ length: count }, (_, i) => ({ _id: 'p' + i, name: '测试成员' + i, gender: i % 2 ? 'male' : 'female', lifeStatus: 'living', birthDateInfo: { year: 1980, calendar: 'lunar', precision: 'year' }, bio: '完整虚构简介' }));
  const relations = persons.slice(1).filter(() => shape !== 'isolated').map((p, i) => ({ _id: 'r' + i, type: 'parent_child', fromPersonId: 'p' + (shape === 'wide' ? 0 : shape === 'deep' ? i : Math.floor(i / 2)), toPersonId: p._id }));
  return { name: '虚构大字谱书', description: '完整介绍', exportedAt: '2026-10-07T00:00:00Z', persons, relations };
}
function planFor(data, assets) { const doc = document(); try { return prepareBook(doc, data, assets); } finally { doc.destroy(); } }
function values(plan) { return plan.pages.flatMap(p => p.ops.filter(op => op.type === 'text').map(op => op.value)).join('\n'); }
for (const count of [1, 36, 200, 500]) test('A4 大字谱书 ' + count + ' 人版心、字号、唯一资料与真实跳转目标完整', async () => {
  const data = fixture(count); const plan = planFor(data);
  assert.equal(plan.pages.length % 2, 0);
  assert.equal(plan.pages[0].kind, 'cover'); assert.equal(plan.pages[1].kind, 'blank');
  assert.equal(Object.keys(plan.personPages).length, count);
  const anchors = plan.pages.flatMap(p => p.ops.filter(op => op.type === 'anchor'));
  for (const person of data.persons) {
    assert.equal(anchors.filter(a => a.id === plan.model.ids.get(person._id)).length, 1);
    assert.ok(plan.allPanels[person._id].length > 0);
  }
  for (const page of plan.pages) {
    assert.ok(Math.abs(page.bounds.left / MM - (page.number % 2 ? 30 : 20)) < 0.001);
    assert.ok(Math.abs((595.28 - page.bounds.right) / MM - (page.number % 2 ? 20 : 30)) < 0.001);
    assert.ok(page.figures.length <= 3);
    for (const op of page.ops.filter(op => op.type === 'text')) {
      assert.ok(op.size >= 12); assert.ok(op.y + op.height <= page.bounds.bottom + 0.5);
      if (['records', 'contents', 'index'].includes(page.kind) && op.size !== 18 && op.size !== 22) assert.equal(op.size, 14);
    }
    if (page.kind === 'blank') assert.equal(page.ops.length, 0);
  }
  if (count === 500) {
    assert.ok(plan.pages.filter(p => p.kind === 'atlas').length < 120, '图块应合并，避免原来的逐图一页');
    assert.ok(plan.pages.some(p => p.figures.length === 3));
  }
  const result = await render(data, 'book', {}, {});
  assert.equal(result.pageCount, plan.pages.length);
  assert.equal((result.bytes.toString('latin1').match(/\/Type \/Page\b/g) || []).length, result.pageCount);
});
test('多配偶、共同父母、单亲及独立人物只绘制已记录关系', () => {
  const data = fixture(6, 'isolated');
  data.relations = [
    { _id: 'r1', type: 'parent_child', fromPersonId: 'p0', toPersonId: 'p2' },
    { _id: 'r2', type: 'parent_child', fromPersonId: 'p1', toPersonId: 'p2' },
    { _id: 'r3', type: 'parent_child', fromPersonId: 'p0', toPersonId: 'p3' },
    { _id: 'r4', type: 'spouse', fromPersonId: 'p0', toPersonId: 'p4' },
    { _id: 'r5', type: 'spouse', fromPersonId: 'p0', toPersonId: 'p5' }
  ];
  const model = bookModel(data);
  assert.equal(model.edges.size, 3); assert.equal(model.spouseEdges.size, 2);
  assert.equal(model.sections.find(s => s.children.includes('p2')).spouse, false);
  assert.equal(model.sections.find(s => s.children.includes('p3')).parents.length, 1);
  assert.equal(model.sections.filter(s => s.spouse).length, 2);
  const plan = planFor(data);
  const recordReferences = plan.pages.filter(p => p.kind === 'records').flatMap(p => p.ops.filter(op => op.type === 'text' && op.value.includes('资料第')));
  assert.ok(recordReferences.length > 0);
  assert.ok(recordReferences.every(op => /^P\d+ /.test(op.value)), '页码不能单独换到下一行失去对应人物');
  for (const page of plan.pages) {
    const cards = page.ops.filter(op => op.type === 'rect');
    for (const rule of page.ops.filter(op => op.type === 'rule' && op.relation)) {
      const [x1, y1, x2, y2] = rule.points;
      for (const card of cards) {
        const insideVertical = x1 === x2 && x1 > card.x + .1 && x1 < card.x + card.width - .1 && Math.max(y1, y2) > card.y + .1 && Math.min(y1, y2) < card.y + card.height - .1;
        const insideHorizontal = y1 === y2 && y1 > card.y + .1 && y1 < card.y + card.height - .1 && Math.max(x1, x2) > card.x + .1 && Math.min(x1, x2) < card.x + card.width - .1;
        assert.equal(insideVertical || insideHorizontal, false, '关系线不能穿过人物卡片');
      }
    }
  }
});
test('多子女续图、长姓名、同名与大批查阅链接不缩字或漏项', () => {
  const data = fixture(36, 'wide');
  data.persons[1].name = '长姓名'.repeat(10); data.persons[2].name = data.persons[3].name = '同名人物';
  const plan = planFor(data);
  const children = plan.figures.flatMap(f => f.section.children);
  assert.equal(new Set(children).size, 35);
  assert.ok(plan.figures.every(f => f.section.children.length <= 8));
  const text = values(plan);
  assert.match(text, /承 F\d+/); assert.match(text, /续 F\d+/);
  assert.equal(plan.model.ids.get('p2') === plan.model.ids.get('p3'), false);
  assert.ok(plan.pages.some(p => p.ops.some(op => op.value === '同名人物')));
  assert.ok(plan.pages.flatMap(p => p.ops).filter(op => op.personId === 'p1').every(op => op.height > 54));
});
test('长简介保留全部文本，续页重复身份，缺项合并且无头像不占图框', () => {
  const data = fixture(1); data.persons[0] = { _id: 'p0', name: '长简介人物', bio: '完整故事。'.repeat(1500) };
  const plan = planFor(data);
  const records = plan.pages.filter(p => p.kind === 'records');
  assert.ok(records.length > 3);
  assert.ok(records.slice(1).every(p => p.title.includes('P001') && p.title.includes('长简介人物') && p.title.includes('续')));
  const text = records.flatMap(p => p.ops.filter(op => op.type === 'text' && op.size === 14).map(op => op.value)).join('');
  assert.equal((text.match(/完整故事。/g) || []).length, 1500);
  assert.match(text, /未填写：/);
  assert.equal(records.flatMap(p => p.ops).filter(op => ['image', 'rect'].includes(op.type)).length, 0);
});
test('中文换行不以闭标点开头，不以开标点结尾', () => {
  const doc = document();
  try {
    const lines = wrapText(doc, '人物简介（完整资料），记录家族故事。'.repeat(20), 85, 14);
    assert.ok(lines.every(line => !/^[，。；：！？、）】》」』]/.test(line)));
    assert.ok(lines.slice(0, -1).every(line => !/[（【《「『]$/.test(line)));
    assert.equal(lines.join(''), '人物简介（完整资料），记录家族故事。'.repeat(20));
  } finally { doc.destroy(); }
  assert.ok(pageBounds(2).left < pageBounds(3).left);
});
test('不连通与循环关系保留人物并列入辈分待确认，已设置缺失头像明确注明', () => {
  const data = fixture(6, 'isolated');
  data.persons[1].avatarAssetId = 'missing';
  data.relations = [{ _id: 'r1', type: 'parent_child', fromPersonId: 'p0', toPersonId: 'p1' }, { _id: 'r2', type: 'parent_child', fromPersonId: 'p1', toPersonId: 'p0' }];
  const plan = planFor(data);
  assert.equal(Object.keys(plan.personPages).length, 6);
  assert.match(values(plan), /辈分待确认/); assert.match(values(plan), /头像：已设置，暂不可用/);
});
for (const shape of ['wide', 'deep', 'isolated']) test('500 人 ' + shape + ' 谱书完整分页与查阅不遗漏', async () => {
  const data = fixture(500, shape); const plan = planFor(data);
  assert.equal(Object.keys(plan.personPages).length, 500);
  assert.equal(plan.model.edges.size, data.relations.length);
  if (shape === 'wide') assert.ok(plan.pages.filter(p => p.kind === 'index').some(p => p.ops.some(op => typeof op.value === 'string' && op.value.includes('（续）'))));
  const result = await render(data, 'book', {}, {});
  assert.equal(result.pageCount, plan.pages.length);
});
test('有效头像保留图片区，农历精度与已填资料不合并为缺项', () => {
  const data = fixture(1); data.persons[0].avatarAssetId = 'valid'; data.persons[0].birthPlace = '完整出生地点';
  const plan = planFor(data, { p0: Buffer.from('image-placeholder') });
  assert.equal(plan.pages.flatMap(p => p.ops).filter(op => op.type === 'image').length, 1);
  const text = values(plan); assert.match(text, /农历 1980年/); assert.match(text, /完整出生地点/);
  assert.ok(plan.pages.flatMap(p => p.ops).filter(op => op.type === 'text' && op.value.startsWith('未填写：')).every(op => !op.value.includes('头像') && !op.value.includes('出生日期')));
});
