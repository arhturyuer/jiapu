const { makeBookPlan, PAGE, MM } = require('./book-layout');
function diagramOps(plan, item) {
  const { figure, x, y } = item;
  const { model, figures, figurePages, personPages, parentPanels } = plan;
  const section = figure.section; const ops = [];
  const text = (value, px, py, width, size = 12, target) => ops.push({ type: 'text', value, x: x + px, y: y + py, width, size, height: size * 1.5, target });
  const rule = (x1, y1, x2, y2) => ops.push({ type: 'rule', points: [x + x1, y + y1, x + x2, y + y2], relation: true });
  const kind = section.children.length ? section.spouse ? '夫妻及亲子关系' : '已记录父母与子女' : section.spouse ? '夫妻关系' : '关系待补充';
  const range = section.children.length ? ' · 子女 ' + (section.start + 1) + '-' + (section.start + section.children.length) + '／' + section.total : '';
  const width = plan.pages[figure.page - 1].bounds.width;
  text(figure.code + ' · ' + kind + range, 0, 0, width, 14, figure.code);
  if (figure.captionHeight > 28) {
    const siblings = figures.filter(other => other.section.key === section.key);
    const index = siblings.indexOf(figure); const previous = siblings[index - 1]; const next = siblings[index + 1];
    if (previous) text('承 ' + previous.code + ' · 第 ' + figurePages[previous.code] + ' 页', 0, 23, width / 2, 12, previous.code);
    if (next) text('续 ' + next.code + ' · 第 ' + figurePages[next.code] + ' 页', width / 2, 23, width / 2, 12, next.code);
  }
  const parents = section.parents.map(id => figure.positions[id]);
  if (section.spouse && parents.length === 2) {
    const first = parents[0]; const second = parents[1];
    rule(first.x + first.width, first.y + first.height / 2, second.x, second.y + second.height / 2);
    text('夫妻', first.x + first.width + 2, first.y + first.height / 2 - 21, second.x - first.x - first.width - 4, 12);
  }
  if (section.children.length) {
    const spine = width / 2;
    const trunk = figure.captionHeight + figure.parentHeight + 13;
    parents.forEach(p => { rule(p.x + p.width / 2, p.y + p.height, p.x + p.width / 2, trunk); rule(p.x + p.width / 2, trunk, spine, trunk); });
    const children = section.children.map(id => figure.positions[id]);
    rule(spine, trunk, spine, Math.max(...children.map(p => p.y + p.height / 2)));
    children.forEach(p => rule(spine, p.y + p.height / 2, p.x < spine ? p.x + p.width : p.x, p.y + p.height / 2));
  }
  for (const id of section.parents.concat(section.children)) {
    const p = figure.positions[id]; const card = figure.cards[id];
    ops.push({ type: 'rect', x: x + p.x, y: y + p.y, width: p.width, height: p.height, personId: id });
    let top = p.y + 6;
    card.names.forEach(line => { text(line, p.x + 8, top, p.width - 16, 16, model.ids.get(id)); top += 24; });
    text(model.ids.get(id) + ' · 资料第 ' + personPages[id] + ' 页', p.x + 8, top, p.width - 16, 12, model.ids.get(id)); top += 18;
    if (card.navigation) {
      const downstream = (parentPanels[id] || []).find(other => other.section.key !== section.key);
      if (!downstream) throw new Error('后续世系定位缺失');
      text('下接 ' + downstream.code + '／第 ' + figurePages[downstream.code] + ' 页', p.x + 8, top, p.width - 16, 12, downstream.code);
      text('完整后代图见人物资料', p.x + 8, top + 18, p.width - 16, 12, model.ids.get(id));
    }
  }
  return ops;
}
function validatePlan(doc, plan) {
  const targets = new Set(plan.pages.map(page => 'page-' + page.number));
  plan.pages.forEach(page => page.ops.filter(op => op.type === 'anchor').forEach(op => targets.add(op.id)));
  for (const page of plan.pages) for (const op of page.ops) {
    if (op.type === 'text') {
      if (op.size < 12 || doc.fontSize(op.size).widthOfString(op.value) > op.width + 0.5) throw new Error('谱书文字超过预留边界');
      if (op.target && !targets.has(op.target)) throw new Error('谱书查阅链接目标不存在');
    }
    if (['text', 'rect', 'image'].includes(op.type)) {
      if (op.x < page.bounds.left - 0.5 || op.x + op.width > page.bounds.right + 0.5 || op.y < page.bounds.top - 0.5 || op.y + op.height > page.bounds.bottom + 0.5) throw new Error('谱书内容越过版心');
    }
  }
}
function prepareBook(doc, snapshot, assets) {
  const plan = makeBookPlan(doc, snapshot, assets);
  plan.pages.forEach(page => { page.ops = page.ops.flatMap(op => op.type === 'diagram' ? diagramOps(plan, op) : [op]); });
  validatePlan(doc, plan);
  return plan;
}
function drawBook(doc, snapshot, assets = {}) {
  const plan = prepareBook(doc, snapshot, assets);
  function text(value, x, y, width, size, target) {
    doc.fillColor('#000000').fontSize(size).text(value, x, y, { width, lineBreak: false, goTo: target });
  }
  for (const page of plan.pages) {
    doc.addPage({ size: 'A4', margin: 0 });
    doc.addNamedDestination('page-' + page.number, 'XYZ', page.bounds.left, page.bounds.top, null);
    for (const op of page.ops) {
      if (op.type === 'text') text(op.value, op.x, op.y, op.width, op.size, op.target);
      if (op.type === 'anchor') doc.addNamedDestination(op.id, 'XYZ', op.x, op.y, null);
      if (op.type === 'rule') doc.lineWidth(0.75).moveTo(op.points[0], op.points[1]).lineTo(op.points[2], op.points[3]).stroke('#555555');
      if (op.type === 'rect') doc.lineWidth(0.75).roundedRect(op.x, op.y, op.width, op.height, 4).fillAndStroke('#FFFFFF', '#555555');
      if (op.type === 'image') doc.image(assets[op.id], op.x, op.y, { fit: [op.width, op.height], align: 'center', valign: 'center' });
    }
    if (!['cover', 'blank'].includes(page.kind)) {
      text('有谱家谱 · ' + ({ intro: '编排说明', contents: '目录', overview: '全谱导览', atlas: '家庭世系图', records: '人物资料', index: '姓名索引' }[page.kind]), page.bounds.left, 9 * MM, page.bounds.width, 12);
      doc.lineWidth(0.75).moveTo(page.bounds.left, 18 * MM).lineTo(page.bounds.right, 18 * MM).stroke('#555555');
      const label = page.number + '／' + plan.pages.length;
      const width = doc.fontSize(12).widthOfString(label);
      text(label, page.number % 2 ? page.bounds.right - width : page.bounds.left, PAGE[1] - 14 * MM, width + 0.1, 12);
    }
  }
  doc.outline.addItem('封面', { pageNumber: 0 });
  plan.entries.forEach(entry => doc.outline.addItem(entry.title, { pageNumber: entry.page - 1 }));
  return { pageCount: plan.pages.length, personCount: plan.model.people.length, relationCount: snapshot.relations.length };
}
module.exports = { drawBook, prepareBook, diagramOps, validatePlan };
