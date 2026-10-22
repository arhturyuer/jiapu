const domain = require('./domain');
const personDate = require('./person-date');
const PERSON_FIELDS = ['_id', 'name', 'gender', 'lifeStatus', 'birthDate', 'deathDate', 'birthDateInfo', 'deathDateInfo', 'birthDateRange', 'deathDateRange', 'birthPlace', 'bio', 'avatarAssetId', 'spouseDisplayOrder'];
function fields(row, keys) { return Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]])); }
function familyPerson(person) {
  const result = fields(person, PERSON_FIELDS);
  result.birthDateRange = personDate.effectiveRange(person, 'birth');
  result.deathDateRange = personDate.effectiveRange(person, 'death');
  return result;
}
function familyRelation(relation) {
  return {
    _id: relation._id, type: relation.type, fromPersonId: relation.fromPersonId, toPersonId: relation.toPersonId,
    childOrder: relation.type === 'parent_child' && relation.childOrder !== undefined && relation.childOrder !== null && Number.isFinite(Number(relation.childOrder)) ? Number(relation.childOrder) : null,
    childOrderUpdatedAt: relation.type === 'parent_child' ? relation.childOrderUpdatedAt || null : null,
    createdAt: relation.createdAt || null, updatedAt: relation.updatedAt || null
  };
}
function examplePerson(person) {
  const source = person || {};
  return {
    _id: domain.cleanText(source._id, 80), name: domain.cleanText(source.name, 30),
    gender: ['male', 'female', 'unknown'].includes(source.gender) ? source.gender : 'unknown',
    lifeStatus: ['living', 'deceased', 'unknown'].includes(source.lifeStatus) ? source.lifeStatus : 'unknown',
    birthDate: domain.cleanDate(source.birthDate), deathDate: domain.cleanDate(source.deathDate),
    birthPlace: domain.cleanText(source.birthPlace, 80), bio: domain.cleanText(source.bio, 500), avatarAssetId: '', photoAssetIds: []
  };
}
function exampleRelation(relation) {
  return { _id: domain.cleanText(relation._id, 80), type: relation.type === 'spouse' ? 'spouse' : 'parent_child',
    fromPersonId: domain.cleanText(relation.fromPersonId, 80), toPersonId: domain.cleanText(relation.toPersonId, 80) };
}
function exampleGraph(content) {
  const persons = (content.persons || []).map(examplePerson).filter(person => person._id && person.name);
  const ids = new Set(persons.map(person => person._id));
  const relations = (content.relations || []).map(exampleRelation).filter(relation => relation._id && relation.fromPersonId !== relation.toPersonId && ids.has(relation.fromPersonId) && ids.has(relation.toPersonId));
  return { persons, relations };
}
async function rows(db, name, where, limit) {
  const result = []; let cursor = '';
  while (true) {
    const page = (await db.collection(name).where(Object.assign({}, where, cursor ? { _id: db.command.gt(cursor) } : {})).orderBy('_id', 'asc').limit(100).get()).data || [];
    result.push(...page);
    if (result.length > limit) throw Object.assign(new Error('家谱超过当前导出容量'), { code: 'PDF_LIMIT_EXCEEDED' });
    if (page.length < 100) return result;
    cursor = page[page.length - 1]._id;
  }
}
module.exports = { familyPerson, familyRelation, examplePerson, exampleRelation, exampleGraph, rows };
