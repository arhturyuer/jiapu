// Match JavaScript truthiness for the persisted JSON fields, including legacy
// values. Mongo's boolean coercion alone treats the empty string as true.
async function readCompletion(db, familyId, limit, assert) {
  const $ = db.command.aggregate;
  const truthy = field => {
    const value = $.ifNull(['$' + field, null]);
    return $.and([$.neq([value, null]), $.neq([value, false]), $.neq([value, 0]), $.neq([value, ''])]);
  };
  const fields = [truthy('name'), $.and([truthy('gender'), $.neq(['$gender', 'unknown'])]),
    $.or([truthy('birthDate'), truthy('birthDateInfo')]), truthy('avatarAssetId'),
    $.or([truthy('bio'), truthy('birthPlace')])];
  const result = await db.collection('persons').aggregate()
    .match({ familyId, status: 'active' })
    .group({ _id: null, personCount: $.sum(1), completedFields: $.sum($.add(fields.map(field => $.cond([field, 1, 0])))) })
    .limit(1).end();
  const row = (result.list || [])[0] || { personCount: 0, completedFields: 0 };
  assert(row.personCount <= limit, 'RESULT_LIMIT_EXCEEDED', '数据量超过当前版本支持范围，请联系管理员', { collection: 'persons', limit });
  return row.personCount ? Math.round(row.completedFields / (row.personCount * 5) * 100) : 0;
}
module.exports = { readCompletion };
