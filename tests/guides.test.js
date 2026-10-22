require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDatabase } = require('./helpers/membership-db');
const { runtime } = require('./helpers/counting-runtime');
const { initialize, seeds } = require('../cloudfunctions/youpuJobs/guides-seed');
const { guideId } = require('../cloudfunctions/youpuOpsApi/guides');
const content = require('../cloudfunctions/youpuOpsApi/guide-content');
const legacy = require('./fixtures/legacy-guides');
const root = path.resolve(__dirname, '..');
function draft(title = '测试指南', sortOrder = 10) { return { title, summary: '虚构指南摘要', sortOrder, related: [], body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '虚构指南正文' }] }] } }; }
async function fixture(role = 'operator') {
  const db = createDatabase(); db.now = new Date('2026-10-19T00:00:00Z'); await initialize(db);
  db.put('operators', 'op', { authUid: 'fixture-actor', role, status: 'active' });
  const signed = []; const uploaded = [];
  const cloud = { getTempFileURL: async ({ fileList }) => { signed.push(...fileList); return { fileList: fileList.map(fileID => ({ fileID, tempFileURL: 'https://fixture.test/' + fileID })) }; }, uploadFile: async data => { uploaded.push(data); return { fileID: 'cloud://fixture/' + data.cloudPath }; } };
  const ops = runtime(path.join(root, 'cloudfunctions/youpuOpsApi'), db, { cloud });
  const user = runtime(path.join(root, 'cloudfunctions/youpuUserApi'), db, { actor: '', cloud });
  let sequence = 0;
  async function call(action, fields = {}) { const result = await ops.call({ action, requestId: 'request-' + ++sequence, ...fields }); assert.equal(result.success, true, JSON.stringify(result)); return result.data; }
  async function publicCall(type, fields = {}) { const result = await user.call({ type, ...fields }); assert.equal(result.success, true, JSON.stringify(result)); return result.data; }
  async function create(slug = 'new-guide', data = draft()) { return call('guides.create', { slug, draft: data }); }
  return { db, ops, user, call, publicCall, create, signed, uploaded };
}

test('迁入八篇指南保留正文、问答、slug、关联，重跑不覆盖修改及删除', async () => {
  const f = await fixture();
  assert.equal(f.db.all('guides').length, 8);
  for (const row of legacy.guides) {
    const stored = f.db.get('guides', guideId(row.slug));
    const texts = stored.published.body.content.flatMap(node => node.content || []).map(node => node.text);
    for (const pair of row.sections.concat(row.questions)) for (const text of pair) assert.ok(texts.includes(text));
    assert.deepEqual(stored.published.related, row.related);
  }
  const id = guideId(seeds[0].slug);
  await f.call('guides.delete', { guideId: id, revision: 1 });
  const before = f.db.get('guides', id);
  await initialize(f.db); assert.deepEqual(f.db.get('guides', id), before);
  f.db.put('system_config', 'guide_settings', { draft: { title: '编辑过', summary: '说明' }, published: { title: '现行', summary: '说明' }, revision: 9 });
  await initialize(f.db); assert.equal(f.db.get('system_config', 'guide_settings').revision, 9);
});

test('草稿标题、排序、正文、关联与列表文案发布前不泄漏，发布后动态生效', async () => {
  const f = await fixture(); const created = await f.create(); const id = created.guideId;
  assert.equal((await f.publicCall('public.guides.list')).items.some(row => row.slug === 'new-guide'), false);
  assert.equal((await f.user.call({ type: 'public.guides.get', slug: 'new-guide' })).code, 'GUIDE_NOT_FOUND');
  await f.call('guides.publish', { guideId: id, revision: 1 });
  const changed = draft('修改后标题', 0); changed.related = [seeds[0].slug];
  await f.call('guides.updateDraft', { guideId: id, revision: 2, draft: changed });
  let result = await f.publicCall('public.guides.get', { slug: 'new-guide' }); assert.equal(result.guide.title, '测试指南'); assert.equal(result.related.length, 0);
  await f.call('guides.publish', { guideId: id, revision: 3 });
  result = await f.publicCall('public.guides.get', { slug: 'new-guide' }); assert.equal(result.guide.title, '修改后标题'); assert.equal(result.related[0].slug, seeds[0].slug);
  assert.doesNotMatch(JSON.stringify(result), /updatedBy|createdBy|revision|"draft"|"published"|cloud:\/\//);
  await f.call('guides.settings.updateDraft', { revision: 1, draft: { title: '新列表标题', summary: '新说明' } });
  assert.notEqual((await f.publicCall('public.guides.list')).settings.title, '新列表标题');
  await f.call('guides.settings.publish', { revision: 2 }); assert.equal((await f.publicCall('public.guides.list')).settings.title, '新列表标题');
  assert.equal(f.db.all('users').length, 0); assert.equal(f.db.all('analytics_activity_daily').length, 0);
});

test('下架、删除与恢复不泄漏旧快照，回收站slug不能复用，关联自动过滤', async () => {
  const f = await fixture(); const id = guideId(seeds[0].slug);
  const data = draft(); data.related = [seeds[0].slug]; const created = await f.create('related-guide', data); await f.call('guides.publish', { guideId: created.guideId, revision: 1 });
  await f.call('guides.unpublish', { guideId: id, revision: 1 });
  assert.equal((await f.publicCall('public.guides.get', { slug: 'related-guide' })).related.length, 0);
  assert.equal((await f.user.call({ type: 'public.guides.get', slug: seeds[0].slug })).code, 'GUIDE_NOT_FOUND');
  await f.call('guides.delete', { guideId: id, revision: 2 });
  assert.equal((await f.ops.call({ action: 'guides.create', requestId: 'duplicate', slug: seeds[0].slug, draft: data })).code, 'GUIDE_SLUG_EXISTS');
  await f.call('guides.restore', { guideId: id, revision: 3 });
  assert.equal(f.db.get('guides', id).status, 'draft');
  assert.equal((await f.user.call({ type: 'public.guides.get', slug: seeds[0].slug })).code, 'GUIDE_NOT_FOUND');
  await f.call('guides.publish', { guideId: id, revision: 4 }); assert.equal((await f.publicCall('public.guides.get', { slug: 'related-guide' })).related.length, 1);
});

test('运营鉴权、并发修订、请求重试幂等和审计失败回滚', async () => {
  const f = await fixture(); const created = await f.create();
  const input = { action: 'guides.updateDraft', requestId: 'same-request', guideId: created.guideId, revision: 1, draft: draft('第一次修改') };
  const responses = await Promise.all([f.ops.call(input), f.ops.call({ ...input })]); assert.ok(responses.every(row => row.success));
  assert.equal(f.db.get('guides', created.guideId).revision, 2);
  assert.equal(f.db.all('audit_logs').filter(row => row.action === 'ops.guides.updateDraft').length, 1);
  assert.equal((await f.ops.call({ ...input, requestId: 'different-request' })).code, 'GUIDE_CONFLICT');
  f.db.writeHook = name => { if (name === 'audit_logs') throw new Error('audit unavailable'); };
  assert.equal((await f.ops.call({ action: 'guides.publish', requestId: 'audit-fail', guideId: created.guideId, revision: 2 })).success, false);
  assert.equal(f.db.get('guides', created.guideId).revision, 2); assert.equal(f.db.get('guides', created.guideId).status, 'draft');
  f.db.writeHook = null; f.db.put('operators', 'op', { authUid: 'fixture-actor', role: 'operator', status: 'disabled' });
  for (const action of ['guides.list', 'guides.detail', 'guides.create', 'guides.settings.get', 'guides.image.upload']) assert.equal((await f.ops.call({ action })).success, false);
  const superAdmin = await fixture('super_admin'); await superAdmin.create('super-admin-guide');
});

test('排序分页不遗漏同序号文章，搜索、状态筛选、非法游标和slug固定', async () => {
  const f = await fixture(); await f.create('another-guide', draft('唯一标题', 0));
  let cursor = ''; const ids = [];
  do { const page = await f.call('guides.list', { pageSize: 2, cursor }); ids.push(...page.items.map(row => row._id)); cursor = page.nextCursor; } while (cursor);
  assert.equal(ids.length, 9); assert.equal(new Set(ids).size, 9);
  assert.equal((await f.call('guides.list', { keyword: '唯一', status: 'draft' })).items.length, 1);
  assert.equal((await f.ops.call({ action: 'guides.list', cursor: 'garbage' })).success, false);
  const row = f.db.get('guides', guideId('another-guide'));
  assert.equal((await f.ops.call({ action: 'guides.updateDraft', guideId: row._id, revision: row.revision, slug: 'changed-slug', draft: row.draft })).code, 'GUIDE_SLUG_IMMUTABLE');
});

test('富文本格式可往返，拒绝脚本、外链图片、未知属性和过大或过深正文', () => {
  const body = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '<script>文字</script>', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }] }] }, { type: 'orderedList', attrs: { start: 2 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '列表' }] }] }] }] };
  assert.deepEqual(content.document(content.document(body)), content.document(body));
  const rendered = content.renderNodes(content.document(body), {}); assert.equal(rendered[0].children[0].children[0].children[0].children[0].text, '<script>文字</script>');
  for (const node of [{ type: 'script' }, { type: 'image', attrs: { src: 'https://private.test' } }, { type: 'paragraph', attrs: { onclick: 'evil' } }, { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'javascript:evil' } }] }]) assert.throws(() => content.document({ type: 'doc', content: [node] }));
  assert.throws(() => content.document({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a'.repeat(210000) }] }] }));
  let nested = { type: 'paragraph' }; for (let i = 0; i < 15; i++) nested = { type: 'blockquote', content: [nested] };
  assert.throws(() => content.document({ type: 'doc', content: [nested] }));
});

test('指南图片上传校验、去重、安全签名范围与草稿图片隔离', async () => {
  const f = await fixture(); const created = await f.create(); const id = created.guideId;
  for (const imageData of ['data:image/png;base64,' + Buffer.from('not a png').toString('base64'), 'data:image/png;base64,' + Buffer.alloc(1024 * 1024 + 1).toString('base64'), 'data:image/svg+xml;base64,YQ==']) assert.equal((await f.ops.call({ action: 'guides.image.upload', guideId: id, imageData })).success, false);
  const imageData = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a01020304', 'hex').toString('base64');
  const uploaded = await f.call('guides.image.upload', { guideId: id, imageData }); await f.call('guides.image.upload', { guideId: id, imageData }); assert.equal(f.uploaded.length, 1);
  const next = draft(); next.body.content.push({ type: 'image', attrs: { assetId: uploaded.assetId } });
  const other = await f.create('other-guide');
  assert.equal((await f.ops.call({ action: 'guides.updateDraft', guideId: other.guideId, revision: 1, draft: next })).code, 'GUIDE_INVALID_ASSET');
  await f.call('guides.publish', { guideId: id, revision: 1 }); await f.call('guides.updateDraft', { guideId: id, revision: 2, draft: next });
  f.signed.length = 0; const old = await f.publicCall('public.guides.get', { slug: 'new-guide' }); assert.equal(f.signed.length, 0); assert.doesNotMatch(JSON.stringify(old), /img|cloud:\/\//);
  await f.call('guides.publish', { guideId: id, revision: 3 }); const current = await f.publicCall('public.guides.get', { slug: 'new-guide' }); assert.equal(current.guide.nodes[1].name, 'img'); assert.equal(f.signed.length, 1);
  assert.ok(f.signed.every(file => file.includes('ops/guides/')));
});

test('新增已发布指南进入增长统计，下架拒绝，阅读不建档', async () => {
  const f = await fixture(); const created = await f.create('new-dynamic-guide'); await f.call('guides.publish', { guideId: created.guideId, revision: 1 });
  const user = runtime(path.join(root, 'cloudfunctions/youpuUserApi'), f.db);
  const event = { type: 'growth.record', event: 'view', page: 'pages/guide/index', slug: 'new-dynamic-guide', scene: 1005 };
  assert.equal((await user.call(event)).success, true); assert.equal(f.db.all('growth_events').length, 1); assert.equal(f.db.all('users').length, 0);
  await f.call('guides.unpublish', { guideId: created.guideId, revision: 2 }); assert.equal((await user.call(event)).code, 'GUIDE_NOT_FOUND');
});

function pageHarness(name, call) {
  let page; const events = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/pages', name, 'index.js'), 'utf8'), { Page: definition => { page = definition; }, wx: { setNavigationBarTitle() {} }, require: name => {
    if (name.endsWith('launch-ad')) return { wrap: value => value };
    if (name.endsWith('/api')) return { call, userMessage: error => error.message };
    if (name.endsWith('/growth')) return { record: (...args) => events.push(args), create: () => Promise.resolve() };
    throw new Error(name);
  } });
  page.data = structuredClone(page.data); page.setData = data => Object.assign(page.data, data); return { page, events };
}
test('小程序每次进入重读、失败无静态回退、重试和离页迟到保护', async () => {
  let resolve; let count = 0;
  const h = pageHarness('guide', () => { count++; return new Promise(done => { resolve = done; }); }); h.page.onLoad({ slug: 'dynamic' });
  const pending = h.page.onShow(); h.page.onHide(); resolve({ guide: { slug: 'dynamic', title: '旧响应' } }); await pending; assert.equal(h.page.data.guide, null);
  const next = h.page.onShow(); resolve({ guide: { slug: 'dynamic', title: '当前内容', nodes: [] } }); await next; assert.equal(h.page.data.guide.title, '当前内容'); assert.equal(count, 2);
  assert.equal(h.page.onShareAppMessage().path, '/pages/guide/index?slug=dynamic');
  const failed = pageHarness('guide', () => Promise.reject(new Error('已下架'))); failed.page.onLoad({ slug: 'prepare-family-records' }); await failed.page.onShow(); assert.equal(failed.page.data.guide, null); assert.equal(failed.page.data.error, '已下架');
  let attempts = 0; const list = pageHarness('guides', async () => { if (++attempts === 1) throw new Error('网络错误'); return { items: [], settings: { title: '后台标题', summary: '后台说明' } }; });
  await list.page.onShow(); assert.equal(list.page.data.error, '网络错误'); await list.page.loadGuides(); assert.equal(list.page.data.settings.title, '后台标题'); assert.equal(list.page.data.guides.length, 0); assert.equal(list.page.data.loading, false);
});

test('独立部署内容规范一致，schema、安全规则及后台入口同步', () => {
  assert.equal(fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/guide-content.js'), 'utf8'), fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/guide-content.js'), 'utf8'));
  const indexes = require('../deployment/database-indexes.json'); assert.equal(indexes.schemaVersion, 14); assert.ok(indexes.indexes.guides.some(row => row.unique));
  const rules = fs.readFileSync(path.join(root, 'deployment/apply-security.mjs'), 'utf8'); assert.match(rules, /'guides'/); assert.match(rules, /'guide_assets'/);
  assert.match(fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8'), /GuideManager/);
  assert.equal(fs.existsSync(path.join(root, 'miniprogram/config/guides.js')), false);
});

test('staging探针在生产、环境不匹配或缺少秘密时拒绝，拒绝前不访问数据', async () => {
  const source = fs.readFileSync(path.join(root, 'deployment/guides-staging-probe.js'), 'utf8');
  for (const [env, contextEnv, inputSecret] of [['cloud1-d5gs5yj4l283d9c6d', 'cloud1-d5gs5yj4l283d9c6d', 'secret'], ['fixture-staging', 'other-staging', 'secret'], ['fixture-staging', 'fixture-staging', 'wrong']]) {
    let accesses = 0;
    const exports = {};
    const cloud = { init() {}, database: () => ({ collection() { accesses++; throw new Error('unexpected database access'); } }), getWXContext: () => ({ ENV: contextEnv }) };
    vm.runInNewContext(source, { exports, __dirname: root, process: { env: { PROBE_ENV: env, TCB_ENV: env, PROBE_SECRET: 'secret', PROBE_RUN: 'fixture' } }, require: name => name === 'wx-server-sdk' ? cloud : require(name) });
    await assert.rejects(exports.main({ action: 'cleanup', run: 'fixture', secret: inputSecret })); assert.equal(accesses, 0);
  }
});

test('编辑器与服务端等价JSON字段顺序、空段落和默认列表属性不误报未保存', async () => {
  const { stableStringify, storedDocument } = await import('../admin/src/guide-document.js');
  const editor = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: '格式正文' }] }, { type: 'paragraph' }, { type: 'orderedList', attrs: { start: 1, type: null }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '列表' }] }] }] }] };
  const saved = content.document(storedDocument(editor));
  assert.equal(stableStringify(storedDocument(editor)), stableStringify(storedDocument(saved)));
  const withTemporaryUrl = { type: 'doc', content: [{ type: 'image', attrs: { assetId: 'ga_' + 'a'.repeat(40), src: 'https://fixture.test/signed', width: null, height: null } }] };
  assert.doesNotMatch(JSON.stringify(storedDocument(withTemporaryUrl)), /signed|width|height|src/);
});
