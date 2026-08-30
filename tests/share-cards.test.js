const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const card = require(path.join(root, 'miniprogram/utils/share-card.js'));

test('分享卡按场景生成安全标题、路径与图片兜底', function () {
  const full = card.create({ kind: 'family_full', familyName: '李氏家谱', personCount: 12, role: 'member', inviterName: '李明', path: '/pages/invite/index?token=opaque' });
  const perspective = card.create({ kind: 'family_perspective', familyName: '李氏家谱', personName: '李建国', personCount: 12, role: 'viewer' });
  const example = card.create({ kind: 'example', exampleName: '三代同堂', customTitle: '看看三代同堂的关系' });
  const discovery = card.create({ kind: 'discovery' });
  assert.equal(full.title, '李氏家谱｜已有12位家人，邀你一起完善');
  assert.match(perspective.title, /^从李建国看李氏家谱｜查看家人关系$/);
  assert.equal(example.title, '看看三代同堂的关系');
  assert.equal(discovery.path, '/pages/create-family/index?source=share_menu');
  [full, perspective, example, discovery].forEach(function (value) {
    assert.equal(value.imageUrl, '/images/share/brand-fallback.jpg');
    assert.doesNotMatch(JSON.stringify(value), /birthDate|avatar|tokenHash|phone|联系方式/);
  });
});

test('分享卡长文案有安全截断、层级与短行动语', function () {
  const full = card.create({
    kind: 'family_full',
    familyName: '这是一个名称很长很长很长很长很长很长很长很长的家谱',
    inviterName: '这是一个名称很长很长很长很长很长很长的邀请人',
    personCount: 99,
    role: 'member'
  });
  const perspective = card.create({
    kind: 'family_perspective',
    familyName: '这是一个名称很长很长很长很长很长很长很长很长的家谱',
    personName: '这是一个名称很长很长很长的成员',
    role: 'viewer'
  });
  assert.match(full.title, /…｜已有99位家人/);
  assert.match(perspective.title, /^从.*…看.*…｜查看家人关系$/);
  assert.equal(full.visual.cta, '打开家谱，一起完善');
  assert.equal(perspective.visual.cta, '打开家谱，查看关系');
  assert.ok(full.visual.heading.length <= 30);
  assert.equal(full.visual.meta.includes('…'), true);
});

test('两行标题会为说明文字留出空间，行动语居中显示在放大按钮内', function () {
  const calls = [];
  const canvas = {
    font: '',
    beginPath: function () {}, moveTo: function () {}, arcTo: function () {}, closePath: function () {},
    arc: function () {}, fill: function () {}, stroke: function () {}, fillRect: function () {},
    quadraticCurveTo: function () {},
    measureText: function (value) { return { width: String(value).length * Number((this.font.match(/(\d+)px/) || [0, 20])[1]) }; },
    fillText: function (value, x, y) {
      calls.push({ value: value, x: x, y: y, textAlign: this.textAlign, textBaseline: this.textBaseline });
    }
  };
  const full = card.create({
    kind: 'family_full', familyName: '这是一个名称很长很长很长很长很长很长很长很长的家谱',
    inviterName: '李明', personCount: 12, role: 'member'
  });
  card.draw(canvas, full);
  const meta = calls.find(function (item) { return item.value.indexOf('李明') >= 0; });
  const cta = calls.find(function (item) { return item.value === '打开家谱，一起完善'; });
  assert.ok(meta.y >= 309);
  assert.equal(card.CARD_RENDER_VERSION, 'share-card-v3');
  assert.deepEqual(card.CARD_BUTTON, { x: 76, y: 430, width: 440, height: 90, radius: 24 });
  assert.deepEqual(cta, {
    value: '打开家谱，一起完善', x: 296, y: 475, textAlign: 'center', textBaseline: 'middle'
  });
});

test('分享卡缓存指纹会随展示信息变化', function () {
  const base = { kind: 'family_full', familyName: '张氏家谱', personCount: 3, role: 'member', inviterName: '张华' };
  assert.match(card.fingerprint(base), /^share-card-v3\|/);
  assert.notEqual(card.fingerprint(base), card.fingerprint(Object.assign({}, base, { personCount: 4 })));
  assert.notEqual(card.fingerprint(base), card.fingerprint(Object.assign({}, base, { role: 'viewer' })));
});

test('全部分享入口设置图片，系统菜单进入建谱页', function () {
  const members = fs.readFileSync(path.join(root, 'miniprogram/pages/members/index.js'), 'utf8');
  const tree = fs.readFileSync(path.join(root, 'miniprogram/pages/tree/index.js'), 'utf8');
  const example = fs.readFileSync(path.join(root, 'miniprogram/pages/example/index.js'), 'utf8');
  const createFamily = fs.readFileSync(path.join(root, 'miniprogram/pages/create-family/index.js'), 'utf8');
  [members, tree, example].forEach(function (source) {
    assert.match(source, /imageUrl:/);
    assert.match(source, /share\.record/);
  });
  assert.match(members, /kind: 'discovery'/);
  assert.match(tree, /kind: 'discovery'/);
  assert.match(example, /source=example_share/);
  assert.match(createFamily, /source: this\.data\.source === 'share_menu' \? 'share_menu' : ''/);
  assert.equal(fs.existsSync(path.join(root, 'miniprogram/images/share/brand-fallback.jpg')), true);
});

test('分享漏斗由受控服务端接口与运营后台汇总', function () {
  const userApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const opsApi = fs.readFileSync(path.join(root, 'cloudfunctions/youpuOpsApi/index.js'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'admin/src/App.vue'), 'utf8');
  assert.match(userApi, /async function shareRecord/);
  assert.match(userApi, /'share\.record': shareRecord/);
  assert.match(userApi, /incrementShareMetric\(db, invitationShareKind\(invitation\), 'opened'\)/);
  assert.match(userApi, /incrementShareMetric\(transaction, invitationShareKind\(invitation\), 'converted'\)/);
  assert.match(userApi, /shareSource === 'share_menu'/);
  assert.match(opsApi, /async function shareFunnelSummary\(days\)/);
  assert.match(opsApi, /shareFunnel: shareFunnel/);
  assert.match(admin, /近 \{\{ shareFunnel\.days \}\} 天分享回流/);
});

test('邀请落地页仅展示核心信息且没有举报入口', function () {
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/invite/index.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'miniprogram/pages/invite/index.js'), 'utf8');
  assert.doesNotMatch(wxml, /family-description|举报这条邀请|reportInvite/);
  assert.match(wxml, /仅受邀家人可访问/);
  assert.match(wxml, /wx:if="\{\{isPerspective\}\}"/);
  assert.match(js, /roleText: data\.role === 'member' \? '共同维护' : '仅查看'/);
  assert.match(js, /actionText: data\.role === 'member' \? '加入家谱' : '加入并查看'/);
  assert.doesNotMatch(js, /reportInvite/);
});
