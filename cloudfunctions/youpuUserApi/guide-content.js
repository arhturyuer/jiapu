// Kept byte-identical in the two API deployment roots; verified by contract tests.
const DEFAULT_SETTINGS = { title: '把家人的名字、关系和故事整理成家谱', summary: '从准备资料到邀请家人、导出打印，按你当前的问题开始。' };
function check(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { code: 'GUIDE_INVALID_CONTENT' });
}
function text(value, max, label, required) {
  check(typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value), label + '格式无效或过长');
  const result = value.trim();
  check(!required || result.length > 0, '请填写' + label);
  return result;
}
function slug(value) {
  check(typeof value === 'string' && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value), '文章标识只能使用小写字母、数字和连字符，最多80字符');
  return value;
}
function document(input) {
  check(input && typeof input === 'object' && Buffer.byteLength(JSON.stringify(input), 'utf8') <= 200000, '正文不能超过200KB');
  let count = 0;
  function node(value, depth, parent) {
    check(value && typeof value === 'object' && !Array.isArray(value) && depth <= 12 && ++count <= 3000, '正文结构过于复杂');
    const type = value.type;
    const rules = { doc: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'image'], paragraph: ['text', 'hardBreak'], heading: ['text', 'hardBreak'], bulletList: ['listItem'], orderedList: ['listItem'], listItem: ['paragraph', 'bulletList', 'orderedList'], blockquote: ['paragraph', 'heading', 'bulletList', 'orderedList'] };
    check(Object.hasOwn(rules, type) || ['text', 'hardBreak', 'image'].includes(type), '正文包含不支持的内容');
    check(parent ? rules[parent] && rules[parent].includes(type) : type === 'doc', '正文节点位置无效');
    check(Object.keys(value).every(key => ['type', 'attrs', 'content', 'text', 'marks'].includes(key)), '正文包含未知字段');
    const result = { type };
    const attrs = value.attrs || {};
    check(typeof attrs === 'object' && !Array.isArray(attrs), '正文属性无效');
    const allowed = type === 'heading' ? ['level'] : type === 'orderedList' ? ['start', 'type'] : type === 'image' ? ['assetId', 'alt', 'title'] : [];
    check(Object.keys(attrs).every(key => allowed.includes(key)), '正文包含不支持的属性');
    if (type === 'heading') { check([2, 3].includes(attrs.level), '仅支持二级、三级标题'); result.attrs = { level: attrs.level }; }
    if (type === 'orderedList') { check(attrs.start === undefined || (Number.isInteger(attrs.start) && attrs.start >= 1 && attrs.start <= 999), '列表起始序号无效'); check(attrs.type === undefined || attrs.type === null || attrs.type === '1', '列表格式无效'); result.attrs = { start: attrs.start || 1 }; }
    if (type === 'image') {
      check(typeof attrs.assetId === 'string' && /^ga_[a-f0-9]{40}$/.test(attrs.assetId), '请使用后台上传的指南图片');
      result.attrs = { assetId: attrs.assetId, alt: text(attrs.alt || '', 200, '图片说明'), title: text(attrs.title || '', 200, '图片标题') };
    }
    if (type === 'text') {
      check(typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 20000, '文本节点无效');
      result.text = value.text;
    } else check(value.text === undefined, '正文文本位置无效');
    if (value.marks !== undefined) {
      check(type === 'text' && Array.isArray(value.marks) && value.marks.length <= 3, '文字格式无效');
      result.marks = value.marks.map(mark => {
        check(mark && ['bold', 'italic', 'underline'].includes(mark.type) && Object.keys(mark).every(key => key === 'type'), '文字包含不支持的格式');
        return { type: mark.type };
      });
    }
    if (Object.hasOwn(rules, type)) {
      check(Array.isArray(value.content) || value.content === undefined, '正文结构无效');
      result.content = (value.content || []).map(child => node(child, depth + 1, type));
      if (['bulletList', 'orderedList', 'listItem'].includes(type)) check(result.content.length > 0, '列表内容不能为空');
    } else check(value.content === undefined, '正文节点不能包含子内容');
    return result;
  }
  return node(input, 0, '');
}
function draft(value) {
  check(value && typeof value === 'object', '请填写指南内容');
  const order = value.sortOrder === undefined ? 0 : value.sortOrder;
  check(Number.isInteger(order) && order >= 0 && order <= 999999, '排序值需为0至999999的整数');
  check(Array.isArray(value.related) && value.related.length <= 8, '最多选择8篇关联指南');
  return { title: text(value.title, 100, '标题', true), summary: text(value.summary, 500, '摘要', true), sortOrder: order, related: [...new Set(value.related.map(slug))], body: document(value.body) };
}
function settings(value) { return { title: text(value && value.title, 100, '列表标题', true), summary: text(value && value.summary, 500, '列表说明', true) }; }
function assetIds(doc) {
  const ids = new Set();
  function walk(node) { if (node.type === 'image') ids.add(node.attrs.assetId); (node.content || []).forEach(walk); }
  walk(doc); check(ids.size <= 30, '每篇指南最多使用30张图片'); return [...ids];
}
function renderNodes(doc, urls) {
  function render(node) {
    if (node.type === 'text') {
      let result = { type: 'text', text: node.text };
      (node.marks || []).forEach(mark => { result = { name: { bold: 'strong', italic: 'em', underline: 'u' }[mark.type], attrs: {}, children: [result] }; });
      return result;
    }
    if (node.type === 'image') return urls[node.attrs.assetId] ? { name: 'img', attrs: { src: urls[node.attrs.assetId], alt: node.attrs.alt, style: 'max-width:100%;height:auto;display:block;margin:1em 0;' } } : { name: 'p', attrs: { style: 'color:#65706a;' }, children: [{ type: 'text', text: '[图片暂不可用]' }] };
    const tags = { paragraph: 'p', heading: 'h' + (node.attrs && node.attrs.level || 2), bulletList: 'ul', orderedList: 'ol', listItem: 'li', blockquote: 'blockquote', hardBreak: 'br' };
    const styles = { paragraph: 'margin:0.8em 0;line-height:1.9;', heading: 'margin:1.2em 0 0.6em;font-size:' + (node.attrs && node.attrs.level === 3 ? '1.12em' : '1.25em') + ';line-height:1.6;font-weight:600;', bulletList: 'padding-left:1.5em;', orderedList: 'padding-left:1.5em;', blockquote: 'margin:1em 0;padding-left:1em;border-left:3px solid #c5d6cc;color:#65706a;' };
    const attrs = { style: styles[node.type] || '' };
    if (node.type === 'orderedList') attrs.start = String(node.attrs.start);
    return { name: tags[node.type], attrs, children: (node.content || []).map(render) };
  }
  return doc.content.map(render);
}
module.exports = { DEFAULT_SETTINGS, check, text, slug, document, draft, settings, assetIds, renderNodes };
