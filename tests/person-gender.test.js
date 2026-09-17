require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gender = require('../miniprogram/utils/person-gender');
const graph = require('../miniprogram/utils/graph-layout');

function loadCreateFamilyPage() {
  let definition = null;
  const previousGetApp = global.getApp;
  const previousPage = global.Page;
  global.getApp = function () { return {}; };
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/create-family/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.getApp = previousGetApp;
  global.Page = previousPage;
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function (patch) { Object.assign(page.data, patch); };
  page.onLoad({});
  return page;
}

test('性别展示模型统一输出文字、样式和伴侣默认值', function () {
  assert.deepEqual(gender.presentation('male'), { value: 'male', text: '男', className: 'gender-male' });
  assert.deepEqual(gender.presentation('female'), { value: 'female', text: '女', className: 'gender-female' });
  assert.deepEqual(gender.presentation('unexpected'), { value: 'unknown', text: '未填', className: 'gender-unknown' });
  assert.equal(gender.opposite('male'), 'female');
  assert.equal(gender.opposite('female'), 'male');
  assert.equal(gender.opposite('unknown'), '');
  assert.equal(gender.isKnown('unknown'), false);
});

test('家谱节点携带性别展示信息且不改变横竖排尺寸', function () {
  const persons = [
    { _id: 'm', name: '男性', gender: 'male' },
    { _id: 'f', name: '女性', gender: 'female' },
    { _id: 'u', name: '待补', gender: 'unknown' }
  ];
  const horizontal = graph.layoutGraph(persons, [], { mode: 'full', nameLayout: 'horizontal' });
  assert.equal(horizontal.nodeWidth, 168);
  assert.equal(horizontal.nodeHeight, 164);
  const presentations = Object.fromEntries(horizontal.nodes.map(function (node) { return [node._id, [node.genderText, node.genderClass]]; }));
  assert.deepEqual(presentations, {
    m: ['男', 'gender-male'], f: ['女', 'gender-female'], u: ['未填', 'gender-unknown']
  });
  const vertical = graph.layoutGraph(persons, [], { mode: 'full', nameLayout: 'vertical' });
  assert.equal(vertical.nodeWidth, 88);
  assert.equal(vertical.nodeHeight, 164);
});

test('新建成员契约要求明确性别并保留存量未知性别', function () {
  const root = path.resolve(__dirname, '..');
  const api = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const createPage = fs.readFileSync(path.join(root, 'miniprogram/pages/create-family/index.js'), 'utf8');
  const addTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/add-member/index.wxml'), 'utf8');
  const editTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/edit-member/index.wxml'), 'utf8');
  assert.match(api, /PERSON_GENDER_REQUIRED/);
  assert.match(api, /assertKnownGender\(firstPerson\.gender\)/);
  assert.match(api, /if \(spouseName\) assertKnownGender\(spouseGender\)/);
  assert.match(api, /assertKnownGender\(person\.gender\)/);
  assert.match(api, /assertGenderChangeAllowed\(snapshot\.gender, changes\.gender\)/);
  assert.match(api, /assertGenderChangeAllowed\(person\.gender, request\.payload\.changes\.gender\)/);
  assert.match(createPage, /spouseGender:\s*this\.data\.spouseName\.trim\(\)/);
  assert.doesNotMatch(addTemplate, /data-gender="unknown"/);
  assert.match(editTemplate, /wx:if="\{\{canKeepUnknownGender\}\}"/);
});

test('首次建谱要求选择性别，伴侣默认异性但手动选择优先', function () {
  const previousWx = global.wx;
  const toasts = [];
  global.wx = { showToast: function (value) { toasts.push(value.title); } };
  const page = loadCreateFamilyPage();
  page.setData({ startName: '甲' });
  page.nextStep();
  assert.equal(page.data.step, 1);
  assert.equal(toasts.pop(), '请选择第一位成员的性别');
  page.chooseGender({ currentTarget: { dataset: { gender: 'male' } } });
  assert.equal(page.data.spouseGender, 'female');
  page.nextStep();
  page.inputField({ currentTarget: { dataset: { field: 'spouseName' } }, detail: { value: '伴侣' } });
  assert.equal(page.data.spouseGender, 'female');
  page.chooseSpouseGender({ currentTarget: { dataset: { gender: 'male' } } });
  page.chooseGender({ currentTarget: { dataset: { gender: 'female' } } });
  assert.equal(page.data.spouseGender, 'male');
  global.wx = previousWx;
});

test('男女与未填样式使用约定色板并覆盖主要人物界面', function () {
  const root = path.resolve(__dirname, '..');
  const styles = fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8').toLowerCase();
  assert.match(styles, /#416b89/);
  assert.match(styles, /#e6eff5/);
  assert.match(styles, /#985565/);
  assert.match(styles, /#f5e7eb/);
  assert.match(styles, /#65706a/);
  assert.match(styles, /#ecefed/);
  [
    'miniprogram/pages/tree/index.wxml',
    'miniprogram/pages/example/index.wxml',
    'miniprogram/pages/person-list/index.wxml',
    'miniprogram/pages/member-detail/index.wxml',
    'miniprogram/pages/example-person-detail/index.wxml',
    'admin/src/components/ExampleGraphPreview.vue'
  ].forEach(function (file) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /genderClass/, file + ' 应使用统一性别样式');
  });
});

test('家谱图的性别配色与性别标识可独立生效', function () {
  const root = path.resolve(__dirname, '..');
  const expectedCondition = /showGenderColors && item\.gender !== 'unknown' \? item\.genderClass : 'gender-neutral'/;
  const expectedAvatarCondition = /showGenderColors && selectedPerson\.gender !== 'unknown' \? selectedPerson\.genderClass : 'gender-neutral'/;
  ['miniprogram/pages/tree/index.wxml', 'miniprogram/pages/example/index.wxml'].forEach(function (file) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, expectedCondition, file + ' 应在未知性别或关闭性别配色时使用中性卡片');
    assert.match(source, /wx:if="\{\{showGenderBadge\}\}"/, file + ' 应独立控制性别文字标识');
    assert.match(source, /life-status-badge/, file + ' 应为已故成员提供“故”标记');
    assert.match(source, /is-deceased/, file + ' 应为已故成员提供独立样式');
  });
  assert.match(fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.wxml'), 'utf8'), expectedAvatarCondition);
});
