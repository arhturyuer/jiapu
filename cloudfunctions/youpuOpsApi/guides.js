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
function createService({ db, cloud, assert, requireOperator, opsMutate, writeOpsAudit }) {
  const authorize = context => requireOperator(context, ['super_admin', 'operator']);
  async function get(id, scope = db) {
    assert(typeof id === 'string' && /^guide_[a-f0-9]{40}$/.test(id), 'GUIDE_NOT_FOUND', '指南不存在');
    const row = await read(scope, 'guides', id); assert(row, 'GUIDE_NOT_FOUND', '指南不存在'); return row;
  }
  function revision(row, event) { assert(Number.isInteger(event.revision) && event.revision === row.revision, 'GUIDE_CONFLICT', '内容已被其他操作更新，请刷新后重试'); }
  async function validateAssets(body, id, scope) {
    for (const assetId of content.assetIds(body)) {
      const asset = await read(scope || db, 'guide_assets', assetId);
      assert(asset && asset.guideId === id && asset.fileId && asset.status === 'active', 'GUIDE_INVALID_ASSET', '图片不属于当前指南或暂不可用');
    }
  }
  async function imageUrls(row) {
    const urls = {}; const assets = [];
    for (const assetId of [...new Set(content.assetIds(row.draft.body).concat(row.published ? content.assetIds(row.published.body) : []))]) {
      const asset = await read(db, 'guide_assets', assetId);
      if (asset && asset.guideId === row._id && asset.status === 'active') assets.push(asset);
    }
    if (assets.length) {
      const response = await cloud.getTempFileURL({ fileList: assets.map(asset => asset.fileId) });
      for (const asset of assets) { const file = (response.fileList || []).find(item => item.fileID === asset.fileId); if (file && file.tempFileURL) urls[asset._id] = file.tempFileURL; }
    }
    return urls;
  }
  async function list(event, context) {
    await authorize(context);
    const status = event.status || ''; assert(['', 'draft', 'published', 'unpublished', 'deleted'].includes(status), 'INVALID_INPUT', '指南状态无效');
    const keyword = content.text(event.keyword || '', 100, '搜索词').toLowerCase();
    const rows = (await allRows(db, status)).map(row => ({ _id: row._id, slug: row.slug, title: row.draftTitle, status: row.status, revision: row.revision, sortOrder: row.draftSortOrder, updatedAt: row.updatedAt }));
    return page(rows.filter(row => !keyword || row.title.toLowerCase().includes(keyword)), event, status + '|' + keyword);
  }
  async function detail(event, context) {
    await authorize(context); const guide = await get(event.guideId);
    return { guide, imageUrls: await imageUrls(guide) };
  }
  async function mutate(event, context, action, handler) {
    const operator = await authorize(context);
    return opsMutate(operator, action, event, async transaction => {
      const currentOperator = await read(transaction, 'operators', operator._id);
      assert(currentOperator && currentOperator.status === 'active' && ['super_admin', 'operator'].includes(currentOperator.role), 'NO_PERMISSION', '当前运营账号没有执行此操作的权限');
      const result = await handler(transaction, operator);
      await writeOpsAudit(transaction, operator, 'ops.' + action, 'guides', result.guideId || 'guide_settings', '运营后台修谱指南管理', action, event.requestId);
      return result;
    });
  }
  async function create(event, context) {
    const slug = content.slug(event.slug); const draft = content.draft(event.draft); const id = guideId(slug);
    return mutate(event, context, 'guides.create', async (transaction, operator) => {
      assert(!await read(transaction, 'guides', id), 'GUIDE_SLUG_EXISTS', '该文章标识已使用（含回收站），请换一个');
      assert(!content.assetIds(draft.body).length, 'GUIDE_INVALID_ASSET', '请先创建指南，再上传正文图片');
      assert(!draft.related.includes(slug), 'GUIDE_INVALID_CONTENT', '不能关联当前指南');
      await transaction.collection('guides').doc(id).set({ data: { slug, draft, published: null, draftTitle: draft.title, draftSortOrder: draft.sortOrder, publishedTitle: '', publishedSummary: '', publishedSortOrder: 0, status: 'draft', revision: 1, createdBy: operator._id, updatedBy: operator._id, createdAt: db.serverDate(), updatedAt: db.serverDate() } });
      return { guideId: id, revision: 1 };
    });
  }
  async function change(event, context, action) {
    return mutate(event, context, 'guides.' + action, async (transaction, operator) => {
      const row = await get(event.guideId, transaction); revision(row, event);
      assert(action === 'restore' ? row.status === 'deleted' : row.status !== 'deleted', 'GUIDE_INVALID_STATE', '指南状态已变化，请刷新');
      const data = { revision: row.revision + 1, updatedAt: db.serverDate(), updatedBy: operator._id };
      if (action === 'updateDraft') {
        assert(event.slug === undefined || event.slug === row.slug, 'GUIDE_SLUG_IMMUTABLE', '文章标识创建后不能修改');
        const draft = content.draft(event.draft); assert(!draft.related.includes(row.slug), 'GUIDE_INVALID_CONTENT', '不能关联当前指南');
        await validateAssets(draft.body, row._id, transaction);
        data.draft = db.command.set(draft); data.draftTitle = draft.title; data.draftSortOrder = draft.sortOrder;
      } else if (action === 'publish') {
        const draft = content.draft(row.draft);
        assert(draft.body.content.some(node => node.type === 'image' || JSON.stringify(node).includes('"text":')), 'GUIDE_INVALID_CONTENT', '发布前请填写正文');
        await validateAssets(draft.body, row._id, transaction);
        for (const slug of draft.related) { const related = await read(transaction, 'guides', guideId(slug)); assert(related && related.status !== 'deleted', 'GUIDE_INVALID_CONTENT', '关联指南已删除或不存在，请调整后发布'); }
        Object.assign(data, { published: db.command.set(draft), publishedTitle: draft.title, publishedSummary: draft.summary, publishedSortOrder: draft.sortOrder, status: 'published', publishedAt: db.serverDate() });
      } else if (action === 'unpublish') {
        assert(row.status === 'published', 'GUIDE_INVALID_STATE', '当前指南尚未发布'); data.status = 'unpublished';
      } else if (action === 'delete') data.status = 'deleted';
      else if (action === 'restore') data.status = 'draft';
      await transaction.collection('guides').doc(row._id).update({ data });
      return { guideId: row._id, revision: data.revision };
    });
  }
  async function settingsGet(event, context) {
    await authorize(context); const setting = await read(db, 'system_config', 'guide_settings');
    assert(setting, 'GUIDE_NOT_INITIALIZED', '请先完成指南初始化'); return setting;
  }
  async function settingsChange(event, context, action) {
    return mutate(event, context, 'guides.settings.' + action, async (transaction, operator) => {
      const row = await read(transaction, 'system_config', 'guide_settings'); assert(row, 'GUIDE_NOT_INITIALIZED', '请先完成指南初始化'); revision(row, event);
      const next = content.settings(action === 'publish' ? row.draft : event.draft);
      const data = { revision: row.revision + 1, updatedAt: db.serverDate(), updatedBy: operator._id };
      data[action === 'publish' ? 'published' : 'draft'] = db.command.set(next);
      await transaction.collection('system_config').doc('guide_settings').update({ data });
      return { revision: data.revision };
    });
  }
  async function upload(event, context) {
    const operator = await authorize(context); const row = await get(event.guideId); assert(row.status !== 'deleted', 'GUIDE_INVALID_STATE', '请先恢复指南');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(event.imageData || ''));
    assert(match, 'GUIDE_INVALID_IMAGE', '请上传PNG、JPEG或WebP图片');
    const bytes = Buffer.from(match[2], 'base64');
    assert(bytes.length > 0 && bytes.length <= 1024 * 1024 && bytes.toString('base64').replace(/=+$/, '') === match[2].replace(/=+$/, ''), 'GUIDE_INVALID_IMAGE', '图片无效或超过1MB');
    const valid = match[1] === 'png' ? bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : match[1] === 'jpeg' ? bytes.length >= 3 && bytes.subarray(0, 3).toString('hex') === 'ffd8ff' : bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    assert(valid, 'GUIDE_INVALID_IMAGE', '图片格式与内容不匹配');
    const fingerprint = digest(bytes); const assetId = 'ga_' + digest(row._id + ':' + fingerprint);
    // Content-addressed paths make retries safe without overwriting other images.
    const cloudPath = 'ops/guides/' + row._id + '/' + fingerprint + '.' + (match[1] === 'jpeg' ? 'jpg' : match[1]);
    let asset = await read(db, 'guide_assets', assetId);
    if (!asset) {
      const uploaded = await cloud.uploadFile({ cloudPath, fileContent: bytes });
      assert(uploaded.fileID, 'GUIDE_IMAGE_UPLOAD_FAILED', '图片上传失败，请重试');
      await mutate(event, context, 'guides.image.upload', async transaction => {
        const current = await get(row._id, transaction); assert(current.status !== 'deleted', 'GUIDE_INVALID_STATE', '指南已删除');
        if (!await read(transaction, 'guide_assets', assetId)) await transaction.collection('guide_assets').doc(assetId).set({ data: { guideId: row._id, fileId: uploaded.fileID, status: 'active', size: bytes.length, createdBy: operator._id, createdAt: db.serverDate() } });
        return { guideId: row._id, assetId, fingerprint };
      });
      asset = await read(db, 'guide_assets', assetId);
    }
    assert(asset && asset.guideId === row._id && asset.status === 'active', 'GUIDE_INVALID_ASSET', '图片暂不可用');
    const response = await cloud.getTempFileURL({ fileList: [asset.fileId] });
    const file = (response.fileList || []).find(item => item.fileID === asset.fileId);
    assert(file && file.tempFileURL, 'GUIDE_IMAGE_UPLOAD_FAILED', '图片地址读取失败，请重试');
    return { assetId, url: file.tempFileURL };
  }
  return {
    'guides.list': list, 'guides.detail': detail, 'guides.create': create,
    ...Object.fromEntries(['updateDraft', 'publish', 'unpublish', 'delete', 'restore'].map(action => ['guides.' + action, (event, context) => change(event, context, action)])),
    'guides.image.upload': upload, 'guides.settings.get': settingsGet,
    ...Object.fromEntries(['updateDraft', 'publish'].map(action => ['guides.settings.' + action, (event, context) => settingsChange(event, context, action)]))
  };
}
module.exports = { createService, guideId, read, allRows, page };
