module.exports = function fixture(branches = ['b'], siblings = ['a', 'b', 'c']) {
  const persons = [{ _id: 'root', name: '家长', gender: 'male' }];
  const relations = [];
  function person(id, name = '成员', birthDate = '') { persons.push({ _id: id, name, gender: 'male', birthDate }); }
  function edge(from, to, type = 'parent_child') {
    relations.push({ _id: type + ':' + from + ':' + to, type, fromPersonId: from, toPersonId: to });
  }
  siblings.forEach((id, i) => { person(id, '兄弟' + i, '197' + i + '-01-01'); edge('root', id); });
  function children(parent, count = 20) {
    for (let i = 0; i < count; i++) { const id = parent + '-child-' + i; person(id); edge(parent, id); }
  }
  branches.forEach(id => children(id));
  return { persons, relations, person, edge, children };
};
