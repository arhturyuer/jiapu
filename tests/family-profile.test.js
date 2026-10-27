require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runtime } = require('./helpers/counting-runtime');
const { createDatabase } = require('./helpers/membership-db');
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
function fixture(options = {}) {
  const db = createDatabase();
  const actor = 'fixture-actor', actorId = 'u_' + hash(actor), membershipId = 'fm_' + hash('family:' + actor);
  db.put('users', actorId, { nickName: '虚构用户', status: 'active' });
  db.put('families', 'family', { name: '虚构家谱', description: '原简介', status: 'active', personCount: 0, relationCount: 0 });
  db.put('family_memberships', membershipId, { familyId: 'family', userId: actorId, role: 'admin', status: 'active' });
  const server = runtime('cloudfunctions/youpuUserApi', db, options);
  let request = 0;
  return { db, role(role) { db.put('family_memberships', membershipId, { ...db.get('family_memberships', membershipId), role }); },
    call: async (type, data = {}) => JSON.parse(JSON.stringify(await server.call({ type, familyId: 'family', name: '虚构家谱', description: '原简介', requestId: 'profile-' + ++request, ...data }))) };
}
async function ok(h, type, data) { const result = await h.call(type, data); assert.equal(result.success, true, result.message); return result.data; }
test('新增字段完整读写、摘要不携带长文；旧客户端更新不清除新增资料', async () => {
  const h = fixture();
  const profile = { surname: '虚', ancestralHome: '虚构祖籍', hallName: '虚构堂号', generationPoem: '甲乙\n丙丁', history: '历史'.repeat(1500), familyMotto: '家训\n传承', featuredSection: 'history' };
  await ok(h, 'family.update', profile);
  const full = await ok(h, 'family.profile');
  for (const [key, value] of Object.entries(profile)) assert.equal(full.profile[key], value);
  const list = await ok(h, 'family.list');
  assert.equal(list.families[0].history, undefined);
  assert.equal(list.families[0].familyMotto, undefined);
  assert.equal(list.families[0].featuredExcerpt.length, 100);
  await ok(h, 'family.update', { name: '旧客户端改名' });
  assert.equal((await ok(h, 'family.profile')).profile.history, profile.history);
  await ok(h, 'family.update', { history: '', featuredSection: 'none' });
  assert.equal((await ok(h, 'family.profile')).profile.history, '');
});
test('三角色读取、仅管理员编辑；跨谱与归档拒绝访问，公开端无资料动作', async () => {
  const h = fixture();
  for (const role of ['admin', 'member', 'viewer']) {
    h.role(role);
    assert.equal((await h.call('family.profile')).success, true);
    if (role !== 'admin') assert.equal((await h.call('family.update', { surname: '新' })).code, 'NO_PERMISSION');
  }
  h.db.put('families', 'other', { name: '其他家谱', status: 'active' });
  assert.equal((await h.call('family.profile', { familyId: 'other' })).code, 'NO_FAMILY_ACCESS');
  assert.equal((await h.call('public.family.profile')).code, 'UNKNOWN_ACTION');
  assert.equal((await h.call('family.profile', { familyId: {} })).code, 'INVALID_FAMILY_PROFILE');
  assert.equal((await h.call('family.profile', { familyId: '' })).code, 'INVALID_FAMILY_PROFILE');
  h.db.put('families', 'family', { ...h.db.get('families', 'family'), status: 'archived' });
  assert.equal((await h.call('family.profile')).code, 'FAMILY_ARCHIVED');
});
test('旧记录缺省、类型长度和空重点校验，非法输入不能部分保存', async () => {
  const h = fixture();
  const data = await ok(h, 'family.profile');
  assert.equal(data.profile.featuredSection, 'none'); assert.equal(data.profile.history, '');
  for (const input of [{ surname: {} }, { history: '长'.repeat(3001) }, { featuredSection: 'bad' }, { featuredSection: 'familyMotto' }, { hallName: null }]) {
    assert.equal((await h.call('family.update', input)).code, 'INVALID_FAMILY_PROFILE');
    assert.equal(h.db.get('families', 'family').surname, undefined);
  }
});
test('安全检查覆盖长文末尾，拒绝时资料及编写记录均不落库', async () => {
  const seen = [];
  const h = fixture({ cloud: { openapi: { security: { msgSecCheck: async ({ content }) => { seen.push(content); return { result: { suggest: content.includes('尾部拒绝') ? 'risky' : 'pass' } }; } } } } });
  const history = '前'.repeat(2900) + '尾部拒绝';
  const result = await h.call('family.update', { surname: '不能部分保存', history });
  assert.equal(result.success, false);
  assert.ok(seen.some(content => content.includes('尾部拒绝')));
  assert.ok(seen.every(content => content.length <= 2003));
  assert.equal(h.db.get('families', 'family').surname, undefined);
  assert.equal(h.db.all('audit_logs').length, 0);
});
test('全文通过后记录新增和清空前后值，幂等写入及事务失败回滚', async () => {
  const h = fixture();
  await ok(h, 'family.update', { requestId: 'same', surname: '虚', familyMotto: '诚实', featuredSection: 'familyMotto' });
  await ok(h, 'family.update', { requestId: 'same', surname: '虚', familyMotto: '诚实', featuredSection: 'familyMotto' });
  assert.equal(h.db.all('audit_logs').length, 1);
  const records = await ok(h, 'contribution.list');
  assert.ok(records.items[0].changes.some(row => row.label === '家训' && row.after === '诚实'));
  assert.ok(records.items[0].changes.some(row => row.field === 'featuredSection' && row.after === '家训'));
  h.db.writeHook = name => { if (name === 'audit_logs') throw new Error('fixture rollback'); };
  assert.equal((await h.call('family.update', { familyMotto: '不应写入' })).success, false);
  assert.equal(h.db.get('families', 'family').familyMotto, '诚实');
  h.db.writeHook = null;
  await ok(h, 'family.update', { familyMotto: '', featuredSection: 'none' });
  assert.ok((await ok(h, 'contribution.list')).items.some(row => row.changes.some(change => change.before === '诚实' && change.after === '不详')));
});

test('完整备份家谱信息保留新增资料和重点，旧记录按缺省值导出', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync('cloudfunctions/youpuJobs/index.js', 'utf8');
  const body = source.slice(source.indexOf('async function familyBackupDataset('), source.indexOf('async function buildFamilyBackup('));
  let family = { name: '虚构备份', history: '一段历史\n第二段', familyMotto: '家训', featuredSection: 'history' };
  const context = { Buffer, Date, maybeGet: async () => family, listAllForExport: async () => [], toCsv: () => '' };
  vm.runInNewContext(body + '; result = familyBackupDataset;', context);
  let result = await context.result({ familyId: 'family' });
  let exported = JSON.parse(result.baseEntries.find(entry => entry.name === '家谱信息.json').content.toString());
  assert.equal(exported.history, family.history); assert.equal(exported.featuredSection, 'history');
  family = { name: '旧资料' }; result = await context.result({ familyId: 'family' });
  exported = JSON.parse(result.baseEntries[0].content.toString()); assert.equal(exported.featuredSection, 'none'); assert.equal(exported.generationPoem, '');
});

test('staging 探针只在明确独立环境及本次密钥匹配时允许运行', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  for (const env of ['cloud1-d5gs5yj4l283d9c6d', 'other']) {
    const context = { exports: {}, process: { env: { PROBE_ENV: 'fixture-staging', TCB_ENV: env, PROBE_RUN: 'fixture', PROBE_SECRET: 'secret' } }, Buffer, URL, Date, setTimeout, clearTimeout, __dirname: __dirname,
      require: name => name === 'wx-server-sdk' ? { init() {}, database: () => ({}), getWXContext: () => ({ ENV: env }) } : require(name) };
    vm.runInNewContext(fs.readFileSync('deployment/family-profile-staging-probe.js', 'utf8'), context);
    await assert.rejects(context.exports.main({ action: 'run', run: 'fixture', secret: 'secret' }), /PROBE_ENV/);
  }
});
