// Secret-authenticated, disposable staging fixture using downloaded ops routes.
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createRequire } = require('module');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const prefix = 'guides-probe-' + process.env.PROBE_RUN;
const operatorId = prefix + '-operator';
const actor = prefix + '-actor';
const slugs = [prefix + '-main', prefix + '-related'];
const id = slug => 'guide_' + crypto.createHash('sha256').update(slug).digest('hex').slice(0, 40);
function check(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
function opsRuntime(identity) {
  const file = path.join(__dirname, 'ops/index.js'); const localRequire = createRequire(file);
  const mockCloud = { init() {}, DYNAMIC_CURRENT_ENV: cloud.DYNAMIC_CURRENT_ENV, database: () => db,
    getWXContext: () => ({ OPENID: identity, ENV: process.env.PROBE_ENV }),
    uploadFile: input => cloud.uploadFile(input), getTempFileURL: input => cloud.getTempFileURL(input) };
  const sandbox = { exports: {}, module: { exports: {} }, __dirname: path.dirname(file), __filename: file,
    require: name => name === 'wx-server-sdk' ? mockCloud : localRequire(name), Buffer, URL, Date, process, setTimeout, clearTimeout, console };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file }); return sandbox.exports.main;
}
async function rows(collection, where) { const found = (await db.collection(collection).where(where).limit(100).get()).data || []; check(found.length < 100, 'PROBE_CLEANUP_LIMIT'); return found; }
async function cleanup() {
  for (const slug of slugs) {
    const guideId = id(slug);
    const guide = await db.collection('guides').doc(guideId).get().catch(() => ({ data: null }));
    if (guide.data) check(guide.data.slug === slug && guide.data.createdBy === operatorId, 'PROBE_FIXTURE_OWNERSHIP');
    const assets = await rows('guide_assets', { guideId });
    if (assets.length) {
      check(assets.every(asset => asset.createdBy === operatorId), 'PROBE_ASSET_OWNERSHIP');
      const deleted = await cloud.deleteFile({ fileList: assets.map(asset => asset.fileId) });
      check((deleted.fileList || []).every(file => !file.status), 'PROBE_STORAGE_CLEANUP');
      for (const asset of assets) await db.collection('guide_assets').doc(asset._id).remove();
    }
    if (guide.data) await db.collection('guides').doc(guideId).remove();
  }
  for (const [collection, where] of [['audit_logs', { actorId: 'operator_' + operatorId }], ['idempotency_records', { actorId: 'operator_' + operatorId }]]) {
    for (const row of await rows(collection, where)) await db.collection(collection).doc(row._id).remove();
  }
  const operator = await db.collection('operators').doc(operatorId).get().catch(() => ({ data: null }));
  if (operator.data) { check(operator.data.authUid === actor, 'PROBE_OPERATOR_OWNERSHIP'); await db.collection('operators').doc(operatorId).remove(); }
  return { success: true, cleaned: true };
}
async function run() {
  const schema = (await db.collection('system_config').doc('schema').get()).data; check(schema.version === 14, 'PROBE_SCHEMA');
  await db.collection('operators').doc(operatorId).set({ data: { authUid: actor, role: 'operator', status: 'active', displayName: '指南虚构验收账号', createdAt: db.serverDate() } });
  const ops = opsRuntime(actor); let sequence = 0; const outcomes = [];
  async function call(action, fields = {}) {
    const response = await ops({ action, requestId: prefix + '-' + ++sequence, ...fields }, {});
    check(response.success, response.code || 'PROBE_OPS'); return response.data;
  }
  async function publicCall(type, fields = {}, expectedCode) {
    const result = await cloud.callFunction({ name: 'youpuUserApi', data: { type, ...fields } });
    const response = typeof result.result === 'string' ? JSON.parse(result.result) : result.result;
    if (expectedCode) { check(!response.success && response.code === expectedCode, 'PROBE_PUBLIC_REJECTION'); return; }
    check(response.success, response.code || 'PROBE_PUBLIC'); return response.data;
  }
  const draft = { title: '虚构指南验收', summary: '仅用于独立staging的临时验收数据', sortOrder: 999999, related: [], body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '虚构验收正文', marks: [{ type: 'bold' }] }] }] } };
  const main = await call('guides.create', { slug: slugs[0], draft });
  const related = await call('guides.create', { slug: slugs[1], draft: { ...draft, title: '虚构关联指南' } });
  await publicCall('public.guides.get', { slug: slugs[0] }, 'GUIDE_NOT_FOUND'); outcomes.push('draft_hidden');
  await call('guides.publish', { guideId: related.guideId, revision: 1 });
  const image = await call('guides.image.upload', { guideId: main.guideId, imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVSAAAAAASUVORK5CYII=' });
  draft.related = [slugs[1]]; draft.body.content.push({ type: 'image', attrs: { assetId: image.assetId, alt: '虚构测试图片' } });
  await call('guides.updateDraft', { guideId: main.guideId, revision: 1, draft });
  await call('guides.publish', { guideId: main.guideId, revision: 2 });
  let visible = await publicCall('public.guides.get', { slug: slugs[0] });
  check(visible.guide.title === draft.title && visible.related.length === 1 && visible.guide.nodes.some(node => node.name === 'img'), 'PROBE_PUBLISHED_IMAGE'); outcomes.push('published_text_image_related');
  draft.title = '虚构指南修改后'; draft.sortOrder = 999998;
  const update = { guideId: main.guideId, revision: 3, draft, requestId: prefix + '-retry' };
  await call('guides.updateDraft', update); await call('guides.updateDraft', update);
  visible = await publicCall('public.guides.get', { slug: slugs[0] }); check(visible.guide.title !== draft.title, 'PROBE_DRAFT_ISOLATION');
  const detail = await call('guides.detail', { guideId: main.guideId }); check(detail.guide.revision === 4, 'PROBE_IDEMPOTENCY');
  const conflict = await ops({ action: 'guides.publish', guideId: main.guideId, revision: 3, requestId: prefix + '-conflict' }, {}); check(conflict.code === 'GUIDE_CONFLICT', 'PROBE_CONFLICT'); outcomes.push('draft_snapshot_idempotency_conflict');
  await call('guides.publish', { guideId: main.guideId, revision: 4 });
  visible = await publicCall('public.guides.get', { slug: slugs[0] }); check(visible.guide.title === draft.title, 'PROBE_UPDATED_PUBLICATION');
  await call('guides.unpublish', { guideId: related.guideId, revision: 2 });
  visible = await publicCall('public.guides.get', { slug: slugs[0] }); check(visible.related.length === 0, 'PROBE_RELATED_FILTER');
  await call('guides.unpublish', { guideId: main.guideId, revision: 5 }); await publicCall('public.guides.get', { slug: slugs[0] }, 'GUIDE_NOT_FOUND');
  await call('guides.delete', { guideId: main.guideId, revision: 6 }); await call('guides.restore', { guideId: main.guideId, revision: 7 }); await publicCall('public.guides.get', { slug: slugs[0] }, 'GUIDE_NOT_FOUND'); outcomes.push('unpublish_delete_restore');
  const settings = await call('guides.settings.get');
  await call('guides.settings.updateDraft', { revision: settings.revision, draft: settings.published });
  await call('guides.settings.publish', { revision: settings.revision + 1 });
  // Preserve a preexisting unpublished settings draft after validating publication.
  await call('guides.settings.updateDraft', { revision: settings.revision + 2, draft: settings.draft });
  const list = await publicCall('public.guides.list'); check(list.settings.title === settings.published.title && list.items.every(item => !slugs.includes(item.slug)), 'PROBE_LIST_SETTINGS'); outcomes.push('list_settings_snapshot');
  const unauthorized = await opsRuntime('')({ action: 'guides.create', slug: prefix + '-denied', draft, requestId: prefix + '-denied' }, {}); check(!unauthorized.success, 'PROBE_UNAUTHORIZED'); outcomes.push('unauthorized_rejected');
  return { success: true, outcomes, schemaVersion: schema.version };
}
exports.main = async event => {
  const context = cloud.getWXContext() || {};
  const actualEnv = process.env.TCB_ENV || process.env.SCF_NAMESPACE || context.ENV;
  check(process.env.PROBE_ENV && process.env.PROBE_ENV !== 'cloud1-d5gs5yj4l283d9c6d' && actualEnv === process.env.PROBE_ENV && (!context.ENV || context.ENV === process.env.PROBE_ENV), 'PROBE_ENV');
  check(process.env.PROBE_SECRET && event.secret === process.env.PROBE_SECRET && event.run === process.env.PROBE_RUN, 'PROBE_AUTH');
  if (event.action === 'cleanup') return cleanup();
  check(event.action === 'run', 'PROBE_ACTION'); return run();
};
