require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const entry = require('../miniprogram/utils/contribution-entry');
const api = require('../miniprogram/utils/api');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function page(call, cacheCalls = []) {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.resolve('miniprogram/pages/contribution/index.js'), 'utf8'), {
    require(name) {
      if (name.includes('launch-ad')) return { wrap: value => value };
      if (name.includes('/api')) return { call, userMessage: error => error.message };
      if (name.includes('format')) return require('../miniprogram/utils/format');
      throw new Error(name);
    },
    getApp: () => ({ getContributionSummary: (familyId, personId, options) => { cacheCalls.push({ type: 'summary', options }); return call('contribution.summary', { familyId, personId }); }, getContributionList: (query, options) => { cacheCalls.push({ type: 'list', options }); return call('contribution.list', query); } }),
    Page: value => { definition = value; }, wx: { stopPullDownRefresh() {} }
  });
  const result = Object.assign({}, definition, { data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update); } });
  result.onLoad({ familyId: 'family', personId: 'p1' });
  return result;
}
const row = id => ({ _id: id, authorKey: 'one', authorName: '小王', summary: '更新资料', createdAt: '2026-10-23', changes: [{ objectName: '王五', label: '出生时间', field: 'birth', before: '不详', after: '农历 1932年8月8日' }] });

test('记录页默认全部、编写者筛选、分页失败重试，长文本保留', async () => {
  const calls = []; let failMore = true;
  const p = page(async (type, query) => {
    calls.push({ type, query });
    if (type === 'contribution.summary') return { authors: [{ key: 'one', name: '同名家人' }, { key: 'two', name: '同名家人' }] };
    if (query.cursor && failMore) throw new Error('网络暂不可用');
    const item = row(query.cursor ? 'second' : 'first');
    if (query.cursor) item.changes[0].after = '长简介'.repeat(600);
    return { items: [item], hasMore: !query.cursor, nextCursor: query.cursor ? '' : 'next' };
  });
  await p.onShow();
  assert.equal(p.data.items[0].summaryText, '补充了王五的出生时间');
  assert.match(p.data.items[0].timeText, /2026.*10.*23.*\d{2}:\d{2}/);
  assert.equal(p.data.authors.length, 3);
  await p.changeAuthor({ detail: { value: 2 } });
  assert.equal(p.data.authorKey, 'two');
  assert.equal(calls.filter(c => c.type === 'contribution.list').at(-1).query.authorKey, 'two');
  await p.loadMore();
  assert.equal(p.data.items.length, 1);
  assert.equal(p.data.moreError, '网络暂不可用');
  failMore = false;
  await p.loadMore();
  assert.equal(p.data.items.length, 2);
  assert.equal(p.data.items[1].changes[0].after.length, 1800);
  assert.equal(p.data.hasMore, false);
});

test('记录页空态、加载错误重试及离页／新筛选的迟到响应隔离', async () => {
  let fail = true;
  const old = deferred(); let late = false;
  const p = page(async type => {
    if (type === 'contribution.summary') return { authors: [] };
    if (late) return old.promise;
    if (fail) throw new Error('无法连接');
    return { items: [], hasMore: false };
  });
  await p.onShow();
  assert.equal(p.data.error, '无法连接');
  fail = false;
  await p.retry();
  assert.equal(p.data.error, '');
  assert.equal(p.data.items.length, 0);
  late = true;
  const loading = p.retry();
  p.onHide();
  late = false;
  await p.onShow();
  old.resolve({ items: [row('stale')], hasMore: false });
  await loading;
  assert.equal(p.data.items.length, 0);
});

test('摘要按身份保留同名名单、前三人加总数、空态及切换人物迟到隔离', async t => {
  const original = api.call; const originalGetApp = global.getApp;
  global.getApp = () => ({ getContributionSummary: (familyId, personId) => api.call('contribution.summary', { familyId, personId }) });
  t.after(() => { api.call = original; global.getApp = originalGetApp; });
  const p = { data: {}, setData(update) { Object.assign(this.data, update); } };
  const slow = deferred();
  api.call = (_, query) => query.personId === 'old' ? slow.promise : Promise.resolve({ authors: Array.from({ length: 4 }, (_, i) => ({ key: String(i), name: '同名家人' })) });
  const pending = entry.load(p, 'family', 'old');
  await entry.load(p, 'family', 'new');
  assert.equal(p.data.contributionText, '资料编写：同名家人、同名家人、同名家人等 4 人');
  slow.resolve({ authors: [] }); await pending;
  assert.match(p.data.contributionText, /4 人/);
  api.call = () => Promise.resolve({ authors: [] });
  await entry.load(p, 'family', 'new');
  assert.equal(p.data.contributionText, '暂无编写记录');
  api.call = () => Promise.reject(new Error('failed'));
  await entry.load(p, 'family', 'new');
  assert.equal(p.data.contributionText, '暂无编写记录');
  assert.equal(p.data.contributionError, true);
  await entry.load(p, 'other-family', 'new');
  assert.match(p.data.contributionText, /点击查看/);
});


test('记录页普通打开和筛选使用缓存，下拉与错误重试同时强刷摘要和列表', async () => {
  const requests = [];
  const p = page(async type => type === 'contribution.summary' ? { authors: [] } : { items: [], hasMore: false }, requests);
  await p.onShow();
  assert.ok(requests.every(request => !request.options));
  requests.length = 0;
  await p.onPullDownRefresh();
  assert.deepEqual(requests.map(request => request.type), ['summary', 'list']);
  assert.ok(requests.every(request => request.options.force === true));
  requests.length = 0;
  await p.retry();
  assert.ok(requests.every(request => request.options.force === true));
});
