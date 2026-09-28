require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../miniprogram/utils/api');

const root = path.resolve(__dirname, '..');
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

function loadPage() {
  const previousPage = global.Page;
  let definition;
  global.Page = function (value) { definition = value; };
  const modulePath = require.resolve('../miniprogram/pages/examples/index');
  delete require.cache[modulePath];
  require(modulePath);
  global.Page = previousPage;
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function (patch, callback) {
    Object.assign(page.data, patch);
    if (callback) callback();
  };
  return page;
}

test('分类切换保留全部标签，简介按渲染高度展开且重新加载后收起', async function () {
  const previousCall = api.call;
  const previousWx = global.wx;
  const calls = [];
  let navigations = 0;
  api.call = function (type, payload) {
    calls.push({ type, payload });
    return Promise.resolve({
      tags: ['人物', '故事'],
      items: payload.tag === '故事'
        ? [{ _id: 'long', slug: 'long', title: '长故事', description: '甲'.repeat(300) }]
        : [
          { _id: 'long', slug: 'long', title: '长故事', description: '甲'.repeat(300) },
          { _id: 'short', slug: 'short', title: '短故事', description: '简介' }
        ]
    });
  };
  global.wx = {
    navigateTo: function () { navigations += 1; },
    createSelectorQuery: function () {
      const query = {
        in: function () { return this; },
        selectAll: function () { return this; },
        boundingClientRect: function () { return this; },
        exec: function (callback) {
          callback([page.data.examples.map(function () { return { height: 108 }; }),
            page.data.examples.map(function (item) { return { height: item._id === 'long' ? 180 : 36 }; })]);
        }
      };
      return query;
    }
  };
  const page = loadPage();
  try {
    await page.loadExamples();
    assert.deepEqual(page.data.tags, ['人物', '故事']);
    assert.deepEqual(page.data.overflowById, { long: true });
    page.toggleDescription({ currentTarget: { dataset: { id: 'long' } } });
    assert.equal(page.data.expandedById.long, true);
    assert.equal(navigations, 0);
    await new Promise(function (resolve) { page.setData({ activeTag: '故事' }, resolve); });
    await page.loadExamples();
    assert.equal(page.data.expandedById.long, undefined);
    assert.deepEqual(page.data.tags, ['人物', '故事']);
    assert.deepEqual(calls.map(function (call) { return call.payload.tag; }), ['', '故事']);
  } finally {
    api.call = previousCall;
    global.wx = previousWx;
  }
});

test('用户端示例简介保留千字和段落，分类标签从全部已发布示例生成', async function () {
  const source = read('cloudfunctions/youpuUserApi/index.js');
  const descriptionStart = source.indexOf('function publicExampleDescription(');
  const descriptionEnd = source.indexOf('\n// The staging notifier', descriptionStart);
  const listStart = source.indexOf('async function examplesList(');
  const listEnd = source.indexOf('\nasync function examplesGet(', listStart);
  assert.ok(descriptionStart >= 0 && descriptionEnd > descriptionStart && listStart >= 0 && listEnd > listStart);
  const templates = [
    { _id: 'a', tags: ['人物'], publishedContent: {} },
    { _id: 'b', tags: ['故事'], publishedContent: {} }
  ];
  const context = {
    result: null,
    getOpenid: function () { return 'test'; },
    requireActiveUser: async function () {},
    cleanText: function (value) { return String(value || ''); },
    listAll: async function () { return templates; },
    publicExampleContent: function (template) { return { _id: template._id }; }
  };
  vm.runInNewContext(source.slice(descriptionStart, descriptionEnd) + '\n' + source.slice(listStart, listEnd) + '\nresult = { publicExampleDescription, examplesList };', context);
  const description = '  第一段\r\n  第二段 ' + '谱'.repeat(988);
  assert.equal(Array.from(description.replace(/\r\n/g, '\n')).length, 1000);
  assert.equal(context.result.publicExampleDescription(description), description.replace(/\r\n/g, '\n'));
  const list = await context.result.examplesList({ tag: '人物' });
  assert.deepEqual(Array.from(list.tags), ['人物', '故事']);
  assert.deepEqual(Array.from(list.items, function (item) { return item._id; }), ['a']);
});

test('列表仅标签栏横滑，展开操作阻止卡片跳转', function () {
  const style = read('miniprogram/pages/examples/index.wxss');
  const template = read('miniprogram/pages/examples/index.wxml');
  const page = read('miniprogram/pages/examples/index.js');
  assert.match(style, /page \{ overflow-x: hidden; \}/);
  assert.match(style, /\.tag-scroll \{ width: 100%;/);
  assert.match(style, /\.card-desc\.is-collapsed \{ max-height: 108rpx; overflow: hidden; \}/);
  assert.match(style, /\.desc-toggle \{ position: absolute; right: 0; bottom: 0; height: 36rpx;/);
  assert.match(style, /\.desc-tail-reserve \{ visibility: hidden;[^}]*white-space: nowrap; \}/);
  assert.doesNotMatch(style, /\.desc-wrap\.is-expanded \.card-desc \{/);
  assert.match(template, /scroll-view class="tag-scroll" scroll-x/);
  assert.match(template, /catchtap="toggleDescription"/);
  assert.match(template, /class="desc-wrap \{\{expandedById\[item\._id\]/);
  assert.match(template, /class="desc-toggle" wx:if="\{\{overflowById\[item\._id\]\}\}"/);
  assert.match(template, /expandedById\[item\._id\] \? '收起' : '…展开'/);
  assert.match(template, /card-desc card-desc-visible/);
  assert.match(template, /class="desc-tail-reserve" wx:if="\{\{overflowById\[item\._id\] && expandedById\[item\._id\]\}\}">收起<\/text><\/text>/);
  assert.match(page, /selectAll\('\.card-desc-visible'\)/);
});
