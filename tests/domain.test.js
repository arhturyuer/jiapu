const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../cloudfunctions/youpuUserApi/domain');

test('输入清洗和日期格式不会保留控制字符或非法日期', function () {
  assert.equal(domain.cleanText('  张\u0000三  ', 20), '张三');
  assert.equal(domain.cleanText('123456', 4), '1234');
  assert.equal(domain.cleanDate('2020-08-01'), '2020-08-01');
  assert.equal(domain.cleanDate('2020/08/01'), '');
});

test('家庭角色矩阵只允许明确授权的角色', function () {
  assert.equal(domain.roleAllows('admin', ['admin']), true);
  assert.equal(domain.roleAllows('member', ['admin', 'member']), true);
  assert.equal(domain.roleAllows('viewer', ['admin', 'member']), false);
  assert.equal(domain.roleAllows('owner', ['admin']), false);
});

test('配偶关系规范化且父母子女环可被识别', function () {
  assert.deepEqual(domain.canonicalPair('spouse', 'person-z', 'person-a'), ['person-a', 'person-z']);
  assert.deepEqual(domain.canonicalPair('parent_child', 'person-z', 'person-a'), ['person-z', 'person-a']);
  const relations = [
    { type: 'parent_child', fromPersonId: 'a', toPersonId: 'b', status: 'active' },
    { type: 'parent_child', fromPersonId: 'b', toPersonId: 'c', status: 'active' }
  ];
  assert.equal(domain.reachesTarget('a', 'c', relations), true);
  assert.equal(domain.reachesTarget('c', 'a', relations), false);
});

test('邀请状态按撤销、过期和次数上限统一转换', function () {
  const now = Date.parse('2026-07-14T00:00:00Z');
  assert.equal(domain.invitationState({ status: 'revoked' }, now), 'revoked');
  assert.equal(domain.invitationState({ status: 'active', expiresAt: '2026-07-13T00:00:00Z', useCount: 0, maxUses: 50 }, now), 'expired');
  assert.equal(domain.invitationState({ status: 'active', expiresAt: '2026-08-13T00:00:00Z', useCount: 50, maxUses: 50 }, now), 'exhausted');
  assert.equal(domain.invitationState({ status: 'active', expiresAt: '2026-08-13T00:00:00Z', useCount: 49, maxUses: 50 }, now), 'active');
});
