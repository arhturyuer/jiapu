const crypto = require('crypto');
const { gunzipSync } = require('node:zlib');
const { createImageProcessor } = require('./pdf/avatar');
const graphSource = require('./pdf/source/pdf-graph-source');
const layoutSnapshot = require('./pdf/shared/pdf-layout-snapshot');
async function read(scope, name, id) {
  try { return (await scope.collection(name).doc(id).get()).data || null; }
  catch (error) {
    if (/document with _id [^\s]+ does not exist/.test(String(error.errMsg || error.message))) return null;
    throw error;
  }
}
const ROLES = ['admin', 'member', 'viewer'];
const MESSAGES = {
  PDF_ACCESS_CHANGED: '家谱、会员或访问权限已变化，请返回确认',
  PDF_GRAPH_CHANGED: '家谱图已变化，请返回家谱刷新后重新生成',
  PDF_LAYOUT_INVALID: '家谱图已变化，请返回家谱刷新后重新生成',
  PDF_LAYOUT_UNSUPPORTED: '请更新小程序后重新生成家谱图',
  PDF_LIMIT_EXCEEDED: '家谱超过当前导出容量，请联系微信客服',
  PDF_INVALID_GRAPH: '家谱关系资料异常，请联系管理员检查',
  PDF_EMPTY: '家谱暂无成员，请先添加',
  PDF_FAILED: 'PDF 生成失败，请重试',
  PDF_MINI_CODE_FAILED: '小程序码暂不可用，请重试原任务',
  PDF_AVATAR_RUNTIME_UNAVAILABLE: '照片处理服务暂不可用，请稍后重试'
};
function fail(code) { throw Object.assign(new Error(MESSAGES[code] || MESSAGES.PDF_FAILED), { code }); }
function membershipActive(family) { return family && (family.proLifetime === true || new Date(family.proExpiresAt).getTime() > Date.now()); }
function unpackLayout(value) {
  if (!value || !value.encoding) return value;
  try {
    if (value.encoding !== 'gzip-base64' || (value.version !== 1 && value.version !== 2) || typeof value.data !== 'string' || value.data.length > 768000) fail('PDF_LAYOUT_INVALID');
    const decoded = JSON.parse(gunzipSync(Buffer.from(value.data, 'base64'), { maxOutputLength: 768000 }).toString('utf8'));
    if (decoded.sourceRevision !== value.sourceRevision || decoded.version !== value.version) fail('PDF_LAYOUT_INVALID');
    return decoded;
  } catch (error) { fail('PDF_LAYOUT_INVALID'); }
}
async function rows(db, name, where, limit) {
  const result = []; let cursor = '';
  while (true) {
    const query = Object.assign({}, where, cursor ? { _id: db.command.gt(cursor) } : {});
    const page = (await db.collection(name).where(query).orderBy('_id', 'asc').limit(100).get()).data || [];
    result.push(...page);
    if (result.length > limit) fail('PDF_LIMIT_EXCEEDED');
    if (page.length < 100) return result;
    cursor = page[page.length - 1]._id;
  }
}
function normalize(snapshot, limit) {
  if (snapshot.persons.length > limit || snapshot.relations.length > 2000) fail('PDF_LIMIT_EXCEEDED');
  const ids = new Set(snapshot.persons.map(p => p._id));
  if (ids.size !== snapshot.persons.length || snapshot.persons.some(p => !p.name || !p._id)) fail('PDF_INVALID_GRAPH');
  snapshot.persons = snapshot.persons.map(graphSource.familyPerson);
  snapshot.relations = snapshot.relations.filter(r => ids.has(r.fromPersonId) && ids.has(r.toPersonId)).map(graphSource.familyRelation);
  if (snapshot.relations.some(r => !['spouse', 'parent_child'].includes(r.type) || r.fromPersonId === r.toPersonId)) fail('PDF_INVALID_GRAPH');
  return snapshot;
}
function createWorker(options) {
  const { db, cloud } = options;
  const render = options.render || ((...args) => require('./pdf/render').render(...args));
  async function authorize(task) {
    const user = await read(db, 'users', task.userId);
    if (!user || user.status !== 'active') fail('PDF_ACCESS_CHANGED');
    if (task.source === 'example') {
      const result = await db.collection('example_templates').where({ slug: task.slug, status: 'published' }).limit(1).get();
      const example = (result.data || [])[0];
      if (!example || !example.publishedContent) fail('PDF_ACCESS_CHANGED');
      return example;
    }
    const family = await read(db, 'families', task.familyId);
    const memberships = await db.collection('family_memberships').where({ familyId: task.familyId, userId: task.userId, status: 'active' }).limit(1).get();
    if (!family || family.status !== 'active' || !membershipActive(family) || !memberships.data[0] || !ROLES.includes(memberships.data[0].role)) fail('PDF_ACCESS_CHANGED');
    return family;
  }
  async function snapshot(task) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const source = await authorize(task);
      if (task.source === 'example') {
        const content = source.publishedContent;
        const projected = task.layoutSnapshot ? graphSource.exampleGraph(content) : { persons: content.persons || [], relations: content.relations || [] };
        return normalize(Object.assign({ name: source.title || content.family && content.family.name || '示例家谱', description: source.description || content.family && content.family.description || '', exportedAt: new Date().toISOString(), sourceRevision: Number(source.publishedVersion || 0) }, projected), 200);
      }
      const persons = await rows(db, 'persons', { familyId: task.familyId, status: 'active' }, 500);
      const relations = await rows(db, 'relations', { familyId: task.familyId, status: 'active' }, 2000);
      const after = await authorize(task);
      if (Number(source.contentRevision || 0) === Number(after.contentRevision || 0)) {
        return normalize({ name: source.name || '我的家谱', description: source.description || '', persons, relations, exportedAt: new Date().toISOString(), sourceRevision: Number(source.contentRevision || 0) }, 500);
      }
    }
    fail('PDF_GRAPH_CHANGED');
  }
  async function loadAvatars(task, data) {
    const assets = {}; let unavailable = 0; let processImage;
    for (const person of data.persons) {
      if (!person.avatarAssetId) continue;
      const asset = await read(db, 'media_assets', person.avatarAssetId);
      if (task.source === 'example' || !asset || asset.familyId !== task.familyId || asset.status !== 'active' || asset.moderationStatus !== 'approved' || !asset.fileId || Number(asset.size || 0) > 10 * 1024 * 1024) { unavailable += 1; continue; }
      if (!processImage) processImage = options.imageProcessor || createImageProcessor();
      try {
        const result = await cloud.downloadFile({ fileID: asset.fileId });
        const bytes = result.fileContent;
        if (!bytes || bytes.length > 10 * 1024 * 1024) throw new Error('invalid avatar');
        assets[person._id] = await processImage(bytes);
      } catch (error) { unavailable += 1; }
    }
    data.unavailableMediaCount = unavailable;
    return assets;
  }
  async function claim(id) {
    return db.runTransaction(async tx => {
      const task = await read(tx, 'export_tasks', id);
      if (!task || task.kind !== 'family_pdf' || task.status !== 'pending' || task.miniCodeRequired && !task.miniCodeBase64) return null;
      const runToken = crypto.randomBytes(12).toString('hex');
      await tx.collection('export_tasks').doc(id).update({ data: { status: 'processing', progress: 5, runToken, startedAt: db.serverDate(), updatedAt: db.serverDate() } });
      return Object.assign(task, { runToken });
    });
  }
  async function update(task, data) {
    return db.runTransaction(async tx => {
      const current = await read(tx, 'export_tasks', task._id);
      if (!current || current.runToken !== task.runToken || current.status !== 'processing') return false;
      await tx.collection('export_tasks').doc(task._id).update({ data: Object.assign({}, data, { updatedAt: db.serverDate() }) });
      return true;
    });
  }
  async function process(id) {
    const task = await claim(id);
    if (!task) return { skipped: true };
    let fileId = '';
    try {
      const data = await snapshot(task);
      if (!data.persons.length) fail('PDF_EMPTY');
      if (task.layoutSnapshot) data.posterLayout = layoutSnapshot.restore(unpackLayout(task.layoutSnapshot), data.persons, data.relations, data.sourceRevision, task.display.nameLayout);
      await update(task, { progress: 20 });
      const assets = await loadAvatars(task, data);
      await update(task, { progress: 50 });
      const miniCode = task.miniCodeBase64 ? Buffer.from(task.miniCodeBase64, 'base64') : null;
      const result = await render(data, task.format, task.display, assets, miniCode);
      await verifyRevision(task, data.sourceRevision);
      const fileName = String(data.name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 40) + '-' + (task.format === 'poster' ? '矢量全谱图' : 'A4完整谱书') + '.pdf';
      const uploaded = await cloud.uploadFile({ cloudPath: 'exports/' + task.userId + '/' + task._id + '-' + task.runToken + '.pdf', fileContent: result.bytes });
      fileId = uploaded.fileID;
      if (!fileId) fail('PDF_FAILED');
      await verifyRevision(task, data.sourceRevision);
      const committed = await update(task, {
        status: 'completed', progress: 100, fileId, fileName, size: result.bytes.length,
        personCount: result.personCount, relationCount: result.relationCount, pageCount: result.pageCount,
        unavailableMediaCount: data.unavailableMediaCount, sourceRevision: data.sourceRevision,
        completedAt: db.serverDate(), expiresAt: new Date(Date.now() + 72 * 3600000)
      });
      if (!committed) await cloud.deleteFile({ fileList: [fileId] });
      return { completed: committed, taskId: id };
    } catch (error) {
      if (fileId) await cloud.deleteFile({ fileList: [fileId] }).catch(() => {});
      const code = error.code && error.code.startsWith('PDF_') ? error.code : 'PDF_FAILED';
      await update(task, { status: 'failed', failureCode: code, failureMessage: code === 'PDF_FONT_MISSING_GLYPH' ? error.message : MESSAGES[code] || MESSAGES.PDF_FAILED, failedAt: db.serverDate() });
      return { completed: false, taskId: id, code };
    }
  }
  async function verifyRevision(task, revision) {
    const source = await authorize(task);
    if (task.layoutSnapshot && Number(task.source === 'example' ? source.publishedVersion || 0 : source.contentRevision || 0) !== revision) fail('PDF_GRAPH_CHANGED');
  }
  async function maintenance() {
    const tasks = await rows(db, 'export_tasks', { kind: 'family_pdf', status: 'pending' }, 5000);
    let failed = 0;
    for (const task of tasks) {
      if (Date.now() - new Date(task.updatedAt || task.createdAt).getTime() > 30 * 60000) {
        await db.runTransaction(async tx => {
          const current = await read(tx, 'export_tasks', task._id);
          if (current && current.status === 'pending' && Date.now() - new Date(current.updatedAt || current.createdAt).getTime() > 30 * 60000) {
            await tx.collection('export_tasks').doc(task._id).update({ data: { status: 'failed', failureCode: 'PDF_FAILED', failureMessage: '任务启动超时，请重试', updatedAt: db.serverDate() } });
            failed += 1;
          }
        });
      }
    }
    return { failed };
  }
  return { process, authorize, snapshot, maintenance };
}
module.exports = { createWorker, normalize, membershipActive, unpackLayout };
