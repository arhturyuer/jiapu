module.exports = function () {
  const persons = [
    ['father', '永添', 'male'], ['mother', '李洁玲', 'female'],
    ['son-1', '虚构长子', 'male'], ['son-2', '潘海泉', 'male'],
    ['rong', '潘容芬', 'female'], ['ying', '潘水英', 'female'], ['man', '潘满丽', 'female']
  ].map(function (row) { return { _id: row[0], name: row[1], gender: row[2], status: 'active' }; });
  const relations = [{ _id: 'spouse', type: 'spouse', fromPersonId: 'father', toPersonId: 'mother', status: 'active' }];
  for (const parent of ['father', 'mother']) {
    const ids = parent === 'father' ? ['son-1', 'son-2', 'man', 'rong', 'ying'] : ['rong', 'ying', 'man'];
    ids.forEach(function (id, index) {
      const updatedAt = parent === 'father' ? (id === 'man' ? 300 : 250) : id === 'rong' ? 400 : id === 'ying' ? 350 : 100;
      relations.push({ _id: parent + '-' + id, type: 'parent_child', fromPersonId: parent, toPersonId: id, childOrder: index, updatedAt: updatedAt, status: 'active' });
    });
  }
  return { persons: persons, relations: relations };
};
