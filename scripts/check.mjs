import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceFiles } from './workspace-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--build-admin')) {
  console.error('用法: bash scripts/check.sh [--build-admin]');
  process.exit(2);
}
const buildAdmin = args[0] === '--build-admin';
const buildEnv = process.env.VITE_CLOUDBASE_ENV || '';
if (buildAdmin && (!buildEnv || /REPLACE_WITH|YOUR_|<|>|\s/.test(buildEnv))) {
  console.error('--build-admin 必须显式提供有效的 VITE_CLOUDBASE_ENV；仅用于本地构建，不连接云端。');
  process.exit(2);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 19)) {
  console.error('需要 Node.js 20.19+。');
  process.exit(2);
}
const node = process.env.NODE_BIN || process.execPath;
const pnpm = process.env.PNPM_BIN || 'pnpm';

function run(command, commandArgs, cwd = root) {
  const result = spawnSync(command, commandArgs, { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}

try {
  const files = workspaceFiles(root);
  console.log('检查自有 JS/MJS 语法（排除依赖、本地配置和构建产物）');
  for (const file of files.filter(function (file) { return /\.(js|mjs)$/.test(file); })) {
    run(node, ['--check', resolve(root, file)]);
  }
  run(node, [resolve(root, 'scripts/check-docs.mjs')]);
  const tests = files.filter(function (file) { return /^tests\/[^/]+\.test\.js$/.test(file); });
  if (!tests.length) throw new Error('未找到自动化测试，已阻止空检查通过。');
  run(node, ['--test', ...tests.map(function (file) { return resolve(root, file); })]);
  // The build script already includes vue-tsc; avoid running it twice.
  run(pnpm, ['run', buildAdmin ? 'build' : 'typecheck'], resolve(root, 'admin'));
  console.log('本地代码、文档、测试和后台' + (buildAdmin ? '构建' : '类型检查') + '通过；未执行云端或微信操作。');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
