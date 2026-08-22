const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const participation = require('./participation');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const FEEDBACK_GROUP_SETTINGS_ID = 'active';
const FEEDBACK_QR_MAX_BYTES = 1024 * 1024;
class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function assert(condition, code, message) {
  if (!condition) throw new OpsError(code, message);
}

function cleanText(value, length) {
  return String(value || '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, length || 200);
}

function cleanExampleSlug(value) {
  return cleanText(value, 80).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function cleanExampleDate(value) {
  const text = cleanText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text + 'T00:00:00Z')) ? text : '';
}

function generatedExampleId(kind, used) {
  let id = '';
  do {
    id = 'example_' + kind + '_' + crypto.randomBytes(12).toString('hex');
  } while (used.has(id));
  used.add(id);
  return id;
}

function normalizeExampleContent(input, existingContent) {
  const source = input || {};
  const family = source.family || {};
  const previous = existingContent || {};
  const previousPersons = Array.isArray(previous.persons) ? previous.persons : [];
  const previousRelations = Array.isArray(previous.relations) ? previous.relations : [];
  const existingPeopleById = {};
  const existingPeopleByName = {};
  const existingNameCounts = {};
  previousPersons.forEach(function (person) {
    const id = cleanText(person && person._id, 80);
    const name = cleanText(person && person.name, 30);
    if (id) existingPeopleById[id] = person;
    if (name) existingNameCounts[name] = (existingNameCounts[name] || 0) + 1;
  });
  previousPersons.forEach(function (person) {
    const name = cleanText(person && person.name, 30);
    if (name && existingNameCounts[name] === 1) existingPeopleByName[name] = person;
  });
  const usedPersonIds = new Set(Object.keys(existingPeopleById));
  const submittedNameById = {};
  const peopleByName = {};
  const seenNames = new Set();
  const claimedExistingPersonIds = new Set();
  const persons = (Array.isArray(source.persons) ? source.persons : []).slice(0, 50).map(function (item) {
    const person = item || {};
    const name = cleanText(person.name, 30);
    const submittedId = cleanText(person._id, 80);
    assert(name, 'EXAMPLE_PERSON_NAME_REQUIRED', '每位示例人物都需要姓名');
    assert(!seenNames.has(name), 'EXAMPLE_PERSON_NAME_DUPLICATE', '示例人物姓名不能重复，请修改后再保存');
    seenNames.add(name);
    if (submittedId) submittedNameById[submittedId] = name;
    const existing = existingPeopleById[submittedId] || existingPeopleByName[name];
    assert(!existing || !claimedExistingPersonIds.has(existing._id), 'EXAMPLE_PERSON_DUPLICATE', '示例人物标识不能重复');
    if (existing) claimedExistingPersonIds.add(existing._id);
    const id = existing && existing._id ? existing._id : generatedExampleId('person', usedPersonIds);
    const normalized = {
      _id: id,
      name: name,
      gender: ['male', 'female', 'unknown'].includes(person.gender) ? person.gender : 'unknown',
      lifeStatus: ['living', 'deceased', 'unknown'].includes(person.lifeStatus) ? person.lifeStatus : 'unknown',
      birthDate: cleanExampleDate(person.birthDate),
      deathDate: cleanExampleDate(person.deathDate),
      birthPlace: cleanText(person.birthPlace, 80),
      bio: cleanText(person.bio, 500),
      avatarAssetId: '',
      photoAssetIds: []
    };
    peopleByName[name] = normalized;
    return normalized;
  });
  assert(persons.length >= 3, 'EXAMPLE_MIN_PERSONS', '示例家谱至少需要 3 位人物');
  const previousNameById = {};
  previousPersons.forEach(function (person) { previousNameById[person._id] = cleanText(person.name, 30); });
  const existingRelationsById = {};
  const existingRelationsByKey = {};
  previousRelations.forEach(function (relation) {
    const fromName = previousNameById[relation.fromPersonId];
    const toName = previousNameById[relation.toPersonId];
    if (!fromName || !toName) return;
    const pair = relation.type === 'spouse' && fromName > toName ? [toName, fromName] : [fromName, toName];
    const key = relation.type + ':' + pair.join(':');
    existingRelationsById[relation._id] = relation;
    existingRelationsByKey[key] = relation;
  });
  const usedRelationIds = new Set(Object.keys(existingRelationsById));
  const seenRelations = new Set();
  const claimedExistingRelationIds = new Set();
  const relations = (Array.isArray(source.relations) ? source.relations : []).slice(0, 100).map(function (item) {
    const relation = item || {};
    const type = relation.type === 'spouse' ? 'spouse' : relation.type === 'parent_child' ? 'parent_child' : '';
    const fromName = cleanText(relation.fromPersonName || submittedNameById[cleanText(relation.fromPersonId, 80)], 30);
    const toName = cleanText(relation.toPersonName || submittedNameById[cleanText(relation.toPersonId, 80)], 30);
    assert(type && fromName && toName && fromName !== toName, 'EXAMPLE_INVALID_RELATION', '示例关系信息不完整');
    assert(peopleByName[fromName] && peopleByName[toName], 'EXAMPLE_RELATION_PERSON_NOT_FOUND', '示例关系中的人物姓名必须与人物表完全一致');
    const namePair = type === 'spouse' && fromName > toName ? [toName, fromName] : [fromName, toName];
    const key = type + ':' + namePair.join(':');
    assert(!seenRelations.has(key), 'EXAMPLE_RELATION_DUPLICATE', '示例关系不能重复');
    seenRelations.add(key);
    const fromPersonId = peopleByName[namePair[0]]._id;
    const toPersonId = peopleByName[namePair[1]]._id;
    const submittedId = cleanText(relation._id, 80);
    const submittedExisting = existingRelationsById[submittedId];
    const sameEndpoints = submittedExisting && submittedExisting.type === type && (
      type === 'spouse'
        ? [submittedExisting.fromPersonId, submittedExisting.toPersonId].sort().join(':') === [fromPersonId, toPersonId].sort().join(':')
        : submittedExisting.fromPersonId === fromPersonId && submittedExisting.toPersonId === toPersonId
    );
    const existing = sameEndpoints ? submittedExisting : existingRelationsByKey[key];
    assert(!existing || !claimedExistingRelationIds.has(existing._id), 'EXAMPLE_RELATION_DUPLICATE', '示例关系不能重复');
    if (existing) claimedExistingRelationIds.add(existing._id);
    const id = existing && existing._id ? existing._id : generatedExampleId('relation', usedRelationIds);
    return { _id: id, type: type, fromPersonId: fromPersonId, toPersonId: toPersonId };
  });
  assert(relations.length >= 2, 'EXAMPLE_MIN_RELATIONS', '示例家谱至少需要 2 条关系');
  const childrenByParent = {};
  relations.filter(function (relation) { return relation.type === 'parent_child'; }).forEach(function (relation) {
    if (!childrenByParent[relation.fromPersonId]) childrenByParent[relation.fromPersonId] = [];
    childrenByParent[relation.fromPersonId].push(relation.toPersonId);
  });
  function reaches(start, target, visited) {
    if (start === target) return true;
    if (visited[start]) return false;
    visited[start] = true;
    return (childrenByParent[start] || []).some(function (child) { return reaches(child, target, visited); });
  }
  relations.filter(function (relation) { return relation.type === 'parent_child'; }).forEach(function (relation) {
    const children = childrenByParent[relation.fromPersonId] || [];
    childrenByParent[relation.fromPersonId] = children.filter(function (child) { return child !== relation.toPersonId; });
    assert(!reaches(relation.toPersonId, relation.fromPersonId, {}), 'EXAMPLE_RELATION_CYCLE', '示例父母子女关系不能形成循环');
    childrenByParent[relation.fromPersonId].push(relation.toPersonId);
  });
  return {
    family: {
      name: cleanText(family.name, 40),
      description: cleanText(family.description, 200)
    },
    persons: persons,
    relations: relations
  };
}

function hash(value, length) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length || 24);
}

function operatorIdentity(context) {
  const wxContext = cloud.getWXContext() || {};
  const info = context && context.userInfo ? context.userInfo : {};
  const auth = context && context.auth ? context.auth : {};
  return cleanText(
    wxContext.UID || wxContext.TCB_UUID || wxContext.UUID ||
    info.uid || info.sub || info.userId || info._id || info.openId || info.openid ||
    auth.uid || auth.sub || auth.userId ||
    (context && (context.uid || context.sub || context.userId)) ||
    wxContext.OPENID || wxContext.UNIONID,
    128
  );
}

async function verifiedOperatorIdentity(context) {
  const platformIdentity = operatorIdentity(context);
  if (platformIdentity) return platformIdentity;

  const accessToken = cleanText(context && context.youpuAccessToken, 8192);
  assert(accessToken, 'UNAUTHENTICATED', '请先登录运营后台');

  const envId = cleanText(
    process.env.TCB_ENV || process.env.SCF_NAMESPACE || (context && context.namespace),
    64
  );
  assert(/^[A-Za-z0-9-]{3,64}$/.test(envId), 'AUTH_SERVICE_UNAVAILABLE', '暂时无法校验登录状态，请稍后重试');

  let response;
  try {
    response = await fetch(`https://${envId}.api.tcloudbasegateway.com/auth/v1/user/me`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      signal: AbortSignal.timeout(5000)
    });
  } catch (error) {
    throw new OpsError('AUTH_SERVICE_UNAVAILABLE', '暂时无法校验登录状态，请稍后重试');
  }

  if (response.status === 401 || response.status === 403) {
    throw new OpsError('UNAUTHENTICATED', '登录状态已失效，请重新登录');
  }
  if (!response.ok) {
    console.error(JSON.stringify({ type: 'ops_auth_verify_failed', status: response.status }));
    throw new OpsError('AUTH_SERVICE_UNAVAILABLE', '暂时无法校验登录状态，请稍后重试');
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new OpsError('AUTH_SERVICE_UNAVAILABLE', '暂时无法校验登录状态，请稍后重试');
  }
  const profile = body && typeof body.data === 'object' ? body.data : body;
  const identity = cleanText(profile && (profile.sub || profile.user_id || profile.uid), 128);
  const status = cleanText(profile && profile.status, 32).toUpperCase();
  assert(identity, 'UNAUTHENTICATED', '登录状态已失效，请重新登录');
  assert(!status || status === 'ACTIVE', 'UNAUTHENTICATED', '运营账号已被停用');
  return identity;
}

function sortedKeys(value) {
  return value && typeof value === 'object'
    ? Object.keys(value).sort().slice(0, 30)
    : [];
}

async function maybeGet(collectionName, id, scope) {
  try {
    const result = await (scope || db).collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (error) {
    return null;
  }
}

async function requireOperator(context, roles) {
  const identity = await verifiedOperatorIdentity(context);
  assert(identity, 'UNAUTHENTICATED', '请先登录运营后台');
  const result = await db.collection('operators').where({ authUid: identity, status: 'active' }).limit(1).get();
  assert(result.data && result.data.length, 'NOT_OPERATOR', '当前账号不在运营白名单中');
  const operator = result.data[0];
  if (roles && roles.length) assert(roles.includes(operator.role), 'NO_PERMISSION', '当前运营角色没有此权限');
  return operator;
}

async function writeOpsAudit(scope, operator, action, objectType, objectId, reason, summary, requestId, familyId) {
  await (scope || db).collection('audit_logs').add({
    data: {
      familyId: cleanText(familyId || (objectType === 'family' ? objectId : ''), 80),
      actorId: 'operator_' + operator._id,
      actorAccount: cleanText(operator.email || operator.displayName || operator._id, 120),
      actorType: 'operator',
      action: action,
      objectType: objectType || '',
      objectId: objectId || '',
      reason: cleanText(reason, 200),
      summary: cleanText(summary, 120),
      operatorAudit: true,
      requestId: cleanText(requestId, 80),
      createdAt: db.serverDate()
    }
  });
}

async function opsMutate(operator, action, event, handler) {
  const requestId = cleanText(event.requestId, 80);
  assert(requestId, 'REQUEST_ID_REQUIRED', '请求缺少幂等标识');
  const recordId = 'ops_idem_' + hash([operator._id, action, requestId].join(':'), 40);
  return db.runTransaction(async function (transaction) {
    const existing = await maybeGet('idempotency_records', recordId, transaction);
    if (existing && existing.status === 'completed') return existing.result || {};
    assert(!existing, 'REQUEST_IN_PROGRESS', '操作正在处理中，请勿重复提交');
    await transaction.collection('idempotency_records').doc(recordId).set({
      data: {
        actorId: 'operator_' + operator._id,
        action: action,
        requestId: requestId,
        status: 'processing',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    const result = await handler(transaction);
    await transaction.collection('idempotency_records').doc(recordId).update({
      data: {
        status: 'completed',
        result: result || {},
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        updatedAt: db.serverDate()
      }
    });
    return result || {};
  });
}

async function page(collectionName, where, event) {
  const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  const cursor = cleanText(event.cursor, 80);
  const condition = Object.assign({}, where || {});
  if (cursor) condition._id = _.gt(cursor);
  const result = await db.collection(collectionName)
    .where(condition)
    .orderBy('_id', 'asc')
    .limit(pageSize + 1)
    .get();
  let items = result.data || [];
  const hasMore = items.length > pageSize;
  items = items.slice(0, pageSize);
  return {
    items: items,
    nextCursor: hasMore && items.length ? items[items.length - 1]._id : '',
    hasMore: hasMore
  };
}

function isMissingCollectionError(error) {
  const code = cleanText(error && (error.errCode || error.code), 120).toLowerCase();
  const message = cleanText(error && (error.errMsg || error.message), 500).toLowerCase();
  return code.includes('collectionnotexist') || code.includes('collection_not_exist') ||
    message.includes('collection not exist') || message.includes('collection does not exist') ||
    message.includes('集合不存在');
}

function isMissingDocumentError(error) {
  const code = cleanText(error && (error.errCode || error.code), 120).toLowerCase();
  const message = cleanText(error && (error.errMsg || error.message), 500).toLowerCase();
  return code.includes('documentnotexist') || code.includes('document_not_exist') ||
    /document\s*(?:is\s*)?not\s*exist/.test(message) ||
    /document\s*does\s*not\s*exist/.test(message) ||
    /document\s*not\s*found/.test(message) ||
    message.includes('文档不存在');
}

function errorDigest(error) {
  return {
    code: cleanText(error && (error.errCode || error.code), 120),
    message: cleanText(error && (error.errMsg || error.message), 300),
    name: cleanText(error && error.name, 80)
  };
}

function exampleStorageError(resource, error) {
  const digest = errorDigest(error);
  console.error(JSON.stringify({ type: 'example_storage_error', resource: resource, error: digest }));
  if (isMissingCollectionError(error)) {
    return new OpsError(resource === 'versions' ? 'EXAMPLE_VERSION_STORE_UNAVAILABLE' : 'EXAMPLE_TEMPLATE_STORE_UNAVAILABLE',
      resource === 'versions' ? '示例发布版本暂不可读取，请稍后重试' : '示例草稿库暂不可读取，请稍后重试');
  }
  return new OpsError(resource === 'versions' ? 'EXAMPLE_VERSION_READ_FAILED' : 'EXAMPLE_TEMPLATE_READ_FAILED',
    resource === 'versions' ? '读取示例发布版本失败，请重试' : '读取示例草稿失败，请重试');
}

async function findExampleDocument(collectionName, id, scope, options) {
  try {
    const result = await (scope || db).collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (error) {
    if (isMissingDocumentError(error) || (options && options.allowMissingCollection && isMissingCollectionError(error))) return null;
    throw exampleStorageError(collectionName === 'example_template_versions' ? 'versions' : 'templates', error);
  }
}

async function getExampleTemplate(templateId, scope) {
  const id = cleanText(templateId, 80);
  assert(id, 'EXAMPLE_NOT_FOUND', '示例家谱不存在');
  const template = await findExampleDocument('example_templates', id, scope);
  assert(template, 'EXAMPLE_NOT_FOUND', '示例家谱不存在');
  assert(typeof template === 'object' && !Array.isArray(template) && cleanText(template._id, 80), 'EXAMPLE_TEMPLATE_CORRUPT', '示例草稿数据不完整，请联系管理员处理');
  assert(['draft', 'published', 'archived'].includes(template.status || 'draft'), 'EXAMPLE_TEMPLATE_CORRUPT', '示例草稿状态无效，请联系管理员处理');
  return template;
}

async function readExampleVersions(template) {
  const publishedVersion = Number(template.publishedVersion) || 0;
  if (publishedVersion <= 0 || template.status === 'draft') return [];
  try {
    const versions = await listAll('example_template_versions', { templateId: template._id }, 100);
    assert(versions.every(function (version) {
      return version && version.templateId === template._id && Number(version.version) > 0;
    }), 'EXAMPLE_VERSION_CORRUPT', '示例发布版本数据不完整，请联系管理员处理');
    return versions;
  } catch (error) {
    if (error && error.code) throw error;
    throw exampleStorageError('versions', error);
  }
}

async function writeExampleViewAudit(operator, templateId, requestId) {
  try {
    await writeOpsAudit(db, operator, 'ops.example.view', 'example_template', templateId, '运营后台查看', '查看示例家谱', requestId);
  } catch (error) {
    console.warn(JSON.stringify({ type: 'example_view_audit_failed', templateId: templateId, requestId: cleanText(requestId, 80), error: errorDigest(error) }));
  }
}

async function writeRequiredExampleAudit(scope, operator, action, templateId, reason, summary, requestId) {
  try {
    await writeOpsAudit(scope, operator, action, 'example_template', templateId, reason, summary, requestId);
  } catch (error) {
    console.error(JSON.stringify({ type: 'example_mutation_audit_failed', templateId: templateId, requestId: cleanText(requestId, 80), action: action, error: errorDigest(error) }));
    throw new OpsError('EXAMPLE_AUDIT_WRITE_FAILED', '示例操作审计写入失败，操作未完成，请重试');
  }
}

async function checkExampleCollection(collectionName, optional) {
  try {
    await db.collection(collectionName).limit(1).get();
    return { state: 'ready' };
  } catch (error) {
    if (optional && isMissingCollectionError(error)) return { state: 'not_initialized' };
    throw exampleStorageError(collectionName === 'example_template_versions' ? 'versions' : 'templates', error);
  }
}

const EXAMPLE_COLLECTIONS = ['example_templates', 'example_template_versions'];
let exampleCollectionsReadyPromise = null;

function isCollectionAlreadyExistsError(error) {
  const code = cleanText(error && (error.errCode || error.code), 120).toLowerCase();
  const message = cleanText(error && (error.errMsg || error.message), 500).toLowerCase();
  return code.includes('alreadyexist') || code.includes('collectionexist') || code.includes('resourceexist') ||
    message.includes('already exist') || message.includes('collection exists') ||
    message.includes('table exist') || message.includes('resourceexist') || message.includes('集合已存在');
}

// A newly enabled environment has no collection until its first use. Collection
// creation cannot run inside a transaction, so make storage ready before any
// example write enters opsMutate. This keeps the first publish from failing
// after the draft itself was created successfully.
async function ensureExampleCollections() {
  if (exampleCollectionsReadyPromise) return exampleCollectionsReadyPromise;
  exampleCollectionsReadyPromise = (async function () {
    const created = [];
    for (const collectionName of EXAMPLE_COLLECTIONS) {
      try {
        // Existing collections are the normal path. Checking first avoids
        // treating CloudBase's ResourceExist response as a storage failure on
        // every save or publish request.
        await db.collection(collectionName).limit(1).get();
        continue;
      } catch (error) {
        if (!isMissingCollectionError(error)) {
          throw exampleStorageError(collectionName === 'example_template_versions' ? 'versions' : 'templates', error);
        }
      }
      try {
        await db.createCollection(collectionName);
        created.push(collectionName);
      } catch (error) {
        // A concurrent first request may have created the collection after our
        // read but before createCollection. That is a successful outcome.
        if (!isCollectionAlreadyExistsError(error)) {
          throw exampleStorageError(collectionName === 'example_template_versions' ? 'versions' : 'templates', error);
        }
      }
    }
    if (created.length) {
      console.log(JSON.stringify({ type: 'example_collections_initialized', collections: created }));
    }
    return { created: created };
  })();
  try {
    return await exampleCollectionsReadyPromise;
  } catch (error) {
    exampleCollectionsReadyPromise = null;
    throw error;
  }
}

async function listAll(collectionName, where, hardLimit) {
  const limit = hardLimit || 500;
  let rows = [];
  while (rows.length <= limit) {
    const pageResult = await db.collection(collectionName)
      .where(where || {})
      .skip(rows.length)
      .limit(100)
      .get();
    const pageRows = pageResult.data || [];
    rows = rows.concat(pageRows);
    assert(rows.length <= limit, 'RESULT_LIMIT_EXCEEDED', '记录数量超过运营端单次查看上限，请使用筛选条件');
    if (pageRows.length < 100) return rows;
  }
  throw new OpsError('RESULT_LIMIT_EXCEEDED', '记录数量超过运营端单次查看上限，请使用筛选条件');
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function listByIds(collectionName, field, ids, where, hardLimit) {
  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (!uniqueIds.length) return [];
  const rows = [];
  for (const batch of chunks(uniqueIds, 50)) {
    const condition = Object.assign({}, where || {});
    condition[field] = _.in(batch);
    const batchRows = await listAll(collectionName, condition, hardLimit || 2500);
    rows.push.apply(rows, batchRows);
  }
  return rows;
}

async function userParticipation(userIds) {
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  const result = {};
  ids.forEach(function (userId) { result[userId] = participation.summarize(0, 0); });
  if (!ids.length) return result;

  const queries = await Promise.all([
    listByIds('families', 'creatorId', ids, { status: 'active' }),
    listByIds('family_memberships', 'userId', ids, { status: 'active' })
  ]);
  const createdFamilies = queries[0];
  const memberships = queries[1];
  createdFamilies.forEach(function (family) {
    if (result[family.creatorId]) result[family.creatorId].createdFamilyCount += 1;
  });

  const activeFamilies = await listByIds('families', '_id', memberships.map(function (item) { return item.familyId; }), { status: 'active' });
  const familyById = activeFamilies.reduce(function (map, family) {
    map[family._id] = family;
    return map;
  }, {});
  memberships.forEach(function (membership) {
    const family = familyById[membership.familyId];
    if (family && family.creatorId !== membership.userId && result[membership.userId]) {
      result[membership.userId].joinedFamilyCount += 1;
    }
  });
  ids.forEach(function (userId) {
    const item = result[userId];
    result[userId] = participation.summarize(item.createdFamilyCount, item.joinedFamilyCount);
  });
  return result;
}

async function currentParticipatingUserCount() {
  const queries = await Promise.all([
    listAll('families', { status: 'active' }, 5000),
    listAll('family_memberships', { status: 'active' }, 5000)
  ]);
  const families = queries[0];
  const memberships = queries[1];
  const activeFamilyIds = new Set(families.map(function (family) { return family._id; }));
  const userIds = new Set(families.map(function (family) { return family.creatorId; }).filter(Boolean));
  memberships.forEach(function (membership) {
    if (activeFamilyIds.has(membership.familyId)) userIds.add(membership.userId);
  });
  const activeUsers = await listByIds('users', '_id', Array.from(userIds), { status: 'active' });
  return activeUsers.length;
}

function maskIdentity(value) {
  const text = cleanText(value, 200);
  if (!text) return '';
  return text.length <= 8 ? hash(text, 8) : text.slice(0, 4) + '…' + text.slice(-4);
}

function publicUser(user, statistics) {
  const stats = statistics || participation.summarize(0, 0);
  return {
    _id: user._id,
    identity: maskIdentity(user.openid || user._id),
    nickName: user.nickName ? user.nickName.slice(0, 1) + '**' : '未设置',
    status: user.status,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    createdFamilyCount: stats.createdFamilyCount,
    joinedFamilyCount: stats.joinedFamilyCount,
    activeFamilyCount: stats.activeFamilyCount,
    participationType: stats.participationType
  };
}

function publicFamily(family, statistics) {
  const stats = statistics || {};
  return {
    _id: family._id,
    name: family.name ? family.name.slice(0, 1) + '**' : '未命名',
    status: family.status,
    userCount: Number(stats.userCount) || 0,
    memberCount: Number(stats.memberCount) || 0,
    personCount: family.personCount || 0,
    relationCount: family.relationCount || 0,
    createdAt: family.createdAt || null,
    updatedAt: family.updatedAt || null
  };
}

function maskedName(value, fallback) {
  const text = cleanText(value, 80);
  if (!text) return fallback || '未命名人物';
  return text.slice(0, 1) + (text.length > 1 ? '**' : '*');
}

function publicOpsPerson(person, options) {
  const config = options || {};
  return {
    _id: person._id,
    name: maskedName(person.name),
    gender: person.gender || 'unknown',
    lifeStatus: person.lifeStatus || 'unknown',
    birthDate: person.birthDate || '',
    deathDate: person.deathDate || '',
    birthPlace: person.birthPlace ? person.birthPlace.slice(0, 2) + '…' : '',
    hasBio: Boolean(person.bio),
    hasAvatar: Boolean(person.avatarAssetId),
    avatarStatus: config.avatarStatus || (person.avatarAssetId ? 'pending' : 'none'),
    relationCount: Number(config.relationCount) || 0,
    isStartPerson: Boolean(config.startPersonId && config.startPersonId === person._id),
    createdAt: person.createdAt || null,
    updatedAt: person.updatedAt || null
  };
}

async function familyRelationContext(familyId, hardLimit) {
  const relations = await listAll('relations', { familyId: familyId, status: 'active' }, hardLimit || 2500);
  const countByPerson = {};
  relations.forEach(function (relation) {
    countByPerson[relation.fromPersonId] = (countByPerson[relation.fromPersonId] || 0) + 1;
    countByPerson[relation.toPersonId] = (countByPerson[relation.toPersonId] || 0) + 1;
  });
  return { relations: relations, countByPerson: countByPerson };
}

async function personAvatarStatuses(persons) {
  const assetIds = Array.from(new Set((persons || []).map(function (person) { return person.avatarAssetId; }).filter(Boolean)));
  if (!assetIds.length) return {};
  const result = await db.collection('media_assets').where({ _id: _.in(assetIds) }).limit(assetIds.length).get();
  return (result.data || []).reduce(function (map, asset) {
    map[asset._id] = asset.moderationStatus || asset.status || 'pending';
    return map;
  }, {});
}

async function sessionMe(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  return {
    operator: {
      _id: operator._id,
      displayName: operator.displayName,
      email: operator.email || '',
      role: operator.role
    }
  };
}

function feedbackQrUpload(event) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(event.imageData || ''));
  assert(match, 'INVALID_FEEDBACK_QR', '请上传 PNG、JPEG 或 WebP 格式的二维码图片');
  const encoded = match[2];
  const content = Buffer.from(encoded, 'base64');
  assert(content.length > 0 && content.length <= FEEDBACK_QR_MAX_BYTES, 'FEEDBACK_QR_TOO_LARGE', '二维码图片不能超过 1MB');
  assert(content.toString('base64').replace(/=+$/, '') === encoded.replace(/=+$/, ''), 'INVALID_FEEDBACK_QR', '二维码图片数据无效');
  const isPng = content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  const isWebp = content.length >= 12 && content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP';
  const kind = match[1];
  assert((kind === 'png' && isPng) || (kind === 'jpeg' && isJpeg) || (kind === 'webp' && isWebp), 'INVALID_FEEDBACK_QR', '二维码图片格式与文件内容不匹配');
  return { content: content, extension: kind === 'jpeg' ? 'jpg' : kind, contentType: 'image/' + kind };
}

async function feedbackGroupPayload(setting) {
  if (!setting || !setting.fileId) return { available: false, qrCodeUrl: '', updatedAt: null };
  try {
    const result = await cloud.getTempFileURL({ fileList: [setting.fileId] });
    const item = (result.fileList || [])[0] || {};
    return { available: Boolean(item.tempFileURL), qrCodeUrl: item.tempFileURL || '', updatedAt: setting.updatedAt || null };
  } catch (error) {
    return { available: false, qrCodeUrl: '', updatedAt: setting.updatedAt || null };
  }
}

async function feedbackGroupGet(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  return feedbackGroupPayload(await maybeGet('feedback_group_settings', FEEDBACK_GROUP_SETTINGS_ID));
}

async function feedbackGroupUpdate(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const requestId = cleanText(event.requestId, 80);
  assert(requestId, 'REQUEST_ID_REQUIRED', '请求缺少幂等标识');
  const image = feedbackQrUpload(event);
  const cloudPath = ['ops', 'feedback-groups', hash([operator._id, requestId].join(':'), 48) + '.' + image.extension].join('/');
  let upload;
  try {
    upload = await cloud.uploadFile({ cloudPath: cloudPath, fileContent: image.content });
  } catch (error) {
    throw new OpsError('FEEDBACK_QR_UPLOAD_FAILED', '二维码上传失败，请稍后重试');
  }
  const fileId = cleanText(upload && upload.fileID, 500);
  assert(fileId, 'FEEDBACK_QR_UPLOAD_FAILED', '二维码上传失败，请稍后重试');
  let mutation;
  try {
    mutation = await opsMutate(operator, 'feedbackGroup.update', event, async function (transaction) {
      const previous = await maybeGet('feedback_group_settings', FEEDBACK_GROUP_SETTINGS_ID, transaction);
      await transaction.collection('feedback_group_settings').doc(FEEDBACK_GROUP_SETTINGS_ID).set({
        data: {
          fileId: fileId,
          cloudPath: cloudPath,
          contentType: image.contentType,
          size: image.content.length,
          version: Math.max(0, Number(previous && previous.version) || 0) + 1,
          updatedBy: operator._id,
          updatedAt: db.serverDate()
        }
      });
      await writeOpsAudit(transaction, operator, 'ops.feedback_group.update', 'feedback_group_settings', FEEDBACK_GROUP_SETTINGS_ID, '运营后台替换反馈群二维码', '替换用户反馈群二维码', event.requestId);
      return { replacedFileId: cleanText(previous && previous.fileId, 500) };
    });
  } catch (error) {
    await cloud.deleteFile({ fileList: [fileId] }).catch(function () {});
    throw error;
  }
  const replacedFileId = cleanText(mutation && mutation.replacedFileId, 500);
  if (replacedFileId && replacedFileId !== fileId) {
    cloud.deleteFile({ fileList: [replacedFileId] }).catch(function (error) {
      console.warn(JSON.stringify({ type: 'feedback_qr_previous_delete_failed', error: errorDigest(error) }));
    });
  }
  return feedbackGroupPayload(await maybeGet('feedback_group_settings', FEEDBACK_GROUP_SETTINGS_ID));
}

async function dashboardSummary(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const [users, families, reports, moderation, deletions, participatingUsers] = await Promise.all([
    db.collection('users').where({ status: 'active' }).count(),
    db.collection('families').where({ status: 'active' }).count(),
    db.collection('reports').where({ status: _.in(['open', 'processing']) }).count(),
    db.collection('media_assets').where({ moderationStatus: _.in(['review', 'pending']) }).count(),
    db.collection('account_deletion_requests').where({ status: _.in(['pending', 'failed']) }).count(),
    currentParticipatingUserCount()
  ]);
  const activeUsers = users.total || 0;
  const currentParticipatingUsers = participatingUsers || 0;
  return {
    totals: {
      activeUsers: activeUsers,
      currentParticipatingUsers: currentParticipatingUsers,
      visitorUsers: Math.max(0, activeUsers - currentParticipatingUsers),
      activeFamilies: families.total || 0,
      reportBacklog: reports.total || 0,
      moderationBacklog: moderation.total || 0,
      deletionBacklog: deletions.total || 0
    },
    generatedAt: new Date().toISOString()
  };
}

function participationFilter(value) {
  const filter = cleanText(value, 30);
  return ['visitor', 'creator', 'member', 'creator_member', 'participating'].includes(filter) ? filter : '';
}

async function usersPageWithParticipation(where, event, filter) {
  const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  let cursor = cleanText(event.cursor, 80);
  let hasMore = true;
  const users = [];
  while (users.length < pageSize && hasMore) {
    const remaining = pageSize - users.length;
    const sourcePage = await page('users', where, { pageSize: remaining, cursor: cursor });
    if (!sourcePage.items.length) {
      hasMore = false;
      break;
    }
    const statistics = await userParticipation(sourcePage.items.map(function (user) { return user._id; }));
    sourcePage.items.forEach(function (user) {
      const stats = statistics[user._id];
      if (!filter || (filter === 'participating' ? stats.participationType !== 'visitor' : stats.participationType === filter)) {
        users.push(publicUser(user, stats));
      }
    });
    cursor = sourcePage.items[sourcePage.items.length - 1]._id;
    hasMore = sourcePage.hasMore;
  }
  return {
    items: users,
    nextCursor: hasMore ? cursor : '',
    hasMore: hasMore
  };
}

async function usersList(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const where = event.status ? { status: cleanText(event.status, 30) } : {};
  const filter = participationFilter(event.participationType);
  return usersPageWithParticipation(where, event, filter);
}

async function usersDetail(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const user = await maybeGet('users', event.userId);
  assert(user, 'USER_NOT_FOUND', '用户不存在');
  const memberships = await listAll('family_memberships', { userId: user._id }, 500);
  const familyRows = await listByIds('families', '_id', memberships.map(function (item) { return item.familyId; }), {});
  const familyById = familyRows.reduce(function (map, family) {
    map[family._id] = family;
    return map;
  }, {});
  const statistics = await userParticipation([user._id]);
  const stats = statistics[user._id];
  await writeOpsAudit(db, operator, 'ops.user.view', 'user', user._id, '运营后台直接查看', '查看用户资料', event.requestId);
  return {
    user: {
      _id: user._id,
      identity: maskIdentity(user.openid || user._id),
      nickName: user.nickName || '未设置',
      status: user.status,
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || null,
      createdFamilyCount: stats.createdFamilyCount,
      joinedFamilyCount: stats.joinedFamilyCount,
      activeFamilyCount: stats.activeFamilyCount,
      participationType: stats.participationType
    },
    memberships: memberships.map(function (item) {
      const family = familyById[item.familyId];
      return {
        familyId: item.familyId,
        role: item.role,
        status: item.status,
        familyStatus: family ? family.status : 'deleted',
        participationSource: family && family.creatorId === user._id ? 'created' : 'joined',
        joinedAt: item.joinedAt || null
      };
    })
  };
}

async function usersFreeze(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  const reason = event.freeze !== false ? '运营后台冻结' : '运营后台解除冻结';
  return opsMutate(operator, 'users.freeze', event, async function (transaction) {
    const user = await maybeGet('users', event.userId, transaction);
    assert(user, 'USER_NOT_FOUND', '用户不存在');
    const freezing = event.freeze !== false;
    assert(freezing ? user.status === 'active' : user.status === 'frozen', 'INVALID_STATUS_TRANSITION', '当前账户状态不能执行此操作');
    const status = freezing ? 'frozen' : (user.statusBeforeFreeze || 'active');
    await transaction.collection('users').doc(user._id).update({
      data: {
        status: status,
        statusBeforeFreeze: freezing ? user.status : _.remove(),
        frozenReason: freezing ? reason : _.remove(),
        frozenAt: freezing ? db.serverDate() : _.remove(),
        updatedAt: db.serverDate()
      }
    });
    await writeOpsAudit(transaction, operator, freezing ? 'ops.user.freeze' : 'ops.user.unfreeze', 'user', user._id, reason, freezing ? '冻结用户' : '解除用户冻结', event.requestId);
    return { userId: user._id, status: status };
  });
}

async function familiesList(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const where = event.status ? { status: cleanText(event.status, 30) } : {};
  const result = await page('families', where, event);
  const familyCounts = await Promise.all(result.items.map(async function (family) {
    const counts = await Promise.all([
      db.collection('family_memberships').where({ familyId: family._id, status: 'active' }).count(),
      db.collection('persons').where({ familyId: family._id, status: 'active' }).count()
    ]);
    return { familyId: family._id, userCount: counts[0].total || 0, memberCount: counts[1].total || 0 };
  }));
  const countsByFamilyId = familyCounts.reduce(function (map, item) {
    map[item.familyId] = item;
    return map;
  }, {});
  result.items = result.items.map(function (family) {
    return publicFamily(family, countsByFamilyId[family._id]);
  });
  return result;
}

async function familiesDetail(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const family = await maybeGet('families', event.familyId);
  assert(family, 'FAMILY_NOT_FOUND', '家谱不存在');
  const detailData = await Promise.all([
    listAll('family_memberships', { familyId: family._id, status: 'active' }, 500),
    listAll('reports', { familyId: family._id }, 500),
    listAll('moderation_tasks', { familyId: family._id }, 500),
    db.collection('audit_logs').where({ familyId: family._id }).orderBy('createdAt', 'desc').limit(20).get()
  ]);
  const memberships = detailData[0];
  const reports = detailData[1];
  const moderationTasks = detailData[2];
  const recentOperations = (detailData[3].data || []).filter(function (item) {
    return item.operatorAudit && item.action !== 'ops.family.view';
  }).slice(0, 5).map(function (item) {
    return {
      _id: item._id,
      actorAccount: item.actorAccount || item.actorId || '运营人员',
      action: item.action,
      summary: item.summary || '',
      createdAt: item.createdAt || null
    };
  });
  await writeOpsAudit(db, operator, 'ops.family.view', 'family', family._id, '运营后台直接查看', '查看家谱资料', event.requestId);
  return {
    family: publicFamily(family, { userCount: memberships.length, memberCount: family.personCount }),
    collaborators: memberships.map(function (item) {
      return { displayName: item.displayName ? item.displayName.slice(0, 1) + '**' : '家人', role: item.role, status: item.status };
    }),
    risk: {
      reportBacklog: reports.filter(function (item) { return ['open', 'processing'].includes(item.status); }).length,
      moderationBacklog: moderationTasks.filter(function (item) { return ['pending', 'review'].includes(item.status); }).length
    },
    recentOperations: recentOperations
  };
}

async function familiesPersons(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const family = await maybeGet('families', event.familyId);
  assert(family, 'FAMILY_NOT_FOUND', '家谱不存在');
  const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  const cursor = cleanText(event.cursor, 80);
  const keyword = cleanText(event.keyword, 40).toLocaleLowerCase('zh-CN');
  let persons;
  let hasMore;

  if (keyword) {
    persons = await listAll('persons', { familyId: family._id, status: 'active' }, 500);
    persons = persons.filter(function (person) {
      return cleanText(person.name, 80).toLocaleLowerCase('zh-CN').includes(keyword);
    }).sort(function (left, right) {
      return String(left._id).localeCompare(String(right._id));
    });
    if (cursor) persons = persons.filter(function (person) { return String(person._id) > cursor; });
    hasMore = persons.length > pageSize;
    persons = persons.slice(0, pageSize);
  } else {
    const result = await page('persons', { familyId: family._id, status: 'active' }, { pageSize: pageSize, cursor: cursor });
    persons = result.items;
    hasMore = result.hasMore;
  }

  const relationLimit = Math.min(5000, Math.max(2500, Number(family.relationCount || 0) + 100));
  const relationContext = await familyRelationContext(family._id, relationLimit);
  const avatarStatuses = await personAvatarStatuses(persons);
  const items = persons.map(function (person) {
    return publicOpsPerson(person, {
      avatarStatus: person.avatarAssetId ? avatarStatuses[person.avatarAssetId] || 'pending' : 'none',
      relationCount: relationContext.countByPerson[person._id] || 0,
      startPersonId: family.startPersonId || ''
    });
  });
  return {
    items: items,
    nextCursor: hasMore && items.length ? items[items.length - 1]._id : '',
    hasMore: hasMore,
    keyword: keyword
  };
}

async function familiesPersonDetail(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const family = await maybeGet('families', event.familyId);
  assert(family, 'FAMILY_NOT_FOUND', '家谱不存在');
  const person = await maybeGet('persons', event.personId);
  assert(person && person.familyId === family._id && person.status === 'active', 'PERSON_NOT_FOUND', '谱内人物不存在');
  const relationLimit = Math.min(5000, Math.max(2500, Number(family.relationCount || 0) + 100));
  const relationContext = await familyRelationContext(family._id, relationLimit);
  const relatedRelations = relationContext.relations.filter(function (relation) {
    return relation.fromPersonId === person._id || relation.toPersonId === person._id;
  });
  const relatedIds = Array.from(new Set(relatedRelations.map(function (relation) {
    return relation.fromPersonId === person._id ? relation.toPersonId : relation.fromPersonId;
  })));
  let relatedPeople = [];
  if (relatedIds.length) {
    const result = await db.collection('persons').where({ _id: _.in(relatedIds) }).limit(relatedIds.length).get();
    relatedPeople = result.data || [];
  }
  const peopleById = relatedPeople.reduce(function (map, item) {
    map[item._id] = item;
    return map;
  }, {});
  const avatarStatuses = await personAvatarStatuses([person]);
  const relatives = relatedRelations.map(function (relation) {
    const relatedId = relation.fromPersonId === person._id ? relation.toPersonId : relation.fromPersonId;
    const related = peopleById[relatedId] || {};
    let role = '亲属';
    if (relation.type === 'spouse') role = '配偶';
    if (relation.type === 'parent_child' && relation.fromPersonId === person._id) {
      role = related.gender === 'male' ? '儿子' : related.gender === 'female' ? '女儿' : '子女';
    }
    if (relation.type === 'parent_child' && relation.toPersonId === person._id) {
      role = related.gender === 'male' ? '父亲' : related.gender === 'female' ? '母亲' : '父母';
    }
    return { personId: relatedId, name: maskedName(related.name, '未知人物'), role: role };
  });
  await writeOpsAudit(db, operator, 'ops.family.person.view', 'person', person._id, '运营后台直接查看', '查看谱内人物资料', event.requestId, family._id);
  return {
    person: publicOpsPerson(person, {
      avatarStatus: person.avatarAssetId ? avatarStatuses[person.avatarAssetId] || 'pending' : 'none',
      relationCount: relationContext.countByPerson[person._id] || 0,
      startPersonId: family.startPersonId || ''
    }),
    relatives: relatives
  };
}

async function familiesFreeze(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  const reason = event.freeze !== false ? '运营后台冻结' : '运营后台解除冻结';
  return opsMutate(operator, 'families.freeze', event, async function (transaction) {
    const family = await maybeGet('families', event.familyId, transaction);
    assert(family, 'FAMILY_NOT_FOUND', '家谱不存在');
    const freezing = event.freeze !== false;
    assert(freezing ? ['active', 'archived'].includes(family.status) : family.status === 'frozen', 'INVALID_STATUS_TRANSITION', '当前家谱状态不能执行此操作');
    const status = freezing ? 'frozen' : (family.statusBeforeFreeze || 'active');
    await transaction.collection('families').doc(family._id).update({
      data: {
        status: status,
        statusBeforeFreeze: freezing ? family.status : _.remove(),
        frozenReason: freezing ? reason : _.remove(),
        frozenAt: freezing ? db.serverDate() : _.remove(),
        updatedAt: db.serverDate()
      }
    });
    await writeOpsAudit(transaction, operator, freezing ? 'ops.family.freeze' : 'ops.family.unfreeze', 'family', family._id, reason, freezing ? '冻结家谱' : '解除家谱冻结', event.requestId);
    return { familyId: family._id, status: status };
  });
}

async function reportsList(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const scope = cleanText(event.scope, 30);
  const where = scope === 'backlog'
    ? { status: _.in(['open', 'processing']) }
    : event.status ? { status: cleanText(event.status, 30) } : {};
  const result = await page('reports', where, event);
  result.items = result.items.map(function (item) {
    return {
      _id: item._id,
      familyId: item.familyId,
      targetType: item.targetType,
      reason: item.reason,
      status: item.status,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    };
  });
  result.scope = scope === 'backlog' ? 'backlog' : 'all';
  return result;
}

async function reportsDetail(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const report = await maybeGet('reports', event.reportId);
  assert(report, 'REPORT_NOT_FOUND', '举报工单不存在');
  await writeOpsAudit(db, operator, 'ops.report.view', 'report', report._id, '运营后台直接查看', '查看举报工单详情', event.requestId);
  return {
    _id: report._id,
    familyId: report.familyId,
    reporterId: report.reporterId,
    targetType: report.targetType,
    targetId: report.targetId,
    reason: report.reason,
    detail: report.detail || '',
    status: report.status,
    resolution: report.resolution || '',
    createdAt: report.createdAt || null,
    updatedAt: report.updatedAt || null
  };
}

async function reportsAssign(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  return opsMutate(operator, 'reports.assign', event, async function (transaction) {
    const report = await maybeGet('reports', event.reportId, transaction);
    assert(report, 'REPORT_NOT_FOUND', '举报工单不存在');
    assert(report.status === 'open', 'INVALID_STATUS_TRANSITION', '该举报工单已被处理');
    await transaction.collection('reports').doc(report._id).update({
      data: { status: 'processing', assigneeId: operator._id, assignedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await writeOpsAudit(transaction, operator, 'ops.report.assign', 'report', report._id, '运营后台领取', '领取举报工单', event.requestId);
    return { reportId: report._id, status: 'processing' };
  });
}

async function reportsResolve(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const resolution = cleanText(event.resolution, 300);
  assert(resolution, 'RESOLUTION_REQUIRED', '请填写处理结论');
  const status = event.decision === 'reject' ? 'rejected' : 'resolved';
  return opsMutate(operator, 'reports.resolve', event, async function (transaction) {
    const report = await maybeGet('reports', event.reportId, transaction);
    assert(report, 'REPORT_NOT_FOUND', '举报工单不存在');
    assert(['open', 'processing'].includes(report.status), 'INVALID_STATUS_TRANSITION', '该举报工单已经完成');
    await transaction.collection('reports').doc(report._id).update({
      data: {
        status: status,
        assigneeId: operator._id,
        resolution: resolution,
        resolvedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await writeOpsAudit(transaction, operator, 'ops.report.resolve', 'report', report._id, resolution, status === 'resolved' ? '确认并处理举报' : '驳回举报', event.requestId);
    return { reportId: report._id, status: status };
  });
}

async function moderationList(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const scope = event.scope === 'reviewed' ? 'reviewed' : 'pending';
  const statuses = scope === 'reviewed' ? ['approved', 'rejected'] : ['review', 'pending'];
  const where = { status: _.in(statuses) };
  const result = await page('moderation_tasks', where, event);
  const reviewerIds = Array.from(new Set(result.items.map(function (item) {
    return item.reviewedBy;
  }).filter(Boolean)));
  let reviewersById = {};
  if (reviewerIds.length) {
    const reviewers = await db.collection('operators').where({ _id: _.in(reviewerIds) }).limit(reviewerIds.length).get();
    reviewersById = (reviewers.data || []).reduce(function (map, reviewer) {
      map[reviewer._id] = reviewer;
      return map;
    }, {});
  }
  result.items = result.items.map(function (item) {
    const reviewer = item.reviewedBy ? reviewersById[item.reviewedBy] || {} : {};
    const reviewSource = item.reviewedBy ? 'manual' : 'machine';
    const machineDecision = item.machineDecision || (item.result && item.result.suggest) || '';
    const reviewReason = item.reviewReason || (
      item.status === 'approved'
        ? '机器审核通过'
        : item.status === 'rejected'
          ? '机器审核拒绝'
          : '等待人工复核'
    );
    return {
      _id: item._id,
      familyId: item.familyId || '',
      type: item.type || 'image',
      kind: item.type === 'text' ? '文字' : '图片',
      moderationStatus: item.status,
      contentHash: item.contentHash || '',
      reviewSource: reviewSource,
      reviewerId: item.reviewedBy || '',
      reviewerName: item.reviewedByName || reviewer.displayName || reviewer.email || item.reviewedBy || '系统审核',
      reviewerAccount: item.reviewedByAccount || reviewer.email || '',
      reviewReason: reviewReason,
      machineDecision: machineDecision,
      decidedAt: item.reviewedAt || (scope === 'reviewed' ? item.updatedAt || item.createdAt || null : null),
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    };
  });
  result.scope = scope;
  return result;
}

async function moderationGetUrl(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const task = await maybeGet('moderation_tasks', event.taskId);
  assert(task, 'MODERATION_TASK_NOT_FOUND', '复核任务不存在');
  const completed = ['approved', 'rejected'].includes(task.status);
  assert(completed || ['pending', 'review'].includes(task.status), 'MEDIA_NOT_REVIEWABLE', '该内容不可查看');
  await writeOpsAudit(db, operator, 'ops.moderation.view', 'moderation_task', task._id, '运营后台直接查看', completed ? '查看审核记录内容' : '查看待复核内容', event.requestId, task.familyId || '');
  if (task.type === 'text') {
    if (!task.content) {
      return {
        taskId: task._id,
        type: 'text',
        status: task.status,
        available: false,
        unavailableReason: '文字内容已按 30 天保留周期清理'
      };
    }
    return { taskId: task._id, type: 'text', status: task.status, available: true, text: task.content };
  }
  const asset = await maybeGet('media_assets', task.assetId);
  if ((!asset || !asset.fileId) && completed) {
    return {
      taskId: task._id,
      type: 'image',
      status: task.status,
      available: false,
      unavailableReason: task.status === 'rejected' ? '拒绝图片已按 24 小时保留周期清理' : '图片文件已不可用'
    };
  }
  assert(asset && asset.fileId, 'MEDIA_NOT_FOUND', '审核图片不存在');
  const response = await cloud.getTempFileURL({ fileList: [asset.fileId] });
  const url = response.fileList && response.fileList[0] && response.fileList[0].tempFileURL;
  assert(url, 'MEDIA_URL_FAILED', '临时访问地址生成失败');
  return { taskId: task._id, type: 'image', status: task.status, available: true, url: url };
}

async function moderationReview(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  assert(['approve', 'reject'].includes(event.decision), 'INVALID_REVIEW_DECISION', '请选择有效的复核结论');
  const approved = event.decision === 'approve';
  const reason = approved ? '运营后台人工通过' : cleanText(event.reason, 200);
  assert(approved || reason, 'REVIEW_REASON_REQUIRED', '拒绝内容时必须填写原因');
  const reviewedByName = cleanText(operator.displayName || operator.email || operator._id, 120);
  const reviewedByAccount = cleanText(operator.email || '', 120);
  return opsMutate(operator, 'moderation.review', event, async function (transaction) {
    const task = await maybeGet('moderation_tasks', event.taskId, transaction);
    assert(task, 'MODERATION_TASK_NOT_FOUND', '复核任务不存在');
    assert(['pending', 'review'].includes(task.status), 'INVALID_STATUS_TRANSITION', '该内容已经完成复核');
    const moderationStatus = approved ? 'approved' : 'rejected';
    if (task.type !== 'text') {
      const asset = await maybeGet('media_assets', task.assetId, transaction);
      assert(asset, 'MEDIA_NOT_FOUND', '审核图片不存在');
      await transaction.collection('media_assets').doc(asset._id).update({
        data: {
          moderationStatus: moderationStatus,
          status: approved ? 'active' : 'pending',
          reviewedBy: operator._id,
          reviewedByName: reviewedByName,
          reviewedByAccount: reviewedByAccount,
          reviewReason: reason,
          reviewedAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
    await transaction.collection('moderation_tasks').doc(task._id).update({
      data: {
        status: moderationStatus,
        reviewedBy: operator._id,
        reviewedByName: reviewedByName,
        reviewedByAccount: reviewedByAccount,
        reviewReason: reason,
        reviewedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await writeOpsAudit(transaction, operator, approved ? 'ops.moderation.approve' : 'ops.moderation.reject', 'moderation_task', task._id, reason, approved ? '通过内容复核' : '拒绝内容复核', event.requestId);
    return { taskId: task._id, status: moderationStatus };
  });
}

async function deletionsList(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const scope = cleanText(event.scope, 30);
  const where = scope === 'backlog'
    ? { status: _.in(['pending', 'failed']) }
    : event.status ? { status: cleanText(event.status, 30) } : {};
  const result = await page('account_deletion_requests', where, event);
  result.scope = scope === 'backlog' ? 'backlog' : 'all';
  return result;
}

async function deletionsRetry(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  return opsMutate(operator, 'deletions.retry', event, async function (transaction) {
    const request = await maybeGet('account_deletion_requests', event.deletionId, transaction);
    assert(request, 'DELETION_NOT_FOUND', '注销任务不存在');
    assert(request.status === 'failed', 'DELETION_NOT_FAILED', '只有失败任务可以重试');
    await transaction.collection('account_deletion_requests').doc(request._id).update({
      data: { status: 'pending', executeAt: new Date(), failureMessage: _.remove(), updatedAt: db.serverDate() }
    });
    await writeOpsAudit(transaction, operator, 'ops.deletion.retry', 'account_deletion', request._id, '运营后台重试', '重试注销任务', event.requestId);
    return { deletionId: request._id, status: 'pending' };
  });
}

async function auditsList(event, context) {
  await requireOperator(context, ['super_admin']);
  const where = event.operatorOnly ? { operatorAudit: true } : {};
  const result = await page('audit_logs', where, event);
  result.items = result.items.map(function (item) {
    return {
      _id: item._id,
      actorName: item.actorAccount || (item.actorType === 'operator' ? item.actorId || '运营人员' : '家庭用户'),
      actorId: item.actorId || '',
      action: item.action,
      objectType: item.objectType,
      objectId: item.objectId,
      summary: item.summary,
      reason: item.reason || '',
      createdAt: item.createdAt
    };
  });
  return result;
}

async function operatorsList(event, context) {
  await requireOperator(context, ['super_admin']);
  const result = await page('operators', {}, event);
  result.items = result.items.map(function (item) {
    return {
      _id: item._id,
      displayName: item.displayName,
      email: item.email || '',
      role: item.role,
      status: item.status,
      createdAt: item.createdAt || null
    };
  });
  return result;
}

async function operatorsCreate(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  const authUid = cleanText(event.authUid, 128);
  const displayName = cleanText(event.displayName, 30);
  const email = cleanText(event.email, 120).toLowerCase();
  const role = event.role === 'super_admin' ? 'super_admin' : 'operator';
  assert(authUid && displayName, 'INVALID_OPERATOR', '请填写认证 UID 和运营人员姓名');
  const id = 'op_' + hash(authUid, 32);
  return opsMutate(operator, 'operators.create', event, async function (transaction) {
    const existing = await maybeGet('operators', id, transaction);
    assert(!existing || existing.status !== 'active', 'OPERATOR_EXISTS', '该认证账号已在运营白名单中');
    await transaction.collection('operators').doc(id).set({
      data: {
        authUid: authUid,
        displayName: displayName,
        email: email,
        role: role,
        status: 'active',
        createdBy: operator._id,
        createdAt: existing && existing.createdAt ? existing.createdAt : db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await writeOpsAudit(transaction, operator, 'ops.operator.create', 'operator', id, '运营后台创建', '创建运营账号', event.requestId);
    return { operatorId: id, role: role };
  });
}

async function operatorsDisable(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  assert(operator._id !== event.operatorId, 'CANNOT_DISABLE_SELF', '不能停用当前登录账号');
  return opsMutate(operator, 'operators.disable', event, async function (transaction) {
    const target = await maybeGet('operators', event.operatorId, transaction);
    assert(target, 'OPERATOR_NOT_FOUND', '运营账号不存在');
    assert(target.status === 'active', 'INVALID_STATUS_TRANSITION', '该运营账号已经停用');
    await transaction.collection('operators').doc(target._id).update({
      data: { status: 'disabled', disabledAt: db.serverDate(), disabledReason: '运营后台停用', updatedAt: db.serverDate() }
    });
    await writeOpsAudit(transaction, operator, 'ops.operator.disable', 'operator', target._id, '运营后台停用', '停用运营账号', event.requestId);
    return { operatorId: target._id, status: 'disabled' };
  });
}

function publicExampleTemplate(template) {
  const content = template.publishedContent || template.draftContent || {};
  return {
    _id: template._id,
    slug: template.slug,
    title: template.title || (content.family && content.family.name) || '未命名示例',
    description: template.description || (content.family && content.family.description) || '',
    tags: template.tags || [],
    status: template.status || 'draft',
    sortOrder: Number(template.sortOrder) || 0,
    personCount: (content.persons || []).length,
    relationCount: (content.relations || []).length,
    publishedVersion: Number(template.publishedVersion) || 0,
    publishedAt: template.publishedAt || null,
    updatedAt: template.updatedAt || null,
    createdAt: template.createdAt || null
  };
}

function normalizeExampleMetadata(event, fallback) {
  const source = event || {};
  const existing = fallback || {};
  const title = cleanText(source.title === undefined ? existing.title : source.title, 40);
  const slug = cleanExampleSlug(source.slug === undefined ? existing.slug : source.slug);
  assert(title, 'EXAMPLE_TITLE_REQUIRED', '请填写示例家谱名称');
  assert(slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug), 'EXAMPLE_SLUG_INVALID', '示例链接标识只能使用小写字母、数字和连字符');
  return {
    title: title,
    slug: slug,
    description: cleanText(source.description === undefined ? existing.description : source.description, 200),
    tags: (Array.isArray(source.tags) ? source.tags : (existing.tags || [])).map(function (tag) {
      return cleanText(tag, 20);
    }).filter(function (tag, index, values) { return tag && values.indexOf(tag) === index; }).slice(0, 8),
    sortOrder: Math.max(0, Math.min(9999, Number(source.sortOrder === undefined ? existing.sortOrder : source.sortOrder) || 0)),
    shareTitle: cleanText(source.shareTitle === undefined ? existing.shareTitle : source.shareTitle, 60),
    shareDescription: cleanText(source.shareDescription === undefined ? existing.shareDescription : source.shareDescription, 100)
  };
}

async function examplesList(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const status = cleanText(event.status, 20);
  const where = status ? { status: status } : {};
  const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  let items;
  try {
    // Keep the first-load path deliberately simple. A newly enabled environment
    // has no example records yet, so it does not need cursor paging or sorting
    // at the database layer before the in-memory operating order is applied.
    const result = await db.collection('example_templates').where(where).limit(pageSize).get();
    items = result.data || [];
  } catch (error) {
    // The only valid empty state is a brand-new environment without the
    // collection. Other database failures must remain visible and traceable.
    if (!isMissingCollectionError(error)) throw exampleStorageError('templates', error);
    console.log(JSON.stringify({ type: 'examples_list_empty_store', error: errorDigest(error) }));
    items = [];
  }
  items = items.map(publicExampleTemplate).sort(function (left, right) {
    return left.sortOrder - right.sortOrder || left.slug.localeCompare(right.slug);
  });
  return { items: items, nextCursor: '', hasMore: false };
}

async function examplesHealth(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const templates = await checkExampleCollection('example_templates', true);
  const versions = await checkExampleCollection('example_template_versions', true);
  let audits;
  try {
    await db.collection('audit_logs').limit(1).get();
    audits = { state: 'ready' };
  } catch (error) {
    console.warn(JSON.stringify({ type: 'example_audit_store_unavailable', error: errorDigest(error) }));
    audits = { state: 'unavailable' };
  }
  return { templates: templates, versions: versions, audits: audits };
}

async function examplesDetail(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const template = await getExampleTemplate(event.templateId);
  const versions = await readExampleVersions(template);
  await writeExampleViewAudit(operator, template._id, event.requestId);
  return {
    template: Object.assign(publicExampleTemplate(template), {
      draftContent: template.draftContent || { family: { name: template.title || '', description: template.description || '' }, persons: [], relations: [] },
      shareTitle: template.shareTitle || '',
      shareDescription: template.shareDescription || ''
    }),
    versions: versions.sort(function (left, right) { return Number(right.version) - Number(left.version); }).map(function (version) {
      return { _id: version._id, version: version.version, publishedAt: version.publishedAt || null, publishedByName: version.publishedByName || '' };
    })
  };
}

async function examplesCreate(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  await ensureExampleCollections();
  const meta = normalizeExampleMetadata(event);
  const id = 'example_' + hash(meta.slug, 32);
  const content = normalizeExampleContent(event.draftContent || {
    family: { name: meta.title, description: meta.description },
    persons: [{ _id: 'person-1', name: '示例人物一' }, { _id: 'person-2', name: '示例人物二' }, { _id: 'person-3', name: '示例人物三' }],
    relations: [{ _id: 'relation-1', type: 'parent_child', fromPersonId: 'person-1', toPersonId: 'person-2' }, { _id: 'relation-2', type: 'parent_child', fromPersonId: 'person-1', toPersonId: 'person-3' }]
  });
  return opsMutate(operator, 'examples.create', event, async function (transaction) {
    // CloudBase transactions report a missing document differently across
    // environments. For creation, an absent fixed-ID document is the expected
    // state, so use the shared safe primary-key lookup instead of converting
    // that state into a template-read failure.
    const existing = await maybeGet('example_templates', id, transaction);
    assert(!existing, 'EXAMPLE_SLUG_EXISTS', '该示例链接标识已存在');
    try {
      await transaction.collection('example_templates').doc(id).set({
        data: {
          slug: meta.slug,
          title: meta.title,
          description: meta.description,
          tags: meta.tags,
          sortOrder: meta.sortOrder,
          shareTitle: meta.shareTitle,
          shareDescription: meta.shareDescription,
          status: 'draft',
          draftContent: content,
          publishedVersion: 0,
          createdBy: operator._id,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    } catch (error) {
      throw exampleStorageError('templates', error);
    }
    await writeRequiredExampleAudit(transaction, operator, 'ops.example.create', id, '运营后台创建', '创建示例家谱', event.requestId);
    return { templateId: id };
  });
}

async function examplesUpdateDraft(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  await ensureExampleCollections();
  return opsMutate(operator, 'examples.updateDraft', event, async function (transaction) {
    const template = await getExampleTemplate(event.templateId, transaction);
    assert(template.status !== 'archived', 'EXAMPLE_ARCHIVED', '已归档的示例不能继续编辑');
    const meta = normalizeExampleMetadata(event, template);
    assert(meta.slug === template.slug, 'EXAMPLE_SLUG_IMMUTABLE', '创建后不能修改示例链接标识');
    const content = normalizeExampleContent(event.draftContent || template.draftContent, template.draftContent);
    await transaction.collection('example_templates').doc(template._id).update({
      data: Object.assign({}, meta, { draftContent: content, updatedAt: db.serverDate() })
    });
    await writeRequiredExampleAudit(transaction, operator, 'ops.example.update_draft', template._id, '运营后台编辑', '更新示例草稿', event.requestId);
    return { templateId: template._id, draftContent: content };
  });
}

async function examplesPublish(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  await ensureExampleCollections();
  return opsMutate(operator, 'examples.publish', event, async function (transaction) {
    const template = await getExampleTemplate(event.templateId, transaction);
    assert(template.status !== 'archived', 'EXAMPLE_ARCHIVED', '已归档的示例不能发布');
    const content = normalizeExampleContent(template.draftContent, template.draftContent);
    const version = Number(template.publishedVersion || 0) + 1;
    const versionId = 'example_version_' + hash(template._id + ':' + version, 32);
    await transaction.collection('example_template_versions').doc(versionId).set({
      data: {
        templateId: template._id,
        version: version,
        snapshot: { title: template.title, description: template.description, tags: template.tags || [], sortOrder: template.sortOrder || 0, shareTitle: template.shareTitle || '', shareDescription: template.shareDescription || '', content: content },
        publishedBy: operator._id,
        publishedByName: operator.displayName || '',
        publishedAt: db.serverDate()
      }
    });
    await transaction.collection('example_templates').doc(template._id).update({
      data: { status: 'published', publishedVersion: version, publishedContent: content, publishedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await writeRequiredExampleAudit(transaction, operator, 'ops.example.publish', template._id, '运营后台发布', '发布示例家谱 v' + version, event.requestId);
    return { templateId: template._id, version: version };
  });
}

async function examplesUnpublish(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  await ensureExampleCollections();
  return opsMutate(operator, 'examples.unpublish', event, async function (transaction) {
    const template = await getExampleTemplate(event.templateId, transaction);
    assert(template.status === 'published', 'EXAMPLE_NOT_PUBLISHED', '该示例当前未发布');
    await transaction.collection('example_templates').doc(template._id).update({
      data: { status: 'draft', publishedContent: _.remove(), unpublishedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await writeRequiredExampleAudit(transaction, operator, 'ops.example.unpublish', template._id, '运营后台下架', '下架示例家谱', event.requestId);
    return { templateId: template._id, status: 'draft' };
  });
}

async function examplesRollback(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  await ensureExampleCollections();
  return opsMutate(operator, 'examples.rollback', event, async function (transaction) {
    const template = await getExampleTemplate(event.templateId, transaction);
    const version = await findExampleDocument('example_template_versions', cleanText(event.versionId, 80), transaction);
    assert(version && version.templateId === template._id, 'EXAMPLE_VERSION_NOT_FOUND', '示例历史版本不存在');
    const snapshot = version.snapshot || {};
    assert(snapshot.content, 'EXAMPLE_VERSION_INVALID', '示例历史版本不完整');
    const nextVersion = Number(template.publishedVersion || 0) + 1;
    const nextVersionId = 'example_version_' + hash(template._id + ':' + nextVersion, 32);
    await transaction.collection('example_template_versions').doc(nextVersionId).set({
      data: {
        templateId: template._id,
        version: nextVersion,
        sourceVersion: version.version,
        snapshot: snapshot,
        publishedBy: operator._id,
        publishedByName: operator.displayName || '',
        publishedAt: db.serverDate()
      }
    });
    await transaction.collection('example_templates').doc(template._id).update({
      data: {
        title: snapshot.title || template.title,
        description: snapshot.description || '',
        tags: snapshot.tags || [],
        sortOrder: Number(snapshot.sortOrder) || 0,
        shareTitle: snapshot.shareTitle || '',
        shareDescription: snapshot.shareDescription || '',
        draftContent: snapshot.content,
        publishedContent: snapshot.content,
        status: 'published',
        publishedVersion: nextVersion,
        publishedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await writeRequiredExampleAudit(transaction, operator, 'ops.example.rollback', template._id, '运营后台回滚', '从 v' + version.version + ' 创建发布版本 v' + nextVersion, event.requestId);
    return { templateId: template._id, version: nextVersion };
  });
}

async function examplesArchive(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  await ensureExampleCollections();
  return opsMutate(operator, 'examples.archive', event, async function (transaction) {
    const template = await getExampleTemplate(event.templateId, transaction);
    assert(template.status !== 'published', 'EXAMPLE_UNPUBLISH_FIRST', '请先下架示例再归档');
    await transaction.collection('example_templates').doc(template._id).update({
      data: { status: 'archived', archivedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await writeRequiredExampleAudit(transaction, operator, 'ops.example.archive', template._id, '运营后台归档', '归档示例家谱', event.requestId);
    return { templateId: template._id, status: 'archived' };
  });
}

const handlers = {
  'session.me': sessionMe,
  'dashboard.summary': dashboardSummary,
  'users.list': usersList,
  'users.detail': usersDetail,
  'users.freeze': usersFreeze,
  'families.list': familiesList,
  'families.detail': familiesDetail,
  'families.persons': familiesPersons,
  'families.personDetail': familiesPersonDetail,
  'families.freeze': familiesFreeze,
  'reports.list': reportsList,
  'reports.detail': reportsDetail,
  'reports.assign': reportsAssign,
  'reports.resolve': reportsResolve,
  'moderation.list': moderationList,
  'moderation.getUrl': moderationGetUrl,
  'moderation.review': moderationReview,
  'deletions.list': deletionsList,
  'deletions.retry': deletionsRetry,
  'audits.list': auditsList,
  'operators.list': operatorsList,
  'operators.create': operatorsCreate,
  'operators.disable': operatorsDisable,
  'feedbackGroup.get': feedbackGroupGet,
  'feedbackGroup.update': feedbackGroupUpdate,
  'examples.health': examplesHealth,
  'examples.list': examplesList,
  'examples.detail': examplesDetail,
  'examples.create': examplesCreate,
  'examples.updateDraft': examplesUpdateDraft,
  'examples.publish': examplesPublish,
  'examples.unpublish': examplesUnpublish,
  'examples.rollback': examplesRollback,
  'examples.archive': examplesArchive
};

exports.main = async function (event, context) {
  const startedAt = Date.now();
  const request = event || {};
  const runtimeContext = Object.assign({}, context || {});
  Object.defineProperty(runtimeContext, 'youpuAccessToken', {
    value: cleanText(request.accessToken, 8192),
    enumerable: false
  });
  delete request.accessToken;
  const action = cleanText(request.action || request.type, 80);
  const requestId = cleanText(request.requestId, 80) || crypto.randomBytes(8).toString('hex');
  const identity = operatorIdentity(runtimeContext);
  const anonymousActorId = identity ? 'operator_' + hash(identity, 24) : '';
  request.requestId = requestId;
  if (!identity && action === 'session.me') {
    const wxContext = cloud.getWXContext() || {};
    console.warn(JSON.stringify({
      requestId: requestId,
      type: 'ops_identity_context_missing',
      contextKeys: sortedKeys(context),
      userInfoKeys: sortedKeys(context && context.userInfo),
      authKeys: sortedKeys(context && context.auth),
      wxContextKeys: sortedKeys(wxContext)
    }));
  }
  try {
    const handler = handlers[action];
    assert(handler, 'UNKNOWN_ACTION', '未知的运营操作');
    const data = await handler(request, runtimeContext);
    console.log(JSON.stringify({ requestId: requestId, actorId: anonymousActorId, action: action, success: true, durationMs: Date.now() - startedAt, resultCode: 'OK' }));
    return { success: true, data: data, requestId: requestId };
  } catch (error) {
    console.error(JSON.stringify({
      type: 'ops_request_failed',
      requestId: requestId,
      actorId: anonymousActorId,
      action: action,
      success: false,
      code: error.code || 'SERVER_ERROR',
      durationMs: Date.now() - startedAt,
      resultCode: error.code || 'SERVER_ERROR',
      error: errorDigest(error)
    }));
    return {
      success: false,
      code: error.code || 'SERVER_ERROR',
      message: error.code ? error.message : '运营服务暂时不可用',
      requestId: requestId
    };
  }
};
