import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
export const JOBS_PACKAGE_DIR = 'deployment/build/youpuJobs';
const SHARP_VERSION = '0.34.5';
const VIPS_VERSION = '1.2.4';
export function copyJobsSource(root, target) {
  const source = resolve(root, 'cloudfunctions/youpuJobs');
  if (target === source || target.startsWith(source + '/')) throw new Error('构建目录不能覆盖任务源码');
  if (existsSync(target) && !existsSync(join(target, '.jobs-package.json'))) throw new Error('构建目录不属于此打包器');
  rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (['node_modules', 'config.json'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('源码入口不能是符号链接');
    cpSync(join(source, entry.name), join(target, entry.name), { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(join(target, 'package.json')));
  if (pkg.dependencies.sharp !== SHARP_VERSION) throw new Error('Sharp 构建版本与源码不一致');
  writeFileSync(join(target, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nsupportedArchitectures:\n  os: [linux]\n  cpu: [x64]\n  libc: [glibc]\n');
  writeFileSync(join(target, '.jobs-package.json'), JSON.stringify({ source: 'cloudfunctions/youpuJobs', platform: 'linux', arch: 'x64', libc: 'glibc', ready: false }));
}
export function pruneAndVerifyJobsPackage(target) {
  const directory = join(target, 'node_modules/@img');
  for (const name of readdirSync(directory)) {
    if (name.startsWith('sharp-') && !['sharp-linux-x64', 'sharp-libvips-linux-x64'].includes(name)) rmSync(join(directory, name), { recursive: true, force: true });
  }
  rmSync(join(target, 'node_modules/.bin'), { recursive: true, force: true });
  const sharp = JSON.parse(readFileSync(join(target, 'node_modules/sharp/package.json')));
  const binding = JSON.parse(readFileSync(join(directory, 'sharp-linux-x64/package.json')));
  const vips = JSON.parse(readFileSync(join(directory, 'sharp-libvips-linux-x64/package.json')));
  if (sharp.version !== SHARP_VERSION || binding.version !== SHARP_VERSION || vips.version !== VIPS_VERSION) throw new Error('Linux 原生依赖版本不符合锁定值');
  let nativeCount = 0;
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('部署依赖不能包含符号链接');
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.node')) {
        const bytes = readFileSync(file);
        if (bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) throw new Error('部署包存在非 Linux x64 二进制');
        nativeCount += 1;
      }
    }
  }
  walk(join(target, 'node_modules'));
  if (!nativeCount) throw new Error('Linux Sharp 绑定缺失');
  const marker = { source: 'cloudfunctions/youpuJobs', platform: 'linux', arch: 'x64', libc: 'glibc', ready: true, sharp: SHARP_VERSION, libvipsPackage: VIPS_VERSION, nativeCount };
  writeFileSync(join(target, '.jobs-package.json'), JSON.stringify(marker, null, 2) + '\n');
  return marker;
}
export function verifyJobsPackage(root) {
  const source = resolve(root, 'cloudfunctions/youpuJobs'); const target = resolve(root, JOBS_PACKAGE_DIR);
  const marker = JSON.parse(readFileSync(join(target, '.jobs-package.json')));
  if (!marker.ready || marker.platform !== 'linux' || marker.arch !== 'x64' || marker.libc !== 'glibc') throw new Error('请先执行 node deployment/build-jobs.mjs 构建 Linux 依赖');
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (['node_modules', 'config.json'].includes(entry.name)) continue;
      const file = join(folder, entry.name); const counterpart = join(target, file.slice(source.length + 1));
      if (entry.isDirectory()) walk(file);
      else if (entry.isSymbolicLink() || !existsSync(counterpart) || lstatSync(counterpart).isSymbolicLink() || hash(file) !== hash(counterpart)) throw new Error('Linux 部署包源码不同步，请重新构建');
    }
  }
  walk(source); pruneAndVerifyJobsPackage(target);
  return target;
}
