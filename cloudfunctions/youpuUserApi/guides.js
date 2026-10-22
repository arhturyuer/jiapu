const crypto = require('crypto');
const content = require('./guide-content');
const digest = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 40);
const guideId = slug => 'guide_' + digest(slug);
async function read(scope, collection, id) {
  try { return (await scope.collection(collection).doc(id).get()).data || null; }
  catch (error) { if (/document.*(?:not.*exist|not.*found|does not exist)/i.test(String(error.errMsg || error.message))) return null; throw error; }
}
async function allRows(db, status) {
  const rows = []; let last = '';
  while (true) {
    const where = Object.assign({}, status ? { status } : {}, last ? { _id: db.command.gt(last) } : {});
    let query = db.collection('guides').where(where).orderBy('_id', 'asc').limit(100);
    if (query.field) query = query.field({ slug: true, status: true, revision: true, draftTitle: true, draftSortOrder: true, publishedTitle: true, publishedSummary: true, publishedSortOrder: true, updatedAt: true });
    const batch = (await query.get()).data || [];
    rows.push(...batch); content.check(rows.length <= 2000, '指南数量超过查询上限，请联系管理员');
    if (batch.length < 100) return rows;
    last = batch[batch.length - 1]._id;
  }
}
function page(rows, event, scope) {
  const size = Math.min(100, Math.max(1, Math.floor(Number(event.pageSize) || 25)));
  let cursor;
  if (event.cursor) {
    try { cursor = JSON.parse(Buffer.from(String(event.cursor), 'base64url').toString()); } catch (error) { /* checked below */ }
    content.check(typeof event.cursor === 'string' && event.cursor.length <= 512 && cursor && Number.isInteger(cursor.order) && typeof cursor.id === 'string' && cursor.id.length <= 100 && cursor.scope === scope, '分页标识无效，请刷新');
  }
  rows.sort((a, b) => a.sortOrder - b.sortOrder || a._id.localeCompare(b._id));
  const remaining = cursor ? rows.filter(row => row.sortOrder > cursor.order || (row.sortOrder === cursor.order && row._id > cursor.id)) : rows;
  const items = remaining.slice(0, size); const last = items[items.length - 1]; const hasMore = remaining.length > size;
  return { items, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ order: last.sortOrder, id: last._id, scope })).toString('base64url') : '' };
}
function createService({ db, cloud, assert }) {
  async function published(slug) {
    content.slug(slug); const row = await read(db, 'guides', guideId(slug));
    assert(row && row.status === 'published' && row.published, 'GUIDE_NOT_FOUND', '这篇指南暂不可用，请查看其他修谱指南。');
    return row;
  }
  async function list(event) {
    const setting = await read(db, 'system_config', 'guide_settings');
    assert(setting && setting.published, 'GUIDE_NOT_INITIALIZED', '修谱指南暂不可用，请稍后重试');
    const rows = (await allRows(db, 'published')).map(row => ({ _id: row._id, slug: row.slug, title: row.publishedTitle, summary: row.publishedSummary, sortOrder: row.publishedSortOrder }));
    const result = page(rows, event, 'published');
    result.items = result.items.map(({ _id, ...row }) => row);
    return { ...result, settings: content.settings(setting.published) };
  }
  async function get(event) {
    const row = await published(event.slug); const snapshot = content.draft(row.published); const urls = {}; const assets = [];
    for (const id of content.assetIds(snapshot.body)) {
      const asset = await read(db, 'guide_assets', id);
      if (asset && asset.guideId === row._id && asset.status === 'active' && asset.fileId) assets.push(asset);
    }
    if (assets.length) {
      try {
        const response = await cloud.getTempFileURL({ fileList: assets.map(asset => asset.fileId) });
        for (const asset of assets) { const file = (response.fileList || []).find(item => item.fileID === asset.fileId); if (file && file.tempFileURL) urls[asset._id] = file.tempFileURL; }
      } catch (error) { /* Text stays readable if image signing is unavailable. */ }
    }
    const related = [];
    for (const slug of snapshot.related) {
      const target = await read(db, 'guides', guideId(slug));
      if (target && target.status === 'published' && target.published) related.push({ slug, title: target.published.title, summary: target.published.summary });
    }
    // Only projected, validated published data leaves the public API.
    return { guide: { slug: row.slug, title: snapshot.title, summary: snapshot.summary, nodes: content.renderNodes(snapshot.body, urls) }, related };
  }
  return { list, get, published };
}
module.exports = { createService };
