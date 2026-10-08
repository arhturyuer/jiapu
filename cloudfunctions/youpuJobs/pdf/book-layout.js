const { bookModel } = require('./book-model');
const graph = require('./shared/graph-layout');
const dates = require('./shared/person-date');
const MM = 72 / 25.4;
const PAGE = [595.28, 841.89];
const TOP = 20 * MM;
const BOTTOM = PAGE[1] - 22 * MM;
const WIDTH = PAGE[0] - 50 * MM;
const CLOSING = /^[，。；：！？、）】》」』…,.!?;:)]$/;
const OPENING = /[（【《「『(\[]$/;
function pageBounds(number) {
  const left = (number % 2 ? 30 : 20) * MM;
  return { left, right: left + WIDTH, top: TOP, bottom: BOTTOM, width: WIDTH };
}
function wrapText(doc, value, width, size) {
  doc.fontSize(size);
  const lines = [];
  for (const paragraph of String(value || '').split('\n')) {
    let line = '';
    for (const character of Array.from(paragraph)) {
      if (line && doc.widthOfString(line + character) > width) {
        let carry = '';
        if (CLOSING.test(character) || OPENING.test(line)) {
          const previous = Array.from(line);
          do { carry = previous.pop() + carry; } while (previous.length && CLOSING.test(character) && (CLOSING.test(Array.from(carry)[0]) || /^\s/.test(carry)));
          line = previous.join('');
        }
        if (line) lines.push(line);
        line = carry + character;
      } else line += character;
    }
    lines.push(line);
  }
  return lines;
}
function makeBookPlan(doc, snapshot, assets = {}) {
  const model = bookModel(snapshot);
  const pages = []; const entries = []; const personPages = {}; const atlasPages = {};
  const figurePages = {}; const parentPanels = {}; const allPanels = {};
  const recordRanges = {}; const blankPages = [];
  let page; let y;
  const measure = (value, width, size) => wrapText(doc, value, width, size);
  function text(value, x, top, width, size = 14, target) {
    page.ops.push({ type: 'text', value, x, y: top, width, size, height: size * 1.5, target });
  }
  function lines(value, x, top, width, size = 14, step = 21, target) {
    const list = measure(value, width, size);
    list.forEach((line, index) => text(line, x, top + index * step, width, size, target));
    return list.length * step;
  }
  function anchor(id, top = y) { page.ops.push({ type: 'anchor', id, x: page.bounds.left, y: top }); }
  function newPage(kind, title, size = 22) {
    const number = pages.length + 1;
    page = { number, kind, title: title || '', bounds: pageBounds(number), ops: [], figures: [] };
    pages.push(page); y = TOP;
    if (title) y += lines(title, page.bounds.left, y, WIDTH, size, size * 1.5) + 10;
    if (kind === 'blank') blankPages.push(number);
    return number;
  }
  function ensure(height, kind, title, size) { if (y + height > BOTTOM) newPage(kind, title, size); }
  function paragraph(value, options = {}) {
    const { size = 14, step = 21, target, continuation = '编排说明（续）', kind = page.kind } = options;
    for (const line of measure(value, WIDTH, size)) {
      ensure(step, kind, continuation, options.titleSize || 22);
      text(line, page.bounds.left, y, WIDTH, size, target); y += step;
    }
    y += 7;
  }
  function referenceRow(items, options = {}) {
    let x = page.bounds.left;
    const step = options.step || 21; const size = options.size || 14;
    ensure(step, options.kind || page.kind, options.continuation, options.titleSize);
    for (const item of items) {
      const width = doc.fontSize(size).widthOfString(item.reserve || item.value);
      if (x + width > page.bounds.right && x > page.bounds.left) {
        y += step; ensure(step, options.kind || page.kind, options.continuation, options.titleSize); x = page.bounds.left;
      }
      text(item.value, x, y, width + 0.1, size, item.target); x += width + 7;
    }
    y += step + 7;
  }
  const rangeText = numbers => {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    return sorted.length ? sorted[0] === sorted[sorted.length - 1] ? String(sorted[0]) : sorted[0] + '-' + sorted[sorted.length - 1] : '未记录';
  };
  const figureList = id => allPanels[id] || [];
  const figureReference = figure => ({ reserve: figure.code + '／第 9999 页', value: () => figure.code + '／第 ' + figurePages[figure.code] + ' 页', target: figure.code });
  newPage('cover');
  y = 175;
  lines('家 谱', page.bounds.left, y, WIDTH, 44, 66); y += 88;
  y += lines(snapshot.name, page.bounds.left, y, WIDTH, 30, 45) + 35;
  lines(snapshot.persons.length + ' 位成员 · ' + snapshot.relations.length + ' 条关系', page.bounds.left, y, WIDTH, 14, 21);
  lines('大字阅读 · 双面左装订\n生成日期 ' + new Date(new Date(snapshot.exportedAt).getTime() + 8 * 3600000).toISOString().slice(0, 10) + '\n由有谱家谱生成', page.bounds.left, 640, WIDTH, 14, 21);
  newPage('blank');
  entries.push({ title: '编排说明与家谱简介', page: newPage('intro', '编排说明与家谱简介') });
  paragraph('本谱完整收录生成时已保存的成员和有效关系。P 编号标识人物，F 编号标识世系图块；编号仅在本次谱书内有效。同名人物通过编号、出生信息及亲属资料区分。');
  paragraph('代次依据当前已记录关系推导，仅表示相对代次，不代表已考证的宗族世次或房支。辈分待确认者单列；未记录的亲属关系不推断，人物已填资料完整保留，缺项集中说明。');
  paragraph('阅读顺序：先查全谱导览，再按 F 编号阅读家庭世系图，最后按 P 编号或姓名索引查人物。图卡注明资料页；“下接”指向后续世系，人物资料列出全部相关图块。编号和页码在 PDF 中可点击。');
  paragraph('关系线：夫妻横线仅表示已记录夫妻关系；亲子连线表示已记录的父母与子女关系。单亲不补另一位父母，无子女记录不代表没有子女。');
  paragraph('打印设置：A4、实际大小／100%、双面、长边翻页、左侧装订。内侧留白 30mm，外侧 20mm；奇偶页装订边自动镜像。页码采用包含封面和留白页的实际 PDF 页序，封面背面及末尾必要留白不印页眉页脚。');
  if (snapshot.unavailableMediaCount) paragraph(snapshot.unavailableMediaCount + ' 位成员已设置的头像暂不可用，人物资料会单独注明。');
  paragraph('家谱简介：' + (snapshot.description || '未填写'));
  const contentsPages = [];
  const rowsPerContents = Math.floor((BOTTOM - TOP - 43) / 28);
  const entryCount = model.grouping.groups.length + 5;
  for (let i = 0; i < Math.ceil(entryCount / rowsPerContents); i += 1) contentsPages.push(newPage('contents', i ? '目录（续）' : '目录'));
  entries.push({ title: '全谱导览', page: newPage('overview', '全谱导览') });
  paragraph('各代人数与查阅页码如下。世系页范围包含该代成员出现的图块；人物资料每位只收录一次。', { continuation: '全谱导览（续）' });
  for (const group of model.grouping.groups) {
    ensure(70, 'overview', '全谱导览（续）');
    paragraph(group.label + ' · ' + group.persons.length + ' 位成员', { continuation: '全谱导览（续）' });
    referenceRow([
      { reserve: '世系图第 9999-9999 页', value: () => '世系图第 ' + rangeText(group.persons.flatMap(p => figureList(p._id).map(f => figurePages[f.code]))) + ' 页', target: () => 'page-' + Math.min(...group.persons.flatMap(p => figureList(p._id).map(f => figurePages[f.code]))) },
      { reserve: '人物资料第 9999-9999 页', value: () => '人物资料第 ' + rangeText(recordRanges[group.key] || []) + ' 页', target: () => 'page-' + recordRanges[group.key][0] }
    ], { continuation: '全谱导览（续）' });
  }
  // Diagram geometry is measured in local coordinates; mirroring translates
  // the entire block, never just its text, so connectors share the same gutter.
  const gutter = 18 * MM; const cardWidth = (WIDTH - gutter) / 2;
  function card(id, unit) {
    const names = measure(model.byId.get(id).name, cardWidth - 16, 16);
    const downstream = (model.parentUnits.get(id) || []).filter(key => key !== unit.key);
    const navigation = downstream.length > 0;
    return { id, names, navigation, downstream, height: 12 + names.length * 24 + 18 + (navigation ? 36 : 0) };
  }
  function diagram(section) {
    const cards = {};
    section.parents.concat(section.children).forEach(id => { cards[id] = card(id, section); });
    const parentHeight = Math.max(...section.parents.map(id => cards[id].height));
    const captionHeight = section.total > section.children.length ? 46 : 28;
    let positionY = captionHeight; const positions = {};
    section.parents.forEach((id, index) => { positions[id] = { x: index * (cardWidth + gutter), y: positionY, width: cardWidth, height: parentHeight }; });
    positionY += parentHeight;
    if (section.children.length) positionY += 26;
    for (let index = 0; index < section.children.length; index += 2) {
      const row = section.children.slice(index, index + 2);
      const height = Math.max(...row.map(id => cards[id].height));
      row.forEach((id, column) => { positions[id] = { x: column * (cardWidth + gutter), y: positionY, width: cardWidth, height }; });
      positionY += height + 10;
    }
    return { section, cards, positions, parentHeight, captionHeight, height: positionY + 12 };
  }
  const figures = [];
  for (const section of model.sections) {
    let start = 0;
    do {
      let take = Math.min(8, section.children.length - start);
      let shape = diagram({ ...section, children: section.children.slice(start, start + take), start: section.start + start });
      while (shape.height > BOTTOM - TOP - 43 && take > 1) {
        take -= 1; shape = diagram({ ...section, children: section.children.slice(start, start + take), start: section.start + start });
      }
      if (shape.height > BOTTOM - TOP - 43) throw new Error('世系图块超过 A4 可打印高度');
      shape.code = 'F' + String(figures.length + 1).padStart(3, '0'); figures.push(shape);
      start += take;
    } while (start < section.children.length);
  }
  figures.forEach(figure => {
    for (const id of figure.section.parents.concat(figure.section.children)) {
      if (!allPanels[id]) allPanels[id] = []; allPanels[id].push(figure);
    }
    if (figure.section.children.length) for (const id of figure.section.parents) {
      if (!parentPanels[id]) parentPanels[id] = []; parentPanels[id].push(figure);
    }
  });
  entries.push({ title: '家庭世系图', page: newPage('atlas', '家庭世系图') });
  for (const figure of figures) {
    if (page.figures.length >= 3 || y + figure.height > BOTTOM) newPage('atlas', '家庭世系图（续）');
    figurePages[figure.code] = page.number; page.figures.push(figure.code); figure.page = page.number; figure.y = y;
    anchor(figure.code);
    page.ops.push({ type: 'diagram', figure, x: page.bounds.left, y });
    figure.section.parents.concat(figure.section.children).forEach(id => {
      if (!atlasPages[id]) atlasPages[id] = []; atlasPages[id].push(page.number);
    });
    y += figure.height;
  }
  function richRows(items) {
    const rows = []; let row = []; let used = 0;
    for (const item of items) {
      const value = item.reserve || item.value;
      const pieces = typeof value === 'string' && doc.fontSize(14).widthOfString(value) > WIDTH ? measure(value, WIDTH, 14) : [value];
      pieces.forEach((piece, index) => {
        const width = doc.fontSize(14).widthOfString(piece);
        if (row.length && (index > 0 || used + width > WIDTH)) { rows.push(row); row = []; used = 0; }
        row.push({ ...item, value: pieces.length > 1 ? piece : item.value, width, offset: used }); used += width + 7;
      });
    }
    if (row.length) rows.push(row);
    return rows;
  }
  function recordBlocks(person) {
    const blocks = []; const missing = [];
    const add = value => blocks.push({ lines: measure(value, WIDTH, 14) });
    const gender = person.gender === 'male' ? '男' : person.gender === 'female' ? '女' : '';
    const status = person.lifeStatus === 'living' ? '健在' : person.lifeStatus === 'deceased' ? '已故' : '';
    const basic = [];
    if (gender) basic.push('性别：' + gender); else missing.push('性别');
    if (status) basic.push('状态：' + status); else missing.push('健在状态');
    if (basic.length) add(basic.join('    '));
    for (const [label, prefix] of [['出生', 'birth'], ['离世', 'death']]) {
      const value = dates.display(person, prefix);
      if (value) add(label + '：' + value); else missing.push(label + '日期');
    }
    if (person.birthPlace) add('出生地：' + person.birthPlace); else missing.push('出生地');
    if (person.avatarAssetId && !assets[person._id]) add('头像：已设置，暂不可用');
    else if (!assets[person._id]) missing.push('头像');
    for (const [label, map] of [['父母', model.parents], ['配偶', model.spouses], ['子女', model.children]]) {
      const related = (map.get(person._id) || []).slice();
      if (label === '子女') {
        const order = model.parentOrders[person._id] || [];
        related.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      } else related.sort((a, b) => model.ids.get(a).localeCompare(model.ids.get(b)));
      if (!related.length) { missing.push(label + '关系'); continue; }
      const items = [{ value: label + '：' }];
      related.forEach(id => {
        const name = model.ids.get(id) + ' ' + model.byId.get(id).name;
        const reserve = name + ' · 资料第 9999 页';
        if (doc.fontSize(14).widthOfString(reserve) <= WIDTH) {
          items.push({ reserve, value: () => name + ' · 资料第 ' + personPages[id] + ' 页', target: model.ids.get(id) });
        } else {
          items.push({ value: name, target: model.ids.get(id) });
          items.push({ reserve: model.ids.get(id) + ' · 资料第 9999 页', value: () => model.ids.get(id) + ' · 资料第 ' + personPages[id] + ' 页', target: model.ids.get(id) });
        }
      });
      blocks.push({ rows: richRows(items) });
    }
    const items = [{ value: '相关世系图：' }];
    figureList(person._id).forEach(figure => items.push(figureReference(figure)));
    blocks.push({ rows: richRows(items) });
    if (person.bio) add('简介：' + person.bio); else missing.push('简介');
    if (missing.length) add('未填写：' + missing.join('、') + '。');
    return blocks;
  }
  entries.push({ title: '分代人物资料', page: pages.length + 1 });
  for (const group of model.grouping.groups) {
    entries.push({ title: group.label, page: newPage('records', group.label) });
    recordRanges[group.key] = [];
    for (const person of group.persons) {
      const heading = model.ids.get(person._id) + ' ' + person.name;
      const headingWidth = WIDTH - (assets[person._id] ? 64 : 0);
      const headerHeight = Math.max(measure(heading, headingWidth, 18).length * 27, assets[person._id] ? 52 : 0) + 9;
      const blocks = recordBlocks(person);
      const recordHeight = headerHeight + blocks.reduce((sum, block) => sum + (block.lines || block.rows).length * 21 + 7, 0) + 15;
      const continuation = heading + '（续）';
      // Keep a short record intact; a long record starts with its heading and
      // at least two body lines, then continues with the same identity.
      const minimum = recordHeight <= BOTTOM - TOP - 43 ? recordHeight : headerHeight + 49;
      ensure(minimum, 'records', group.label);
      personPages[person._id] = page.number; anchor(model.ids.get(person._id));
      const firstPage = page.number;
      lines(heading, page.bounds.left, y, headingWidth, 18, 27);
      if (assets[person._id]) page.ops.push({ type: 'image', id: person._id, x: page.bounds.right - 52, y, width: 52, height: 52 });
      y += headerHeight;
      for (const block of blocks) {
        for (const row of block.lines || block.rows) {
          ensure(21, 'records', continuation, 18);
          if (typeof row === 'string') text(row, page.bounds.left, y, WIDTH, 14);
          else row.forEach(item => text(item.value, page.bounds.left + item.offset, y, item.width + 0.1, 14, item.target));
          y += 21;
        }
        y += 7;
      }
      y += 15;
      for (let number = firstPage; number <= page.number; number += 1) recordRanges[group.key].push(number);
    }
  }
  entries.push({ title: '姓名索引', page: newPage('index', '姓名索引') });
  const columns = [50, 22, 44, 44].map(value => value * MM);
  function indexHeader() {
    let x = page.bounds.left;
    ['姓名', '编号', '代次与出生年', '查阅页码'].forEach((label, index) => {
      lines(label, x + 4, y, columns[index] - 8, 14, 21); x += columns[index];
    });
    y += 48;
    page.ops.push({ type: 'rule', points: [page.bounds.left, y, page.bounds.right, y] }); y += 7;
  }
  indexHeader();
  for (const person of graph.sortPersonsByName(model.people)) {
    const generation = model.grouping.generationByPerson[person._id];
    const groupLabel = generation ? model.grouping.groups.find(group => group.generation === generation).label : '辈分待确认';
    const birth = dates.fromPerson(person, 'birth');
    const birthYear = birth.year ? (birth.calendar === 'lunar' ? '农历 ' : '公历 ') + birth.year + '年' : '出生年未记';
    const nameLines = measure(person.name, columns[0] - 8, 14);
    const generationLines = measure(groupLabel + '\n' + birthYear, columns[2] - 8, 14);
    const refs = figureList(person._id);
    // Keep every relevant diagram page; each page remains independently linked.
    const unique = [...new Set(refs.map(f => figurePages[f.code]))].sort((a, b) => a - b);
    const pageRows = [{ reserve: '资料第 9999 页', value: () => '资料第 ' + personPages[person._id] + ' 页', target: model.ids.get(person._id) }];
    unique.forEach(number => pageRows.push({ value: '世系第 ' + number + ' 页', target: 'page-' + number }));
    const rowCount = Math.max(nameLines.length, generationLines.length, pageRows.length);
    let consumed = 0;
    do {
      const names = consumed ? measure(person.name + '（续）', columns[0] - 8, 14) : nameLines;
      if (y + Math.max(42, names.length * 21 + 10) > BOTTOM) { newPage('index', '姓名索引（续）'); indexHeader(); }
      const capacity = Math.floor((BOTTOM - y - 10) / 21);
      if (consumed === 0 && rowCount <= Math.floor((BOTTOM - TOP - 100) / 21) && rowCount > capacity) { newPage('index', '姓名索引（续）'); indexHeader(); }
      const count = Math.min(rowCount - consumed, Math.floor((BOTTOM - y - 10) / 21));
      if (count < 1) throw new Error('姓名索引没有可用行');
      const x = page.bounds.left;
      const repeatedNameCount = Math.min(names.length, count);
      for (let i = 0; i < repeatedNameCount; i += 1) text(names[i], x + 4, y + i * 21, columns[0] - 8, 14, model.ids.get(person._id));
      text(model.ids.get(person._id), x + columns[0] + 4, y, columns[1] - 8, 14, model.ids.get(person._id));
      for (let i = 0; i < count; i += 1) {
        if (generationLines[consumed + i]) text(generationLines[consumed + i], x + columns[0] + columns[1] + 4, y + i * 21, columns[2] - 8, 14);
        const ref = pageRows[consumed + i];
        if (ref) text(ref.value, x + WIDTH - columns[3] + 4, y + i * 21, columns[3] - 8, 14, ref.target);
      }
      y += count * 21 + 8;
      page.ops.push({ type: 'rule', points: [x, y, page.bounds.right, y] }); y += 6;
      consumed += count;
    } while (consumed < rowCount);
  }
  if (pages.length % 2) newPage('blank');
  entries.forEach((entry, index) => {
    page = pages[contentsPages[Math.floor(index / rowsPerContents)] - 1];
    text(entry.title + '    ' + entry.page, page.bounds.left, TOP + 43 + (index % rowsPerContents) * 28, WIDTH, 14, 'page-' + entry.page);
  });
  pages.forEach(current => current.ops.forEach(op => {
    if (typeof op.value === 'function') op.value = op.value();
    if (typeof op.target === 'function') op.target = op.target();
  }));
  return { pages, entries, model, figures, personPages, atlasPages, figurePages, parentPanels, allPanels, recordRanges, blankPages, contentsPages };
}

module.exports = { makeBookPlan, pageBounds, wrapText, PAGE, TOP, BOTTOM, WIDTH, MM };
