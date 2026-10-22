const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'admin/src/styles.css'), 'utf8');
const rule = (selector) => styles.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`))?.[1] || '';

test('侧栏菜单限制在视口剩余高度内独立滚动，品牌和账号不收缩', function () {
  assert.match(rule('.sidebar'), /position: sticky/);
  assert.match(rule('.sidebar'), /height: 100dvh/);
  const nav = rule('.sidebar-nav');
  assert.match(nav, /min-height: 0/);
  assert.match(nav, /flex: 1 1 0/);
  assert.match(nav, /overflow-y: auto/);
  assert.match(nav, /overscroll-behavior-y: contain/);
  assert.match(rule('.sidebar-heading'), /flex: 0 0 auto/);
  assert.match(rule('.operator-card'), /flex: 0 0 auto/);
  assert.match(rule('.sidebar-nav button'), /flex: 0 0 auto/);
});

test('收起目录保留可访问的展开按钮和工作区，菜单保留原节点及导航校验', function () {
  assert.match(app, /:aria-label="sidebarCollapsed \? '展开目录' : '收起目录'"/);
  assert.match(app, /:aria-expanded="!sidebarCollapsed" aria-controls="operations-navigation"/);
  assert.match(app, /<nav v-show="!sidebarCollapsed" id="operations-navigation"/);
  assert.match(app, /@click="navigateModule\(item\.key\)"/);
  assert.match(rule('.app-shell.sidebar-collapsed'), /grid-template-columns: 64px minmax\(0, 1fr\)/);
  assert.match(rule('.sidebar-toggle'), /width: 44px; height: 44px/);
  assert.match(styles, /\.sidebar-toggle:focus-visible/);
});
