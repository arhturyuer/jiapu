import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Include new files before commit, but never inspect ignored local credentials.
export function workspaceFiles(root) {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error('无法枚举 Git 工作区文件：' + result.stderr);
  return [...new Set(result.stdout.split('\0').filter(Boolean))].filter(function (file) {
    return !/(^|\/)(node_modules|miniprogram_npm|dist|build|coverage|\.cache|\.git|\.pnpm-store)(\/|$)/.test(file) &&
      !/(^|\/)(env\.local\.js|[^/]+\.local\.(env|json))$/.test(file) &&
      existsSync(resolve(root, file));
  }).sort();
}
