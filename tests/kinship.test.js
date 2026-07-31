const assert = require('assert');
const kinship = require('../miniprogram/utils/kinship');

function person(id, gender, birthDate) {
  return { _id: id, name: id, gender: gender, birthDate: birthDate || '', status: 'active' };
}

function parent(id, from, to) {
  return { _id: id, type: 'parent_child', fromPersonId: from, toPersonId: to, status: 'active' };
}

function spouse(id, from, to) {
  return { _id: id, type: 'spouse', fromPersonId: from, toPersonId: to, status: 'active' };
}

const people = [
  person('me', 'male', '1990-06-10'), person('older-brother', 'male', '1988'), person('younger-sister', 'female', '1992'),
  person('same-year-sister', 'female', '1990'), person('father', 'male', '1960-05-01'), person('mother', 'female', '1965-07-02'),
  person('paternal-grandfather', 'male', '1930'), person('paternal-grandmother', 'female', '1933'),
  person('maternal-grandfather', 'male', '1934'), person('maternal-grandmother', 'female', '1936'),
  person('elder-uncle', 'male', '1958'), person('elder-uncle-wife', 'female', '1960'), person('paternal-aunt', 'female', '1963'), person('paternal-aunt-husband', 'male', '1961'),
  person('maternal-uncle', 'male', '1962'), person('maternal-uncle-wife', 'female', '1964'), person('maternal-aunt', 'female', '1967'), person('maternal-aunt-husband', 'male', '1966'),
  person('paternal-cousin', 'male', '1993'), person('maternal-cousin', 'female', '1989'), person('wife', 'female', '1991'), person('father-in-law', 'male', '1961')
];

const relations = [
  parent('r1', 'father', 'me'), parent('r1b', 'mother', 'me'), parent('r2', 'father', 'older-brother'), parent('r3', 'father', 'younger-sister'), parent('r4', 'father', 'same-year-sister'),
  parent('r5', 'paternal-grandfather', 'father'), parent('r6', 'paternal-grandmother', 'father'),
  parent('r7', 'maternal-grandfather', 'mother'), parent('r8', 'maternal-grandmother', 'mother'),
  parent('r9', 'paternal-grandfather', 'elder-uncle'), spouse('r10', 'elder-uncle', 'elder-uncle-wife'),
  parent('r11', 'paternal-grandfather', 'paternal-aunt'), spouse('r12', 'paternal-aunt', 'paternal-aunt-husband'),
  parent('r13', 'maternal-grandfather', 'maternal-uncle'), spouse('r14', 'maternal-uncle', 'maternal-uncle-wife'),
  parent('r15', 'maternal-grandfather', 'maternal-aunt'), spouse('r16', 'maternal-aunt', 'maternal-aunt-husband'),
  parent('r17', 'elder-uncle', 'paternal-cousin'), parent('r18', 'maternal-uncle', 'maternal-cousin'),
  spouse('r19', 'me', 'wife'), parent('r20', 'father-in-law', 'wife')
];

const labels = kinship.calculateKinships(people, relations, 'me');
assert.strictEqual(labels['older-brother'], '哥哥');
assert.strictEqual(labels['younger-sister'], '妹妹');
assert.strictEqual(labels['same-year-sister'], '姐妹');
assert.strictEqual(labels['paternal-grandfather'], '爷爷');
assert.strictEqual(labels['maternal-grandmother'], '外婆');
assert.strictEqual(labels['elder-uncle'], '伯父');
assert.strictEqual(labels['elder-uncle-wife'], '伯母');
assert.strictEqual(labels['paternal-aunt'], '姑妈');
assert.strictEqual(labels['paternal-aunt-husband'], '姑父');
assert.strictEqual(labels['maternal-uncle'], '舅舅');
assert.strictEqual(labels['maternal-uncle-wife'], '舅妈');
assert.strictEqual(labels['maternal-aunt'], '姨妈');
assert.strictEqual(labels['maternal-aunt-husband'], '姨父');
assert.strictEqual(labels['paternal-cousin'], '堂弟');
assert.strictEqual(labels['maternal-cousin'], '表姐');
assert.strictEqual(labels.wife, '妻子');
assert.strictEqual(labels['father-in-law'], '岳父');

assert.strictEqual(kinship.ageOrder(person('a', 'male', '1990'), person('b', 'male', '1990-01-01')), '');
assert.strictEqual(kinship.ageOrder(person('a', 'male', '1990-02-02'), person('b', 'male', '1990-01-01')), 'older');
assert.strictEqual(kinship.directRelationshipLabel(person('a', 'female'), person('b', 'male'), 'spouse'), '丈夫');
assert.strictEqual(kinship.directRelationshipLabel(person('a', 'unknown'), person('b', 'male'), 'spouse'), '配偶');
assert.strictEqual(kinship.relationTypeLabel(person('a', 'male'), 'spouse'), '妻子');

const multiPeople = [person('child', 'female', '1990'), person('father', 'male', '1960'), person('mother', 'female', '1962'), person('shared-grandparent', 'male', '1930')];
const multiRelations = [
  parent('m1', 'father', 'child'), parent('m2', 'mother', 'child'),
  parent('m3', 'shared-grandparent', 'father'), parent('m4', 'shared-grandparent', 'mother')
];
assert.strictEqual(kinship.calculateKinships(multiPeople, multiRelations, 'child')['shared-grandparent'], '祖父');

const preferredPeople = [person('me', 'male', '1990'), person('father', 'male', '1960'), person('wife', 'female', '1991'), person('shared-elder', 'male', '1930')];
const preferredRelations = [
  parent('p1', 'father', 'me'), parent('p2', 'shared-elder', 'father'),
  spouse('p3', 'me', 'wife'), parent('p4', 'shared-elder', 'wife')
];
assert.strictEqual(kinship.calculateKinships(preferredPeople, preferredRelations, 'me')['shared-elder'], '爷爷');

console.log('kinship tests passed');
