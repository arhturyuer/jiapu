const graph = require('./shared/graph-layout');
const personDate = require('./shared/person-date');
const { genderColors } = require('./shared/tree-poster-style');
const MM = 72 / 25.4;
const BACKGROUND = '#F7F4EC';
function drawPoster(doc, snapshot, display, assets, miniCode, helpers) {
  const { text, fitText, verticalText } = helpers;
  const layout = graph.layoutGraph(snapshot.persons, snapshot.relations, { mode: 'full', nameLayout: display.nameLayout, collapsedIds: [] });
  const width = Math.max(750, layout.width) + 128;
  const height = Math.max(900, layout.height) + 324;
  const factor = 1189 * MM / Math.max(width, height);
  doc.addPage({ size: [width * factor, height * factor], margin: 0 });
  doc.posterHeight = height;
  doc.save().scale(factor);
  doc.rect(0, 0, width, height).fill(BACKGROUND);
  function centered(value, x, cy, w, h, size, color) {
    fitText(doc, value, x, cy - h / 2, w, h, size, { align: 'center', color });
  }
  function badge(value, x, y, background, foreground, config) {
    const size = 20; doc.fontSize(size);
    const w = Math.max(config.minimumWidth, doc.widthOfString(value) + config.padding);
    doc.lineWidth(3).roundedRect(x, y, w, config.height, config.height / 2).fillAndStroke(background, BACKGROUND);
    centered(value, x, y + config.height / 2 + 1, w, 24, size, foreground);
  }
  const qrX = width - 64 - 150; const copyRight = qrX - 24;
  const titleWidth = Math.max(240, copyRight - 220 - 64 - 28);
  fitText(doc, snapshot.name, 64, 26, titleWidth, 112, 88);
  text(doc, '当前视图：完整家谱', 64, 152, titleWidth, 32, { color: '#65706A' });
  text(doc, '由有谱家谱生成', copyRight - 220, 70, 220, 26, { align: 'right', color: '#245C4A' });
  text(doc, '扫码查看详情', copyRight - 220, 114, 220, 23, { align: 'right' });
  if (miniCode) {
    // Keep the native mini-program code square; never substitute an ordinary QR.
    doc.image(miniCode, qrX, 34, { width: 150, height: 150 });
  }
  doc.lineWidth(2).moveTo(64, 222).lineTo(width - 64, 222).stroke('#D8DED9');
  const ox = 64; const oy = 260;
  doc.lineCap('round');
  (layout.lines || []).filter(line => !line.isFlow).forEach(line => {
    const color = line.lineRole === 'spouse' ? '#829D91' : line.lineRole === 'rail' ? '#BEC9C3' : '#A6B7AE';
    doc.lineWidth(line.lineRole === 'spouse' ? 5 : line.lineRole === 'rail' ? 3 : 4);
    doc.moveTo(line.x1 + ox, line.y1 + oy).lineTo(line.x2 + ox, line.y2 + oy).stroke(color);
  });
  (layout.crossings || []).forEach(crossing => {
    const x = crossing.x + ox; const y = crossing.y + oy;
    doc.circle(x, y, 7).fill(BACKGROUND);
    doc.lineWidth(4).moveTo(x, y - 7).lineTo(x, y + 7).stroke(crossing.isSpouse ? '#829D91' : '#A6B7AE');
  });
  (layout.junctions || []).forEach(item => doc.lineWidth(3).circle(item.x + ox, item.y + oy, 7).fillAndStroke('#829D91', BACKGROUND));
  const byId = new Map(snapshot.persons.map(person => [person._id, person]));
  layout.nodes.forEach(node => {
    const person = byId.get(node._id); const x = ox + node.x; const y = oy + node.y;
    const w = layout.nodeWidth; const h = layout.nodeHeight;
    const colors = genderColors(person, display.showGenderColors);
    doc.lineWidth(2).roundedRect(x, y, w, h, 24).fillAndStroke(colors.surface, colors.border);
    if (display.showGenderBadge) badge(person.gender === 'male' ? '男' : person.gender === 'female' ? '女' : '未填', x - 12, y - 15, colors.badge, '#FFFFFF', { minimumWidth: 44, height: 34, padding: 20 });
    if (person.lifeStatus === 'deceased') badge('故', x + w - 38 + 12, y - 15, '#EEF0ED', '#53655C', { minimumWidth: 38, height: 34, padding: 18 });
    if (display.nameLayout === 'vertical') {
      verticalText(doc, person.name, x + 11, y + 16, w - 22, h - 32, 27);
    } else {
      const avatarX = x + (w - 52) / 2; const avatarY = y + 14;
      doc.lineWidth(3).roundedRect(avatarX, avatarY, 52, 52, 18).fillAndStroke(colors.avatar, colors.border);
      if (assets[person._id]) {
        doc.save();
        try {
          doc.roundedRect(avatarX, avatarY, 52, 52, 18).clip();
          doc.image(assets[person._id], avatarX, avatarY, { cover: [52, 52], align: 'center', valign: 'center' });
        } finally { doc.restore(); }
      } else centered(Array.from(person.name)[0] || '家', avatarX, avatarY + 27, 52, 32, 26, colors.text);
      centered(person.name, x + 12, y + 89, w - 24, 36, 28);
      const year = personDate.fromPerson(person, 'birth').year;
      if (year) centered(year + '年', x + 12, y + 121, w - 24, 28, 22, '#65706A');
    }
    if (display.showChildRankBadge && node.childRankLabel) badge(node.childRankLabel, x - 12, y + h - 16, '#FFF0CA', '#704A16', { minimumWidth: 66, height: 36, padding: 24 });
  });
  doc.restore(); delete doc.posterHeight;
  return { pageCount: doc.bufferedPageRange().count, personCount: layout.nodes.length, relationCount: snapshot.relations.length };
}
module.exports = { drawPoster };
