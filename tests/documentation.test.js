const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu-docs-'));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'README.md'), '# 当前说明\n\n## 使用方法\n\n[用法](#使用方法)\n');
  fs.writeFileSync(path.join(root, 'docs/文档索引.md'), [
    '# 文档索引',
    '<!-- docs-index:start -->',
    '| [README](../README.md) | 现行规范 | 使用 | 2026-09-16 | [依据](../README.md) | — | 保留 |',
    '| [索引](./文档索引.md) | 现行规范 | 索引 | 2026-09-16 | [依据](../README.md) | — | 新增 |',
    '<!-- docs-index:end -->'
  ].join('\n'));
  return root;
}

test('文档检查接受中文标题、行内和引用链接，并忽略代码示例和外部网址', async function (t) {
  const { checkDocs } = await import('../scripts/check-docs.mjs');
  const root = fixture(t);
  fs.appendFileSync(path.join(root, 'README.md'), '\n[入口][entry]\n[entry]: docs/文档索引.md\n[外部](https://example.invalid/no-network)\n## `node` 命令\n[命令](#node-命令)\n```md\n[示例](不存在.md)\n```\n');
  assert.deepEqual(checkDocs(root, ['README.md', 'docs/文档索引.md']), []);
});

test('文档检查拒绝未登记文件、断链、错误锚点和未定义引用', async function (t) {
  const { checkDocs } = await import('../scripts/check-docs.mjs');
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'docs/new.md'), '# 新文档\n[不存在](gone.md)\n[错锚点](../README.md#wrong)\n');
  let errors = checkDocs(root, ['README.md', 'docs/文档索引.md', 'docs/new.md']);
  assert.ok(errors.some(function (error) { return error.includes('未登记文档'); }));
  assert.ok(errors.some(function (error) { return error.includes('gone.md'); }));
  assert.ok(errors.some(function (error) { return error.includes('失效标题锚点'); }));
  fs.appendFileSync(path.join(root, 'README.md'), '\n[入口][undefined]\n');
  errors = checkDocs(root, ['README.md', 'docs/文档索引.md', 'docs/new.md']);
  assert.ok(errors.some(function (error) { return error.includes('未定义的引用链接'); }));
});

test('历史文档必须有顶部状态与现行替代入口，索引日期和重复登记也被检查', async function (t) {
  const { checkDocs } = await import('../scripts/check-docs.mjs');
  const root = fixture(t);
  const index = path.join(root, 'docs/文档索引.md');
  const row = '| [旧文档](./old.md) | 历史记录 | 旧记录 | 2026-09-16 | [依据](../README.md) | [入口](../README.md) | 原位归档 |';
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('<!-- docs-index:end -->', row + '\n<!-- docs-index:end -->'));
  fs.writeFileSync(path.join(root, 'docs/old.md'), '# 旧说明\n');
  const files = ['README.md', 'docs/文档索引.md', 'docs/old.md'];
  assert.ok(checkDocs(root, files).some(function (error) { return error.includes('顶部未标注'); }));
  fs.appendFileSync(path.join(root, 'docs/old.md'), '\n> 文档状态：历史记录；不作为当前指引。[入口](../README.md)\n');
  assert.deepEqual(checkDocs(root, files), []);
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('<!-- docs-index:end -->', row.replace('2026-09-16', '2026-02-30') + '\n<!-- docs-index:end -->'));
  const errors = checkDocs(root, files);
  assert.ok(errors.some(function (error) { return error.includes('重复登记'); }));
  assert.ok(errors.some(function (error) { return error.includes('无效核验日期'); }));
});

test('现行部署文档中的活动函数和 schema 对齐部署验证及初始化代码', function () {
  const root = path.resolve(__dirname, '..');
  const read = function (file) { return fs.readFileSync(path.join(root, file), 'utf8'); };
  const manifest = JSON.parse(read('deployment/cloudbaserc.example.json'));
  const doc = read('docs/有谱开发部署说明.md');
  for (const fn of manifest.functions) {
    const row = doc.split('\n').find(function (line) { return line.startsWith('|') && line.includes('`' + fn.name + '`') && /\d+ 秒/.test(line); });
    assert.ok(row, '部署说明缺少 ' + fn.name);
    assert.ok(row.includes(fn.timeout + ' 秒') && row.includes(fn.memorySize + ' MB'), fn.name + ' 规格失配');
  }
  const jobs = read('cloudfunctions/youpuJobs/index.js');
  const schema = jobs.match(/doc\('schema'\)\.set\(\{\s*data:\s*\{\s*version:\s*(\d+)/);
  assert.ok(schema);
  assert.ok(doc.includes('schema v' + schema[1]));
  const verifier = read('deployment/verify-cloud.mjs');
  const productionNotifier = verifier.match(/Object\.assign\(\{\}, item, \{ name: '([^']+)'/);
  assert.ok(productionNotifier);
  assert.ok(doc.includes('production：`' + productionNotifier[1] + '`'));
});
