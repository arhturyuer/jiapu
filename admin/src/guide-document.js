// Editor and server may emit equivalent JSON with different object key order.
export function stableStringify(value) {
  return JSON.stringify(value, function (key, item) {
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
    return item;
  });
}
export function storedDocument(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const containers = ['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote'];
  function walk(node) {
    if (node.type === 'image') node.attrs = { assetId: node.attrs?.assetId, alt: node.attrs?.alt || '', title: node.attrs?.title || '' };
    if (node.type === 'orderedList') node.attrs = { start: node.attrs?.start || 1 };
    if (containers.includes(node.type)) node.content = node.content || [];
    if (node.marks && !node.marks.length) delete node.marks;
    node.content?.forEach(walk);
  }
  walk(copy); return copy;
}
