const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiapu jobs package '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'cloudfunctions/youpuJobs'); fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ dependencies: { sharp: '0.34.5' } }));
  fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = {};\n');
  const api = await import('../deployment/jobs-package.mjs'); const target = path.join(root, api.JOBS_PACKAGE_DIR);
  api.copyJobsSource(root, target);
  const node = path.join(target, 'node_modules');
  for (const [name, version] of [['sharp', '0.34.5'], ['@img/sharp-linux-x64', '0.34.5'], ['@img/sharp-libvips-linux-x64', '1.2.4'], ['@img/sharp-darwin-arm64', '0.34.5']]) {
    fs.mkdirSync(path.join(node, name), { recursive: true }); fs.writeFileSync(path.join(node, name, 'package.json'), JSON.stringify({ version }));
  }
  fs.mkdirSync(path.join(node, '@img/sharp-linux-x64/lib'));
  const elf = Buffer.alloc(64); elf.write('7f454c46', 0, 'hex'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
  fs.writeFileSync(path.join(node, '@img/sharp-linux-x64/lib/sharp-linux-x64.node'), elf);
  return { root, source, target, api, node };
}
test('Linux 打包排除 Mac 平台包，校验 ELF 并阻止源码过期部署', async t => {
  const h = await fixture(t); const marker = h.api.pruneAndVerifyJobsPackage(h.target);
  assert.equal(marker.ready, true); assert.equal(marker.nativeCount, 1);
  assert.equal(fs.existsSync(path.join(h.node, '@img/sharp-darwin-arm64')), false);
  assert.equal(h.api.verifyJobsPackage(h.root), h.target);
  fs.writeFileSync(path.join(h.source, 'index.js'), 'changed');
  assert.throws(() => h.api.verifyJobsPackage(h.root), /源码不同步/);
});
test('Linux 打包拒绝 Mac 二进制和符号链接，不覆盖未归属目录', async t => {
  const h = await fixture(t); const binary = path.join(h.node, '@img/sharp-linux-x64/lib/sharp-linux-x64.node');
  fs.writeFileSync(binary, Buffer.alloc(64));
  assert.throws(() => h.api.pruneAndVerifyJobsPackage(h.target), /非 Linux x64/);
  fs.rmSync(binary); fs.symlinkSync(path.join(h.source, 'index.js'), binary);
  assert.throws(() => h.api.pruneAndVerifyJobsPackage(h.target), /符号链接/);
  const other = path.join(h.root, 'unowned'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'keep'), 'keep');
  assert.throws(() => h.api.copyJobsSource(h.root, other), /不属于/);
  assert.equal(fs.readFileSync(path.join(other, 'keep'), 'utf8'), 'keep');
});
