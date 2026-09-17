import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceFiles } from './workspace-files.mjs';

const indexPath = 'docs/文档索引.md';
const statuses = new Set(['现行规范', '规划草案', '历史记录', '已废弃']);

function withoutFences(source) {
  return source.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
}

function withoutCode(source) {
  return withoutFences(source).replace(/`[^`\n]+`/g, '');
}

function links(source) {
  const text = withoutCode(source);
  const destinations = [];
  const references = new Map();
  const normalize = function (value) { return value.trim().replace(/\s+/g, ' ').toLowerCase(); };
  for (const match of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gm)) {
    references.set(normalize(match[1]), match[2]);
    destinations.push(match[2]);
  }
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)) {
    destinations.push(match[1]);
  }
  for (const match of text.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const label = normalize(match[2] || match[1]);
    if (!references.has(label)) throw new Error('未定义的引用链接：' + label);
  }
  return destinations.map(function (value) { return value.replace(/^<|>$/g, ''); });
}

function anchors(source) {
  const result = new Set();
  const counts = new Map();
  const text = withoutFences(source).replace(/`/g, '');
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) || 0;
    result.add(base + (count ? '-' + count : ''));
    counts.set(base, count + 1);
  }
  return result;
}

export function checkDocs(root, files = workspaceFiles(root)) {
  const errors = [];
  const markdown = files.filter(function (file) { return file.endsWith('.md'); });
  const registry = new Map();
  const indexFile = resolve(root, indexPath);
  if (!existsSync(indexFile)) return ['缺少文档索引：' + indexPath];
  const index = readFileSync(indexFile, 'utf8');
  const table = index.match(/<!-- docs-index:start -->([\s\S]*?)<!-- docs-index:end -->/);
  if (!table) return ['文档索引缺少 docs-index 标记'];
  for (const line of table[1].split('\n')) {
    if (!/^\|\s*\[/.test(line)) continue;
    const columns = line.split('|').slice(1, -1).map(function (value) { return value.trim(); });
    const match = columns[0].match(/^\[[^\]]+\]\(([^)]+)\)$/);
    if (columns.length !== 7 || !match) {
      errors.push('索引行应包含文档、状态、用途、核验日期、依据、替代入口、处理说明七列：' + line);
      continue;
    }
    const file = relative(root, resolve(dirname(indexFile), match[1]));
    if (registry.has(file)) errors.push('重复登记：' + file);
    const [, status, purpose, date, evidence, replacement, disposition] = columns;
    if (!statuses.has(status)) errors.push(file + '：无效文档状态');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) errors.push(file + '：无效核验日期');
    if (!purpose || !disposition || !evidence.includes('](')) errors.push(file + '：缺少用途、处理说明或依据链接');
    if (['历史记录', '已废弃', '规划草案'].includes(status) && !replacement.includes('](')) errors.push(file + '：缺少现行替代入口');
    registry.set(file, { status, replacement });
  }
  for (const file of markdown) {
    if (!registry.has(file)) errors.push('未登记文档：' + file);
  }
  for (const [file, entry] of registry) {
    if (!markdown.includes(file)) errors.push('索引指向不存在或已忽略的文档：' + file);
    else if (['历史记录', '已废弃', '规划草案'].includes(entry.status)) {
      const top = readFileSync(resolve(root, file), 'utf8').split('\n').slice(0, 12).join('\n');
      if (!top.includes('文档状态：' + entry.status)) errors.push(file + '：顶部未标注文档状态');
      if (!top.includes('](')) errors.push(file + '：顶部缺少现行入口链接');
      for (const destination of links(entry.replacement)) {
        const replacement = relative(root, resolve(dirname(indexFile), destination.split('#')[0]));
        if (registry.get(replacement)?.status !== '现行规范') errors.push(file + '：替代入口必须是已登记的现行规范');
      }
    }
  }
  for (const file of markdown) {
    const source = readFileSync(resolve(root, file), 'utf8');
    try {
      for (const destination of links(source)) {
        if (/^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('//')) continue;
        const [targetPath, fragment] = destination.split('#');
        const target = resolve(dirname(resolve(root, file)), decodeURIComponent(targetPath || file.split('/').pop()));
        const rel = relative(root, target);
        if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !existsSync(target)) {
          errors.push(file + '：失效或仓库外文件链接 ' + destination);
        } else if (fragment && target.endsWith('.md') && !anchors(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment))) {
          errors.push(file + '：失效标题锚点 ' + destination);
        }
      }
    } catch (error) {
      errors.push(file + '：' + error.message);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const errors = checkDocs(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('文档登记、状态、替代入口及本地文件链接检查通过（不验证外网、线上状态或业务语义）。');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
