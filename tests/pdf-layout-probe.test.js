const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../deployment/pdf-staging-probe.js'), 'utf8');
test('PDF 探针拒绝生产、错误环境、错误密钥且不读写业务资料', async () => {
  for (const scenario of [{ env: 'cloud1-d5gs5yj4l283d9c6d', secret: 'secret' }, { env: 'other-staging', secret: 'secret' }, { env: 'fixture-staging', secret: 'wrong' }]) {
    let queries = 0;
    const cloud = { init() {}, database: () => ({ collection() { queries++; throw new Error('unexpected access'); } }), getWXContext: () => ({ ENV: scenario.env }) };
    const context = { exports: {}, require: name => name === 'wx-server-sdk' ? cloud : {}, process: { env: { PROBE_ENV: 'fixture-staging', PROBE_SECRET: 'secret' } }, Buffer };
    vm.runInNewContext(source, context);
    const result = await context.exports.main({ action: 'cleanup', run: '123456abcdef', secret: scenario.secret });
    assert.equal(result.code, 'PROBE_UNAUTHORIZED'); assert.equal(queries, 0);
  }
});
test('密集夹具清理最多四个并发删除，失败时等待本批全部结束再退出', async () => {
  const helper = source.match(/async function removeRows\(name, rows\) \{[\s\S]*?\n\}/)[0];
  let active = 0; let maximum = 0; const completed = [];
  const db = { collection: () => ({ doc: id => ({ remove: async () => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setTimeout(resolve, id === '0' ? 1 : 5)); if (id === '0') throw new Error('virtual failure'); }
    finally { active--; completed.push(id); }
  } }) }) };
  const context = { db }; vm.runInNewContext(helper + '\nthis.removeRows = removeRows;', context);
  await assert.rejects(context.removeRows('persons', Array.from({ length: 10 }, (_, i) => ({ _id: String(i) }))), /virtual failure/);
  assert.equal(maximum, 4); assert.equal(active, 0); assert.deepEqual(completed.sort(), ['0', '1', '2', '3']);
});
