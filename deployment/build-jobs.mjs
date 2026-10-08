import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyJobsSource, JOBS_PACKAGE_DIR, pruneAndVerifyJobsPackage } from './jobs-package.mjs';
const root = resolve(import.meta.dirname, '..'); const target = resolve(root, JOBS_PACKAGE_DIR);
copyJobsSource(root, target);
const result = spawnSync(process.env.PNPM_BIN || 'pnpm', ['--dir', target, 'install', '--prod', '--ignore-scripts', '--force', '--frozen-lockfile', '--node-linker=hoisted'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Linux 依赖安装失败，部署包未就绪');
const marker = pruneAndVerifyJobsPackage(target);
console.log('任务函数 Linux x64/glibc 部署包就绪，Sharp ' + marker.sharp);
