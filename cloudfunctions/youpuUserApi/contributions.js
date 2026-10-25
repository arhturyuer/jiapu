const crypto = require('crypto');
const date = require('./pdf-shared/person-date');
const ACTIONS = new Set(['family.create', 'family.update', 'person.create_related', 'person.update', 'person.delete', 'relation.link_existing', 'relation.remove', 'relation.reorder_children', 'relation.reorder_spouses']);
const LABELS = { name: '姓名', gender: '性别', birth: '出生时间', death: '离世时间', lifeStatus: '在世状态', birthPlace: '籍贯', bio: '人物简介', avatarAssetId: '头像' };
const drafts = new WeakMap();
function append(scope, personIds, changes) {
  if (!changes.length) return;
  const draft = drafts.get(scope) || { personIds: [], changes: [] };
  draft.personIds = Array.from(new Set(draft.personIds.concat(personIds)));
  draft.changes.push(...changes);
  drafts.set(scope, draft);
}
function text(person, field) {
  if (field === 'birth' || field === 'death') return date.display(person, field) || '不详';
  if (field === 'gender') return { male: '男', female: '女', unknown: '不详' }[person[field]] || '不详';
  if (field === 'lifeStatus') return { living: '健在', deceased: '已故', unknown: '不详' }[person[field]] || '不详';
  return String(person[field] || '') || '不详';
}
function person(scope, before, after) {
  const target = after || before;
  const changes = [];
  for (const field of Object.keys(LABELS)) {
    const oldValue = before ? text(before, field) : '不详';
    const newValue = after ? text(after, field) : '不详';
    if (field === 'avatarAssetId') {
      if ((before && before.avatarAssetId || '') !== (after && after.avatarAssetId || '')) changes.push({ objectName: target.name, field, label: '头像', before: before && before.avatarAssetId ? '已设置' : '未设置', after: after && after.avatarAssetId ? '已设置' : '未设置', description: !after || !after.avatarAssetId ? '移除头像' : !before || !before.avatarAssetId ? '新增头像' : '更换头像' });
    } else if (oldValue !== newValue && after) changes.push({ objectName: target.name, field, label: LABELS[field], before: oldValue, after: newValue });
  }
  if (!after) changes.push({ objectName: target.name, field: 'person', label: '人物', before: target.name, after: '已删除' });
  append(scope, [target._id], changes);
}
function family(scope, before, after) {
  append(scope, [], ['name', 'description'].filter(key => (before && before[key] || '') !== (after[key] || '')).map(key => ({ objectName: after.name, field: key, label: key === 'name' ? '家谱名称' : '家谱介绍', before: before && before[key] || '不详', after: after[key] || '不详' })));
}
function relation(scope, row, first, second, removed = false) {
  const description = first.name + (row.type === 'spouse' ? '与' : '是') + second.name + (row.type === 'spouse' ? '为配偶' : '的家长');
  append(scope, [row.fromPersonId, row.toPersonId], [{ objectName: '亲属关系', field: 'relation', label: '亲属关系', before: removed ? description : '无此关系', after: removed ? '已移除' : description }]);
}
function order(scope, personIds, objectName, label, before, after, names) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const readable = ids => ids.map(id => names.get(id) || '家人').join('、');
  append(scope, personIds, [{ objectName, field: 'order', label, before: readable(before), after: readable(after) }]);
}
function take(scope) { const value = drafts.get(scope); drafts.delete(scope); return value || null; }
function key(familyId, actorId) { return crypto.createHash('sha256').update(familyId + ':' + actorId).digest('hex').slice(0, 32); }
function createService({ db, command, assert, getOpenid, requireActiveUser, requireMembership, mustGet, maybeGet, roles }) {
  async function access(event) {
    assert(typeof event.familyId === 'string' && event.familyId.length > 0 && event.familyId.length <= 80, 'INVALID_CONTRIBUTION_QUERY', '缺少家谱信息');
    assert(event.personId === undefined || typeof event.personId === 'string' && event.personId.length <= 80, 'INVALID_CONTRIBUTION_QUERY', '人物参数无效');
    assert(event.authorKey === undefined || event.authorKey === '' || typeof event.authorKey === 'string' && /^[a-f0-9]{32}$/.test(event.authorKey), 'INVALID_CONTRIBUTION_QUERY', '编写者参数无效');
    const openid = getOpenid();
    await requireActiveUser(openid);
    await requireMembership(event.familyId, roles, db, openid);
    if (event.personId) {
      const person = await mustGet(db, 'persons', event.personId, 'PERSON_NOT_FOUND', '成员不存在');
      assert(person.familyId === event.familyId, 'CROSS_FAMILY_RELATION', '成员不属于当前家谱');
    }
  }
  function parseCursor(value) {
    if (!value) return null;
    try {
      assert(typeof value === 'string' && value.length <= 600, 'INVALID_CONTRIBUTION_CURSOR', '记录游标无效');
      const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
      assert(typeof parsed.id === 'string' && parsed.id.length <= 100 && Number.isFinite(new Date(parsed.time).getTime()), 'INVALID_CONTRIBUTION_CURSOR', '记录游标无效');
      return parsed;
    } catch (error) { assert(false, 'INVALID_CONTRIBUTION_CURSOR', '记录游标无效'); }
  }
  function cursor(row) { return Buffer.from(JSON.stringify({ time: new Date(row.createdAt).toISOString(), id: row._id })).toString('base64'); }
  async function batch(familyId, position) {
    const base = { familyId };
    let where = base;
    if (position) where = command.and([base, command.or([{ createdAt: command.lt(new Date(position.time)) }, { createdAt: new Date(position.time), _id: command.lt(position.id) }])]);
    return (await db.collection('audit_logs').where(where).orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(100).get()).data || [];
  }
  async function project(row, cache) {
    let contribution = row.contribution;
    const legacy = row.contributionVersion !== 1;
    if (legacy) {
      if (!ACTIONS.has(row.action) && row.action !== 'change.approve') return null;
      contribution = { authorId: row.actorId, authorName: row.actorName, personIds: row.objectType === 'person' ? [row.objectId] : [], changes: [] };
      if (row.action === 'relation.remove') {
        const relation = await maybeGet(db, 'relations', row.objectId);
        if (relation && relation.familyId === row.familyId) contribution.personIds = [relation.fromPersonId, relation.toPersonId];
      }
      if (row.action === 'change.approve') {
        const request = await maybeGet(db, 'change_requests', row.objectId);
        if (!request || request.familyId !== row.familyId || request.status !== 'approved' || !request.createdBy) return null;
        const payload = request.payload || {};
        contribution.authorId = request.createdBy;
        contribution.authorName = request.requesterName;
        contribution.reviewerId = row.actorId;
        contribution.reviewerName = row.actorName;
        contribution.personIds = [payload.personId, payload.anchorPersonId, payload.relatedPersonId, payload.parentPersonId].concat(payload.orderedChildIds || [], payload.orderedPersonIds || [], payload.sharedParentIds || [], payload.sharedChildIds || [], payload.coParentId || [], payload.parentPartnerId || []).filter(Boolean);
        if (!['update_person', 'create_related', 'link_existing_relation', 'reorder_children', 'reorder_spouses'].includes(request.type)) return null;
      }
    }
    if (!contribution || !contribution.authorId) return null;
    async function identity(id) {
      if (!cache.has(id)) cache.set(id, await maybeGet(db, 'users', id));
      return cache.get(id);
    }
    async function name(id, fallback) {
      const user = await identity(id);
      return id.startsWith('deleted_') || user && user.status === 'deleted' ? '已注销用户' : fallback || '一位家人';
    }
    const author = await identity(contribution.authorId);
    const authorId = author && author.status === 'deleted' && author.anonymousActorId || contribution.authorId;
    return { _id: row._id, authorKey: key(row.familyId, authorId), authorName: await name(contribution.authorId, contribution.authorName), reviewerName: contribution.reviewerId ? await name(contribution.reviewerId, contribution.reviewerName) : '', reviewedAt: contribution.reviewerId ? row.createdAt : null, personIds: contribution.personIds || [], summary: row.summary || '编写家谱资料', changes: contribution.changes || [], legacy, createdAt: row.createdAt };
  }
  async function scan(event, listing) {
    await access(event);
    let position = listing ? parseCursor(event.cursor) : null;
    const items = [], authors = new Map(), cache = new Map();
    let more = true;
    while (more) {
      const rows = await batch(event.familyId, position);
      more = rows.length === 100;
      for (const row of rows) {
        position = { time: new Date(row.createdAt).toISOString(), id: row._id };
        const item = await project(row, cache);
        if (!item || event.personId && !item.personIds.includes(event.personId)) continue;
        if (!authors.has(item.authorKey)) authors.set(item.authorKey, { key: item.authorKey, name: item.authorName });
        if (!listing || event.authorKey && item.authorKey !== event.authorKey) continue;
        if (items.length === 30) return { items, hasMore: true, nextCursor: cursor(items[29]) };
        const { personIds, ...publicItem } = item;
        items.push(publicItem);
      }
    }
    return listing ? { items, hasMore: false, nextCursor: null } : { authors: Array.from(authors.values()), count: authors.size };
  }
  return { summary: event => scan(event, false), list: event => scan(event, true) };
}
module.exports = { ACTIONS, person, family, relation, order, take, key, createService };
