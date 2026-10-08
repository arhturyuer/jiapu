import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'miniprogram/utils');
const target = resolve(root, 'cloudfunctions/youpuJobs/pdf/shared');
const checking = process.argv.includes('--check');
const files = new Set();
function collect(file) {
  const name = relative(source, file);
  if (files.has(name)) return;
  files.add(name);
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const dependency = resolve(dirname(file), match[1] + '.js');
    if (!dependency.startsWith(source + '/')) throw new Error('PDF 布局依赖必须位于 utils');
    collect(dependency);
  }
}
collect(resolve(source, 'graph-layout.js'));
collect(resolve(source, 'tree-poster-style.js'));
const hashes = {};
for (const name of [...files].sort()) {
  const data = readFileSync(resolve(source, name));
  hashes[name] = createHash('sha256').update(data).digest('hex');
  const destination = resolve(target, name);
  if (checking) {
    if (!existsSync(destination) || !data.equals(readFileSync(destination))) throw new Error('PDF 布局打包不同步：' + name);
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, data);
  }
}
const manifest = JSON.stringify(hashes, null, 2) + '\n';
if (checking) {
  if (readFileSync(resolve(target, 'manifest.json'), 'utf8') !== manifest) throw new Error('PDF 布局指纹不同步');
} else writeFileSync(resolve(target, 'manifest.json'), manifest);
console.log('PDF 布局依赖 ' + files.size + ' 项' + (checking ? '一致' : '已打包'));
