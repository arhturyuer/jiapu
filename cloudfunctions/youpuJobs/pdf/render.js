const PDFDocument = require('pdfkit');
const path = require('path');
const { drawPoster } = require('./poster');
const { bookModel } = require('./book-model');
const { drawBook } = require('./book');
const FONT = path.join(__dirname, 'fonts/NotoSansCJKsc-Regular.otf');
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function fontCheck(doc, texts) {
  const font = doc._font.font;
  const missing = new Set();
  for (const value of texts) for (const character of String(value || '')) {
    if (!/\s/.test(character) && !font.hasGlyphForCodePoint(character.codePointAt(0))) missing.add(character);
  }
  if (missing.size) throw failure('PDF_FONT_MISSING_GLYPH', '中文字体暂不支持部分字符（' + [...missing].slice(0, 8).join('') + '），请联系微信客服');
}
function text(doc, value, x, y, width, size, options) {
  doc.fillColor(options && options.color || '#202824').fontSize(size).text(String(value || ''), x, y, Object.assign({ width, lineGap: size * 0.2 }, doc.posterHeight ? { height: Math.max(1, doc.posterHeight - y) } : {}, options || {}));
}
function fitText(doc, value, x, y, width, height, size, options) {
  let actual = size;
  while (actual > 2) {
    doc.fontSize(actual);
    if (doc.heightOfString(value, { width, lineGap: actual * 0.15 }) <= height) break;
    actual *= 0.9;
  }
  text(doc, value, x, y, width, actual, Object.assign({ height, lineGap: actual * 0.15 }, options || {}));
}
function verticalText(doc, value, x, y, width, height, size) {
  const characters = Array.from(value);
  let actual = size; let lineHeight;
  while (true) {
    doc.fontSize(actual);
    lineHeight = doc.currentLineHeight(true) + actual * 0.15;
    if (actual <= 2 || characters.length * lineHeight <= height && characters.every(character => doc.widthOfString(character) <= width)) break;
    actual *= 0.9;
  }
  // Position each glyph independently: multiline paragraph centering can
  // offset the last line, while mixed-width glyphs still share this center.
  characters.forEach((character, index) => {
    const glyphWidth = doc.widthOfString(character);
    text(doc, character, x + (width - glyphWidth) / 2, y + (height - characters.length * lineHeight) / 2 + index * lineHeight, width, actual, { height: lineHeight, lineBreak: false, align: 'left' });
  });
}
async function render(snapshot, format, display, assets, miniCode) {
  if (!snapshot.persons.length) throw failure('PDF_EMPTY', '家谱暂无成员，请先添加');
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, info: { Title: snapshot.name, Author: '有谱家谱', CreationDate: new Date(snapshot.exportedAt) } });
  doc.registerFont('Chinese', FONT).font('Chinese');
  fontCheck(doc, [snapshot.name, snapshot.description, ...snapshot.persons.flatMap(p => [p.name, p.bio, p.birthPlace])]);
  const chunks = []; doc.on('data', chunk => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); });
  let result;
  try { result = format === 'poster' ? drawPoster(doc, snapshot, display || {}, assets || {}, miniCode, { text, fitText, verticalText }) : drawBook(doc, snapshot, assets || {}); doc.end(); }
  catch (error) { doc.destroy(); throw error; }
  await done;
  return Object.assign(result, { bytes: Buffer.concat(chunks) });
}
module.exports = { render, bookModel, fontCheck };
