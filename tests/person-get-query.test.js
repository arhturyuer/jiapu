require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('500 人家谱的人物详情只查询当前人物关系，并批量读取亲属', async function () {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/youpuUserApi/index.js'), 'utf8');
  const start = source.indexOf('async function personGet(event) {');
  const end = source.indexOf('\nasync function personCreateRelated(', start);
  assert.ok(start >= 0 && end > start);
  const people = Array.from({ length: 500 }, function (_, index) {
    return { _id: 'p' + index, familyId: 'f1', status: 'active', name: '人物' + index };
  });
  const relations = Array.from({ length: 499 }, function (_, index) {
    return {
      _id: 'r' + index, familyId: 'f1', status: 'active', type: 'parent_child',
      fromPersonId: index < 120 ? 'p0' : 'p' + index,
      toPersonId: 'p' + (index + 1)
    };
  });
  const relationQueries = [];
  const personQueries = [];
  const context = {
    getOpenid: function () { return 'test'; },
    requireActiveUser: async function () {},
    mustGet: async function (_, collection, id) { return people.find(function (person) { return person._id === id; }); },
    requireMembership: async function () { return { membership: { role: 'admin' } }; },
    assert: function (condition) { if (!condition) throw new Error('assertion failed'); },
    listAll: async function (_, where) {
      relationQueries.push(where);
      return relations.filter(function (relation) {
        return Object.keys(where).every(function (field) { return relation[field] === where[field]; });
      });
    },
    db: { collection: function () {
      return { where: function (where) {
        personQueries.push(where);
        return { limit: function (size) {
          assert.ok(size <= 50);
          return { get: async function () {
            return { data: people.filter(function (person) { return where._id.ids.includes(person._id); }) };
          } };
        } };
      } };
    } },
    _: { in: function (ids) { return { ids: ids }; } },
    GRAPH_RELATION_LIMIT: 2000,
    ACTIVE_ROLES: ['admin', 'member', 'viewer'],
    publicPerson: function (person) { return person; },
    result: null
  };
  vm.runInNewContext(source.slice(start, end) + '\nresult = personGet;', context);
  const result = await context.result({ personId: 'p0' });
  assert.equal(result.person._id, 'p0');
  assert.equal(result.relatives.length, 120);
  assert.equal(relationQueries.length, 2);
  assert.ok(relationQueries.every(function (query) { return query.fromPersonId === 'p0' || query.toPersonId === 'p0'; }));
  assert.equal(personQueries.length, 3);
  assert.ok(personQueries.every(function (query) { return query.familyId === 'f1' && query.status === 'active'; }));
});
