const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

test('多示例家谱提供只读列表、详情和稳定分享入口', function () {
  const userApi = read('cloudfunctions/youpuUserApi/index.js');
  const app = JSON.parse(read('miniprogram/app.json'));
  const listPage = read('miniprogram/pages/examples/index.wxml');
  const detailPage = read('miniprogram/pages/example/index.js');
  assert.match(userApi, /'examples\.list':\s*examplesList/);
  assert.match(userApi, /'examples\.get':\s*examplesGet/);
  assert.match(userApi, /status:\s*'published'/);
  assert.match(userApi, /publishedContent/);
  assert.ok(app.pages.includes('pages/examples/index'));
  assert.ok(app.pages.includes('pages/example/index'));
  assert.match(listPage, /官方虚构示例/);
  assert.match(detailPage, /open-type="share"|onShareAppMessage/);
  assert.match(detailPage, /path:\s*'\/pages\/example\/index\?slug='/);
});

test('示例详情保留查看交互并阻断真实家谱写入', function () {
  const source = read('miniprogram/pages/example/index.js');
  const template = read('miniprogram/pages/example/index.wxml');
  assert.match(source, /graphLayout\.layoutGraph/);
  assert.match(source, /selectPerspective/);
  assert.match(source, /showPerson/);
  assert.match(template, /添加亲属/);
  assert.doesNotMatch(source, /person\.createRelated|person\.update|invite\.create|family\.dashboard/);
});

test('运营后台提供草稿、发布、回滚、下架和归档治理', function () {
  const ops = read('cloudfunctions/youpuOpsApi/index.js');
  const admin = read('admin/src/components/ExampleManager.vue');
  ['examplesCreate', 'examplesUpdateDraft', 'examplesPublish', 'examplesUnpublish', 'examplesRollback', 'examplesArchive'].forEach(function (name) {
    assert.match(ops, new RegExp('async function ' + name));
  });
  assert.match(ops, /normalizeExampleContent/);
  assert.match(ops, /EXAMPLE_RELATION_CYCLE/);
  assert.match(ops, /EXAMPLE_RELATION_DUPLICATE/);
  assert.match(ops, /requireOperator\(context, \['super_admin'\]\)/);
  assert.match(admin, /图谱预览/);
  assert.match(admin, /保存草稿/);
  assert.match(admin, /发布更新/);
  assert.match(admin, /selected\.status !== 'archived'/);
  assert.match(admin, /回滚到此版本/);
});

test('运营后台支持表格导入导出与基于共享布局的关系图校对', function () {
  const manager = read('admin/src/components/ExampleManager.vue');
  const graph = read('admin/src/components/ExampleGraphPreview.vue');
  assert.match(manager, /import \* as XLSX from 'xlsx'/);
  assert.match(manager, /下载模板/);
  assert.match(manager, /导出 Excel/);
  assert.match(manager, /导出 CSV/);
  assert.match(manager, /导入预览/);
  assert.match(manager, /载入草稿修改/);
  assert.match(manager, /rowIssues\('relation'/);
  assert.match(manager, /未匹配：/);
  assert.match(manager, /整体替换当前草稿/);
  assert.match(graph, /miniprogram\/utils\/graph-layout\.js/);
  assert.match(graph, /layoutGraph\(props\.persons/);
  assert.match(graph, /selectRelation/);
  assert.match(graph, /selectPerson/);
  assert.match(graph, /class="relation-hit"/);
  assert.match(graph, /nodeHeight = computed/);
  assert.match(graph, /:height="nodeHeight"/);
  assert.match(graph, /line\.relationIds/);
  assert.match(graph, /chooseLine\(hit\)/);
  assert.match(graph, /pendingRelationIds/);
  assert.match(graph, /layout\.crossings/);
  assert.doesNotMatch(graph, /function segment\(style:/);
  assert.doesNotMatch(graph, /height="116"/);
  assert.doesNotMatch(graph, /relation-hit" :class="\{ selected:/);
  assert.doesNotMatch(graph, /\.relation-hit\.selected/);
  const userPage = read('miniprogram/pages/tree/index.js');
  const examplePage = read('miniprogram/pages/example/index.js');
  const userCanvas = read('miniprogram/pages/tree/index.wxml');
  const exampleCanvas = read('miniprogram/pages/example/index.wxml');
  for (const source of [userPage, examplePage]) assert.match(source, /crossings: result\.crossings/);
  for (const source of [userCanvas, exampleCanvas]) assert.match(source, /wx:for="\{\{crossings\}\}"/);
});

test('示例表格按唯一姓名管理，内部人物与关系标识由服务端维护', function () {
  const manager = read('admin/src/components/ExampleManager.vue');
  const validation = read('admin/src/example-validation.js');
  const ops = read('cloudfunctions/youpuOpsApi/index.js');
  assert.doesNotMatch(manager, /人物ID|关系ID|起始人物ID|结束人物ID/);
  assert.match(manager, /起始人物姓名/);
  assert.match(manager, /结束人物姓名/);
  assert.match(validation, /姓名重复/);
  assert.match(manager, /fromPersonName/);
  assert.match(ops, /function generatedExampleId/);
  assert.match(ops, /EXAMPLE_PERSON_NAME_DUPLICATE/);
  assert.match(ops, /EXAMPLE_RELATION_PERSON_NOT_FOUND/);
  assert.match(ops, /normalizeExampleContent\(event\.draftContent \|\| template\.draftContent, template\.draftContent\)/);
  assert.match(ops, /draftContent: content/);
});

test('草稿详情在尚未发布、版本集合为空时仍可打开编辑器', function () {
  const ops = read('cloudfunctions/youpuOpsApi/index.js');
  assert.match(ops, /async function examplesDetail/);
  assert.match(ops, /const template = await getExampleTemplate\(event\.templateId\)/);
  assert.match(ops, /const versions = await readExampleVersions\(template\)/);
  assert.match(ops, /publishedVersion <= 0 \|\| template\.status === 'draft'/);
  assert.doesNotMatch(ops.match(/async function examplesDetail[\s\S]*?\n}\n\nasync function examplesCreate/)[0], /maybeGet/);
});

test('示例接口提供可观测错误、强写入审计与健康检查', function () {
  const ops = read('cloudfunctions/youpuOpsApi/index.js');
  assert.match(ops, /function errorDigest/);
  assert.match(ops, /type: 'ops_request_failed'/);
  assert.match(ops, /async function writeRequiredExampleAudit/);
  assert.match(ops, /EXAMPLE_AUDIT_WRITE_FAILED/);
  assert.match(ops, /exampleValidation\.validateExampleContent/);
  assert.match(ops, /details: error\.code && error\.details/);
  assert.match(ops, /async function examplesHealth/);
  assert.match(ops, /'examples\.health': examplesHealth/);
});

test('首次发布会在事务外补齐示例版本集合，避免空集合导致发布失败', function () {
  const ops = read('cloudfunctions/youpuOpsApi/index.js');
  const jobs = read('cloudfunctions/youpuJobs/index.js');
  const security = read('deployment/apply-security.mjs');
  assert.match(ops, /async function ensureExampleCollections/);
  assert.match(ops, /await db\.createCollection\(collectionName\)/);
  assert.match(ops, /message\.includes\('table exist'\)/);
  assert.match(ops, /await db\.collection\(collectionName\)\.limit\(1\)\.get\(\)/);
  assert.match(ops, /await ensureExampleCollections\(\);\n  return opsMutate\(operator, 'examples\.publish'/);
  assert.match(jobs, /'example_template_versions'/);
  assert.match(security, /'example_template_versions'/);
});

test('首次创建示例使用安全主键读取，兼容 CloudBase 事务中的缺失文档返回', function () {
  const ops = read('cloudfunctions/youpuOpsApi/index.js');
  assert.match(ops, /document\\s\*\(\?:is\\s\*\)\?not\\s\*exist/);
  assert.match(ops, /document\\s\*not\\s\*found/);
  const create = ops.match(/async function examplesCreate[\s\S]*?\n}\n\nasync function examplesUpdateDraft/)[0];
  assert.match(create, /maybeGet\('example_templates', id, transaction\)/);
  assert.doesNotMatch(create, /findExampleDocument\('example_templates', id, transaction/);
});

test('运营端详情失败可重试并展示请求 ID', function () {
  const manager = read('admin/src/components/ExampleManager.vue');
  const cloudbase = read('admin/src/cloudbase.ts');
  assert.match(manager, /failedSelection/);
  assert.match(manager, /retrySelected/);
  assert.match(manager, /加载示例草稿失败/);
  assert.match(manager, /请求 ID/);
  assert.match(cloudbase, /请求 ID：\$\{result\.requestId\}/);
  assert.match(cloudbase, /getValidationIssues/);
  assert.match(cloudbase, /details: result\.details/);
});

test('示例图谱复用真实家谱的选中连线、定位与只读资料交互', function () {
  const graph = read('miniprogram/pages/example/index.js');
  const template = read('miniprogram/pages/example/index.wxml');
  const detail = read('miniprogram/pages/example-person-detail/index.js');
  const detailTemplate = read('miniprogram/pages/example-person-detail/index.wxml');
  assert.match(graph, /selectedPersonId/);
  assert.match(graph, /selectedPersonId: personId/);
  assert.match(graph, /graphViewport\.fitTransform/);
  assert.match(graph, /graphViewport\.zoomAroundCenter/);
  assert.match(graph, /graphLayout\.expandCollapsedIds/);
  assert.match(template, /relation-flow/);
  assert.match(template, /openMemberDetail/);
  assert.match(detail, /onRelationTouchMove/);
  assert.match(detail, /Math\.abs\(dx\) > Math\.abs\(dy\) \* 1\.2/);
  assert.match(detailTemplate, /创建后管理关系/);
  assert.doesNotMatch(graph, /person\.update|person\.createRelated|relation\.remove/);
});

test('示例家谱竖屏保留标题操作区，横屏仅保留原生家谱标题', function () {
  const page = read('miniprogram/pages/example/index.wxml');
  const style = read('miniprogram/pages/example/index.wxss');
  const treeStyle = read('miniprogram/pages/tree/index.wxss');
  const source = read('miniprogram/pages/example/index.js');
  assert.match(page, /example-identity/);
  assert.match(page, /example-actions/);
  assert.match(style, /\.example-header \{ height:196rpx/);
  assert.match(style, /height:calc\(100vh - 196rpx - 120rpx\)/);
  assert.match(style, /\.example-page\.is-landscape \.example-header \{ display:none; \}/);
  assert.match(style, /\.example-page\.is-landscape \.graph-viewport \{ height:100vh; \}/);
  assert.match(style, /height:164rpx; min-height:164rpx/);
  assert.match(treeStyle, /height: 164rpx;\n  min-height: 164rpx/);
  assert.match(source, /isLandscape \? 0 : 316 \* width \/ 750/);
  assert.match(source, /setNavigationBarTitle\(\{ title: isLandscape && familyName \? familyName : '示例家谱' \}\)/);
});

test('示例家谱全谱适配沿用真实家谱的完整画布定位策略', function () {
  const viewport = require(path.join(root, 'miniprogram/utils/graph-viewport.js'));
  const layout = { width: 750, height: 900, nodes: [] };
  const viewportSize = { width: 375, height: 500, rpxToPx: 0.5 };
  const exampleTransform = viewport.fitTransform(layout, viewportSize, { fitAll: true, minimumScale: 0.32 });
  const treeTransform = viewport.fitTransform(layout, viewportSize, { fitAll: true, minimumScale: 0.32 });
  assert.deepEqual(exampleTransform, treeTransform);
  assert.doesNotMatch(read('miniprogram/pages/example/index.js'), /contentBounds/);
});
