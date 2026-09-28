const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const ops = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');

function normalize(input, fallback) {
  const source = ops.match(/function normalizeExampleDisplayPreference\(input, fallback\) \{[\s\S]*?\n\}/);
  assert.ok(source);
  const context = {
    input: input,
    fallback: fallback,
    result: null,
    assert: function (condition, code, message) {
      if (!condition) { const error = new Error(message); error.code = code; throw error; }
    }
  };
  vm.runInNewContext(source[0] + '\nresult = normalizeExampleDisplayPreference(input, fallback);', context);
  return JSON.parse(JSON.stringify(context.result));
}

function publicExample(template) {
  const source = userApi.match(/function publicExampleContent\(template\) \{[\s\S]*?\n\}/);
  const description = userApi.match(/function publicExampleDescription\(value\) \{[\s\S]*?\n\}/);
  assert.ok(source);
  assert.ok(description);
  const context = {
    template: template,
    result: null,
    cleanText: function (value) { return String(value || ''); },
    publicExamplePerson: function (person) { return person; }
  };
  vm.runInNewContext(description[0] + '\n' + source[0] + '\nresult = publicExampleContent(template);', context);
  return JSON.parse(JSON.stringify(context.result));
}

test('示例默认展示设置校验五项取值并兼容旧示例', function () {
  const baseline = { nameLayout: 'horizontal', showChildRankBadge: false, showGenderBadge: false, showGenderColors: true, autoCollapseEnabled: true };
  assert.deepEqual(normalize(), baseline);
  assert.deepEqual(normalize(undefined, { nameLayout: 'vertical', autoCollapseEnabled: false }), { ...baseline, nameLayout: 'vertical', autoCollapseEnabled: false });
  assert.throws(function () { normalize({ showGenderBadge: 'yes' }); }, { code: 'EXAMPLE_DISPLAY_PREFERENCE_INVALID' });
  assert.throws(function () { normalize({ nameLayout: 'diagonal' }); }, { code: 'EXAMPLE_DISPLAY_PREFERENCE_INVALID' });
  assert.throws(function () { normalize({ extra: true }); }, { code: 'EXAMPLE_DISPLAY_PREFERENCE_INVALID' });
});

test('示例发布和回滚使用版本化默认值，客户端只读取已发布值', function () {
  assert.match(ops, /draftDisplayPreference: displayPreference/);
  assert.match(ops, /snapshot: \{[^\n]*displayPreference: displayPreference/);
  assert.match(ops, /publishedDisplayPreference: displayPreference/);
  assert.match(ops, /normalizeExampleDisplayPreference\(undefined, snapshot\.displayPreference\)/);
  const publicContent = userApi.match(/function publicExampleContent\(template\) \{[\s\S]*?\n\}/);
  assert.ok(publicContent);
  assert.match(publicContent[0], /template\.publishedDisplayPreference/);
  assert.doesNotMatch(publicContent[0], /template\.draftDisplayPreference/);
  const published = publicExample({
    slug: 'demo', title: '虚构示例', publishedContent: { family: {}, persons: [], relations: [] },
    draftDisplayPreference: { nameLayout: 'vertical', showGenderBadge: true },
    publishedDisplayPreference: { nameLayout: 'horizontal', showGenderBadge: false }
  });
  assert.equal(published.defaultDisplayPreference.nameLayout, 'horizontal');
  assert.equal(published.defaultDisplayPreference.showGenderBadge, false);
  assert.deepEqual(publicExample({ slug: 'legacy', publishedContent: { family: {}, persons: [], relations: [] } }).defaultDisplayPreference,
    { nameLayout: 'horizontal', showChildRankBadge: false, showGenderBadge: false, showGenderColors: true, autoCollapseEnabled: true });
});

test('后台五个编辑页签与预览定位、展示设置相连', function () {
  const manager = fs.readFileSync(path.join(root, 'admin/src/components/ExampleManager.vue'), 'utf8');
  const preview = fs.readFileSync(path.join(root, 'admin/src/components/ExampleGraphPreview.vue'), 'utf8');
  for (const label of ['家谱资料', '人物表', '关系表', '预览图', '默认展示']) assert.match(manager, new RegExp(`label: '${label}'`));
  assert.match(manager, /activeTab\.value = 'persons'/);
  assert.match(manager, /activeTab\.value = 'relations'/);
  assert.match(manager, /:display-preference="draft\.displayPreference"/);
  assert.match(preview, /suggestCollapsedIds\([^\n]*\{ limit: 36 \}/);
  assert.match(preview, /nameLayout: props\.displayPreference\.nameLayout/);
  assert.match(preview, /displayPreference\.showChildRankBadge/);
  assert.match(preview, /displayPreference\.showGenderBadge/);
  assert.match(preview, /displayPreference\.showGenderColors/);
});

test('示例预览使用的共享布局可随竖排和智能收起改变节点', function () {
  const graph = require('../miniprogram/utils/graph-layout');
  const persons = Array.from({ length: 50 }, function (_, index) {
    return { _id: 'p' + index, name: '虚构人物' + index, gender: index % 2 ? 'female' : 'male' };
  });
  const relations = Array.from({ length: 49 }, function (_, index) {
    return { _id: 'r' + index, type: 'parent_child', fromPersonId: 'p' + Math.floor(index / 2), toPersonId: 'p' + (index + 1) };
  });
  const collapsed = graph.suggestCollapsedIds(persons, relations, { limit: 36 });
  const expanded = graph.layoutGraph(persons, relations, { mode: 'full', nameLayout: 'horizontal', collapsedIds: [] });
  const preview = graph.layoutGraph(persons, relations, { mode: 'full', nameLayout: 'vertical', collapsedIds: collapsed });
  assert.equal(expanded.nodes.length, 50);
  assert.equal(preview.nodes.length, 36);
  assert.equal(expanded.nodeWidth, 168);
  assert.equal(preview.nodeWidth, 88);
});
