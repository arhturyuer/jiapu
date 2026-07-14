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
  return cleanText(wxContext.UID || wxContext.OPENID || wxContext.UNIONID || info.uid || info.openId || auth.uid, 128);
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
  const identity = operatorIdentity(context);
  assert(identity, 'UNAUTHENTICATED', '请先登录运营后台');
  const result = await db.collection('operators').where({ authUid: identity, status: 'active' }).limit(1).get();
  assert(result.data && result.data.length, 'NOT_OPERATOR', '当前账号不在运营白名单中');
  const operator = result.data[0];
  if (roles && roles.length) assert(roles.includes(operator.role), 'NO_PERMISSION', '当前运营角色没有此权限');
  return operator;
}

async function writeOpsAudit(scope, operator, action, objectType, objectId, reason, summary, requestId) {
  await (scope || db).collection('audit_logs').add({
    data: {
      familyId: '',
      actorId: 'operator_' + operator._id,
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

async function requireLinkedWorkOrder(workOrderId, objectType, objectId) {
  const id = cleanText(workOrderId, 80);
  assert(id, 'WORK_ORDER_REQUIRED', '查看必要资料必须关联举报或注销工单');
  const deletion = await maybeGet('account_deletion_requests', id);
  if (deletion) {
    assert(objectType === 'user' && deletion.userId === objectId, 'WORK_ORDER_MISMATCH', '注销工单与查看对象不匹配');
    return { type: 'deletion', id: deletion._id };
  }
  const report = await maybeGet('reports', id);
  assert(report, 'WORK_ORDER_NOT_FOUND', '关联工单不存在');
  const matched = objectType === 'family'
    ? report.familyId === objectId
    : report.reporterId === objectId;
  assert(matched, 'WORK_ORDER_MISMATCH', '举报工单与查看对象不匹配');
  return { type: 'report', id: report._id };
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
  const workOrder = await requireLinkedWorkOrder(event.workOrderId, 'user', user._id);
  const reason = '处理' + workOrder.type + '工单 ' + workOrder.id;
  const memberships = await listAll('family_memberships', { userId: user._id }, 500);
  await writeOpsAudit(db, operator, 'ops.user.view', 'user', user._id, reason, '查看用户必要资料', event.requestId);
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
  const reason = cleanText(event.reason, 200);
  assert(reason, 'REASON_REQUIRED', '冻结或解冻必须填写原因');
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
  const workOrder = await requireLinkedWorkOrder(event.workOrderId, 'family', family._id);
  const reason = '处理举报工单 ' + workOrder.id;
  const memberships = await listAll('family_memberships', { familyId: family._id, status: 'active' }, 500);
  await writeOpsAudit(db, operator, 'ops.family.view', 'family', family._id, reason, '查看家谱必要资料', event.requestId);
  return {
    family: publicFamily(family),
    collaborators: memberships.map(function (item) {
      return { displayName: item.displayName ? item.displayName.slice(0, 1) + '**' : '家人', role: item.role, status: item.status };
    })
  };
}

async function familiesFreeze(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  const reason = cleanText(event.reason, 200);
  assert(reason, 'REASON_REQUIRED', '冻结或解冻必须填写原因');
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
  const reason = cleanText(event.reason, 200);
  assert(reason, 'REASON_REQUIRED', '查看举报详情必须填写处理原因');
  const report = await maybeGet('reports', event.reportId);
  assert(report, 'REPORT_NOT_FOUND', '举报工单不存在');
  await writeOpsAudit(db, operator, 'ops.report.view', 'report', report._id, reason, '查看举报工单详情', event.requestId);
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
  const reason = cleanText(event.reason, 200);
  assert(reason, 'REASON_REQUIRED', '领取工单必须填写处理说明');
  return opsMutate(operator, 'reports.assign', event, async function (transaction) {
    const report = await maybeGet('reports', event.reportId, transaction);
    assert(report, 'REPORT_NOT_FOUND', '举报工单不存在');
    assert(report.status === 'open', 'INVALID_STATUS_TRANSITION', '该举报工单已被处理');
    await transaction.collection('reports').doc(report._id).update({
      data: { status: 'processing', assigneeId: operator._id, assignedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await writeOpsAudit(transaction, operator, 'ops.report.assign', 'report', report._id, reason, '领取举报工单', event.requestId);
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
  const where = event.status ? { status: cleanText(event.status, 30) } : { status: _.in(['review', 'pending']) };
  const result = await page('moderation_tasks', where, event);
  result.items = result.items.map(function (item) {
    return {
      _id: item._id,
      familyId: item.familyId || '',
      type: item.type || 'image',
      kind: item.type === 'text' ? '文字' : '图片',
      moderationStatus: item.status,
      contentHash: item.contentHash || '',
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    };
  });
  return result;
}

async function moderationGetUrl(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const reason = cleanText(event.reason, 200);
  assert(reason, 'REASON_REQUIRED', '查看待复核内容必须填写工单或复核原因');
  const task = await maybeGet('moderation_tasks', event.taskId);
  assert(task, 'MODERATION_TASK_NOT_FOUND', '复核任务不存在');
  assert(['pending', 'review'].includes(task.status), 'MEDIA_NOT_REVIEWABLE', '该内容不在复核队列中');
  await writeOpsAudit(db, operator, 'ops.moderation.view', 'moderation_task', task._id, reason, '查看待复核内容', event.requestId);
  if (task.type === 'text') {
    return { taskId: task._id, type: 'text', text: task.content || '' };
  }
  const asset = await maybeGet('media_assets', task.assetId);
  assert(asset && asset.fileId, 'MEDIA_NOT_FOUND', '审核图片不存在');
  const response = await cloud.getTempFileURL({ fileList: [asset.fileId] });
  const url = response.fileList && response.fileList[0] && response.fileList[0].tempFileURL;
  assert(url, 'MEDIA_URL_FAILED', '临时访问地址生成失败');
  return { taskId: task._id, type: 'image', url: url };
}

async function moderationReview(event, context) {
  const operator = await requireOperator(context, ['super_admin', 'operator']);
  const reason = cleanText(event.reason, 200);
  assert(reason, 'REASON_REQUIRED', '请填写人工复核结论');
  const approved = event.decision === 'approve';
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
  const reason = cleanText(event.reason, 200);
  assert(reason, 'REASON_REQUIRED', '请填写重试原因');
  return opsMutate(operator, 'deletions.retry', event, async function (transaction) {
    const request = await maybeGet('account_deletion_requests', event.deletionId, transaction);
    assert(request, 'DELETION_NOT_FOUND', '注销任务不存在');
    assert(request.status === 'failed', 'DELETION_NOT_FAILED', '只有失败任务可以重试');
    await transaction.collection('account_deletion_requests').doc(request._id).update({
      data: { status: 'pending', executeAt: new Date(), failureMessage: _.remove(), updatedAt: db.serverDate() }
    });
    await writeOpsAudit(transaction, operator, 'ops.deletion.retry', 'account_deletion', request._id, reason, '重试注销任务', event.requestId);
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
      actorName: item.actorType === 'operator' ? '运营人员' : '家庭用户',
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
  const reason = cleanText(event.reason, 200);
  assert(authUid && displayName, 'INVALID_OPERATOR', '请填写认证 UID 和运营人员姓名');
  assert(reason, 'REASON_REQUIRED', '创建运营账号必须填写原因');
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
    await writeOpsAudit(transaction, operator, 'ops.operator.create', 'operator', id, reason, '创建运营账号', event.requestId);
    return { operatorId: id, role: role };
  });
}

async function operatorsDisable(event, context) {
  const operator = await requireOperator(context, ['super_admin']);
  assert(operator._id !== event.operatorId, 'CANNOT_DISABLE_SELF', '不能停用当前登录账号');
  const reason = cleanText(event.reason, 200);
  assert(reason, 'REASON_REQUIRED', '请填写停用原因');
  return opsMutate(operator, 'operators.disable', event, async function (transaction) {
    const target = await maybeGet('operators', event.operatorId, transaction);
    assert(target, 'OPERATOR_NOT_FOUND', '运营账号不存在');
    assert(target.status === 'active', 'INVALID_STATUS_TRANSITION', '该运营账号已经停用');
    await transaction.collection('operators').doc(target._id).update({
      data: { status: 'disabled', disabledAt: db.serverDate(), disabledReason: reason, updatedAt: db.serverDate() }
    });
    await writeOpsAudit(transaction, operator, 'ops.operator.disable', 'operator', target._id, reason, '停用运营账号', event.requestId);
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
  const action = cleanText(request.action || request.type, 80);
  const requestId = cleanText(request.requestId, 80) || crypto.randomBytes(8).toString('hex');
  const identity = operatorIdentity(context || {});
  const anonymousActorId = identity ? 'operator_' + hash(identity, 24) : '';
  request.requestId = requestId;
  try {
    const handler = handlers[action];
    assert(handler, 'UNKNOWN_ACTION', '未知的运营操作');
    const data = await handler(request, context || {});
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
