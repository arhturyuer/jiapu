import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
// Each function deploys independently. Package the canonical modules explicitly.
for (const name of ['commerce.js', 'membership-records.js']) {
  const source = readFileSync(resolve(root, 'cloudfunctions/youpuUserApi', name), 'utf8');
  const destination = resolve(root, 'cloudfunctions/youpuOpsApi', name);
  if (process.argv.includes('--check')) {
    if (readFileSync(destination, 'utf8') !== source) throw new Error('会员公共模块未同步：' + name);
  } else writeFileSync(destination, source);
}
console.log('会员公共模块' + (process.argv.includes('--check') ? '核验' : '打包') + '通过');
