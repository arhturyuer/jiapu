require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const presentation = require('../miniprogram/utils/node-presentation');
const graph = require('../miniprogram/utils/graph-layout');
const snapshot = require('../miniprogram/utils/pdf-layout-snapshot');
const viewport = require('../miniprogram/utils/graph-viewport');
const { createDatabase } = require('./helpers/membership-db');
const { runtime } = require('./helpers/counting-runtime');

test('姓名边界、复姓、Unicode 与头像回退遵守共享显示规则', () => {
  const name = '一二三四五六七八九十甲';
  for (const length of [1, 4, 5, 8, 9, 10, 11]) {
    const input = Array.from(name).slice(0, length).join('');
    const horizontal = presentation.nameLines(input);
    const vertical = presentation.nameColumns(input);
    assert.ok(horizontal.length <= 2 && horizontal.every(line => Array.from(line).length <= 5));
    assert.ok(vertical.length <= 2 && vertical.every(column => column.split('\n').length <= 4));
    assert.equal(horizontal.join(''), length > 10 ? name.slice(0, 9) + '…' : input);
    assert.equal(vertical.join('').replaceAll('\n', ''), length > 8 ? name.slice(0, 7) + '…' : input);
  }
  assert.deepEqual(presentation.nameLines('𠮷A欧阳长名字'), ['𠮷A欧阳长', '名字']);
  assert.equal(presentation.surname('欧阳长名字'), '欧阳');
  assert.equal(presentation.surname('𠮷田'), '𠮷');
  assert.equal(presentation.surname(''), '家');
  assert.equal(presentation.surnameFontSize('欧阳'), 20);
  assert.equal(presentation.surnameFontSize('𠮷'), 26);
  assert.deepEqual(presentation.avatarPreference(null, false), { showAvatar: true, emptyAvatarStyle: 'default' });
  assert.deepEqual(presentation.avatarPreference({}, true), { showAvatar: true, emptyAvatarStyle: 'surname' });
  for (const style of ['default', 'surname']) {
    assert.equal(presentation.avatarKind('photo', { emptyAvatarStyle: style }), 'photo');
    assert.equal(presentation.avatarKind('', { emptyAvatarStyle: style }), style);
    assert.equal(presentation.avatarKind('photo', { showAvatar: false, emptyAvatarStyle: style }), 'hidden');
  }
  const content = presentation.horizontalContent(name, 164, true, '1980年');
  assert.equal(content.nameTop + content.lines.length * 30, 128);
  assert.ok(content.metaCenter + 12 <= 156);
});

function fixture() {
  const names = ['张甲', '欧阳长名字', '王乙', '司马长姓名验证', '李丙', '一二三四五六七八九'];
  const persons = Array.from({ length: 36 }, (_, i) => ({ _id: 'p' + i, name: names[i % names.length], status: 'active' }));
  const relations = persons.slice(1).map((person, i) => ({ _id: 'r' + i, type: 'parent_child', fromPersonId: 'p' + Math.floor(i / 2), toPersonId: person._id }));
  relations.push({ _id: 's1', type: 'spouse', fromPersonId: 'p1', toPersonId: 'p2' });
  persons.push({ _id: 'p36', name: '公孙长姓名', status: 'active' });
  relations.push({ _id: 's2', type: 'spouse', fromPersonId: 'p1', toPersonId: 'p36' });
  return { persons, relations };
}
function verifyGeometry(layout) {
  layout.nodes.forEach((a, i) => {
    assert.ok(a.x + a.width <= layout.width && a.y + a.height <= layout.height);
    layout.nodes.slice(i + 1).forEach(b => assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, a._id + ' / ' + b._id));
    layout.lines.filter(line => line.type !== 'spouse').forEach(line => {
      const inside = line.x1 === line.x2
        ? line.x1 > a.x && line.x1 < a.x + a.width && Math.max(line.y1, line.y2) > a.y && Math.min(line.y1, line.y2) < a.y + a.height
        : line.y1 > a.y && line.y1 < a.y + a.height && Math.max(line.x1, line.x2) > a.x && Math.min(line.x1, line.x2) < a.x + a.width;
      assert.equal(inside, false, line._id + ' / ' + a._id);
    });
  });
}
test('逐节点宽度支持多配偶、祖先、折叠、缩放与定位，卡片和连线不交叠', () => {
  const data = fixture();
  for (const mode of ['full', 'perspective']) for (const collapsedIds of [[], ['p2']]) {
    const layout = graph.layoutGraph(data.persons, data.relations, { mode, nameLayout: 'vertical', collapsedIds, viewpointId: 'p0' });
    const short = layout.nodes.find(n => n._id === 'p0');
    const long = layout.nodes.find(n => n._id === 'p1');
    assert.equal(short.width, mode === 'full' ? 88 : 112);
    assert.equal(long.width, mode === 'full' ? 120 : 144);
    assert.equal(long.height, mode === 'full' ? 164 : 212);
    verifyGeometry(layout);
    const transform = viewport.fitTransform(layout, { width: 375, height: 600, rpxToPx: .5 }, { focusPersonId: long._id, currentScale: 1 });
    assert.equal(transform.x, 187.5 - (long.x + long.width / 2) * .5);
  }
  const base = graph.layoutGraph(data.persons, data.relations, { nameLayout: 'vertical' });
  const scaled = graph.layoutGraph(data.persons, data.relations, { nameLayout: 'vertical', contentScale: 1.5 });
  assert.equal(scaled.nodes[1].width, base.nodes[1].width * 1.5);
});
test('v3 往返逐节点宽度并拒绝伪造；v1/v2 保留旧长姓名几何', () => {
  const data = fixture();
  for (const version of [1, 2, 3]) {
    const value = snapshot.create(data.persons, data.relations, 'vertical', 7, version);
    const restored = snapshot.restore(JSON.parse(JSON.stringify(value)), data.persons, data.relations, 7, 'vertical');
    assert.equal(restored.nodes.find(n => n._id === 'p1').width, version === 3 ? 120 : 88);
    assert.equal(restored.presentationVersion, version);
    if (version === 3) {
      const bad = structuredClone(value); bad.nodes.find(row => row[4] === 120)[4] = 88;
      assert.throws(() => snapshot.restore(bad, data.persons, data.relations, 7, 'vertical'), { code: 'PDF_LAYOUT_INVALID' });
    }
  }
});
test('真实偏好路由保留新旧默认值，验证枚举与权限，旧客户端写入不覆盖新字段', async () => {
  const db = createDatabase();
  const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
  const uid = 'u_' + hash('fixture-actor');
  db.put('users', uid, { status: 'active', firstEnteredFamilyAt: new Date() });
  db.put('families', 'family', { status: 'active', name: '虚构家谱' });
  db.put('family_memberships', 'fm_' + hash('family:fixture-actor'), { familyId: 'family', userId: uid, status: 'active', role: 'viewer' });
  const h = runtime('cloudfunctions/youpuUserApi', db);
  const read = () => h.call({ type: 'family.getPreference', familyId: 'family' });
  assert.equal((await read()).data.preference.emptyAvatarStyle, 'default');
  const id = 'fp_' + hash('family:fixture-actor');
  db.put('user_family_preferences', id, { nameLayout: 'horizontal' });
  assert.equal((await read()).data.preference.emptyAvatarStyle, 'surname');
  let result = await h.call({ type: 'family.setPreference', familyId: 'family', showAvatar: false, emptyAvatarStyle: 'default', idempotencyKey: 'new' });
  assert.equal(result.success, true, result.message);
  result = await h.call({ type: 'family.setPreference', familyId: 'family', nameLayout: 'vertical', idempotencyKey: 'legacy' });
  assert.equal(result.data.preference.showAvatar, false);
  assert.equal(result.data.preference.emptyAvatarStyle, 'default');
  for (const patch of [{ showAvatar: 'yes' }, { emptyAvatarStyle: 'photo' }]) {
    result = await h.call({ type: 'family.setPreference', familyId: 'family', ...patch, idempotencyKey: JSON.stringify(patch) });
    assert.equal(result.code, 'INVALID_PREFERENCE');
  }
  result = await h.call({ type: 'family.setPreference', familyId: 'foreign', showAvatar: false, idempotencyKey: 'forbidden' });
  assert.equal(result.success, false);
});

test('系统头像随性别配色选择资源，关闭配色与未填性别保持中性', () => {
  for (const gender of ['male', 'female', 'unknown', '']) {
    assert.equal(presentation.systemAvatar(gender, true), '/images/system-avatar-' + (gender === 'male' || gender === 'female' ? gender : 'neutral') + '.png');
    assert.equal(presentation.systemAvatar(gender, false), '/images/system-avatar-neutral.png');
  }
});
