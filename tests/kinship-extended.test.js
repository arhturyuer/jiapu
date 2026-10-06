const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const kinship = require('../miniprogram/utils/kinship');
const dictionaryLookup = require('../miniprogram/utils/kinship-dictionary');
const cases = require('./fixtures/kinship-cases');

test('称谓词表无损压缩保留全部条目和查询结果并控制主包体积', () => {
  const dictionaryPath = path.join(__dirname, '../miniprogram/utils/kinship-data/dictionary.js');
  const dictionary = require(dictionaryPath);
  const records = dictionary.encoded.match(/[A-Z]+[a-z][^A-Za-z]*/g);
  assert.equal(records.join(''), dictionary.encoded);
  assert.equal(records.length, dictionary.count);
  assert.equal(dictionary.count, 76186);
  assert.ok(fs.statSync(dictionaryPath).size < 530000);
  let key = '';
  let label = '';
  const entries = records.map(function (line) {
    const split = line.search(/[a-z]/);
    key = key.slice(0, line.charCodeAt(0) - 65) + line.slice(1, split);
    label = label.slice(0, line.charCodeAt(split) - 97) + line.slice(split + 1);
    const tokens = Array.from(key, code => dictionary.tokens[code.charCodeAt(0) - 65]);
    const sex = tokens[0] === '0' ? 'female' : tokens[0] === '1' ? 'male' : 'unknown';
    assert.equal(dictionaryLookup.lookup(sex === 'unknown' ? tokens : tokens.slice(1), sex), label);
    return [key, label];
  }).sort((a, b) => a[0] < b[0] ? -1 : 1);
  // Fingerprint of all original 76,186 key/label pairs before this encoding change.
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    'c381bcbde507608001a79f126f9bd6963f58dbc052666354f00a6efe8d291235');
});
function fixture(steps, genders, dates) {
  const persons = [...genders].map((gender, index) => ({ _id: 'p' + index, name: '成员' + index, gender: { M: 'male', F: 'female', '?': 'unknown' }[gender], birthDate: (dates || {})[index] || '', status: 'active' }));
  const relations = [...steps].map((step, index) => ({ _id: 'r' + index, type: step === 'S' ? 'spouse' : 'parent_child', fromPersonId: 'p' + (step === 'U' ? index + 1 : index), toPersonId: 'p' + (step === 'U' ? index : index + 1), status: 'active' }));
  return { persons, relations };
}
for (const [name, steps, genders, expected, dates] of cases) {
  test(name, () => {
    const { persons, relations } = fixture(steps, genders, dates);
    const result = kinship.calculateKinshipDetails(persons, relations, 'p0');
    const detail = result['p' + steps.length];
    assert.equal(detail.label, expected);
    assert.equal(detail.paths[0].personIds[0], 'p0');
    assert.equal(detail.paths[0].personIds.at(-1), 'p' + steps.length);
    assert.deepEqual(detail.paths[0].relationIds, relations.map(r => r._id));
    assert.deepEqual(kinship.calculateKinshipDetails([...persons].reverse(), [...relations].reverse(), 'p0'), result);
  });
}

test('部分日期按区间比较并拒绝无效日期', () => {
  const age = (a, b) => kinship.ageOrder({ birthDate: a }, { birthDate: b });
  assert.equal(age('1990-06', '1990-01'), 'older');
  assert.equal(age('1990-06', '1990-07-01'), 'younger');
  assert.equal(age('1990', '1990-01-01'), '');
  assert.equal(age('1990-06', '1990-06-03'), '');
  assert.equal(age('1990-06-03', '1990-06-03'), '');
  for (const invalid of ['1900-02-29', '2000-02-30', '1990-13', '1990-00', '1990-02-00', '0000', '1990/01/01']) assert.equal(age('1990', invalid), '');
  assert.equal(age('2000-03', '2000-02-29'), 'older');
});

test('同一手足经双亲的证据合并，不产生多重关系', () => {
  const { persons, relations } = fixture('UD', 'MMF');
  persons.push({ _id: 'mother', name: '母亲', gender: 'female' });
  relations.push({ _id: 'm1', type: 'parent_child', fromPersonId: 'mother', toPersonId: 'p0' }, { _id: 'm2', type: 'parent_child', fromPersonId: 'mother', toPersonId: 'p2' });
  const detail = kinship.calculateKinshipDetails(persons, relations, 'p0').p2;
  assert.equal(detail.label, '姐妹');
  assert.equal(detail.multiple, false);
  assert.equal(detail.paths.length, 2);
});

test('血亲优先于较短的姻亲，并展示其他已确认关系', () => {
  const { persons, relations } = fixture('UUD', 'MMMM', { 1: '1960', 3: '1958' });
  persons.push({ _id: 'wife', name: '配偶', gender: 'female' });
  relations.push({ _id: 'w', type: 'spouse', fromPersonId: 'p0', toPersonId: 'wife' }, { _id: 'f', type: 'parent_child', fromPersonId: 'p3', toPersonId: 'wife' });
  const detail = kinship.calculateKinshipDetails(persons, relations, 'p0').p3;
  assert.equal(detail.label, '伯父');
  assert.ok(detail.alternatives.some(item => item.label === '岳父'));
  assert.equal(detail.multiple, true);
});

test('两条伯父路径不被未覆盖的同长度姻亲路径降级', () => {
  const { persons, relations } = fixture('UUD', 'MMMM', { 1: '1960', 3: '1958' });
  persons.push({ _id: 'gm', gender: 'female' }, { _id: 'wife', gender: 'female' }, { _id: 'wp', gender: 'male' });
  relations.push(...[
    ['gm1', 'parent_child', 'gm', 'p1'], ['gm2', 'parent_child', 'gm', 'p3'],
    ['w', 'spouse', 'p0', 'wife'], ['wp1', 'parent_child', 'wp', 'wife'], ['wp2', 'parent_child', 'p3', 'wp']
  ].map(([id, type, from, to]) => ({ _id: id, type, fromPersonId: from, toPersonId: to })));
  const detail = kinship.calculateKinshipDetails(persons, relations, 'p0').p3;
  assert.equal(detail.label, '伯父');
  assert.equal(detail.paths.length, 2);
});

test('双重祖父关系稳定展示主称谓与另一个称谓', () => {
  const persons = [{ _id: 'me', gender: 'male' }, { _id: 'f', gender: 'male' }, { _id: 'm', gender: 'female' }, { _id: 'gp', gender: 'male' }];
  const relations = [['f', 'me'], ['m', 'me'], ['gp', 'f'], ['gp', 'm']].map(([from, to], i) => ({ _id: 'r' + i, type: 'parent_child', fromPersonId: from, toPersonId: to }));
  const detail = kinship.calculateKinshipDetails(persons, relations, 'me').gp;
  assert.equal(detail.label, '爷爷');
  assert.ok(detail.alternatives.some(item => item.label === '外公'));
});

test('反向视角依据人物身份重新推导', () => {
  const { persons, relations } = fixture('UUUDD', 'MFMMFM');
  assert.equal(kinship.calculateKinships(persons, relations, 'p0').p5, '表舅');
  // The viewpoint's mother and target's maternal grandfather are siblings:
  // from p5, p0 is the son of a maternal uncle's daughter.
  assert.equal(kinship.calculateKinships(persons, relations, 'p5').p0, '舅表甥男');
  const direct = fixture('DDS', 'MMMF');
  assert.equal(kinship.calculateKinships(direct.persons, direct.relations, 'p3').p0, '祖公父');
});

test('未连接、删除和未知类型关系不混同亲属', () => {
  const { persons, relations } = fixture('UU', 'MMM');
  persons.push({ _id: 'isolated', gender: 'female' });
  relations[1].status = 'deleted';
  relations.push({ _id: 'bad', type: 'unknown', fromPersonId: 'p0', toPersonId: 'isolated' });
  const details = kinship.calculateKinshipDetails(persons, relations, 'p0');
  assert.equal(details.p2.label, '暂未建立关系');
  assert.equal(details.isolated.category, 'unconnected');
  persons[2].status = 'deleted';
  assert.equal(kinship.calculateKinshipDetails(persons, relations, 'p0').p2, undefined);
  assert.deepEqual(kinship.calculateKinshipDetails(persons, relations, 'missing'), {});
});

test('搜索截断仍保留真实连接和已确认称谓', () => {
  const { persons, relations } = fixture('UUUDD', 'MFMMFM');
  const details = kinship.calculateKinshipDetails(persons, relations, 'p0', { maxStates: 1, maxCandidates: 1 });
  assert.equal(details.p5.label, '表舅');
  assert.equal(details.p5.truncated, true);
  assert.notEqual(details.p4.category, 'unconnected');
});

test('缓存复用并感知原地资料、关系、视角变化', () => {
  const { persons, relations } = fixture('UD', 'MMM');
  const cache = kinship.createKinshipCache();
  const first = cache(persons, relations, 'p0');
  assert.strictEqual(cache(persons, relations, 'p0'), first);
  persons[2].gender = 'female';
  const second = cache(persons, relations, 'p0');
  assert.notStrictEqual(second, first);
  assert.equal(second.p2.label, '姐妹');
  persons[0].birthDate = '1990-06'; persons[2].birthDate = '1990-01';
  assert.equal(cache(persons, relations, 'p0').p2.label, '姐姐');
  assert.equal(cache(persons, relations, 'p2').p0.label, '弟弟');
  relations[1].status = 'deleted';
  assert.equal(cache(persons, relations, 'p0').p2.label, '暂未建立关系');
});
