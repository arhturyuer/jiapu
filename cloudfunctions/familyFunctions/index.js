const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PAGE_SIZE = 100;
const MAX_RECORDS = 1000;
const REQUIRED_COLLECTIONS = [
  'users',
  'system_config',
  'families',
  'family_memberships',
  'user_family_preferences',
  'members',
  'persons',
  'relations',
  'invitations',
  'change_requests',
  'audit_logs',
  'media_assets',
  'reports',
  'notifications'
];
let collectionsReadyPromise = null;

class BusinessError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details || null;
  }
}

function assert(condition, code, message, details) {
  if (!condition) throw new BusinessError(code, message, details);
}

function success(data) {
  return { success: true, data: data || {} };
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLength || 100);
}

function cleanDate(value) {
  const text = cleanText(value, 10);
  if (!text) return '';
  assert(/^\d{4}-\d{2}-\d{2}$/.test(text), 'INVALID_DATE', '日期格式不正确');
  return text;
}

function cleanGender(value) {
  return ['male', 'female', 'unknown'].includes(value) ? value : 'unknown';
}

function cleanRole(value) {
  return ['admin', 'member', 'viewer'].includes(value) ? value : 'viewer';
}

function getOpenid() {
  const context = cloud.getWXContext();
  assert(context.OPENID, 'NOT_LOGGED_IN', '无法获取微信身份，请重新进入小程序');
  return context.OPENID;
}

async function ensureCollections() {
  if (collectionsReadyPromise) return collectionsReadyPromise;
  collectionsReadyPromise = (async function () {
    try {
      const marker = await db.collection('system_config').doc('schema_v3').get();
      if (marker.data && marker.data.ready) return;
    } catch (error) {
      // 首次部署时集合或初始化标记尚不存在，继续执行安全初始化。
    }

    await Promise.all(REQUIRED_COLLECTIONS.map(async function (collectionName) {
      try {
        await db.createCollection(collectionName);
      } catch (error) {
        const message = String(error && (error.message || error.errMsg) || '');
        const alreadyExists = /exist|存在|COLLECTION_EXIST/i.test(message)
          || error.errCode === -502005
          || error.code === 'DATABASE_COLLECTION_EXIST';
        if (!alreadyExists) throw error;
      }
    }));
    await db.collection('system_config').doc('schema_v3').set({
      data: {
        ready: true,
        schemaVersion: 3,
        initializedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  })().catch(function (error) {
    collectionsReadyPromise = null;
    throw error;
  });
  return collectionsReadyPromise;
}

async function getAll(collectionName, where) {
  let offset = 0;
  let records = [];
  while (offset < MAX_RECORDS) {
    let query = db.collection(collectionName);
    if (where) query = query.where(where);
    const response = await query.skip(offset).limit(PAGE_SIZE).get();
    records = records.concat(response.data || []);
    if (!response.data || response.data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return records;
}

async function getByIds(collectionName, ids) {
  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (!uniqueIds.length) return [];
  let records = [];
  for (let index = 0; index < uniqueIds.length; index += 20) {
    const group = uniqueIds.slice(index, index + 20);
    const response = await db.collection(collectionName).where({
      _id: _.in(group)
    }).get();
    records = records.concat(response.data || []);
  }
  return records;
}

async function getDocument(collectionName, id, code, message) {
  assert(id, code || 'MISSING_ID', message || '缺少记录标识');
  try {
    const response = await db.collection(collectionName).doc(id).get();
    return response.data;
  } catch (error) {
    throw new BusinessError(code || 'NOT_FOUND', message || '记录不存在');
  }
}

async function ensureUser(openid) {
  const result = await db.collection('users').where({ openid: openid }).limit(1).get();
  if (result.data.length) return result.data[0];

  const createResult = await db.collection('users').add({
    data: {
      openid: openid,
      nickName: '',
      avatarUrl: '',
      status: 'active',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  return getDocument('users', createResult._id, 'USER_CREATE_FAILED', '用户初始化失败');
}

async function getFamily(familyId) {
  const family = await getDocument('families', familyId, 'FAMILY_NOT_FOUND', '家谱不存在或已删除');
  assert(family.status !== 'archived', 'FAMILY_ARCHIVED', '该家谱已归档');
  return family;
}

async function getMembership(familyId, openid) {
  const response = await db.collection('family_memberships').where({
    familyId: familyId,
    userOpenid: openid,
    status: 'active'
  }).limit(1).get();
  if (response.data.length) return response.data[0];

  const family = await getFamily(familyId);
  if (family.creatorOpenid === openid) {
    const user = await ensureUser(openid);
    const createResult = await db.collection('family_memberships').add({
      data: {
        familyId: familyId,
        userOpenid: openid,
        role: 'admin',
        displayName: user.nickName || '创建者',
        avatarUrl: user.avatarUrl || '',
        status: 'active',
        joinedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    return getDocument('family_memberships', createResult._id);
  }
  return null;
}

async function requireMembership(familyId, roles) {
  const openid = getOpenid();
  const membership = await getMembership(familyId, openid);
  assert(membership, 'NO_FAMILY_ACCESS', '你还不是这个家谱的成员');
  if (roles && roles.length) {
    assert(roles.includes(membership.role), 'NO_PERMISSION', '当前身份不能执行这个操作');
  }
  return { openid: openid, membership: membership };
}

async function writeAudit(familyId, openid, action, objectType, objectId, summary, before, after) {
  let actorName = '家人';
  const userResponse = await db.collection('users').where({ openid: openid }).limit(1).get();
  if (userResponse.data.length && userResponse.data[0].nickName) {
    actorName = userResponse.data[0].nickName;
  }
  await db.collection('audit_logs').add({
    data: {
      familyId: familyId,
      actorOpenid: openid,
      actorName: actorName,
      action: action,
      objectType: objectType,
      objectId: objectId || '',
      summary: summary || '',
      before: before || null,
      after: after || null,
      createdAt: db.serverDate()
    }
  });
}

function normalizePerson(input) {
  const person = input || {};
  const name = cleanText(person.name, 30);
  assert(name, 'PERSON_NAME_REQUIRED', '请填写成员姓名');
  return {
    name: name,
    gender: cleanGender(person.gender),
    birthDate: cleanDate(person.birthDate),
    birthPlace: cleanText(person.birthPlace, 80),
    avatar: cleanText(person.avatar, 500),
    bio: cleanText(person.bio, 500),
    lifeStatus: ['living', 'deceased', 'unknown'].includes(person.lifeStatus)
      ? person.lifeStatus
      : 'unknown'
  };
}

async function createPerson(familyId, input, openid) {
  const person = normalizePerson(input);
  const response = await db.collection('persons').add({
    data: Object.assign({}, person, {
      familyId: familyId,
      status: 'active',
      createdBy: openid,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    })
  });
  return getDocument('persons', response._id, 'PERSON_CREATE_FAILED', '成员创建失败');
}

function canonicalSpouseIds(firstId, secondId) {
  return [firstId, secondId].sort();
}

function legacyRelationId(familyId, type, fromPersonId, toPersonId) {
  const source = [familyId, type, fromPersonId, toPersonId].join(':');
  return 'legacy_' + crypto.createHash('sha1').update(source).digest('hex').slice(0, 24);
}

async function migrateLegacyFamily(family, openid) {
  if (family.legacyMigrationCheckedAt) return { migrated: false };
  const familyId = family._id;
  const legacyMembers = await getAll('members', { familyId: familyId });
  if (!legacyMembers.length) {
    await db.collection('families').doc(familyId).update({
      data: { legacyMigrationCheckedAt: db.serverDate() }
    });
    return { migrated: false, personCount: 0 };
  }

  const memberIds = new Set(legacyMembers.map(function (member) { return member._id; }));
  await Promise.all(legacyMembers.map(function (member) {
    return db.collection('persons').doc(member._id).set({
      data: {
        familyId: familyId,
        name: cleanText(member.name, 30) || '未命名成员',
        gender: cleanGender(member.gender),
        birthDate: cleanText(member.birthDate || member.birthday, 10),
        birthPlace: cleanText(member.birthPlace, 80),
        avatar: cleanText(member.avatar || member.avatarUrl, 500),
        bio: cleanText(member.bio || member.description || member.remark, 500),
        lifeStatus: ['living', 'deceased', 'unknown'].includes(member.lifeStatus)
          ? member.lifeStatus
          : 'unknown',
        status: member.status === 'deleted' ? 'deleted' : 'active',
        createdBy: member.createdBy || member._openid || openid,
        createdAt: member.createdAt || db.serverDate(),
        updatedAt: member.updatedAt || db.serverDate(),
        migratedFrom: 'members'
      }
    });
  }));

  const relationMap = {};
  function collectRelation(type, firstId, secondId) {
    if (!memberIds.has(firstId) || !memberIds.has(secondId) || firstId === secondId) return;
    let fromPersonId = firstId;
    let toPersonId = secondId;
    if (type === 'spouse') {
      const ids = canonicalSpouseIds(firstId, secondId);
      fromPersonId = ids[0];
      toPersonId = ids[1];
    }
    const id = legacyRelationId(familyId, type, fromPersonId, toPersonId);
    relationMap[id] = {
      familyId: familyId,
      type: type,
      fromPersonId: fromPersonId,
      toPersonId: toPersonId,
      status: 'active',
      createdBy: openid,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
      migratedFrom: 'members'
    };
  }

  legacyMembers.forEach(function (member) {
    collectRelation('parent_child', member.fatherId, member._id);
    collectRelation('parent_child', member.motherId, member._id);
    if (Array.isArray(member.spouseIds)) {
      member.spouseIds.forEach(function (spouseId) {
        collectRelation('spouse', member._id, spouseId);
      });
    } else {
      collectRelation('spouse', member._id, member.spouseId);
    }
  });

  await Promise.all(Object.keys(relationMap).map(function (relationId) {
    return db.collection('relations').doc(relationId).set({ data: relationMap[relationId] });
  }));
  await db.collection('families').doc(familyId).update({
    data: {
      schemaVersion: 2,
      legacyMigratedAt: db.serverDate(),
      legacyMigrationCheckedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  await writeAudit(
    familyId,
    openid,
    'family.legacy_migrate',
    'family',
    familyId,
    '已自动迁移旧版家谱数据，共 ' + legacyMembers.length + ' 位成员'
  );
  return {
    migrated: true,
    personCount: legacyMembers.length,
    relationCount: Object.keys(relationMap).length
  };
}

function reachesTarget(startId, targetId, relations) {
  const children = {};
  relations.forEach(function (relation) {
    if (relation.type !== 'parent_child' || relation.status === 'deleted') return;
    if (!children[relation.fromPersonId]) children[relation.fromPersonId] = [];
    children[relation.fromPersonId].push(relation.toPersonId);
  });
  const queue = [startId];
  const visited = {};
  while (queue.length) {
    const current = queue.shift();
    if (current === targetId) return true;
    if (visited[current]) continue;
    visited[current] = true;
    (children[current] || []).forEach(function (id) { queue.push(id); });
  }
  return false;
}

async function createRelation(familyId, type, fromPersonId, toPersonId, openid) {
  assert(fromPersonId && toPersonId && fromPersonId !== toPersonId, 'INVALID_RELATION', '不能把成员与自己建立关系');
  assert(['parent_child', 'spouse'].includes(type), 'INVALID_RELATION', '暂不支持这种亲属关系');

  const people = await getByIds('persons', [fromPersonId, toPersonId]);
  assert(people.length === 2, 'PERSON_NOT_FOUND', '关系中的成员不存在');
  assert(people.every(function (person) { return person.familyId === familyId && person.status !== 'deleted'; }), 'CROSS_FAMILY_RELATION', '不能关联其他家谱的成员');

  let fromId = fromPersonId;
  let toId = toPersonId;
  if (type === 'spouse') {
    const ids = canonicalSpouseIds(fromId, toId);
    fromId = ids[0];
    toId = ids[1];
  }

  const duplicate = await db.collection('relations').where({
    familyId: familyId,
    type: type,
    fromPersonId: fromId,
    toPersonId: toId,
    status: 'active'
  }).limit(1).get();
  assert(!duplicate.data.length, 'RELATION_EXISTS', '这条关系已经存在');

  if (type === 'parent_child') {
    const relations = await getAll('relations', { familyId: familyId, status: 'active' });
    assert(!reachesTarget(toId, fromId, relations), 'RELATION_CYCLE', '这条关系会形成循环，无法保存');
  }

  const response = await db.collection('relations').add({
    data: {
      familyId: familyId,
      type: type,
      fromPersonId: fromId,
      toPersonId: toId,
      status: 'active',
      createdBy: openid,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  return getDocument('relations', response._id, 'RELATION_CREATE_FAILED', '关系创建失败');
}

async function createRelatedNow(familyId, anchorPersonId, relationType, personInput, openid) {
  const anchor = await getDocument('persons', anchorPersonId, 'PERSON_NOT_FOUND', '中心成员不存在');
  assert(anchor.familyId === familyId && anchor.status !== 'deleted', 'CROSS_FAMILY_RELATION', '中心成员不属于当前家谱');

  const prepared = Object.assign({}, personInput || {});
  if (relationType === 'father' || relationType === 'son') prepared.gender = 'male';
  if (relationType === 'mother' || relationType === 'daughter') prepared.gender = 'female';
  const person = await createPerson(familyId, prepared, openid);

  try {
    if (relationType === 'father' || relationType === 'mother') {
      await createRelation(familyId, 'parent_child', person._id, anchorPersonId, openid);
    } else if (relationType === 'son' || relationType === 'daughter') {
      await createRelation(familyId, 'parent_child', anchorPersonId, person._id, openid);
    } else if (relationType === 'spouse') {
      await createRelation(familyId, 'spouse', anchorPersonId, person._id, openid);
    } else {
      throw new BusinessError('INVALID_RELATION', '请选择与中心成员的关系');
    }
  } catch (error) {
    await db.collection('persons').doc(person._id).update({
      data: { status: 'deleted', updatedAt: db.serverDate() }
    });
    throw error;
  }

  await writeAudit(familyId, openid, 'person.create_related', 'person', person._id, '添加了家庭成员“' + person.name + '”', null, person);
  return person;
}

async function authLogin(event) {
  const openid = getOpenid();
  const user = await ensureUser(openid);
  return success({ openid: openid, user: user });
}

async function authUpdateProfile(event) {
  const openid = getOpenid();
  const user = await ensureUser(openid);
  const update = {
    nickName: cleanText(event.nickName, 30),
    avatarUrl: cleanText(event.avatarUrl, 500),
    updatedAt: db.serverDate()
  };
  await db.collection('users').doc(user._id).update({ data: update });
  await db.collection('family_memberships').where({ userOpenid: openid, status: 'active' }).update({
    data: {
      displayName: update.nickName || '家人',
      avatarUrl: update.avatarUrl,
      updatedAt: db.serverDate()
    }
  });
  const refreshed = await getDocument('users', user._id);
  return success({ user: refreshed });
}

async function familyCreate(event) {
  const openid = getOpenid();
  const user = await ensureUser(openid);
  const name = cleanText(event.name, 40);
  assert(name, 'FAMILY_NAME_REQUIRED', '请填写家谱名称');
  const startPersonInput = event.startPerson || {};
  assert(cleanText(startPersonInput.name, 30), 'PERSON_NAME_REQUIRED', '请填写第一个成员的姓名');

  const familyResult = await db.collection('families').add({
    data: {
      name: name,
      description: cleanText(event.description, 200),
      creatorOpenid: openid,
      status: 'active',
      privacy: 'private',
      schemaVersion: 2,
      legacyMigrationCheckedAt: db.serverDate(),
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  const familyId = familyResult._id;
  await db.collection('family_memberships').add({
    data: {
      familyId: familyId,
      userOpenid: openid,
      role: 'admin',
      displayName: user.nickName || '创建者',
      avatarUrl: user.avatarUrl || '',
      status: 'active',
      joinedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });

  const startPerson = await createPerson(familyId, startPersonInput, openid);
  const relatives = event.relatives || {};
  if (cleanText(relatives.fatherName, 30)) {
    await createRelatedNow(familyId, startPerson._id, 'father', { name: relatives.fatherName }, openid);
  }
  if (cleanText(relatives.motherName, 30)) {
    await createRelatedNow(familyId, startPerson._id, 'mother', { name: relatives.motherName }, openid);
  }
  if (cleanText(relatives.spouseName, 30)) {
    await createRelatedNow(familyId, startPerson._id, 'spouse', { name: relatives.spouseName }, openid);
  }

  const family = await getFamily(familyId);
  await writeAudit(familyId, openid, 'family.create', 'family', familyId, '创建了“' + name + '”', null, family);
  return success({ family: family, startPersonId: startPerson._id });
}

async function familyList() {
  const openid = getOpenid();
  await ensureUser(openid);
  let memberships = await getAll('family_memberships', { userOpenid: openid, status: 'active' });
  const legacyFamilies = await getAll('families', { creatorOpenid: openid });
  const membershipFamilyIds = memberships.map(function (item) { return item.familyId; });

  for (const family of legacyFamilies) {
    if (family.status === 'archived' || membershipFamilyIds.includes(family._id)) continue;
    const membership = await getMembership(family._id, openid);
    if (membership) memberships.push(membership);
  }

  const families = await getByIds('families', memberships.map(function (item) { return item.familyId; }));
  const roleByFamily = {};
  memberships.forEach(function (membership) { roleByFamily[membership.familyId] = membership.role; });
  const result = families.filter(function (family) {
    return family.status !== 'archived';
  }).map(function (family) {
    return Object.assign({}, family, { currentRole: roleByFamily[family._id] || 'viewer' });
  }).sort(function (a, b) {
    return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
  });
  return success({ families: result });
}

async function familyUpdate(event) {
  const access = await requireMembership(event.familyId, ['admin']);
  const family = await getFamily(event.familyId);
  const update = {
    name: cleanText(event.name, 40) || family.name,
    description: cleanText(event.description, 200),
    updatedAt: db.serverDate()
  };
  await db.collection('families').doc(event.familyId).update({ data: update });
  const refreshed = await getFamily(event.familyId);
  await writeAudit(event.familyId, access.openid, 'family.update', 'family', event.familyId, '更新了家谱资料', family, refreshed);
  return success({ family: refreshed });
}

async function graphGet(event) {
  const access = await requireMembership(event.familyId, ['admin', 'member', 'viewer']);
  const family = await getFamily(event.familyId);
  let persons = await getAll('persons', { familyId: event.familyId, status: 'active' });
  let relations = await getAll('relations', { familyId: event.familyId, status: 'active' });
  if (access.membership.role === 'admin') {
    const migration = await migrateLegacyFamily(family, access.openid);
    if (migration.migrated) {
      persons = await getAll('persons', { familyId: event.familyId, status: 'active' });
      relations = await getAll('relations', { familyId: event.familyId, status: 'active' });
    }
  }
  return success({
    family: Object.assign({}, family, { currentRole: access.membership.role }),
    persons: persons,
    relations: relations,
    currentRole: access.membership.role
  });
}

async function familySetPreference(event) {
  const access = await requireMembership(event.familyId, ['admin', 'member', 'viewer']);
  const existing = await db.collection('user_family_preferences').where({
    familyId: event.familyId,
    userOpenid: access.openid
  }).limit(1).get();
  const preference = {
    viewMode: event.viewMode === 'perspective' ? 'perspective' : 'full',
    lastViewPersonId: cleanText(event.personId, 80),
    updatedAt: db.serverDate()
  };
  if (existing.data.length) {
    await db.collection('user_family_preferences').doc(existing.data[0]._id).update({ data: preference });
  } else {
    await db.collection('user_family_preferences').add({
      data: Object.assign({}, preference, {
        familyId: event.familyId,
        userOpenid: access.openid,
        createdAt: db.serverDate()
      })
    });
  }
  return success({ saved: true });
}

async function familyDashboard(event) {
  const access = await requireMembership(event.familyId, ['admin', 'member', 'viewer']);
  const family = await getFamily(event.familyId);
  let persons = await getAll('persons', { familyId: event.familyId, status: 'active' });
  let relations = await getAll('relations', { familyId: event.familyId, status: 'active' });
  if (access.membership.role === 'admin') {
    const migration = await migrateLegacyFamily(family, access.openid);
    if (migration.migrated) {
      persons = await getAll('persons', { familyId: event.familyId, status: 'active' });
      relations = await getAll('relations', { familyId: event.familyId, status: 'active' });
    }
  }
  const memberships = await getAll('family_memberships', { familyId: event.familyId, status: 'active' });
  let changes = await getAll('change_requests', { familyId: event.familyId, status: 'pending' });
  let audits = await getAll('audit_logs', { familyId: event.familyId });

  if (access.membership.role !== 'admin') {
    changes = changes.filter(function (item) { return item.createdBy === access.openid; });
  }
  audits = audits.sort(function (a, b) {
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  }).slice(0, 20);

  let completedFields = 0;
  persons.forEach(function (person) {
    completedFields += person.name ? 1 : 0;
    completedFields += person.avatar ? 1 : 0;
    completedFields += person.birthDate ? 1 : 0;
    completedFields += person.bio ? 1 : 0;
  });
  const completion = persons.length ? Math.round(completedFields / (persons.length * 4) * 100) : 0;

  return success({
    family: Object.assign({}, family, { currentRole: access.membership.role }),
    stats: {
      personCount: persons.length,
      relationCount: relations.length,
      collaboratorCount: memberships.length,
      completion: completion,
      pendingCount: changes.length
    },
    collaborators: memberships.map(function (item) {
      return {
        _id: item._id,
        displayName: item.displayName || '家人',
        avatarUrl: item.avatarUrl || '',
        role: item.role,
        joinedAt: item.joinedAt
      };
    }),
    pendingChanges: changes.sort(function (a, b) {
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    }),
    recentActivities: audits
  });
}

async function personGet(event) {
  const person = await getDocument('persons', event.personId, 'PERSON_NOT_FOUND', '成员不存在');
  const access = await requireMembership(person.familyId, ['admin', 'member', 'viewer']);
  assert(person.status !== 'deleted', 'PERSON_NOT_FOUND', '成员已删除');
  const relations = await getAll('relations', { familyId: person.familyId, status: 'active' });
  const directRelations = relations.filter(function (relation) {
    return relation.fromPersonId === person._id || relation.toPersonId === person._id;
  });
  const relatedIds = directRelations.map(function (relation) {
    return relation.fromPersonId === person._id ? relation.toPersonId : relation.fromPersonId;
  });
  const relatedPeople = await getByIds('persons', relatedIds);
  const peopleById = {};
  relatedPeople.forEach(function (item) { peopleById[item._id] = item; });
  const relatives = directRelations.map(function (relation) {
    const relatedId = relation.fromPersonId === person._id ? relation.toPersonId : relation.fromPersonId;
    let relationRole = 'spouse';
    if (relation.type === 'parent_child') {
      relationRole = relation.toPersonId === person._id ? 'parent' : 'child';
    }
    return {
      relationId: relation._id,
      role: relationRole,
      person: peopleById[relatedId]
    };
  }).filter(function (item) { return item.person; });
  return success({ person: person, relatives: relatives, currentRole: access.membership.role });
}

async function personCreateRelated(event) {
  const access = await requireMembership(event.familyId, ['admin', 'member']);
  const payload = {
    familyId: event.familyId,
    anchorPersonId: cleanText(event.anchorPersonId, 80),
    relationType: cleanText(event.relationType, 20),
    person: normalizePerson(event.person || {})
  };

  if (access.membership.role !== 'admin') {
    const requestResult = await db.collection('change_requests').add({
      data: {
        familyId: event.familyId,
        type: 'create_related',
        title: '添加家庭成员“' + payload.person.name + '”',
        payload: payload,
        status: 'pending',
        createdBy: access.openid,
        requesterName: access.membership.displayName || '家人',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await writeAudit(event.familyId, access.openid, 'change.request', 'change_request', requestResult._id, '提交了添加成员申请');
    return success({ pending: true, requestId: requestResult._id });
  }

  const person = await createRelatedNow(event.familyId, payload.anchorPersonId, payload.relationType, payload.person, access.openid);
  return success({ person: person, pending: false });
}

async function personUpdate(event) {
  const person = await getDocument('persons', event.personId, 'PERSON_NOT_FOUND', '成员不存在');
  const access = await requireMembership(person.familyId, ['admin', 'member']);
  const input = event.data || {};
  const safeUpdate = {};
  const highImpactUpdate = {};

  if (input.avatar !== undefined) safeUpdate.avatar = cleanText(input.avatar, 500);
  if (input.bio !== undefined) safeUpdate.bio = cleanText(input.bio, 500);
  if (input.birthDate !== undefined) safeUpdate.birthDate = cleanDate(input.birthDate);
  if (input.birthPlace !== undefined) safeUpdate.birthPlace = cleanText(input.birthPlace, 80);
  if (input.name !== undefined && cleanText(input.name, 30) !== person.name) highImpactUpdate.name = cleanText(input.name, 30);
  if (input.gender !== undefined && cleanGender(input.gender) !== person.gender) highImpactUpdate.gender = cleanGender(input.gender);
  if (input.lifeStatus !== undefined && input.lifeStatus !== person.lifeStatus) {
    highImpactUpdate.lifeStatus = ['living', 'deceased', 'unknown'].includes(input.lifeStatus) ? input.lifeStatus : 'unknown';
  }

  if (Object.keys(safeUpdate).length) {
    safeUpdate.updatedAt = db.serverDate();
    await db.collection('persons').doc(person._id).update({ data: safeUpdate });
  }

  let pending = false;
  if (Object.keys(highImpactUpdate).length) {
    assert(highImpactUpdate.name !== '', 'PERSON_NAME_REQUIRED', '成员姓名不能为空');
    if (access.membership.role === 'admin') {
      highImpactUpdate.updatedAt = db.serverDate();
      await db.collection('persons').doc(person._id).update({ data: highImpactUpdate });
    } else {
      pending = true;
      await db.collection('change_requests').add({
        data: {
          familyId: person.familyId,
          type: 'update_person',
          title: '修改成员“' + person.name + '”的关键信息',
          payload: { personId: person._id, changes: highImpactUpdate },
          status: 'pending',
          createdBy: access.openid,
          requesterName: access.membership.displayName || '家人',
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
  }

  const refreshed = await getDocument('persons', person._id);
  await writeAudit(person.familyId, access.openid, pending ? 'person.update_requested' : 'person.update', 'person', person._id, pending ? '提交了成员资料修改申请' : '更新了成员“' + person.name + '”', person, refreshed);
  return success({ person: refreshed, pending: pending });
}

async function personDelete(event) {
  const person = await getDocument('persons', event.personId, 'PERSON_NOT_FOUND', '成员不存在');
  const access = await requireMembership(person.familyId, ['admin']);
  await db.collection('persons').doc(person._id).update({
    data: { status: 'deleted', deletedAt: db.serverDate(), updatedAt: db.serverDate() }
  });
  const relations = await getAll('relations', { familyId: person.familyId, status: 'active' });
  const related = relations.filter(function (relation) {
    return relation.fromPersonId === person._id || relation.toPersonId === person._id;
  });
  for (const relation of related) {
    await db.collection('relations').doc(relation._id).update({
      data: { status: 'deleted', deletedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
  }
  await writeAudit(person.familyId, access.openid, 'person.delete', 'person', person._id, '删除了成员“' + person.name + '”', person, null);
  return success({ deleted: true });
}

async function changeList(event) {
  const access = await requireMembership(event.familyId, ['admin', 'member']);
  let changes = await getAll('change_requests', { familyId: event.familyId, status: 'pending' });
  if (access.membership.role !== 'admin') {
    changes = changes.filter(function (item) { return item.createdBy === access.openid; });
  }
  changes.sort(function (a, b) { return new Date(b.createdAt || 0) - new Date(a.createdAt || 0); });
  return success({ changes: changes, currentRole: access.membership.role });
}

async function changeReview(event) {
  const request = await getDocument('change_requests', event.requestId, 'REQUEST_NOT_FOUND', '修改申请不存在');
  const access = await requireMembership(request.familyId, ['admin']);
  assert(request.status === 'pending', 'REQUEST_REVIEWED', '这条申请已经处理');
  const approved = event.decision === 'approve';
  let createdPerson = null;

  if (approved && request.type === 'create_related') {
    const payload = request.payload;
    createdPerson = await createRelatedNow(payload.familyId, payload.anchorPersonId, payload.relationType, payload.person, access.openid);
  }
  if (approved && request.type === 'update_person') {
    const person = await getDocument('persons', request.payload.personId, 'PERSON_NOT_FOUND', '成员不存在');
    assert(person.familyId === request.familyId, 'CROSS_FAMILY_RELATION', '申请数据异常');
    await db.collection('persons').doc(person._id).update({
      data: Object.assign({}, request.payload.changes, { updatedAt: db.serverDate() })
    });
  }

  await db.collection('change_requests').doc(request._id).update({
    data: {
      status: approved ? 'approved' : 'rejected',
      reviewedBy: access.openid,
      reviewNote: cleanText(event.note, 200),
      reviewedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  await writeAudit(request.familyId, access.openid, approved ? 'change.approve' : 'change.reject', 'change_request', request._id, approved ? '通过了修改申请' : '拒绝了修改申请');
  return success({ approved: approved, person: createdPerson });
}

function createInviteToken() {
  return crypto.randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function validateInvitation(token) {
  const tokenHash = hashToken(cleanText(token, 200));
  const response = await db.collection('invitations').where({ tokenHash: tokenHash }).limit(1).get();
  assert(response.data.length, 'INVITE_INVALID', '邀请不存在或已经失效');
  const invitation = response.data[0];
  assert(invitation.status === 'active', 'INVITE_REVOKED', '邀请已被撤销');
  assert(new Date(invitation.expiresAt).getTime() > Date.now(), 'INVITE_EXPIRED', '邀请已经过期');
  assert(invitation.useCount < invitation.maxUses, 'INVITE_LIMIT_REACHED', '邀请使用次数已达上限');
  return invitation;
}

async function inviteCreate(event) {
  const access = await requireMembership(event.familyId, ['admin', 'member']);
  const family = await getFamily(event.familyId);
  let role = cleanRole(event.role);
  if (role === 'admin') role = 'member';
  if (access.membership.role !== 'admin') role = 'viewer';
  const viewMode = event.viewMode === 'perspective' ? 'perspective' : 'full';
  let viewPersonId = '';
  let viewPersonName = '';

  if (viewMode === 'perspective') {
    const person = await getDocument('persons', event.viewPersonId, 'PERSON_NOT_FOUND', '分享视角成员不存在');
    assert(person.familyId === event.familyId && person.status !== 'deleted', 'PERSON_NOT_FOUND', '分享视角成员不存在');
    viewPersonId = person._id;
    viewPersonName = person.name;
  }

  const token = createInviteToken();
  const expiresInDays = Math.max(1, Math.min(Number(event.expiresInDays) || 30, 30));
  const maxUses = Math.max(1, Math.min(Number(event.maxUses) || 50, 200));
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  const result = await db.collection('invitations').add({
    data: {
      tokenHash: hashToken(token),
      familyId: event.familyId,
      role: role,
      viewMode: viewMode,
      viewPersonId: viewPersonId,
      viewPersonName: viewPersonName,
      status: 'active',
      useCount: 0,
      maxUses: maxUses,
      expiresAt: expiresAt,
      createdBy: access.openid,
      createdByName: access.membership.displayName || '家人',
      createdAt: db.serverDate()
    }
  });
  await writeAudit(event.familyId, access.openid, 'invite.create', 'invitation', result._id, '生成了家庭邀请');
  return success({
    token: token,
    familyName: family.name,
    role: role,
    viewMode: viewMode,
    viewPersonName: viewPersonName,
    expiresAt: expiresAt
  });
}

async function invitePreview(event) {
  const invitation = await validateInvitation(event.token);
  const family = await getFamily(invitation.familyId);
  const persons = await getAll('persons', { familyId: family._id, status: 'active' });
  return success({
    family: { _id: family._id, name: family.name, description: family.description || '' },
    personCount: persons.length,
    inviterName: invitation.createdByName || '家人',
    role: invitation.role,
    viewMode: invitation.viewMode,
    viewPersonId: invitation.viewPersonId || '',
    viewPersonName: invitation.viewPersonName || ''
  });
}

async function inviteAccept(event) {
  const openid = getOpenid();
  const user = await ensureUser(openid);
  const invitation = await validateInvitation(event.token);
  const family = await getFamily(invitation.familyId);
  const existing = await db.collection('family_memberships').where({
    familyId: family._id,
    userOpenid: openid
  }).limit(1).get();
  let role = invitation.role;

  if (existing.data.length) {
    const current = existing.data[0];
    if (current.role === 'admin' || current.role === 'member') role = current.role;
    await db.collection('family_memberships').doc(current._id).update({
      data: {
        role: role,
        status: 'active',
        displayName: user.nickName || current.displayName || '家人',
        avatarUrl: user.avatarUrl || current.avatarUrl || '',
        updatedAt: db.serverDate()
      }
    });
  } else {
    await db.collection('family_memberships').add({
      data: {
        familyId: family._id,
        userOpenid: openid,
        role: role,
        displayName: user.nickName || '家人',
        avatarUrl: user.avatarUrl || '',
        status: 'active',
        joinedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  }

  await db.collection('invitations').doc(invitation._id).update({
    data: { useCount: _.inc(1), lastUsedAt: db.serverDate() }
  });
  await writeAudit(family._id, openid, 'membership.join', 'family', family._id, '通过邀请加入了家谱');
  return success({
    family: Object.assign({}, family, { currentRole: role }),
    role: role,
    viewMode: invitation.viewMode,
    viewPersonId: invitation.viewPersonId || ''
  });
}

const handlers = {
  'auth.login': authLogin,
  'auth.updateProfile': authUpdateProfile,
  'family.create': familyCreate,
  'family.list': familyList,
  'family.update': familyUpdate,
  'family.dashboard': familyDashboard,
  'family.setPreference': familySetPreference,
  'graph.get': graphGet,
  'person.get': personGet,
  'person.createRelated': personCreateRelated,
  'person.update': personUpdate,
  'person.delete': personDelete,
  'change.list': changeList,
  'change.review': changeReview,
  'invite.create': inviteCreate,
  'invite.preview': invitePreview,
  'invite.accept': inviteAccept
};

exports.main = async (event) => {
  try {
    await ensureCollections();
    const handler = handlers[event.type];
    assert(handler, 'UNKNOWN_ACTION', '暂不支持这个操作');
    return await handler(event || {});
  } catch (error) {
    console.error('familyFunctions error', event && event.type, error);
    return {
      success: false,
      code: error.code || 'SERVER_ERROR',
      message: error.code ? error.message : '服务暂时不可用，请稍后重试',
      details: error.details || null
    };
  }
};
