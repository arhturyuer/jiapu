require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function harness() {
  let definition; const calls = []; const timers = new Map(); let next = 0;
  const api = { requestId: () => 'request-id', userMessage: (error, fallback) => error.message || fallback, call: async (type, input) => { calls.push({ type, input }); return {}; } };
  const transfer = { removeTempFile: async () => {}, canShareFile: () => true, isCancelled: () => false };
  const context = { Page: value => { definition = value; }, require: name => name.endsWith('launch-ad') ? { wrap: value => value } : name.endsWith('/api') ? api : transfer, wx: { showToast: () => {} }, setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/pdf-export/index.js'), 'utf8'), context);
  const page = Object.assign({}, definition, { data: Object.assign({}, definition.data), setData: patch => Object.assign(page.data, patch) });
  page.onLoad({ familyId: 'family', display: encodeURIComponent(JSON.stringify({ nameLayout: 'vertical' })) }); page._visible = true;
  return { page, api, transfer, calls, timers };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('PDF 页面沿用显示设置，隐藏后停止轮询并忽略迟到状态', () => {
  const h = harness(); assert.equal(h.page._display.nameLayout, 'vertical');
  h.page.receiveTask({ taskId: 'task', status: 'processing', format: 'poster', progress: 50 });
  assert.equal(h.timers.size, 1); h.page.onHide(); assert.equal(h.timers.size, 0);
  h.page.receiveTask({ taskId: 'task', status: 'completed' }); assert.equal(h.page.data.task.status, 'processing');
});
test('PDF 请求结果不确定时保持同一请求，确认前不能更换格式', async () => {
  const h = harness(); const inputs = [];
  h.api.call = async (type, input) => { inputs.push(input); throw new Error('网络中断'); };
  h.page.generate(); await flush(); assert.equal(h.page.data.uncertain, true);
  h.page.chooseFormat({ currentTarget: { dataset: { format: 'book' } } }); assert.equal(h.page.data.format, 'poster');
  h.page.generate(); await flush(); assert.equal(inputs[0], inputs[1]);
});
test('PDF 文件下载完成后离页清理，不在关闭页面打开文档', async () => {
  const h = harness(); let resolve; const removed = [];
  h.page.data.task = { taskId: 'task', status: 'completed' };
  h.api.call = async () => ({ url: 'https://staging.invalid/pdf', fileName: '测试.pdf' });
  h.transfer.downloadToTempFile = () => new Promise(done => { resolve = done; });
  h.transfer.removeTempFile = async file => removed.push(file);
  const result = h.page.file(); await flush(); h.page.onUnload(); resolve({ filePath: '/tmp/fake.pdf' });
  await assert.rejects(result); assert.deepEqual(removed, ['/tmp/fake.pdf']);
});
