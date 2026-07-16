const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
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

function maskIdentity(value) {
  const text = cleanText(value, 200);
  if (!text) return '';
  return text.length <= 8 ? hash(text, 8) : text.slice(0, 4) + '…' + text.slice(-4);
}

function publicUser(user) {
  return {
    _id: user._id,
    identity: maskIdentity(user.openid || user._id),
    nickName: user.nickName ? user.nickName.slice(0, 1) + '**' : '未设置',
    status: user.status,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null
  };
}

function publicFamily(family) {
  return {
    _id: family._id,
    name: family.name ? family.name.slice(0, 1) + '**' : '未命名',
    status: family.status,
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

async function dashboardSummary(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const [users, families, reports, moderation, deletions] = await Promise.all([
    db.collection('users').where({ status: 'active' }).count(),
    db.collection('families').where({ status: 'active' }).count(),
    db.collection('reports').where({ status: _.in(['open', 'processing']) }).count(),
    db.collection('media_assets').where({ moderationStatus: _.in(['review', 'pending']) }).count(),
    db.collection('account_deletion_requests').where({ status: _.in(['pending', 'failed']) }).count()
  ]);
  return {
    totals: {
      activeUsers: users.total || 0,
      activeFamilies: families.total || 0,
      reportBacklog: reports.total || 0,
      moderationBacklog: moderation.total || 0,
      deletionBacklog: deletions.total || 0
    },
    generatedAt: new Date().toISOString()
  };
}

async function usersList(event, context) {
  await requireOperator(context, ['super_admin', 'operator']);
  const where = event.status ? { status: cleanText(event.status, 30) } : {};
  const result = await page('users', where, event);
  result.items = result.items.map(publicUser);
  return result;
}

async function usersDetail(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const user = await maybeGet('users', event.userId);
  assert(user, 'USER_NOT_FOUND', '用户不存在');
  const memberships = await listAll('family_memberships', { userId: user._id }, 500);
  await writeOpsAudit(db, operator, 'ops.user.view', 'user', user._id, '运营后台直接查看', '查看用户资料', event.requestId);
  return {
    user: {
      _id: user._id,
      identity: maskIdentity(user.openid || user._id),
      nickName: user.nickName || '未设置',
      status: user.status,
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || null
    },
    memberships: memberships.map(function (item) {
      return { familyId: item.familyId, role: item.role, status: item.status, joinedAt: item.joinedAt || null };
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
  result.items = result.items.map(publicFamily);
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
    family: publicFamily(family),
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
  const where = event.status ? { status: cleanText(event.status, 30) } : {};
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
  const where = event.status ? { status: cleanText(event.status, 30) } : {};
  return page('account_deletion_requests', where, event);
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
  'operators.disable': operatorsDisable
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
    console.error(JSON.stringify({ requestId: requestId, actorId: anonymousActorId, action: action, success: false, code: error.code || 'SERVER_ERROR', durationMs: Date.now() - startedAt, resultCode: error.code || 'SERVER_ERROR' }));
    return {
      success: false,
      code: error.code || 'SERVER_ERROR',
      message: error.code ? error.message : '运营服务暂时不可用',
      requestId: requestId
    };
  }
};
