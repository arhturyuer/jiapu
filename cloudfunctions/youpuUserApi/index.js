const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const domain = require('./domain');
const commerce = require('./commerce');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PAGE_SIZE = 50;
const GRAPH_PERSON_LIMIT = 500;
const GRAPH_RELATION_LIMIT = 2000;
const ACTIVE_ROLES = domain.ACTIVE_ROLES;
const RATE_LIMITS = {
  'auth.updateProfile': { max: 20, windowMs: 60 * 60 * 1000 },
  'auth.updateAvatar': { max: 20, windowMs: 60 * 60 * 1000 },
  'account.export': { max: 3, windowMs: 24 * 60 * 60 * 1000 },
  'payment.createOrder': { max: 10, windowMs: 60 * 60 * 1000 },
  'payment.reconcileNow': { max: 20, windowMs: 60 * 60 * 1000 },
  'payment.mockComplete': { max: 10, windowMs: 60 * 60 * 1000 },
  'payment.mockRefund': { max: 10, windowMs: 60 * 60 * 1000 },
  'family.backup.create': { max: 3, windowMs: 24 * 60 * 60 * 1000 },
  'family.create': { max: 10, windowMs: 24 * 60 * 60 * 1000 },
  'invite.create': { max: 60, windowMs: 60 * 60 * 1000 },
  'invite.preview': { max: 60, windowMs: 60 * 1000 },
  'invite.accept': { max: 30, windowMs: 60 * 1000 },
  'share.record': { max: 120, windowMs: 60 * 60 * 1000 },
  'report.create': { max: 20, windowMs: 24 * 60 * 60 * 1000 },
  'media.prepare': { max: 100, windowMs: 24 * 60 * 60 * 1000 }
};
const MUTATION_TYPES = new Set([
  'auth.updateProfile',
  'auth.updateAvatar',
  'account.export',
  'account.exportUrl',
  'account.requestDeletion',
  'account.cancelDeletion',
  'payment.createOrder',
  'payment.reconcileNow',
  'payment.mockComplete',
  'payment.mockRefund',
  'family.backup.create',
  'family.create',
  'family.update',
  'family.archive',
  'family.restore',
  'family.setPreference',
  'family.markOnboardingShared',
  'family.dismissShareReminder',
  'membership.updateRole',
  'membership.transferAdmin',
  'membership.leave',
  'person.createRelated',
  'relation.linkExisting',
  'relation.remove',
  'person.update',
  'person.delete',
  'change.review',
  'invite.create',
  'invite.revoke',
  'invite.accept',
  'share.record',
  'report.create',
  'media.prepare',
  'media.complete'
]);

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
  return domain.cleanText(value, maxLength);
}

// The staging notifier predates the immutable runtime limitation on the
// production function.  Live payments therefore use the Node.js 20
// replacement, while every non-live environment keeps its existing target.
function paymentNotifyFunctionName() {
  return String(process.env.PAYMENT_MODE || '').toLowerCase() === 'live'
    ? 'youpuPaymentNotifyV2'
    : 'youpuPaymentNotify';
}

function cleanDate(value) {
  return domain.cleanDate(value);
}

function cleanGender(value) {
  return ['male', 'female', 'unknown'].includes(value) ? value : 'unknown';
}

function cleanLifeStatus(value) {
  return ['living', 'deceased', 'unknown'].includes(value) ? value : 'unknown';
}

function cleanPersonIds(value, limit) {
  const result = [];
  (Array.isArray(value) ? value : []).forEach(function (item) {
    const id = cleanText(item, 80);
    if (id && result.indexOf(id) < 0 && result.length < (limit || 50)) result.push(id);
  });
  return result;
}

function cleanRole(value) {
  return ACTIVE_ROLES.includes(value) ? value : 'viewer';
}

function hash(value, length) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length || 32);
}

function documentData(value) {
  const data = Object.assign({}, value || {});
  delete data._id;
  return data;
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes || 24).toString('base64url');
}

const SHARE_KINDS = ['family_full', 'family_perspective', 'example', 'discovery'];
const SHARE_STAGES = ['prepared', 'sent', 'opened', 'converted'];

function shareMetricDay(date) {
  return (date || new Date()).toISOString().slice(0, 10);
}

function shareMetricId(day, kind) {
  return 'share_' + day.replace(/-/g, '') + '_' + kind;
}

function invitationShareKind(invitation) {
  return invitation && invitation.viewMode === 'perspective' ? 'family_perspective' : 'family_full';
}

async function incrementShareMetric(scope, kind, stage) {
  if (!SHARE_KINDS.includes(kind) || !SHARE_STAGES.includes(stage)) return;
  if (scope === db) return db.runTransaction(function (transaction) {
    return incrementShareMetric(transaction, kind, stage);
  });
  const day = shareMetricDay();
  const id = shareMetricId(day, kind);
  const current = await maybeGet(scope, 'share_metrics_daily', id);
  if (current) {
    await scope.collection('share_metrics_daily').doc(id).update({
      data: { [stage]: _.inc(1), updatedAt: db.serverDate() }
    });
    return;
  }
  const base = { day: day, kind: kind, prepared: 0, sent: 0, opened: 0, converted: 0, createdAt: db.serverDate(), updatedAt: db.serverDate() };
  base[stage] = 1;
  await scope.collection('share_metrics_daily').doc(id).set({ data: base });
}

async function deleteFilesStrict(fileIds) {
  const files = Array.from(new Set((fileIds || []).filter(Boolean)));
  if (!files.length) return;
  const result = await cloud.deleteFile({ fileList: files });
  const failed = (result.fileList || []).filter(function (item) {
    return item.status !== undefined && Number(item.status) !== 0;
  });
  assert(!failed.length, 'STORAGE_DELETE_FAILED', '云存储文件删除失败，请稍后重试');
}

async function inspectPrivateUpload(fileId) {
  const urls = await cloud.getTempFileURL({ fileList: [fileId] });
  const item = urls.fileList && urls.fileList[0];
  const url = item && item.tempFileURL;
  assert(url, 'MEDIA_URL_FAILED', '图片校验准备失败');
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
  } catch (error) {
    throw new BusinessError('MEDIA_INSPECTION_FAILED', '无法校验图片大小，请重新上传');
  }
  const contentRange = response.headers.get('content-range') || '';
  const rangeMatch = contentRange.match(/\/(\d+)$/);
  const size = rangeMatch ? Number(rangeMatch[1]) : Number(response.headers.get('content-length'));
  if (response.body && response.body.cancel) await response.body.cancel();
  assert(response.ok && Number.isFinite(size) && size > 0, 'MEDIA_INSPECTION_FAILED', '无法校验图片大小，请重新上传');
  return { url: url, size: size };
}

function userId(openid) {
  return 'u_' + hash(openid, 32);
}

function publicAccount(user) {
  return {
    _id: user._id,
    nickName: user.nickName || '',
    avatarAssetId: user.avatarAssetId || '',
    status: user.status || 'active',
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null
  };
}

function publicFamily(family, currentRole) {
  const sharedAt = family.sharedAt || family.onboardingSharedAt || null;
  const familyMembership = commerce.entitlementFromFamily(family);
  return {
    _id: family._id,
    name: family.name || '',
    description: family.description || '',
    status: family.status || 'active',
    personCount: family.personCount || 0,
    relationCount: family.relationCount || 0,
    adminCount: family.adminCount || 0,
    archivedAt: family.archivedAt || null,
    purgeAt: family.purgeAt || null,
    createdAt: family.createdAt || null,
    updatedAt: family.updatedAt || null,
    currentRole: currentRole || '',
    membership: {
      active: familyMembership.active,
      lifetime: familyMembership.lifetime,
      expiresAt: familyMembership.expiresAt,
      plan: familyMembership.plan
    },
    sharedAt: sharedAt,
    shareReminderDismissedAt: family.shareReminderDismissedAt || null
  };
}

function publicPerson(person) {
  return {
    _id: person._id,
    familyId: person.familyId,
    name: person.name || '',
    gender: person.gender || 'unknown',
    lifeStatus: person.lifeStatus || 'unknown',
    birthDate: person.birthDate || '',
    deathDate: person.deathDate || '',
    birthPlace: person.birthPlace || '',
    bio: person.bio || '',
    avatarAssetId: person.avatarAssetId || '',
    createdAt: person.createdAt || null,
    updatedAt: person.updatedAt || null
  };
}

function profileMissingFields(person) {
  const fields = [];
  if (!person.gender || person.gender === 'unknown') fields.push('gender');
  if (!person.birthDate) fields.push('birthDate');
  if (!person.avatarAssetId) fields.push('avatar');
  if (!person.bio && !person.birthPlace) fields.push('story');
  return fields;
}

function publicChangeRequest(item) {
  return {
    _id: item._id,
    familyId: item.familyId,
    type: item.type,
    title: item.title || '家庭资料修改',
    requesterName: item.requesterName || '家人',
    status: item.status,
    reviewNote: item.reviewNote || '',
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null
  };
}

function membershipId(familyId, openid) {
  return 'fm_' + hash(familyId + ':' + openid, 32);
}

function preferenceId(familyId, openid) {
  return 'fp_' + hash(familyId + ':' + openid, 32);
}

function relationId(familyId, type, firstId, secondId) {
  const pair = domain.canonicalPair(type, firstId, secondId);
  const fromId = pair[0];
  const toId = pair[1];
  return 'r_' + hash([familyId, type, fromId, toId].join(':'), 40);
}

function idempotencyId(openid, type, requestId) {
  return 'idem_' + hash([openid, type, requestId].join(':'), 40);
}

async function enforceRateLimit(openid, action) {
  const policy = RATE_LIMITS[action];
  if (!policy) return;
  const windowStart = Math.floor(Date.now() / policy.windowMs) * policy.windowMs;
  const id = 'rate_' + hash([openid, action, windowStart].join(':'), 40);
  await db.runTransaction(async function (transaction) {
    const current = await maybeGet(transaction, 'rate_limits', id);
    assert(!current || Number(current.count || 0) < policy.max, 'RATE_LIMITED', '操作过于频繁，请稍后再试');
    if (current) {
      await transaction.collection('rate_limits').doc(id).update({
        data: { count: _.inc(1), updatedAt: db.serverDate() }
      });
    } else {
      await transaction.collection('rate_limits').doc(id).set({
        data: {
          actorId: userId(openid),
          action: action,
          count: 1,
          expiresAt: new Date(windowStart + policy.windowMs + 60 * 60 * 1000),
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
  });
}

function getOpenid() {
  const context = cloud.getWXContext();
  assert(context && context.OPENID, 'UNAUTHENTICATED', '请重新打开小程序后再试');
  return context.OPENID;
}

async function maybeGet(scope, collectionName, id) {
  try {
    const result = await scope.collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (error) {
    return null;
  }
}

async function mustGet(scope, collectionName, id, code, message) {
  const document = await maybeGet(scope, collectionName, id);
  assert(document, code || 'NOT_FOUND', message || '记录不存在');
  return document;
}

async function listAll(collectionName, where, limit, scope) {
  const database = scope || db;
  const hardLimit = limit || 1000;
  let offset = 0;
  let rows = [];
  while (rows.length <= hardLimit) {
    let query = database.collection(collectionName);
    if (where) query = query.where(where);
    const result = await query.skip(offset).limit(100).get();
    const page = result.data || [];
    rows = rows.concat(page);
    if (rows.length > hardLimit) {
      throw new BusinessError('RESULT_LIMIT_EXCEEDED', '数据量超过当前版本支持范围，请联系管理员', {
        collection: collectionName,
        limit: hardLimit
      });
    }
    if (page.length < 100) return rows;
    offset += page.length;
  }
  throw new BusinessError('RESULT_LIMIT_EXCEEDED', '数据量超过当前版本支持范围，请联系管理员', {
    collection: collectionName,
    limit: hardLimit
  });
}

async function listPage(collectionName, where, event, allowedSortFields) {
  const size = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  const cursor = cleanText(event.cursor, 80);
  let conditions = where || {};
  if (cursor) conditions = Object.assign({}, conditions, { _id: _.gt(cursor) });
  const result = await db.collection(collectionName)
    .where(conditions)
    .orderBy('_id', 'asc')
    .limit(size + 1)
    .get();
  const rows = result.data || [];
  const hasMore = rows.length > size;
  const items = rows.slice(0, size);
  return {
    items: items,
    nextCursor: hasMore && items.length ? items[items.length - 1]._id : '',
    hasMore: hasMore
  };
}

async function ensureUser(openid, scope) {
  const database = scope || db;
  const id = userId(openid);
  const existing = await maybeGet(database, 'users', id);
  if (existing) return existing;
  const user = {
    _id: id,
    openid: openid,
    nickName: '',
    avatarAssetId: '',
    status: 'active',
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  };
  await database.collection('users').doc(id).set({ data: documentData(user) });
  return user;
}

async function requireActiveUser(openid) {
  const user = await ensureUser(openid);
  if (user.status === 'pending_delete') {
    throw new BusinessError('ACCOUNT_PENDING_DELETE', '账户正在注销冷静期内', {
      deletionRequestedAt: user.deletionRequestedAt || null,
      deletionExecuteAt: user.deletionExecuteAt || null
    });
  }
  assert(user.status !== 'frozen', 'ACCOUNT_FROZEN', '账户暂时无法使用，请联系微信客服');
  assert(user.status === 'active', 'ACCOUNT_UNAVAILABLE', '账户当前不可用');
  return user;
}

async function getFamily(scope, familyId, options) {
  const family = await mustGet(scope || db, 'families', familyId, 'FAMILY_NOT_FOUND', '家谱不存在或已删除');
  const allowArchived = options && options.allowArchived;
  assert(family.status !== 'frozen', 'FAMILY_FROZEN', '该家谱暂时无法访问');
  assert(allowArchived || family.status === 'active', 'FAMILY_ARCHIVED', '该家谱已归档');
  return family;
}

async function getMembership(scope, familyId, openid) {
  const membership = await maybeGet(scope || db, 'family_memberships', membershipId(familyId, openid));
  if (!membership || membership.status !== 'active') return null;
  return membership;
}

async function requireMembership(familyId, roles, scope, openidOverride, options) {
  const openid = openidOverride || getOpenid();
  const family = await getFamily(scope || db, familyId, options);
  const membership = await getMembership(scope || db, familyId, openid);
  assert(membership, 'NO_FAMILY_ACCESS', '你还不是这个家谱的成员');
  if (roles && roles.length) {
    assert(domain.roleAllows(membership.role, roles), 'NO_PERMISSION', '当前身份不能执行这个操作');
  }
  return { openid: openid, membership: membership, family: family };
}

function normalizePerson(input) {
  const source = input || {};
  const name = cleanText(source.name, 30);
  assert(name, 'PERSON_NAME_REQUIRED', '请填写成员姓名');
  return {
    name: name,
    gender: cleanGender(source.gender),
    birthDate: cleanDate(source.birthDate),
    birthPlace: cleanText(source.birthPlace, 80),
    avatarAssetId: cleanText(source.avatarAssetId || source.avatar, 80),
    bio: cleanText(source.bio, 500),
    lifeStatus: cleanLifeStatus(source.lifeStatus)
  };
}

function normalizePersonChanges(input) {
  const source = input || {};
  const result = {};
  if (source.name !== undefined) {
    result.name = cleanText(source.name, 30);
    assert(result.name, 'PERSON_NAME_REQUIRED', '成员姓名不能为空');
  }
  if (source.gender !== undefined) result.gender = cleanGender(source.gender);
  if (source.birthDate !== undefined) result.birthDate = cleanDate(source.birthDate);
  if (source.birthPlace !== undefined) result.birthPlace = cleanText(source.birthPlace, 80);
  if (source.avatarAssetId !== undefined || source.avatar !== undefined) {
    result.avatarAssetId = cleanText(source.avatarAssetId || source.avatar, 80);
  }
  if (source.bio !== undefined) result.bio = cleanText(source.bio, 500);
  if (source.lifeStatus !== undefined) result.lifeStatus = cleanLifeStatus(source.lifeStatus);
  return result;
}

async function requireOwnedMedia(assetId, openid, familyId, kind) {
  const id = cleanText(assetId, 80);
  if (!id) return null;
  const asset = await mustGet(db, 'media_assets', id, 'MEDIA_NOT_FOUND', '图片上传记录不存在');
  assert(asset.ownerId === userId(openid), 'NO_PERMISSION', '不能使用其他用户上传的图片');
  assert((asset.familyId || '') === (familyId || ''), 'INVALID_MEDIA_SCOPE', '图片不属于当前家谱');
  if (kind) assert(asset.kind === kind, 'INVALID_MEDIA_KIND', '图片用途不正确');
  assert(asset.fileId && ['pending', 'approved', 'review'].includes(asset.moderationStatus), 'MEDIA_NOT_READY', '图片尚未完成上传');
  return asset;
}

async function moderateText(openid, values) {
  const content = values.map(function (item) { return cleanText(item, 500); }).filter(Boolean).join('\n').slice(0, 2500);
  if (!content || process.env.CONTENT_MODERATION_MODE === 'off') return { suggest: 'pass' };
  const contentHash = hash(content, 48);
  const taskId = 'mt_text_' + contentHash;
  const priorTask = await maybeGet(db, 'moderation_tasks', taskId);
  if (priorTask && priorTask.status === 'approved') return { suggest: 'pass', reviewed: true };
  if (priorTask && priorTask.status === 'rejected') {
    throw new BusinessError('CONTENT_NOT_ALLOWED', '内容未通过人工复核，请修改后再提交');
  }
  if (priorTask && priorTask.status === 'review') {
    throw new BusinessError('CONTENT_PENDING_REVIEW', '内容正在人工复核，请稍后用相同内容重试');
  }
  try {
    const result = await cloud.openapi.security.msgSecCheck({
      openid: openid,
      scene: 2,
      version: 2,
      content: content
    });
    const decision = result && result.result ? result.result.suggest : 'review';
    if (decision !== 'pass') {
      const status = decision === 'risky' ? 'rejected' : 'review';
      await db.collection('moderation_tasks').doc(taskId).set({
        data: {
          type: 'text',
          content: content,
          contentHash: contentHash,
          requestedBy: userId(openid),
          status: status,
          machineDecision: decision,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      throw new BusinessError(
        decision === 'risky' ? 'CONTENT_NOT_ALLOWED' : 'CONTENT_PENDING_REVIEW',
        decision === 'risky' ? '内容包含不适合发布的信息' : '内容已进入人工复核，请稍后用相同内容重试'
      );
    }
    return { suggest: decision };
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    if (process.env.CONTENT_MODERATION_MODE === 'strict') {
      throw new BusinessError('CONTENT_REVIEW_UNAVAILABLE', '内容安全检查暂时不可用，请稍后重试');
    }
    return { suggest: 'review' };
  }
}

async function audit(scope, data) {
  await scope.collection('audit_logs').add({
    data: {
      familyId: data.familyId || '',
      actorId: userId(data.openid),
      actorName: cleanText(data.actorName, 30) || '一位家人',
      actorType: 'user',
      action: data.action,
      objectType: data.objectType || '',
      objectId: data.objectId || '',
      summary: cleanText(data.summary, 120),
      requestId: cleanText(data.requestId, 80),
      createdAt: db.serverDate()
    }
  });
}

async function mutate(type, event, openid, handler) {
  const requestId = cleanText(event.requestId, 80);
  assert(requestId, 'REQUEST_ID_REQUIRED', '请求缺少幂等标识，请刷新页面后重试');
  const recordId = idempotencyId(openid, type, requestId);
  return db.runTransaction(async function (transaction) {
    const actor = await maybeGet(transaction, 'users', userId(openid));
    const allowedActorStatuses = ['account.cancelDeletion'].includes(type)
      ? ['pending_delete']
      : ['account.export', 'account.exportUrl'].includes(type)
        ? ['active', 'pending_delete']
        : ['active'];
    assert(actor && allowedActorStatuses.includes(actor.status), 'ACCOUNT_UNAVAILABLE', '账户当前无法执行此操作');
    const existing = await maybeGet(transaction, 'idempotency_records', recordId);
    if (existing && existing.status === 'completed') return existing.result || {};
    assert(!existing || existing.status === 'failed', 'REQUEST_IN_PROGRESS', '操作正在处理中，请勿重复提交');
    await transaction.collection('idempotency_records').doc(recordId).set({
      data: {
        actorId: userId(openid),
        action: type,
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
        updatedAt: db.serverDate(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });
    return result || {};
  });
}

async function createPersonTx(transaction, familyId, input, openid) {
  const normalized = normalizePerson(input);
  const id = 'p_' + randomToken(18);
  await transaction.collection('persons').doc(id).set({
    data: Object.assign({}, normalized, {
      familyId: familyId,
      status: 'active',
      createdBy: userId(openid),
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    })
  });
  return Object.assign({ _id: id }, normalized, { familyId: familyId, status: 'active' });
}

async function createRelationTx(transaction, familyId, type, firstId, secondId, openid, options) {
  assert(firstId && secondId && firstId !== secondId, 'INVALID_RELATION', '不能把成员与自己建立关系');
  assert(['parent_child', 'spouse'].includes(type), 'INVALID_RELATION', '暂不支持这种亲属关系');
  const personsById = options && options.personsById ? options.personsById : {};
  const first = personsById[firstId] || await mustGet(transaction, 'persons', firstId, 'PERSON_NOT_FOUND', '关系中的成员不存在');
  const second = personsById[secondId] || await mustGet(transaction, 'persons', secondId, 'PERSON_NOT_FOUND', '关系中的成员不存在');
  assert(first.familyId === familyId && second.familyId === familyId, 'CROSS_FAMILY_RELATION', '不能关联其他家谱的成员');
  assert(first.status === 'active' && second.status === 'active', 'PERSON_NOT_FOUND', '关系中的成员已删除');
  let fromId = firstId;
  let toId = secondId;
  if (type === 'spouse' && fromId > toId) {
    fromId = secondId;
    toId = firstId;
  }
  const id = relationId(familyId, type, fromId, toId);
  const duplicate = await maybeGet(transaction, 'relations', id);
  assert(!duplicate || duplicate.status !== 'active', 'RELATION_EXISTS', '这条关系已经存在');
  if (type === 'parent_child' && options && options.relations) {
    assert(!domain.reachesTarget(toId, fromId, options.relations), 'RELATION_CYCLE', '这条关系会形成循环，无法保存');
  }
  const relation = {
    _id: id,
    familyId: familyId,
    type: type,
    fromPersonId: fromId,
    toPersonId: toId,
    status: 'active',
    createdBy: userId(openid),
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  };
  await transaction.collection('relations').doc(id).set({ data: documentData(relation) });
  return relation;
}

async function getSharedChildrenTx(transaction, familyId, anchorPersonId, childIds) {
  const children = [];
  for (const childId of cleanPersonIds(childIds, 30)) {
    const relation = await maybeGet(transaction, 'relations', relationId(familyId, 'parent_child', anchorPersonId, childId));
    assert(relation && relation.status === 'active', 'INVALID_SHARED_CHILD', '所选成员不是中心成员的子女');
    const child = await mustGet(transaction, 'persons', childId, 'PERSON_NOT_FOUND', '所选子女不存在');
    assert(child.familyId === familyId && child.status === 'active', 'CROSS_FAMILY_RELATION', '所选子女不属于当前家谱');
    children.push(child);
  }
  return children;
}

function existingRelationDefinition(anchorPersonId, relatedPersonId, relationType) {
  const definition = domain.relationDefinition(anchorPersonId, relatedPersonId, relationType);
  if (!definition) throw new BusinessError('INVALID_RELATION', '请选择与中心成员的关系');
  return definition;
}

function expectedRelationGender(relationType) {
  return relationType === 'father' || relationType === 'son'
    ? 'male'
    : relationType === 'mother' || relationType === 'daughter'
      ? 'female'
      : '';
}

function assertRelationGender(person, relationType) {
  const expected = expectedRelationGender(relationType);
  assert(!expected || person.gender === 'unknown' || person.gender === expected, 'RELATION_GENDER_CONFLICT', '所选成员的性别与关系称谓不一致');
}

async function createRelatedTx(transaction, familyId, anchorPersonId, relationType, personInput, openid, options) {
  const anchor = await mustGet(transaction, 'persons', anchorPersonId, 'PERSON_NOT_FOUND', '中心成员不存在');
  assert(anchor.familyId === familyId && anchor.status === 'active', 'CROSS_FAMILY_RELATION', '中心成员不属于当前家谱');
  const sharedChildren = relationType === 'spouse'
    ? await getSharedChildrenTx(transaction, familyId, anchorPersonId, options && options.sharedChildIds)
    : [];
  const prepared = Object.assign({}, personInput || {});
  if (relationType === 'father' || relationType === 'son') prepared.gender = 'male';
  if (relationType === 'mother' || relationType === 'daughter') prepared.gender = 'female';
  const person = await createPersonTx(transaction, familyId, prepared, openid);
  const personsById = {};
  personsById[anchor._id] = anchor;
  personsById[person._id] = person;
  if (relationType === 'father' || relationType === 'mother') {
    await createRelationTx(transaction, familyId, 'parent_child', person._id, anchorPersonId, openid, { personsById: personsById });
  } else if (relationType === 'son' || relationType === 'daughter') {
    await createRelationTx(transaction, familyId, 'parent_child', anchorPersonId, person._id, openid, { personsById: personsById });
  } else if (relationType === 'spouse') {
    await createRelationTx(transaction, familyId, 'spouse', anchorPersonId, person._id, openid, { personsById: personsById });
  } else {
    throw new BusinessError('INVALID_RELATION', '请选择与中心成员的关系');
  }
  for (const child of sharedChildren) {
    const childPeople = Object.assign({}, personsById);
    childPeople[child._id] = child;
    await createRelationTx(transaction, familyId, 'parent_child', person._id, child._id, openid, { personsById: childPeople });
  }
  return person;
}

async function linkExistingTx(transaction, familyId, anchorPersonId, relatedPersonId, relationType, sharedChildIds, openid, relations) {
  const anchor = await mustGet(transaction, 'persons', anchorPersonId, 'PERSON_NOT_FOUND', '中心成员不存在');
  const related = await mustGet(transaction, 'persons', relatedPersonId, 'PERSON_NOT_FOUND', '所选成员不存在');
  assert(anchor.familyId === familyId && related.familyId === familyId, 'CROSS_FAMILY_RELATION', '不能关联其他家谱的成员');
  assert(anchor.status === 'active' && related.status === 'active', 'PERSON_NOT_FOUND', '关系中的成员已删除');
  assertRelationGender(related, relationType);
  const expectedGender = expectedRelationGender(relationType);
  const definition = existingRelationDefinition(anchorPersonId, relatedPersonId, relationType);
  const peopleById = {};
  peopleById[anchor._id] = anchor;
  peopleById[related._id] = related;
  await createRelationTx(transaction, familyId, definition.type, definition.fromId, definition.toId, openid, {
    personsById: peopleById,
    relations: relations
  });
  let createdCount = 1;
  if (relationType === 'spouse') {
    const sharedChildren = await getSharedChildrenTx(transaction, familyId, anchorPersonId, sharedChildIds);
    for (const child of sharedChildren) {
      const existing = await maybeGet(transaction, 'relations', relationId(familyId, 'parent_child', relatedPersonId, child._id));
      if (existing && existing.status === 'active') continue;
      const childPeople = Object.assign({}, peopleById);
      childPeople[child._id] = child;
      await createRelationTx(transaction, familyId, 'parent_child', relatedPersonId, child._id, openid, {
        personsById: childPeople,
        relations: relations
      });
      createdCount += 1;
    }
  }
  if (expectedGender && related.gender === 'unknown') {
    await transaction.collection('persons').doc(related._id).update({
      data: { gender: expectedGender, updatedAt: db.serverDate() }
    });
    related.gender = expectedGender;
  }
  return { person: related, relationCount: createdCount };
}

async function authLogin() {
  const openid = getOpenid();
  const user = await ensureUser(openid);
  let deletion = null;
  if (user.status === 'pending_delete') {
    deletion = await maybeGet(db, 'account_deletion_requests', 'del_' + userId(openid));
  }
  return {
    user: publicAccount(user),
    accountState: user.status,
    deletion: deletion
  };
}

async function authUpdateProfile(event) {
  const openid = getOpenid();
  const existingUser = await requireActiveUser(openid);
  const nickName = cleanText(event.nickName, 30);
  const hasAvatarUpdate = event.avatarAssetId !== undefined || event.avatarUrl !== undefined;
  const avatarAssetId = hasAvatarUpdate
    ? cleanText(event.avatarAssetId || event.avatarUrl, 80)
    : existingUser.avatarAssetId || '';
  if (hasAvatarUpdate) await requireOwnedMedia(avatarAssetId, openid, '', 'user_avatar');
  await moderateText(openid, [nickName]);
  return mutate('auth.updateProfile', event, openid, async function (transaction) {
    const user = await ensureUser(openid, transaction);
    const update = {
      nickName: nickName,
      avatarAssetId: avatarAssetId,
      updatedAt: db.serverDate()
    };
    await transaction.collection('users').doc(user._id).update({ data: update });
    const taskId = 'profile_' + user._id;
    await transaction.collection('profile_sync_tasks').doc(taskId).set({
      data: {
        userId: user._id,
        displayName: nickName || '家人',
        avatarAssetId: update.avatarAssetId,
        status: 'pending',
        updatedAt: db.serverDate()
      }
    });
    return { user: publicAccount(Object.assign({}, user, update)) };
  });
}

async function authUpdateAvatar(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const avatarAssetId = cleanText(event.avatarAssetId, 80);
  assert(avatarAssetId, 'AVATAR_REQUIRED', '请选择需要保存的头像');
  const asset = await requireOwnedMedia(avatarAssetId, openid, '', 'user_avatar');
  return mutate('auth.updateAvatar', event, openid, async function (transaction) {
    const user = await ensureUser(openid, transaction);
    const update = { avatarAssetId: avatarAssetId, updatedAt: db.serverDate() };
    await transaction.collection('users').doc(user._id).update({ data: update });
    await transaction.collection('profile_sync_tasks').doc('profile_' + user._id).set({
      data: {
        userId: user._id,
        displayName: user.nickName || '家人',
        avatarAssetId: avatarAssetId,
        status: 'pending',
        updatedAt: db.serverDate()
      }
    });
    return {
      user: publicAccount(Object.assign({}, user, update)),
      moderationStatus: asset.moderationStatus || 'pending'
    };
  });
}

async function accountExport(event) {
  const openid = getOpenid();
  const user = await ensureUser(openid);
  assert(['active', 'pending_delete'].includes(user.status), 'ACCOUNT_UNAVAILABLE', '账户当前不可导出');
  return mutate('account.export', event, openid, async function (transaction) {
    const current = await ensureUser(openid, transaction);
    const taskId = 'exp_' + randomToken(18);
    await transaction.collection('export_tasks').doc(taskId).set({
      data: {
        userId: current._id,
        status: 'pending',
        requestedAt: db.serverDate(),
        expiresAt: null,
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      openid: openid,
      actorName: current.nickName,
      action: 'account.export_requested',
      objectType: 'export_task',
      objectId: taskId,
      summary: '申请导出个人信息',
      requestId: event.requestId
    });
    return { taskId: taskId, status: 'pending' };
  });
}

function publicExportTask(task) {
  return {
    taskId: task._id,
    status: task.status || 'pending',
    requestedAt: task.requestedAt || null,
    completedAt: task.completedAt || null,
    expiresAt: task.expiresAt || null,
    failureMessage: task.status === 'failed' ? cleanText(task.failureMessage, 120) : ''
  };
}

async function accountExportStatus(event) {
  const openid = getOpenid();
  const user = await ensureUser(openid);
  assert(['active', 'pending_delete'].includes(user.status), 'ACCOUNT_UNAVAILABLE', '账户当前不可查询导出状态');
  const taskId = cleanText(event.taskId, 80);
  assert(taskId, 'EXPORT_TASK_REQUIRED', '缺少导出任务信息');
  const task = await mustGet(db, 'export_tasks', taskId, 'EXPORT_TASK_NOT_FOUND', '导出任务不存在');
  assert(task.userId === user._id, 'NO_PERMISSION', '不能查看其他用户的导出任务');
  return publicExportTask(task);
}

async function accountExportUrl(event) {
  const openid = getOpenid();
  const user = await ensureUser(openid);
  assert(['active', 'pending_delete'].includes(user.status), 'ACCOUNT_UNAVAILABLE', '账户当前不可获取导出文件');
  const taskId = cleanText(event.taskId, 80);
  assert(taskId, 'EXPORT_TASK_REQUIRED', '缺少导出任务信息');
  const task = await mustGet(db, 'export_tasks', taskId, 'EXPORT_TASK_NOT_FOUND', '导出任务不存在');
  assert(task.userId === user._id, 'NO_PERMISSION', '不能获取其他用户的导出文件');
  assert(task.status === 'completed' && task.fileId && task.expiresAt && new Date(task.expiresAt).getTime() > Date.now(), 'EXPORT_NOT_READY', '导出文件暂不可用');
  const tempResult = await cloud.getTempFileURL({ fileList: [task.fileId] });
  const url = tempResult.fileList && tempResult.fileList[0] && tempResult.fileList[0].tempFileURL;
  assert(url, 'EXPORT_URL_FAILED', '导出文件链接生成失败，请稍后重试');
  return mutate('account.exportUrl', event, openid, async function (transaction) {
    const current = await mustGet(transaction, 'export_tasks', taskId, 'EXPORT_TASK_NOT_FOUND', '导出任务不存在');
    assert(current.userId === user._id, 'NO_PERMISSION', '不能获取其他用户的导出文件');
    assert(current.status === 'completed' && !current.downloadIssuedAt, 'EXPORT_LINK_ALREADY_ISSUED', '导出链接已生成，请重新申请导出');
    await transaction.collection('export_tasks').doc(taskId).update({
      data: { status: 'download_issued', downloadIssuedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    return { url: url, expiresAt: current.expiresAt || null };
  });
}

async function accountRequestDeletion(event) {
  const openid = getOpenid();
  const activeUser = await requireActiveUser(openid);
  const adminMemberships = await listAll('family_memberships', {
    userId: activeUser._id,
    role: 'admin',
    status: 'active'
  }, 40);
  for (const membership of adminMemberships) {
    const family = await maybeGet(db, 'families', membership.familyId);
    if (family && family.status === 'active' && Number(family.adminCount || 1) <= 1) {
      throw new BusinessError('LAST_ADMIN', '请先转让“' + cleanText(family.name, 30) + '”的管理员或归档家谱，再申请注销', {
        familyId: family._id,
        familyName: cleanText(family.name, 30),
        remediation: 'transfer_or_archive'
      });
    }
  }
  return mutate('account.requestDeletion', event, openid, async function (transaction) {
    const user = await ensureUser(openid, transaction);
    for (const membershipSnapshot of adminMemberships) {
      const membership = await mustGet(transaction, 'family_memberships', membershipSnapshot._id, 'MEMBERSHIP_NOT_FOUND', '家庭身份发生变化，请重试');
      if (membership.status !== 'active' || membership.role !== 'admin') continue;
      const family = await mustGet(transaction, 'families', membership.familyId, 'FAMILY_NOT_FOUND', '家谱状态发生变化，请重试');
      assert(family.status !== 'active' || Number(family.adminCount || 1) > 1, 'LAST_ADMIN', '请先转让“' + cleanText(family.name, 30) + '”的管理员或归档家谱，再申请注销', {
        familyId: family._id,
        familyName: cleanText(family.name, 30),
        remediation: 'transfer_or_archive'
      });
    }
    const executeAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const id = 'del_' + user._id;
    const record = {
      _id: id,
      userId: user._id,
      status: 'pending',
      requestedAt: db.serverDate(),
      executeAt: executeAt,
      completedAt: null,
      retryCount: 0,
      updatedAt: db.serverDate()
    };
    await transaction.collection('account_deletion_requests').doc(id).set({ data: documentData(record) });
    await transaction.collection('users').doc(user._id).update({
      data: {
        status: 'pending_delete',
        deletionRequestedAt: db.serverDate(),
        deletionExecuteAt: executeAt,
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      openid: openid,
      actorName: user.nickName,
      action: 'account.deletion_requested',
      objectType: 'user',
      objectId: user._id,
      summary: '申请注销账户',
      requestId: event.requestId
    });
    return { status: 'pending', executeAt: executeAt };
  });
}

async function accountCancelDeletion(event) {
  const openid = getOpenid();
  const user = await ensureUser(openid);
  assert(user.status === 'pending_delete', 'NO_PENDING_DELETION', '当前没有待处理的注销申请');
  return mutate('account.cancelDeletion', event, openid, async function (transaction) {
    const current = await ensureUser(openid, transaction);
    const request = await mustGet(transaction, 'account_deletion_requests', 'del_' + current._id, 'NO_PENDING_DELETION', '注销申请不存在');
    assert(request.status === 'pending', 'DELETION_ALREADY_PROCESSING', '注销已开始执行，无法撤销');
    await transaction.collection('account_deletion_requests').doc(request._id).update({
      data: { status: 'cancelled', cancelledAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await transaction.collection('users').doc(current._id).update({
      data: {
        status: 'active',
        deletionRequestedAt: _.remove(),
        deletionExecuteAt: _.remove(),
        updatedAt: db.serverDate()
      }
    });
    return { status: 'cancelled' };
  });
}

async function familyCreate(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const name = cleanText(event.name, 40);
  const description = cleanText(event.description, 200);
  const shareSource = event.source === 'share_menu' ? 'share_menu' : '';
  const firstPerson = normalizePerson(event.startPerson || {});
  assert(name, 'FAMILY_NAME_REQUIRED', '请填写家谱名称');
  await requireOwnedMedia(firstPerson.avatarAssetId, openid, '', 'person_avatar');
  const relativeInput = event.relatives || {};
  await moderateText(openid, [
    name,
    description,
    firstPerson.name,
    firstPerson.bio,
    relativeInput.fatherName,
    relativeInput.motherName,
    relativeInput.spouseName
  ]);
  return mutate('family.create', event, openid, async function (transaction) {
    const result = await transaction.collection('families').add({
      data: {
        name: name,
        description: description,
        creatorId: user._id,
        status: 'active',
        privacy: 'private',
        schemaVersion: 3,
        personCount: 1,
        relationCount: 0,
        relationRevision: 0,
        adminCount: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    const familyId = result._id;
    const memberId = membershipId(familyId, openid);
    await transaction.collection('family_memberships').doc(memberId).set({
      data: {
        familyId: familyId,
        userId: user._id,
        role: 'admin',
        displayName: user.nickName || '创建者',
        avatarAssetId: user.avatarAssetId || '',
        status: 'active',
        joinedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    const startPerson = await createPersonTx(transaction, familyId, firstPerson, openid);
    if (firstPerson.avatarAssetId) {
      await transaction.collection('media_assets').doc(firstPerson.avatarAssetId).update({
        data: { familyId: familyId, updatedAt: db.serverDate() }
      });
    }
    let personCount = 1;
    let relationCount = 0;
    const relatives = event.relatives || {};
    const definitions = [
      ['father', relatives.fatherName],
      ['mother', relatives.motherName],
      ['spouse', relatives.spouseName]
    ];
    for (const definition of definitions) {
      if (!cleanText(definition[1], 30)) continue;
      await createRelatedTx(transaction, familyId, startPerson._id, definition[0], { name: definition[1] }, openid);
      personCount += 1;
      relationCount += 1;
    }
    await transaction.collection('families').doc(familyId).update({
      data: {
        personCount: personCount,
        relationCount: relationCount,
        relationRevision: relationCount,
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: familyId,
      openid: openid,
      actorName: user.nickName,
      action: 'family.create',
      objectType: 'family',
      objectId: familyId,
      summary: '创建家谱',
      requestId: event.requestId
    });
    if (shareSource === 'share_menu') await incrementShareMetric(transaction, 'discovery', 'converted');
    return {
      family: { _id: familyId, name: name, description: description, status: 'active', currentRole: 'admin' },
      startPersonId: startPerson._id
    };
  });
}

async function familyList(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const page = await listPage('family_memberships', { userId: user._id, status: 'active' }, event, ['joinedAt']);
  const familyIds = Array.from(new Set(page.items.map(function (membership) { return membership.familyId; }).filter(Boolean)));
  const familyResult = familyIds.length
    ? await db.collection('families').where({ _id: _.in(familyIds) }).limit(familyIds.length).get()
    : { data: [] };
  const familiesById = new Map((familyResult.data || []).map(function (family) { return [family._id, family]; }));
  const families = [];
  for (const membership of page.items) {
    const family = familiesById.get(membership.familyId);
    if (!family || !['active', 'archived'].includes(family.status)) continue;
    if (!event.includeArchived && family.status !== 'active') continue;
    families.push(publicFamily(family, membership.role));
  }
  return { families: families, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

async function familyUpdate(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const name = cleanText(event.name, 40);
  const description = cleanText(event.description, 200);
  assert(name, 'FAMILY_NAME_REQUIRED', '请填写家谱名称');
  await moderateText(openid, [name, description]);
  return mutate('family.update', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ['admin'], transaction, openid);
    await transaction.collection('families').doc(event.familyId).update({
      data: { name: name, description: description, updatedAt: db.serverDate() }
    });
    await audit(transaction, {
      familyId: event.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'family.update',
      objectType: 'family',
      objectId: event.familyId,
      summary: '更新家谱资料',
      requestId: event.requestId
    });
    return { family: publicFamily(await getFamily(transaction, event.familyId), 'admin') };
  });
}

async function familyArchive(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return mutate('family.archive', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ['admin'], transaction, openid);
    const purgeAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await transaction.collection('families').doc(event.familyId).update({
      data: { status: 'archived', archivedAt: db.serverDate(), purgeAt: purgeAt, updatedAt: db.serverDate() }
    });
    await audit(transaction, {
      familyId: event.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'family.archive',
      objectType: 'family',
      objectId: event.familyId,
      summary: '归档家谱',
      requestId: event.requestId
    });
    return { archived: true, purgeAt: purgeAt };
  });
}

async function familyRestore(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return mutate('family.restore', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ['admin'], transaction, openid, { allowArchived: true });
    const family = await getFamily(transaction, event.familyId, { allowArchived: true });
    assert(family.status === 'archived', 'FAMILY_NOT_ARCHIVED', '该家谱不在回收站');
    await transaction.collection('families').doc(event.familyId).update({
      data: { status: 'active', restoredAt: db.serverDate(), purgeAt: _.remove(), updatedAt: db.serverDate() }
    });
    await audit(transaction, {
      familyId: event.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'family.restore',
      objectType: 'family',
      objectId: event.familyId,
      summary: '恢复家谱',
      requestId: event.requestId
    });
    return { restored: true };
  });
}

async function familySetPreference(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return mutate('family.setPreference', event, openid, async function (transaction) {
    await requireMembership(event.familyId, ACTIVE_ROLES, transaction, openid);
    const id = preferenceId(event.familyId, openid);
    await transaction.collection('user_family_preferences').doc(id).set({
      data: {
        familyId: event.familyId,
        userId: userId(openid),
        viewMode: event.viewMode === 'perspective' ? 'perspective' : 'full',
        lastViewPersonId: cleanText(event.personId, 80),
        nameLayout: event.nameLayout === 'vertical' ? 'vertical' : 'horizontal',
        updatedAt: db.serverDate()
      }
    });
    return { saved: true };
  });
}

async function graphGet(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const access = await requireMembership(event.familyId, ACTIVE_ROLES, db, openid);
  const family = access.family;
  const preference = await maybeGet(db, 'user_family_preferences', preferenceId(event.familyId, openid));
  const persons = await listAll('persons', { familyId: event.familyId, status: 'active' }, GRAPH_PERSON_LIMIT);
  const relations = await listAll('relations', { familyId: event.familyId, status: 'active' }, GRAPH_RELATION_LIMIT);
  const personIds = new Set(persons.map(function (person) { return person._id; }));
  const visibleRelations = relations.filter(function (relation) {
    return personIds.has(relation.fromPersonId) && personIds.has(relation.toPersonId);
  });
  const compactPersons = persons.map(function (person) {
    return {
      _id: person._id,
      name: person.name,
      gender: person.gender,
      lifeStatus: person.lifeStatus,
      birthDate: person.birthDate || '',
      avatarAssetId: person.avatarAssetId || '',
      profileMissingFields: profileMissingFields(person)
    };
  });
  return {
    family: publicFamily(family, access.membership.role),
    persons: compactPersons,
    relations: visibleRelations.map(function (relation) {
      return {
        _id: relation._id,
        type: relation.type,
        fromPersonId: relation.fromPersonId,
        toPersonId: relation.toPersonId
      };
    }),
    preference: {
      nameLayout: preference && preference.nameLayout === 'vertical' ? 'vertical' : 'horizontal'
    },
    currentRole: access.membership.role
  };
}

async function familyDashboard(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const access = await requireMembership(event.familyId, ACTIVE_ROLES, db, openid);
  const family = access.family;
  const memberships = await listAll('family_memberships', { familyId: event.familyId, status: 'active' }, 500);
  const persons = await listAll('persons', { familyId: event.familyId, status: 'active' }, GRAPH_PERSON_LIMIT);
  const completedFields = persons.reduce(function (total, person) {
    return total
      + (person.name ? 1 : 0)
      + (person.gender && person.gender !== 'unknown' ? 1 : 0)
      + (person.birthDate ? 1 : 0)
      + (person.avatarAssetId ? 1 : 0)
      + (person.bio || person.birthPlace ? 1 : 0);
  }, 0);
  const completion = persons.length ? Math.round(completedFields / (persons.length * 5) * 100) : 0;
  const pendingWhere = access.membership.role === 'admin'
    ? { familyId: event.familyId, status: 'pending' }
    : { familyId: event.familyId, status: 'pending', createdBy: userId(openid) };
  const pending = await listAll('change_requests', pendingWhere, 500);
  const auditResult = await db.collection('audit_logs').where({ familyId: event.familyId }).orderBy('createdAt', 'desc').limit(20).get();
  return {
    family: publicFamily(family, access.membership.role),
    stats: {
      personCount: family.personCount || 0,
      relationCount: family.relationCount || 0,
      collaboratorCount: memberships.length,
      completion: completion,
      pendingCount: pending.length
    },
    onboarding: {
      isCreator: family.creatorId === userId(openid),
      sharedAt: family.sharedAt || family.onboardingSharedAt || null,
      shareReminderDismissedAt: family.shareReminderDismissedAt || null
    },
    collaborators: memberships.map(function (item) {
      return {
        _id: item._id,
        displayName: item.displayName || '家人',
        avatarAssetId: item.avatarAssetId || '',
        role: item.role,
        joinedAt: item.joinedAt
      };
    }),
    pendingChanges: pending.map(publicChangeRequest),
    recentActivities: (auditResult.data || []).map(function (item) {
      return { _id: item._id, action: item.action, summary: item.summary, createdAt: item.createdAt };
    })
  };
}

async function familyMarkOnboardingShared(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return mutate('family.markOnboardingShared', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ['admin'], transaction, openid);
    const family = access.family;
    const invitation = await mustGet(transaction, 'invitations', event.invitationId, 'INVITE_NOT_FOUND', '邀请不存在');
    assert(invitation.familyId === family._id && invitation.createdBy === userId(openid), 'INVALID_INVITATION', '邀请不属于当前管理员');
    await transaction.collection('families').doc(family._id).update({
      data: {
        sharedAt: family.sharedAt || family.onboardingSharedAt || db.serverDate(),
        // Keep the original field for old clients during the transition.
        onboardingSharedAt: family.onboardingSharedAt || db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: family._id,
      openid: openid,
      action: 'family.onboarding_shared',
      objectType: 'family',
      objectId: family._id,
      summary: '完成首次家庭邀请分享',
      requestId: event.requestId
    });
    return { shared: true };
  });
}

async function familyDismissShareReminder(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return mutate('family.dismissShareReminder', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ['admin'], transaction, openid);
    await transaction.collection('families').doc(event.familyId).update({
      data: {
        shareReminderDismissedAt: access.family.shareReminderDismissedAt || db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: event.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'family.share_reminder_dismiss',
      objectType: 'family',
      objectId: event.familyId,
      summary: '关闭家人邀请提醒',
      requestId: event.requestId
    });
    return { dismissed: true };
  });
}

async function membershipList(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  await requireMembership(event.familyId, ACTIVE_ROLES, db, openid);
  const page = await listPage('family_memberships', { familyId: event.familyId, status: 'active' }, event, ['joinedAt']);
  page.items = page.items.map(function (item) {
    return {
      _id: item._id,
      familyId: item.familyId,
      role: item.role,
      displayName: item.displayName || '家人',
      avatarAssetId: item.avatarAssetId || '',
      status: item.status,
      joinedAt: item.joinedAt || null
    };
  });
  return page;
}

async function membershipUpdateRole(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  assert(ACTIVE_ROLES.includes(event.role), 'INVALID_ROLE', '请选择有效的家庭角色');
  const role = event.role;
  return mutate('membership.updateRole', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ['admin'], transaction, openid);
    const target = await mustGet(transaction, 'family_memberships', event.membershipId, 'MEMBERSHIP_NOT_FOUND', '家庭成员不存在');
    assert(target.familyId === event.familyId && target.status === 'active', 'MEMBERSHIP_NOT_FOUND', '家庭成员不存在');
    let adminDelta = 0;
    if (target.role === 'admin' && role !== 'admin') {
      assert(Number(access.family.adminCount || 1) > 1, 'LAST_ADMIN', '请先转让管理员，再调整自己的角色');
      adminDelta = -1;
    } else if (target.role !== 'admin' && role === 'admin') {
      const targetUser = await mustGet(transaction, 'users', target.userId, 'USER_NOT_FOUND', '家庭成员账户不存在');
      assert(targetUser.status === 'active', 'TARGET_ACCOUNT_UNAVAILABLE', '该家庭成员账户当前不能成为管理员');
      adminDelta = 1;
    }
    await transaction.collection('family_memberships').doc(target._id).update({ data: { role: role, updatedAt: db.serverDate() } });
    if (adminDelta) {
      await transaction.collection('families').doc(event.familyId).update({
        data: { adminCount: _.inc(adminDelta), updatedAt: db.serverDate() }
      });
    }
    await audit(transaction, {
      familyId: event.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'membership.role_update',
      objectType: 'membership',
      objectId: target._id,
      summary: '调整家庭成员角色',
      requestId: event.requestId
    });
    return { membership: Object.assign({}, target, { role: role }) };
  });
}

async function membershipTransferAdmin(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return mutate('membership.transferAdmin', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ['admin'], transaction, openid);
    const target = await mustGet(transaction, 'family_memberships', event.membershipId, 'MEMBERSHIP_NOT_FOUND', '请选择要转让的家庭成员');
    assert(target.familyId === event.familyId && target.status === 'active', 'MEMBERSHIP_NOT_FOUND', '家庭成员不存在');
    assert(target._id !== access.membership._id, 'INVALID_TRANSFER', '请选择其他家庭成员');
    const targetUser = await mustGet(transaction, 'users', target.userId, 'USER_NOT_FOUND', '家庭成员账户不存在');
    assert(targetUser.status === 'active', 'TARGET_ACCOUNT_UNAVAILABLE', '该家庭成员账户当前不能成为管理员');
    const targetWasAdmin = target.role === 'admin';
    await transaction.collection('family_memberships').doc(target._id).update({ data: { role: 'admin', updatedAt: db.serverDate() } });
    if (event.keepAdmin !== true) {
      await transaction.collection('family_memberships').doc(access.membership._id).update({ data: { role: 'member', updatedAt: db.serverDate() } });
    }
    const adminDelta = (targetWasAdmin ? 0 : 1) - (event.keepAdmin === true ? 0 : 1);
    if (adminDelta) {
      await transaction.collection('families').doc(event.familyId).update({
        data: { adminCount: _.inc(adminDelta), updatedAt: db.serverDate() }
      });
    }
    await audit(transaction, {
      familyId: event.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'membership.transfer_admin',
      objectType: 'membership',
      objectId: target._id,
      summary: '转让家谱管理员',
      requestId: event.requestId
    });
    return { transferred: true, membershipId: target._id };
  });
}

async function membershipLeave(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return mutate('membership.leave', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ACTIVE_ROLES, transaction, openid, { allowArchived: true });
    if (access.membership.role === 'admin' && access.family.status === 'active') {
      assert(Number(access.family.adminCount || 1) > 1, 'LAST_ADMIN', '最后一名管理员不能退出，请先转让管理员或归档家谱');
    }
    await transaction.collection('family_memberships').doc(access.membership._id).update({
      data: { status: 'left', leftAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    if (access.membership.role === 'admin') {
      await transaction.collection('families').doc(event.familyId).update({
        data: { adminCount: _.inc(-1), updatedAt: db.serverDate() }
      });
    }
    await audit(transaction, {
      familyId: event.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'membership.leave',
      objectType: 'membership',
      objectId: access.membership._id,
      summary: '退出家谱',
      requestId: event.requestId
    });
    return { left: true };
  });
}

async function personGet(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const person = await mustGet(db, 'persons', event.personId, 'PERSON_NOT_FOUND', '成员不存在');
  const access = await requireMembership(person.familyId, ACTIVE_ROLES, db, openid);
  assert(person.status === 'active', 'PERSON_NOT_FOUND', '成员已删除');
  const relations = await listAll('relations', { familyId: person.familyId, status: 'active' }, GRAPH_RELATION_LIMIT);
  const direct = relations.filter(function (relation) {
    return relation.fromPersonId === person._id || relation.toPersonId === person._id;
  });
  const relatives = [];
  for (const relation of direct) {
    const relatedId = relation.fromPersonId === person._id ? relation.toPersonId : relation.fromPersonId;
    const related = await maybeGet(db, 'persons', relatedId);
    if (!related || related.status !== 'active') continue;
    let role = 'spouse';
    if (relation.type === 'parent_child') role = relation.toPersonId === person._id ? 'parent' : 'child';
    relatives.push({ relationId: relation._id, role: role, person: publicPerson(related) });
  }
  return { person: publicPerson(person), relatives: relatives, currentRole: access.membership.role };
}

async function personCreateRelated(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const person = normalizePerson(event.person || {});
  await requireOwnedMedia(person.avatarAssetId, openid, event.familyId, 'person_avatar');
  await moderateText(openid, [person.name, person.birthPlace, person.bio]);
  return mutate('person.createRelated', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ['admin', 'member'], transaction, openid);
    assert(Number(access.family.personCount || 0) < GRAPH_PERSON_LIMIT, 'FAMILY_PERSON_LIMIT', '单个家谱最多支持 500 人');
    const payload = {
      familyId: event.familyId,
      anchorPersonId: cleanText(event.anchorPersonId, 80),
      relationType: cleanText(event.relationType, 20),
      person: person,
      sharedChildIds: cleanPersonIds(event.sharedChildIds, 30)
    };
    if (access.membership.role === 'member') {
      const result = await transaction.collection('change_requests').add({
        data: {
          familyId: event.familyId,
          type: 'create_related',
          title: '添加家庭成员“' + person.name + '”',
          payload: payload,
          status: 'pending',
          createdBy: userId(openid),
          requesterName: access.membership.displayName || '家人',
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return { pending: true, requestId: result._id };
    }
    const created = await createRelatedTx(
      transaction,
      event.familyId,
      payload.anchorPersonId,
      payload.relationType,
      person,
      openid,
      { sharedChildIds: payload.sharedChildIds }
    );
    await transaction.collection('families').doc(event.familyId).update({
      data: {
        personCount: _.inc(1),
        relationCount: _.inc(1 + (payload.relationType === 'spouse' ? payload.sharedChildIds.length : 0)),
        relationRevision: _.inc(1),
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: event.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'person.create_related',
      objectType: 'person',
      objectId: created._id,
      summary: '添加家庭成员',
      requestId: event.requestId
    });
    return { pending: false, person: created };
  });
}

function relationTypeLabel(relationType) {
  return {
    father: '父亲',
    mother: '母亲',
    spouse: '伴侣',
    son: '儿子',
    daughter: '女儿'
  }[relationType] || '亲属';
}

async function relationLinkExisting(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const familyId = cleanText(event.familyId, 80);
  const anchorPersonId = cleanText(event.anchorPersonId, 80);
  const relatedPersonId = cleanText(event.relatedPersonId, 80);
  const relationType = cleanText(event.relationType, 20);
  const sharedChildIds = cleanPersonIds(event.sharedChildIds, 30);
  existingRelationDefinition(anchorPersonId, relatedPersonId, relationType);
  const snapshotAccess = await requireMembership(familyId, ['admin', 'member'], db, openid);
  const relations = await listAll('relations', { familyId: familyId, status: 'active' }, GRAPH_RELATION_LIMIT);
  const relationRevision = Number(snapshotAccess.family.relationRevision || 0);
  return mutate('relation.linkExisting', event, openid, async function (transaction) {
    const access = await requireMembership(familyId, ['admin', 'member'], transaction, openid);
    if (access.membership.role === 'member') {
      const anchor = await mustGet(transaction, 'persons', anchorPersonId, 'PERSON_NOT_FOUND', '中心成员不存在');
      const related = await mustGet(transaction, 'persons', relatedPersonId, 'PERSON_NOT_FOUND', '所选成员不存在');
      assert(anchor.familyId === familyId && related.familyId === familyId, 'CROSS_FAMILY_RELATION', '不能关联其他家谱的成员');
      assertRelationGender(related, relationType);
      const result = await transaction.collection('change_requests').add({
        data: {
          familyId: familyId,
          type: 'link_existing_relation',
          title: '将“' + related.name + '”关联为“' + anchor.name + '”的' + relationTypeLabel(relationType),
          payload: {
            anchorPersonId: anchorPersonId,
            relatedPersonId: relatedPersonId,
            relationType: relationType,
            sharedChildIds: sharedChildIds
          },
          status: 'pending',
          createdBy: userId(openid),
          requesterName: access.membership.displayName || '家人',
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return { pending: true, requestId: result._id, person: publicPerson(related) };
    }
    assert(Number(access.family.relationRevision || 0) === relationRevision, 'GRAPH_CHANGED', '家谱关系刚刚发生变化，请重试');
    const linked = await linkExistingTx(
      transaction,
      familyId,
      anchorPersonId,
      relatedPersonId,
      relationType,
      sharedChildIds,
      openid,
      relations
    );
    await transaction.collection('families').doc(familyId).update({
      data: {
        relationCount: _.inc(linked.relationCount),
        relationRevision: _.inc(1),
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'relation.link_existing',
      objectType: 'person',
      objectId: linked.person._id,
      summary: '关联已有家庭成员',
      requestId: event.requestId
    });
    return { pending: false, person: publicPerson(linked.person), relationCount: linked.relationCount };
  });
}

async function relationRemove(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const relationIdValue = cleanText(event.relationId, 80);
  assert(relationIdValue, 'RELATION_NOT_FOUND', '关系不存在或已被移除');
  const snapshotRelation = await mustGet(db, 'relations', relationIdValue, 'RELATION_NOT_FOUND', '关系不存在或已被移除');
  const snapshotAccess = await requireMembership(snapshotRelation.familyId, ['admin'], db, openid);
  const relations = await listAll('relations', { familyId: snapshotRelation.familyId, status: 'active' }, GRAPH_RELATION_LIMIT);
  const relationRevision = Number(snapshotAccess.family.relationRevision || 0);
  const canRemove = domain.hasAlternateConnection(
    snapshotRelation.fromPersonId,
    snapshotRelation.toPersonId,
    snapshotRelation._id,
    relations
  );
  return mutate('relation.remove', event, openid, async function (transaction) {
    const relation = await mustGet(transaction, 'relations', relationIdValue, 'RELATION_NOT_FOUND', '关系不存在或已被移除');
    const access = await requireMembership(relation.familyId, ['admin'], transaction, openid);
    assert(relation.status === 'active', 'RELATION_NOT_FOUND', '关系不存在或已被移除');
    assert(relation.familyId === snapshotRelation.familyId, 'CROSS_FAMILY_RELATION', '关系不属于当前家谱');
    assert(Number(access.family.relationRevision || 0) === relationRevision, 'GRAPH_CHANGED', '家谱关系刚刚发生变化，请重试');
    assert(canRemove, 'RELATION_DISCONNECTS_GRAPH', '移除后会使家谱关系断开，请先建立正确关系，再移除当前关系');
    await transaction.collection('relations').doc(relation._id).update({
      data: { status: 'deleted', deletedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await transaction.collection('families').doc(relation.familyId).update({
      data: {
        relationCount: _.inc(-1),
        relationRevision: _.inc(1),
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: relation.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'relation.remove',
      objectType: 'relation',
      objectId: relation._id,
      summary: '移除家庭成员关系',
      requestId: event.requestId
    });
    return { removed: true, relationId: relation._id };
  });
}

async function personUpdate(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const changes = normalizePersonChanges(event.data || {});
  assert(Object.keys(changes).length, 'NO_CHANGES', '没有需要保存的修改');
  const snapshot = await mustGet(db, 'persons', event.personId, 'PERSON_NOT_FOUND', '成员不存在');
  await requireMembership(snapshot.familyId, ['admin', 'member'], db, openid);
  if (changes.avatarAssetId) {
    await requireOwnedMedia(changes.avatarAssetId, openid, snapshot.familyId, 'person_avatar');
  }
  await moderateText(openid, [changes.name, changes.birthPlace, changes.bio]);
  return mutate('person.update', event, openid, async function (transaction) {
    const person = await mustGet(transaction, 'persons', event.personId, 'PERSON_NOT_FOUND', '成员不存在');
    const access = await requireMembership(person.familyId, ['admin', 'member'], transaction, openid);
    if (access.membership.role === 'member') {
      const result = await transaction.collection('change_requests').add({
        data: {
          familyId: person.familyId,
          type: 'update_person',
          title: '修改成员“' + person.name + '”的资料',
          payload: { personId: person._id, changes: changes },
          status: 'pending',
          createdBy: userId(openid),
          requesterName: access.membership.displayName || '家人',
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      return { pending: true, requestId: result._id, person: publicPerson(person) };
    }
    await transaction.collection('persons').doc(person._id).update({ data: Object.assign({}, changes, { updatedAt: db.serverDate() }) });
    await audit(transaction, {
      familyId: person.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'person.update',
      objectType: 'person',
      objectId: person._id,
      summary: '更新成员资料',
      requestId: event.requestId
    });
    return { pending: false, person: publicPerson(Object.assign({}, person, changes)) };
  });
}

async function personDelete(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const snapshotPerson = await mustGet(db, 'persons', event.personId, 'PERSON_NOT_FOUND', '成员不存在');
  const snapshotAccess = await requireMembership(snapshotPerson.familyId, ['admin'], db, openid);
  assert(snapshotPerson.status === 'active', 'PERSON_NOT_FOUND', '成员已删除');
  const relations = await listAll('relations', { familyId: snapshotPerson.familyId, status: 'active' }, GRAPH_RELATION_LIMIT);
  const related = relations.filter(function (relation) {
    return relation.fromPersonId === snapshotPerson._id || relation.toPersonId === snapshotPerson._id;
  });
  assert(related.length <= 80, 'TOO_MANY_RELATIONS', '该成员关联关系较多，请联系运营人员协助删除');
  const relationRevision = Number(snapshotAccess.family.relationRevision || 0);
  return mutate('person.delete', event, openid, async function (transaction) {
    const person = await mustGet(transaction, 'persons', event.personId, 'PERSON_NOT_FOUND', '成员不存在');
    const access = await requireMembership(person.familyId, ['admin'], transaction, openid);
    assert(person.status === 'active', 'PERSON_NOT_FOUND', '成员已删除');
    assert(Number(access.family.relationRevision || 0) === relationRevision, 'GRAPH_CHANGED', '家谱关系刚刚发生变化，请重试');
    await transaction.collection('persons').doc(person._id).update({
      data: { status: 'deleted', deletedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    for (const relation of related) {
      await transaction.collection('relations').doc(relation._id).update({
        data: { status: 'deleted', deletedAt: db.serverDate(), updatedAt: db.serverDate() }
      });
    }
    await transaction.collection('families').doc(person.familyId).update({
      data: {
        personCount: _.inc(-1),
        relationCount: _.inc(-related.length),
        relationRevision: _.inc(1),
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: person.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'person.delete',
      objectType: 'person',
      objectId: person._id,
      summary: '删除家庭成员',
      requestId: event.requestId
    });
    return { deleted: true };
  });
}

async function changeList(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const access = await requireMembership(event.familyId, ['admin', 'member'], db, openid);
  const where = access.membership.role === 'admin'
    ? { familyId: event.familyId, status: event.status || 'pending' }
    : { familyId: event.familyId, status: event.status || 'pending', createdBy: userId(openid) };
  const page = await listPage('change_requests', where, event, ['createdAt']);
  page.items = page.items.map(publicChangeRequest);
  return page;
}

async function changeReview(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const changeRequestId = event.requestIdValue || event.changeRequestId;
  const snapshotRequest = await mustGet(db, 'change_requests', changeRequestId, 'REQUEST_NOT_FOUND', '修改申请不存在');
  const snapshotAccess = await requireMembership(snapshotRequest.familyId, ['admin'], db, openid);
  let graphSnapshot = null;
  if (event.decision === 'approve' && snapshotRequest.type === 'link_existing_relation') {
    graphSnapshot = {
      relationRevision: Number(snapshotAccess.family.relationRevision || 0),
      relations: await listAll('relations', { familyId: snapshotRequest.familyId, status: 'active' }, GRAPH_RELATION_LIMIT)
    };
  }
  return mutate('change.review', event, openid, async function (transaction) {
    const request = await mustGet(transaction, 'change_requests', changeRequestId, 'REQUEST_NOT_FOUND', '修改申请不存在');
    const access = await requireMembership(request.familyId, ['admin'], transaction, openid);
    assert(request.status === 'pending', 'REQUEST_REVIEWED', '这条申请已经处理');
    const approved = event.decision === 'approve';
    let createdPerson = null;
    if (approved && request.type === 'create_related') {
      assert(Number(access.family.personCount || 0) < GRAPH_PERSON_LIMIT, 'FAMILY_PERSON_LIMIT', '单个家谱最多支持 500 人');
      createdPerson = await createRelatedTx(
        transaction,
        request.familyId,
        request.payload.anchorPersonId,
        request.payload.relationType,
        request.payload.person,
        openid,
        { sharedChildIds: cleanPersonIds(request.payload.sharedChildIds, 30) }
      );
      const sharedChildCount = request.payload.relationType === 'spouse'
        ? cleanPersonIds(request.payload.sharedChildIds, 30).length
        : 0;
      await transaction.collection('families').doc(request.familyId).update({
        data: {
          personCount: _.inc(1),
          relationCount: _.inc(1 + sharedChildCount),
          relationRevision: _.inc(1),
          updatedAt: db.serverDate()
        }
      });
    }
    if (approved && request.type === 'link_existing_relation') {
      assert(graphSnapshot, 'GRAPH_CHANGED', '家谱关系刚刚发生变化，请重试');
      assert(Number(access.family.relationRevision || 0) === graphSnapshot.relationRevision, 'GRAPH_CHANGED', '家谱关系刚刚发生变化，请重试');
      const linked = await linkExistingTx(
        transaction,
        request.familyId,
        request.payload.anchorPersonId,
        request.payload.relatedPersonId,
        request.payload.relationType,
        cleanPersonIds(request.payload.sharedChildIds, 30),
        openid,
        graphSnapshot.relations
      );
      createdPerson = linked.person;
      await transaction.collection('families').doc(request.familyId).update({
        data: {
          relationCount: _.inc(linked.relationCount),
          relationRevision: _.inc(1),
          updatedAt: db.serverDate()
        }
      });
    }
    if (approved && request.type === 'update_person') {
      const person = await mustGet(transaction, 'persons', request.payload.personId, 'PERSON_NOT_FOUND', '成员不存在');
      assert(person.familyId === request.familyId, 'CROSS_FAMILY_RELATION', '申请数据异常');
      await transaction.collection('persons').doc(person._id).update({
        data: Object.assign({}, request.payload.changes, { updatedAt: db.serverDate() })
      });
    }
    await transaction.collection('change_requests').doc(request._id).update({
      data: {
        status: approved ? 'approved' : 'rejected',
        reviewedBy: userId(openid),
        reviewNote: cleanText(event.note, 200),
        reviewedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: request.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: approved ? 'change.approve' : 'change.reject',
      objectType: 'change_request',
      objectId: request._id,
      summary: approved ? '通过修改申请' : '拒绝修改申请',
      requestId: event.requestId
    });
    return { approved: approved, person: createdPerson ? publicPerson(createdPerson) : null };
  });
}

function invitationState(invitation) {
  return domain.invitationState(invitation);
}

function assertInvitationActive(invitation) {
  const state = invitationState(invitation);
  assert(state === 'active', 'INVITE_' + state.toUpperCase(), state === 'revoked' ? '邀请已被撤销' : '邀请已经失效');
  return invitation;
}

async function findInvitationByToken(token) {
  const tokenHash = hash(cleanText(token, 200), 64);
  const result = await db.collection('invitations').where({ tokenHash: tokenHash }).limit(1).get();
  assert(result.data && result.data.length, 'INVITE_INVALID', '邀请不存在或已经失效');
  return result.data[0];
}

async function inviteCreate(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return mutate('invite.create', event, openid, async function (transaction) {
    const access = await requireMembership(event.familyId, ['admin'], transaction, openid);
    const family = await getFamily(transaction, event.familyId);
    assert(['member', 'viewer'].includes(event.role), 'INVALID_ROLE', '邀请角色只能是共同补全或仅查看');
    const role = event.role;
    const viewMode = event.viewMode === 'perspective' ? 'perspective' : 'full';
    let viewPersonId = '';
    let viewPersonName = '';
    if (viewMode === 'perspective') {
      const person = await mustGet(transaction, 'persons', event.viewPersonId, 'PERSON_NOT_FOUND', '分享视角成员不存在');
      assert(person.familyId === event.familyId && person.status === 'active', 'PERSON_NOT_FOUND', '分享视角成员不存在');
      viewPersonId = person._id;
      viewPersonName = person.name;
    }
    const token = randomToken(24);
    const expiresInDays = Math.max(1, Math.min(Number(event.expiresInDays) || 30, 30));
    const maxUses = Math.max(1, Math.min(Number(event.maxUses) || 50, 200));
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const result = await transaction.collection('invitations').add({
      data: {
        tokenHash: hash(token, 64),
        familyId: event.familyId,
        role: role,
        viewMode: viewMode,
        viewPersonId: viewPersonId,
        viewPersonName: viewPersonName,
        status: 'active',
        useCount: 0,
        maxUses: maxUses,
        expiresAt: expiresAt,
        createdBy: userId(openid),
        createdByName: access.membership.displayName || '家人',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: event.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'invite.create',
      objectType: 'invitation',
      objectId: result._id,
      summary: '创建家庭邀请',
      requestId: event.requestId
    });
    return {
      invitationId: result._id,
      token: token,
      familyName: family.name,
      role: role,
      viewMode: viewMode,
      viewPersonName: viewPersonName,
      expiresAt: expiresAt,
      maxUses: maxUses
    };
  });
}

async function inviteList(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  await requireMembership(event.familyId, ['admin'], db, openid);
  const page = await listPage('invitations', { familyId: event.familyId }, event, ['createdAt']);
  page.items = page.items.map(function (item) {
    return {
      _id: item._id,
      familyId: item.familyId,
      role: item.role,
      viewMode: item.viewMode,
      viewPersonId: item.viewPersonId || '',
      viewPersonName: item.viewPersonName || '',
      createdByName: item.createdByName || '家人',
      status: item.status,
      displayStatus: invitationState(item),
      useCount: item.useCount || 0,
      maxUses: item.maxUses || 0,
      expiresAt: item.expiresAt,
      createdAt: item.createdAt || null
    };
  });
  return page;
}

async function inviteRevoke(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return mutate('invite.revoke', event, openid, async function (transaction) {
    const invitation = await mustGet(transaction, 'invitations', event.invitationId, 'INVITE_NOT_FOUND', '邀请不存在');
    const access = await requireMembership(invitation.familyId, ['admin'], transaction, openid);
    assert(invitation.status === 'active', 'INVITE_ALREADY_INACTIVE', '邀请已经失效');
    await transaction.collection('invitations').doc(invitation._id).update({
      data: { status: 'revoked', revokedBy: userId(openid), revokedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await audit(transaction, {
      familyId: invitation.familyId,
      openid: openid,
      actorName: access.membership.displayName,
      action: 'invite.revoke',
      objectType: 'invitation',
      objectId: invitation._id,
      summary: '撤销家庭邀请',
      requestId: event.requestId
    });
    return { revoked: true };
  });
}

async function invitePreview(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const invitation = await findInvitationByToken(event.token);
  const family = await getFamily(db, invitation.familyId);
  const membership = await getMembership(db, family._id, openid);
  if (membership) {
    return {
      alreadyJoined: true,
      family: publicFamily(family, membership.role),
      role: membership.role,
      viewMode: invitation.viewMode,
      viewPersonId: invitation.viewPersonId || '',
      viewPersonName: invitation.viewPersonName || ''
    };
  }
  assertInvitationActive(invitation);
  await incrementShareMetric(db, invitationShareKind(invitation), 'opened');
  return {
    alreadyJoined: false,
    invitationId: invitation._id,
    family: { _id: family._id, name: family.name, description: family.description || '' },
    personCount: family.personCount || 0,
    inviterName: invitation.createdByName || '家人',
    role: invitation.role,
    viewMode: invitation.viewMode,
    viewPersonId: invitation.viewPersonId || '',
    viewPersonName: invitation.viewPersonName || ''
  };
}

async function inviteAccept(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const invitationSnapshot = await findInvitationByToken(event.token);
  return mutate('invite.accept', event, openid, async function (transaction) {
    const invitation = await mustGet(transaction, 'invitations', invitationSnapshot._id, 'INVITE_INVALID', '邀请不存在或已经失效');
    assert(invitation.tokenHash === invitationSnapshot.tokenHash, 'INVITE_INVALID', '邀请不存在或已经失效');
    const family = await getFamily(transaction, invitation.familyId);
    const id = membershipId(family._id, openid);
    const existing = await maybeGet(transaction, 'family_memberships', id);
    if (existing && existing.status === 'active') {
      return {
        family: publicFamily(family, existing.role),
        role: existing.role,
        viewMode: invitation.viewMode,
        viewPersonId: invitation.viewPersonId || '',
        alreadyJoined: true
      };
    }
    assertInvitationActive(invitation);
    const role = existing && ['admin', 'member'].includes(existing.role) ? existing.role : invitation.role;
    await transaction.collection('family_memberships').doc(id).set({
      data: {
        familyId: family._id,
        userId: user._id,
        role: role,
        displayName: user.nickName || '家人',
        avatarAssetId: user.avatarAssetId || '',
        status: 'active',
        joinedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await transaction.collection('invitations').doc(invitation._id).update({
      data: { useCount: _.inc(1), lastUsedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await incrementShareMetric(transaction, invitationShareKind(invitation), 'converted');
    await audit(transaction, {
      familyId: family._id,
      openid: openid,
      actorName: user.nickName,
      action: 'membership.join',
      objectType: 'family',
      objectId: family._id,
      summary: '通过邀请加入家谱',
      requestId: event.requestId
    });
    return {
      family: publicFamily(family, role),
      role: role,
      viewMode: invitation.viewMode,
      viewPersonId: invitation.viewPersonId || '',
      alreadyJoined: false
    };
  });
}

async function shareRecord(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const stage = cleanText(event.stage, 20);
  assert(['prepared', 'sent', 'opened'].includes(stage), 'SHARE_STAGE_INVALID', '分享统计状态不合法');
  const invitationId = cleanText(event.invitationId, 80);
  const requestedKind = cleanText(event.kind, 30);
  if (!invitationId && requestedKind === 'example') {
    const slug = cleanText(event.slug, 80);
    assert(slug, 'EXAMPLE_SLUG_REQUIRED', '缺少示例家谱信息');
    const result = await db.collection('example_templates').where({ slug: slug, status: 'published' }).limit(1).get();
    assert(result.data && result.data.length, 'EXAMPLE_NOT_FOUND', '示例家谱已下架或暂不可用');
  }
  return mutate('share.record', event, openid, async function (transaction) {
    let kind = requestedKind;
    if (invitationId) {
      const invitation = await mustGet(transaction, 'invitations', invitationId, 'INVITE_NOT_FOUND', '邀请不存在');
      assert(['prepared', 'sent'].includes(stage), 'SHARE_STAGE_INVALID', '邀请卡只允许记录准备或发送');
      assert(invitation.createdBy === user._id, 'INVALID_INVITATION', '邀请不属于当前用户');
      kind = invitationShareKind(invitation);
    } else {
      assert(['example', 'discovery'].includes(kind), 'SHARE_KIND_INVALID', '分享卡类型不合法');
    }
    await incrementShareMetric(transaction, kind, stage);
    return { recorded: true, kind: kind, stage: stage };
  });
}

async function reportCreate(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const targetType = ['person', 'media', 'family', 'invitation'].includes(event.targetType) ? event.targetType : '';
  const familyId = cleanText(event.familyId, 80);
  const reason = cleanText(event.reason, 40);
  const detail = cleanText(event.detail, 300);
  assert(targetType && event.targetId && reason, 'INVALID_REPORT', '请补充举报对象和原因');
  let invitationProofHash = '';
  if (targetType === 'invitation' && event.inviteToken) {
    invitationProofHash = hash(cleanText(event.inviteToken, 200), 64);
    const proofResult = await db.collection('invitations').where({ tokenHash: invitationProofHash }).limit(1).get();
    const proof = proofResult.data && proofResult.data[0];
    assert(proof && proof._id === event.targetId && proof.familyId === familyId, 'INVALID_REPORT_TARGET', '邀请凭证与举报对象不匹配');
  } else {
    await requireMembership(familyId, ACTIVE_ROLES, db, openid);
  }
  if (targetType === 'family') {
    assert(event.targetId === familyId, 'INVALID_REPORT_TARGET', '举报对象不属于当前家谱');
  } else {
    const collectionName = targetType === 'person' ? 'persons' : (targetType === 'media' ? 'media_assets' : 'invitations');
    const target = await mustGet(db, collectionName, cleanText(event.targetId, 80), 'INVALID_REPORT_TARGET', '举报对象不存在');
    assert(target.familyId === familyId, 'INVALID_REPORT_TARGET', '举报对象不属于当前家谱');
  }
  await moderateText(openid, [reason, detail]);
  return mutate('report.create', event, openid, async function (transaction) {
    if (invitationProofHash) {
      const invitation = await mustGet(transaction, 'invitations', cleanText(event.targetId, 80), 'INVALID_REPORT_TARGET', '举报邀请不存在');
      assert(invitation.tokenHash === invitationProofHash && invitation.familyId === familyId, 'INVALID_REPORT_TARGET', '邀请凭证与举报对象不匹配');
    } else {
      await requireMembership(familyId, ACTIVE_ROLES, transaction, openid);
    }
    const result = await transaction.collection('reports').add({
      data: {
        familyId: familyId,
        reporterId: user._id,
        targetType: targetType,
        targetId: cleanText(event.targetId, 80),
        reason: reason,
        detail: detail,
        status: 'open',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await audit(transaction, {
      familyId: familyId,
      openid: openid,
      actorName: user.nickName,
      action: 'report.create',
      objectType: 'report',
      objectId: result._id,
      summary: '提交内容举报',
      requestId: event.requestId
    });
    return { reportId: result._id, status: 'open' };
  });
}

async function reportListMine(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const page = await listPage('reports', { reporterId: user._id }, event, ['createdAt']);
  page.items = page.items.map(function (item) {
    return {
      _id: item._id,
      familyId: item.familyId,
      targetType: item.targetType,
      reason: item.reason,
      status: item.status,
      resolution: item.resolution || '',
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    };
  });
  return page;
}

async function mediaPrepare(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const extension = ['jpg', 'jpeg', 'png', 'webp'].includes(String(event.extension || '').toLowerCase())
    ? String(event.extension).toLowerCase()
    : 'jpg';
  const kind = ['user_avatar', 'person_avatar'].includes(event.kind) ? event.kind : 'person_avatar';
  if (event.familyId) await requireMembership(event.familyId, ['admin', 'member'], db, openid);
  return mutate('media.prepare', event, openid, async function (transaction) {
    const result = await transaction.collection('media_assets').add({
      data: {
        ownerId: user._id,
        familyId: cleanText(event.familyId, 80),
        kind: kind,
        status: 'uploading',
        moderationStatus: 'pending',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    const cloudPath = ['staging', user._id, result._id + '.' + extension].join('/');
    await transaction.collection('media_assets').doc(result._id).update({ data: { cloudPath: cloudPath } });
    return { assetId: result._id, cloudPath: cloudPath, maxBytes: 5 * 1024 * 1024 };
  });
}

async function mediaComplete(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const existingIdempotency = await maybeGet(db, 'idempotency_records', idempotencyId(openid, 'media.complete', cleanText(event.requestId, 80)));
  if (existingIdempotency && existingIdempotency.status === 'completed') return existingIdempotency.result || {};
  const asset = await mustGet(db, 'media_assets', event.assetId, 'MEDIA_NOT_FOUND', '上传任务不存在');
  assert(asset.ownerId === user._id, 'NO_PERMISSION', '不能处理其他用户的文件');
  const fileId = cleanText(event.fileId, 500);
  assert(fileId && fileId.endsWith('/' + asset.cloudPath), 'INVALID_MEDIA_PATH', '上传文件与任务不匹配');
  const inspected = await inspectPrivateUpload(fileId);
  const size = inspected.size;
  if (size > 5 * 1024 * 1024) {
    await db.collection('media_assets').doc(asset._id).update({
      data: {
        fileId: fileId,
        size: size,
        status: 'pending',
        moderationStatus: 'rejected',
        updatedAt: db.serverDate()
      }
    });
    try {
      await deleteFilesStrict([fileId]);
      await db.collection('media_assets').doc(asset._id).update({
        data: { fileId: '', status: 'deleted', deletedAt: db.serverDate(), updatedAt: db.serverDate() }
      });
    } catch (error) {
      // 保留 fileId，由后台清理任务重试，避免产生无法追踪的存储孤儿。
    }
  }
  assert(size <= 5 * 1024 * 1024, 'MEDIA_TOO_LARGE', '图片不能超过 5MB');
  let moderationStatus = 'review';
  let traceId = '';
  if (process.env.CONTENT_MODERATION_MODE === 'off') {
    moderationStatus = 'approved';
  } else {
    try {
      const response = await cloud.openapi.security.mediaCheckAsync({
        openid: openid,
        scene: 2,
        version: 2,
        mediaType: 2,
        mediaUrl: inspected.url
      });
      traceId = response.traceId || response.trace_id || '';
      moderationStatus = 'pending';
    } catch (error) {
      moderationStatus = 'review';
    }
  }
  return mutate('media.complete', event, openid, async function (transaction) {
    const current = await mustGet(transaction, 'media_assets', asset._id, 'MEDIA_NOT_FOUND', '上传任务不存在');
    assert(current.ownerId === user._id && current.cloudPath === asset.cloudPath, 'NO_PERMISSION', '不能处理其他用户的文件');
    await transaction.collection('media_assets').doc(asset._id).update({
      data: {
        fileId: fileId,
        size: size,
        status: moderationStatus === 'approved' ? 'active' : 'pending',
        moderationStatus: moderationStatus,
        traceId: traceId,
        uploadedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    if (moderationStatus === 'review' || moderationStatus === 'pending') {
      const taskId = 'mt_' + asset._id;
      await transaction.collection('moderation_tasks').doc(taskId).set({
        data: {
          familyId: asset.familyId || '',
          assetId: asset._id,
          traceId: traceId,
          type: 'image',
          status: moderationStatus,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
    return { assetId: asset._id, moderationStatus: moderationStatus, ready: moderationStatus === 'approved' };
  });
}

async function mediaGetUrls(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const ids = Array.from(new Set((event.assetIds || []).map(function (id) { return cleanText(id, 80); }).filter(Boolean))).slice(0, 50);
  if (!ids.length) return { urls: {} };
  const assetsResult = await db.collection('media_assets').where({ _id: _.in(ids), moderationStatus: 'approved', status: 'active' }).get();
  const accessible = await accessibleMediaAssets(assetsResult.data || [], openid);
  if (!accessible.length) return { urls: {} };
  const tempResult = await cloud.getTempFileURL({ fileList: accessible.map(function (asset) { return asset.fileId; }) });
  const urls = {};
  accessible.forEach(function (asset, index) {
    const item = tempResult.fileList[index];
    if (item && item.tempFileURL) urls[asset._id] = item.tempFileURL;
  });
  return { urls: urls };
}

async function mediaGetStates(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const ids = Array.from(new Set((event.assetIds || []).map(function (id) {
    return cleanText(id, 80);
  }).filter(Boolean))).slice(0, 50);
  if (!ids.length) return { states: {} };
  const result = await db.collection('media_assets').where({ _id: _.in(ids) }).get();
  const states = {};
  const accessible = await accessibleMediaAssets(result.data || [], openid);
  for (const asset of accessible) {
    states[asset._id] = asset.status === 'deleted'
      ? 'deleted'
      : asset.moderationStatus || 'pending';
  }
  return { states: states };
}

async function mediaGetPresentation(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const ids = Array.from(new Set((event.assetIds || []).map(function (id) {
    return cleanText(id, 80);
  }).filter(Boolean))).slice(0, 50);
  if (!ids.length) return { items: {} };
  const result = await db.collection('media_assets').where({ _id: _.in(ids) }).get();
  const approved = [];
  const items = {};
  const accessible = await accessibleMediaAssets(result.data || [], openid);
  for (const asset of accessible) {
    const status = asset.status === 'deleted' ? 'deleted' : (asset.moderationStatus || 'pending');
    items[asset._id] = { status: status, url: '' };
    if (status === 'approved' && asset.status === 'active' && asset.fileId) approved.push(asset);
  }
  if (approved.length) {
    const tempResult = await cloud.getTempFileURL({ fileList: approved.map(function (asset) { return asset.fileId; }) });
    approved.forEach(function (asset, index) {
      const item = tempResult.fileList[index];
      if (item && item.tempFileURL) items[asset._id].url = item.tempFileURL;
    });
  }
  return { items: items };
}

async function accessibleMediaAssets(assets, openid) {
  const memberships = new Map();
  const accessible = [];
  for (const asset of assets || []) {
    if (!asset.familyId) {
      if (asset.ownerId === userId(openid)) accessible.push(asset);
      continue;
    }
    if (!memberships.has(asset.familyId)) {
      memberships.set(asset.familyId, getMembership(db, asset.familyId, openid));
    }
    if (await memberships.get(asset.familyId)) accessible.push(asset);
  }
  return accessible;
}

function publicExamplePerson(person) {
  const source = person || {};
  return {
    _id: cleanText(source._id, 80),
    name: cleanText(source.name, 30),
    gender: cleanGender(source.gender),
    lifeStatus: cleanLifeStatus(source.lifeStatus),
    birthDate: cleanDate(source.birthDate),
    deathDate: cleanDate(source.deathDate),
    birthPlace: cleanText(source.birthPlace, 80),
    bio: cleanText(source.bio, 500),
    avatarAssetId: '',
    photoAssetIds: []
  };
}

function publicExampleContent(template) {
  const content = template.publishedContent || {};
  const family = content.family || {};
  const people = (content.persons || []).map(publicExamplePerson).filter(function (person) {
    return person._id && person.name;
  });
  const personIds = new Set(people.map(function (person) { return person._id; }));
  const relations = (content.relations || []).map(function (relation) {
    return {
      _id: cleanText(relation._id, 80),
      type: relation.type === 'spouse' ? 'spouse' : 'parent_child',
      fromPersonId: cleanText(relation.fromPersonId, 80),
      toPersonId: cleanText(relation.toPersonId, 80)
    };
  }).filter(function (relation) {
    return relation._id && relation.fromPersonId !== relation.toPersonId &&
      personIds.has(relation.fromPersonId) && personIds.has(relation.toPersonId);
  });
  return {
    _id: template._id,
    slug: cleanText(template.slug, 80),
    title: cleanText(template.title || family.name, 40),
    description: cleanText(template.description || family.description, 200),
    tags: (template.tags || []).map(function (tag) { return cleanText(tag, 20); }).filter(Boolean).slice(0, 8),
    sortOrder: Number(template.sortOrder) || 0,
    shareTitle: cleanText(template.shareTitle, 60),
    shareDescription: cleanText(template.shareDescription, 100),
    publishedVersion: Number(template.publishedVersion) || 0,
    personCount: people.length,
    relationCount: relations.length,
    persons: people,
    relations: relations
  };
}

async function examplesList(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const tag = cleanText(event.tag, 20);
  let templates = await listAll('example_templates', { status: 'published' }, 100);
  templates = templates.filter(function (template) {
    return template.publishedContent && (!tag || (template.tags || []).includes(tag));
  }).sort(function (left, right) {
    return (Number(left.sortOrder) || 0) - (Number(right.sortOrder) || 0) || String(left._id).localeCompare(String(right._id));
  });
  const tags = Array.from(new Set(templates.reduce(function (all, template) {
    return all.concat(template.tags || []);
  }, []).map(function (item) { return cleanText(item, 20); }).filter(Boolean))).sort();
  return {
    items: templates.map(function (template) {
      const example = publicExampleContent(template);
      delete example.persons;
      delete example.relations;
      return example;
    }),
    tags: tags
  };
}

async function examplesGet(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const slug = cleanText(event.slug, 80);
  assert(slug, 'EXAMPLE_SLUG_REQUIRED', '缺少示例家谱信息');
  const result = await db.collection('example_templates').where({ slug: slug, status: 'published' }).limit(1).get();
  assert(result.data && result.data.length && result.data[0].publishedContent, 'EXAMPLE_NOT_FOUND', '该示例家谱已下架或暂不可用');
  return { example: publicExampleContent(result.data[0]) };
}

function paymentMode() {
  return commerce.paymentProfile(process.env.PAYMENT_MODE).mode;
}

function publicOrder(order) {
  return {
    orderId: order._id,
    familyId: order.familyId,
    familyName: order.familyName || '',
    productId: order.productId,
    productName: order.productName || '',
    priceCents: Number(order.priceCents) || 0,
    status: order.status || 'pending',
    closeReason: order.closeReason || '',
    paymentMode: order.paymentMode || 'mock',
    paymentEnv: Number(order.paymentEnv) === 1 ? 1 : 0,
    wxOrderId: order.wxOrderId || '',
    createdAt: order.createdAt || null,
    paidAt: order.paidAt || null,
    fulfilledAt: order.fulfilledAt || null,
    refundedAt: order.refundedAt || null,
    updatedAt: order.updatedAt || null,
    reconcileStatus: order.reconcileStatus || '',
    reconcileMessage: cleanText(order.reconcileMessage, 160)
  };
}

async function membershipCatalog() {
  const openid = getOpenid();
  await requireActiveUser(openid);
  return {
    products: commerce.catalog().map(commerce.publicProduct),
    rules: {
      scope: 'family',
      autoRenew: false,
      transferable: false,
      freeHistoryLimit: 20,
      backupCooldownDays: 7
    },
    paymentMode: paymentMode()
  };
}

async function membershipStatus(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const access = await requireMembership(event.familyId, ACTIVE_ROLES, db, openid, { allowArchived: true });
  const membership = commerce.entitlementFromFamily(access.family);
  return {
    family: publicFamily(access.family, access.membership.role),
    membership: membership,
    canPurchase: access.family.status === 'active' && !membership.lifetime,
    canBackup: access.membership.role === 'admin' && membership.active
  };
}

async function code2Session(loginCode, expectedOpenid) {
  const code = cleanText(loginCode, 160);
  assert(code, 'PAYMENT_LOGIN_REQUIRED', '支付登录状态已过期，请重试');
  const context = cloud.getWXContext() || {};
  const appId = cleanText(process.env.VP_APP_ID || context.APPID, 80);
  const appSecret = String(process.env.VP_APP_SECRET || '');
  assert(appId && appSecret, 'PAYMENT_NOT_CONFIGURED', '虚拟支付尚未完成服务端配置');
  const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(appId) +
    '&secret=' + encodeURIComponent(appSecret) + '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code';
  let response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (error) {
    throw new BusinessError('PAYMENT_LOGIN_UNAVAILABLE', '支付登录校验暂时不可用，请稍后重试');
  }
  const payload = await response.json().catch(function () { return {}; });
  assert(response.ok && payload.openid && payload.session_key, 'PAYMENT_LOGIN_INVALID', '支付登录状态无效，请重新发起支付');
  assert(payload.openid === expectedOpenid, 'PAYMENT_IDENTITY_MISMATCH', '支付身份校验失败，请重新打开小程序');
  return { openid: payload.openid, sessionKey: payload.session_key };
}

function createTradeNumber() {
  return ('YP' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex')).slice(0, 32);
}

function paymentEnvironment(order) {
  return Number(order && order.paymentEnv) === 1 || (order && order.paymentMode === 'sandbox') ? 1 : 0;
}

function isPaidPaymentResult(result) {
  const source = result || {};
  return Number(source.order_state || source.orderState) === 1 ||
    [2, 3, 4].includes(Number(source.status)) || String(source.status || '').toLowerCase() === 'paid';
}

function canReconcilePaymentOrder(order) {
  return Boolean(order && (order.status === 'pending' || (order.status === 'closed' && order.closeReason === 'payment_timeout')));
}

function paymentResultOrderId(result) {
  const source = result || {};
  return cleanText(source.mch_order_no || source.wx_order_id || source.wxOrderId || source.transaction_id, 80);
}

async function paymentAccessToken() {
  const appId = String(process.env.VP_APP_ID || '');
  const appSecret = String(process.env.VP_APP_SECRET || '');
  assert(appId && appSecret, 'PAYMENT_NOT_CONFIGURED', '虚拟支付尚未完成服务端配置');
  let response;
  try {
    response = await fetch('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(appId) + '&secret=' + encodeURIComponent(appSecret));
  } catch (error) {
    throw new BusinessError('PAYMENT_QUERY_UNAVAILABLE', '支付状态暂时无法确认，请稍后重试');
  }
  const payload = await response.json().catch(function () { return {}; });
  assert(response.ok && payload.access_token, 'PAYMENT_QUERY_UNAVAILABLE', '支付状态暂时无法确认，请稍后重试');
  return payload.access_token;
}

async function queryPaymentOrder(order, openid, accessToken) {
  const appKey = String(process.env.VP_APP_KEY || '');
  assert(appKey, 'PAYMENT_NOT_CONFIGURED', '虚拟支付尚未完成服务端配置');
  // The client success callback may expose the WeChat-side order id. Prefer it
  // when available, while retaining outTradeNo as the documented fallback.
  const orderReference = cleanText(order.wxOrderId, 80);
  const body = JSON.stringify(orderReference
    ? { openid: openid, env: paymentEnvironment(order), wx_order_id: orderReference }
    : { openid: openid, env: paymentEnvironment(order), order_id: order._id });
  const paySig = crypto.createHmac('sha256', appKey).update('/xpay/query_order&' + body, 'utf8').digest('hex');
  let response;
  try {
    response = await fetch('https://api.weixin.qq.com/xpay/query_order?access_token=' + encodeURIComponent(accessToken) + '&pay_sig=' + paySig, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body
    });
  } catch (error) {
    throw new BusinessError('PAYMENT_QUERY_UNAVAILABLE', '支付状态暂时无法确认，请稍后重试');
  }
  const payload = await response.json().catch(function () { return {}; });
  if (!response.ok || Number(payload.errcode || 0) !== 0) {
    if (Number(payload.errcode) === 268490002) {
      // The platform documents this as a request-field error. In sandbox it
      // commonly carries “data does not exist”, but it must not be presented
      // as conclusive proof that the user did not pay.
      throw new BusinessError('PAYMENT_QUERY_NOT_FOUND', '微信沙箱暂时无法查询该订单（268490002：' + cleanText(payload.errmsg, 80) + '），请稍后刷新订单状态');
    }
    throw new BusinessError('PAYMENT_QUERY_UNAVAILABLE', '支付状态暂时无法确认，请稍后重试');
  }
  return payload.order || payload;
}

function clientWxOrderId(event) {
  const value = cleanText(event && event.wxOrderId, 80);
  return /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : '';
}

async function paymentClientCompleted(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const orderId = cleanText(event && event.orderId, 40);
  const wxOrderId = clientWxOrderId(event);
  const resultCode = Number(event && event.resultCode);
  const resultKeys = Array.from(new Set((Array.isArray(event && event.resultKeys) ? event.resultKeys : [])
    .map(function (key) { return cleanText(key, 40); }).filter(Boolean))).slice(0, 12);
  return mutate('payment.clientCompleted', event, openid, async function (transaction) {
    const order = await mustGet(transaction, 'payment_orders', orderId, 'PAYMENT_ORDER_NOT_FOUND', '订单不存在');
    assert(order.payerUserId === user._id, 'NO_PERMISSION', '不能处理其他用户的订单');
    if (order.status !== 'pending') return { order: publicOrder(order) };
    const update = {
      clientPaymentCompletedAt: db.serverDate(),
      clientResultCode: Number.isFinite(resultCode) ? resultCode : 0,
      clientResultKeys: resultKeys,
      updatedAt: db.serverDate()
    };
    if (wxOrderId && !order.wxOrderId) update.wxOrderId = wxOrderId;
    await transaction.collection('payment_orders').doc(orderId).update({ data: update });
    return { order: publicOrder(Object.assign({}, order, update)) };
  });
}

async function paymentCreateOrder(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const access = await requireMembership(event.familyId, ACTIVE_ROLES, db, openid);
  const item = commerce.product(event.productId);
  assert(item, 'PAYMENT_PRODUCT_INVALID', '所选会员商品不存在或已下架');
  const currentMembership = commerce.entitlementFromFamily(access.family);
  assert(!currentMembership.lifetime, 'MEMBERSHIP_ALREADY_LIFETIME', '这份家谱已经是永久会员');
  const profile = commerce.paymentProfile(process.env.PAYMENT_MODE);
  const session = profile.external ? await code2Session(event.loginCode, openid) : { sessionKey: 'staging-mock-session-key' };
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const monthOrders = await listAll('payment_orders', { status: _.in(['fulfilled', 'refunded']), paidAt: _.gte(monthStart) }, 5000);
  const monthGmv = monthOrders.reduce(function (total, order) { return total + (Number(order.priceCents) || 0); }, 0);
  assert(monthGmv + item.priceCents <= 10000000, 'PAYMENT_MONTHLY_LIMIT', '本月支付额度已达到平台上限，请下月再试');
  const offerId = profile.external ? cleanText(process.env.VP_OFFER_ID, 80) : 'staging_mock_offer';
  const appKey = profile.external ? String(process.env.VP_APP_KEY || '') : 'staging-mock-app-key';
  assert(offerId && appKey, 'PAYMENT_NOT_CONFIGURED', '虚拟支付尚未完成服务端配置');
  const orderId = createTradeNumber();
  const attach = JSON.stringify({ familyId: access.family._id, orderId: orderId });
  const signData = commerce.buildSignData({
    offerId: offerId,
    env: profile.env,
    productId: item.productId,
    goodsPrice: item.priceCents,
    outTradeNo: orderId,
    attach: attach
  });
  const payData = {
    signData: signData,
    mode: 'short_series_goods',
    paySig: commerce.paySignature('requestVirtualPayment', signData, appKey),
    signature: commerce.userSignature(signData, session.sessionKey)
  };
  return mutate('payment.createOrder', event, openid, async function (transaction) {
    await transaction.collection('payment_orders').doc(orderId).set({
      data: {
        familyId: access.family._id,
        familyName: access.family.name || '',
        payerUserId: user._id,
        productId: item.productId,
        productName: item.name,
        priceCents: item.priceCents,
        durationDays: item.durationDays,
        lifetime: item.lifetime,
        quantity: 1,
        mode: 'short_series_goods',
        paymentMode: profile.mode,
        paymentEnv: profile.env,
        status: 'pending',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      }
    });
    return { order: publicOrder(Object.assign({ _id: orderId }, item, { productName: item.name, familyId: access.family._id, familyName: access.family.name, status: 'pending' })), payData: payData, mock: !profile.external };
  });
}

async function fulfillOrderTransaction(transaction, order, wxOrderId, paidAt) {
  const grantId = 'grant_' + order._id;
  const priorGrant = await maybeGet(transaction, 'membership_grants', grantId);
  if (priorGrant && priorGrant.status === 'active') return;
  const family = await mustGet(transaction, 'families', order.familyId, 'FAMILY_NOT_FOUND', '订单对应的家谱不存在');
  const now = paidAt instanceof Date ? paidAt : new Date(paidAt || Date.now());
  let startsAt = now;
  let endsAt = null;
  if (!order.lifetime) {
    const currentExpiry = family.proExpiresAt ? new Date(family.proExpiresAt) : null;
    if (currentExpiry && currentExpiry.getTime() > startsAt.getTime()) startsAt = currentExpiry;
    endsAt = new Date(startsAt.getTime() + Number(order.durationDays || 0) * 24 * 60 * 60 * 1000);
  }
  await transaction.collection('membership_grants').doc(grantId).set({
    data: {
      familyId: order.familyId,
      orderId: order._id,
      productId: order.productId,
      durationDays: Number(order.durationDays) || 0,
      lifetime: Boolean(order.lifetime),
      startsAt: startsAt,
      endsAt: endsAt,
      paidAt: now,
      status: 'active',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  await transaction.collection('families').doc(order.familyId).update({
    data: {
      proLifetime: Boolean(family.proLifetime || order.lifetime),
      proExpiresAt: family.proLifetime || order.lifetime ? _.remove() : endsAt,
      proUpdatedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  await transaction.collection('payment_orders').doc(order._id).update({
    data: {
      status: 'fulfilled',
      wxOrderId: wxOrderId,
      paidAt: now,
      fulfilledAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
}

async function paymentMockComplete(event) {
  assert(paymentMode() === 'mock', 'MOCK_PAYMENT_DISABLED', '当前环境不允许模拟支付');
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const orderId = cleanText(event.orderId, 40);
  return mutate('payment.mockComplete', event, openid, async function (transaction) {
    const order = await mustGet(transaction, 'payment_orders', orderId, 'PAYMENT_ORDER_NOT_FOUND', '订单不存在');
    assert(order.payerUserId === user._id, 'NO_PERMISSION', '不能处理其他用户的订单');
    if (order.status === 'fulfilled') return { order: publicOrder(order) };
    assert(order.status === 'pending', 'PAYMENT_ORDER_FINAL', '订单已经结束');
    await fulfillOrderTransaction(transaction, Object.assign({ _id: orderId }, order), 'mock_' + orderId, new Date());
    await transaction.collection('payment_events').doc('mock_deliver_' + orderId).set({ data: {
      type: 'xpay_goods_deliver_notify', wxOrderId: 'mock_' + orderId, orderId: orderId,
      familyId: order.familyId, status: 'applied', source: 'staging_mock', createdAt: db.serverDate()
    } });
    return { order: publicOrder(Object.assign({}, order, { _id: orderId, status: 'fulfilled', wxOrderId: 'mock_' + orderId, paidAt: new Date(), fulfilledAt: new Date() })) };
  });
}

async function paymentMockRefund(event) {
  assert(paymentMode() === 'mock', 'MOCK_PAYMENT_DISABLED', '当前环境不允许模拟退款');
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const orderId = cleanText(event.orderId, 40);
  const previewOrder = await mustGet(db, 'payment_orders', orderId, 'PAYMENT_ORDER_NOT_FOUND', '订单不存在');
  assert(previewOrder.payerUserId === user._id, 'NO_PERMISSION', '不能处理其他用户的订单');
  assert(previewOrder.status === 'fulfilled', 'PAYMENT_NOT_REFUNDABLE', '当前订单不能模拟退款');
  const activeGrantResult = await db.collection('membership_grants').where({ familyId: previewOrder.familyId, status: 'active' }).limit(100).get();
  return mutate('payment.mockRefund', event, openid, async function (transaction) {
    const order = await mustGet(transaction, 'payment_orders', orderId, 'PAYMENT_ORDER_NOT_FOUND', '订单不存在');
    assert(order.payerUserId === user._id, 'NO_PERMISSION', '不能处理其他用户的订单');
    assert(order.status === 'fulfilled', 'PAYMENT_NOT_REFUNDABLE', '当前订单不能模拟退款');
    const grant = await mustGet(transaction, 'membership_grants', 'grant_' + orderId, 'MEMBERSHIP_GRANT_NOT_FOUND', '会员发放记录不存在');
    await transaction.collection('membership_grants').doc(grant._id).update({ data: { status: 'refunded', refundedAt: db.serverDate(), updatedAt: db.serverDate() } });
    const entitlement = commerce.recomputeEntitlement((activeGrantResult.data || []).filter(function (item) { return item._id !== grant._id; }), new Date());
    await transaction.collection('families').doc(order.familyId).update({ data: { proLifetime: entitlement.lifetime, proExpiresAt: entitlement.expiresAt || _.remove(), proUpdatedAt: db.serverDate(), updatedAt: db.serverDate() } });
    await transaction.collection('payment_orders').doc(orderId).update({ data: { status: 'refunded', refundedAt: db.serverDate(), updatedAt: db.serverDate() } });
    await transaction.collection('payment_events').doc('mock_refund_' + orderId).set({ data: {
      type: 'xpay_refund_notify', wxOrderId: order.wxOrderId || ('mock_' + orderId), orderId: orderId,
      familyId: order.familyId, status: 'applied', source: 'staging_mock', createdAt: db.serverDate()
    } });
    return { order: publicOrder(Object.assign({}, order, { _id: orderId, status: 'refunded', refundedAt: new Date() })), membership: entitlement };
  });
}

async function paymentGetOrder(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const order = await mustGet(db, 'payment_orders', cleanText(event.orderId, 40), 'PAYMENT_ORDER_NOT_FOUND', '订单不存在');
  assert(order.payerUserId === user._id, 'NO_PERMISSION', '不能查看其他用户的订单');
  return { order: publicOrder(order) };
}

async function paymentReconcileNow(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const orderId = cleanText(event.orderId, 40);
  const previewOrder = await mustGet(db, 'payment_orders', orderId, 'PAYMENT_ORDER_NOT_FOUND', '订单不存在');
  assert(previewOrder.payerUserId === user._id, 'NO_PERMISSION', '不能处理其他用户的订单');
  if (!canReconcilePaymentOrder(previewOrder)) return { order: publicOrder(previewOrder), reconciled: false };
  assert(['sandbox', 'live'].includes(previewOrder.paymentMode), 'PAYMENT_RECONCILE_UNAVAILABLE', '当前订单不支持支付状态查询');

  let result;
  try {
    result = await queryPaymentOrder(previewOrder, openid, await paymentAccessToken());
  } catch (error) {
    const status = error && error.code === 'PAYMENT_QUERY_NOT_FOUND' ? 'query_not_found' : 'query_failed';
    const message = cleanText(error && error.message, 160) || '支付状态暂时无法确认，请稍后重试';
    const pending = await db.runTransaction(async function (transaction) {
      const latest = await mustGet(transaction, 'payment_orders', orderId, 'PAYMENT_ORDER_NOT_FOUND', '订单不存在');
      if (!canReconcilePaymentOrder(latest)) return latest;
      await transaction.collection('payment_orders').doc(orderId).update({ data: {
        reconcileStatus: status, reconcileMessage: message, lastQueriedAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      return Object.assign({}, latest, { reconcileStatus: status, reconcileMessage: message, lastQueriedAt: new Date(), updatedAt: new Date() });
    });
    return { order: publicOrder(pending), reconciled: false };
  }
  const paid = isPaidPaymentResult(result);
  if (!paid) {
    return db.runTransaction(async function (transaction) {
      const latest = await mustGet(transaction, 'payment_orders', orderId, 'PAYMENT_ORDER_NOT_FOUND', '订单不存在');
      if (!canReconcilePaymentOrder(latest)) return { order: publicOrder(latest), reconciled: false };
      const expired = latest.expiresAt && new Date(latest.expiresAt).getTime() <= Date.now();
      await transaction.collection('payment_orders').doc(orderId).update({ data: {
        status: expired ? 'closed' : 'pending',
        closeReason: expired ? 'payment_timeout' : '',
        reconcileStatus: expired ? 'closed_unpaid' : 'not_paid',
        lastQueriedAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      return { order: publicOrder(Object.assign({}, latest, { status: expired ? 'closed' : 'pending' })), reconciled: false };
    });
  }

  const wxOrderId = paymentResultOrderId(result);
  assert(wxOrderId, 'PAYMENT_QUERY_INVALID', '支付平台返回的订单信息不完整，请稍后重试');
  const internalSecret = String(process.env.VP_INTERNAL_NOTIFY_SECRET || '');
  assert(internalSecret, 'PAYMENT_NOTIFY_UNAVAILABLE', '支付发货服务暂未完成配置，请稍后重试');
  const notification = await cloud.callFunction({
    name: paymentNotifyFunctionName(),
    data: {
      internalSecret: internalSecret,
      Event: 'xpay_goods_deliver_notify',
      MchOrderNo: wxOrderId,
      OutTradeNo: orderId,
      ProductId: previewOrder.productId,
      Quantity: 1
    }
  });
  const notificationResult = notification && notification.result || {};
  assert(Number(notificationResult.ErrCode) === 0, 'PAYMENT_NOTIFY_UNAVAILABLE', '支付发货暂未完成，请稍后刷新订单状态');
  const completed = await mustGet(db, 'payment_orders', orderId, 'PAYMENT_ORDER_NOT_FOUND', '订单不存在');
  return { order: publicOrder(completed), reconciled: completed.status === 'fulfilled' };
}

async function paymentListMine(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const familyId = cleanText(event && event.familyId, 80);
  const pageSize = Math.max(1, Math.min(Math.floor(Number(event && event.pageSize) || 10), 50));
  const requestedOffset = Number(event && event.cursor);
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.min(Math.floor(requestedOffset), 10000)) : 0;
  const where = { payerUserId: user._id };
  if (familyId) where.familyId = familyId;
  const result = await db.collection('payment_orders')
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip(offset)
    .limit(pageSize + 1)
    .get();
  const rows = result.data || [];
  const items = rows.slice(0, pageSize);
  return {
    items: items.map(publicOrder),
    hasMore: rows.length > pageSize,
    nextCursor: rows.length > pageSize ? String(offset + items.length) : ''
  };
}

function publicActivity(item) {
  return {
    _id: item._id,
    actorId: item.actorId || '',
    actorName: item.actorName || '一位家人',
    action: item.action || '',
    objectType: item.objectType || '',
    objectId: item.objectId || '',
    summary: item.summary || '',
    createdAt: item.createdAt || null
  };
}

async function familyActivityList(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const access = await requireMembership(event.familyId, ACTIVE_ROLES, db, openid, { allowArchived: true });
  const entitlement = commerce.entitlementFromFamily(access.family);
  const size = entitlement.active ? Math.max(1, Math.min(Number(event.pageSize) || 30, 50)) : 20;
  const action = cleanText(event.action, 80);
  const actorId = cleanText(event.actorId, 80);
  const actorName = cleanText(event.actorName, 60);
  const from = event.from ? new Date(event.from) : null;
  const to = event.to ? new Date(event.to) : null;
  if (!entitlement.active) {
    const recent = await db.collection('audit_logs').where({ familyId: access.family._id }).orderBy('createdAt', 'desc').limit(20).get();
    const items = (recent.data || []).filter(function (item) {
      const created = new Date(item.createdAt || 0).getTime();
      return (!action || item.action === action) && (!actorId || item.actorId === actorId) && (!actorName || item.actorName === actorName) &&
        (!from || Number.isNaN(from.getTime()) || created >= from.getTime()) && (!to || Number.isNaN(to.getTime()) || created <= to.getTime());
    });
    return { items: items.map(publicActivity), hasMore: false, nextCursor: null, membershipRequired: true, freeLimit: 20 };
  }
  const where = { familyId: access.family._id };
  if (action) where.action = action;
  if (actorId) where.actorId = actorId;
  if (actorName) where.actorName = actorName;
  const cursor = event.cursor ? new Date(event.cursor) : null;
  const lower = from && !Number.isNaN(from.getTime()) ? from : null;
  const upperCandidates = [to, cursor].filter(function (date) { return date && !Number.isNaN(date.getTime()); });
  const upper = upperCandidates.length ? new Date(Math.min.apply(null, upperCandidates.map(function (date) { return date.getTime(); }))) : null;
  if (lower && upper) where.createdAt = _.gte(lower).and(_.lt(upper));
  else if (lower) where.createdAt = _.gte(lower);
  else if (upper) where.createdAt = _.lt(upper);
  const result = await db.collection('audit_logs').where(where).orderBy('createdAt', 'desc').limit(size + 1).get();
  const rows = result.data || [];
  const items = rows.slice(0, size);
  return {
    items: items.map(publicActivity),
    hasMore: entitlement.active && rows.length > size,
    nextCursor: entitlement.active && rows.length > size && items.length ? items[items.length - 1].createdAt : null,
    membershipRequired: !entitlement.active,
    freeLimit: 20
  };
}

function publicBackupTask(task) {
  return {
    taskId: task._id,
    familyId: task.familyId,
    status: task.status || 'pending',
    progress: Math.max(0, Math.min(100, Number(task.progress) || 0)),
    parts: (task.parts || []).map(function (part, index) {
      return { index: index, fileName: part.fileName || ('有谱家庭备份-' + (index + 1) + '.zip'), size: Number(part.size) || 0 };
    }),
    unavailableMediaCount: Number(task.unavailableMediaCount) || 0,
    createdAt: task.createdAt || null,
    completedAt: task.completedAt || null,
    expiresAt: task.expiresAt || null,
    failureMessage: task.status === 'failed' ? cleanText(task.failureMessage, 160) : ''
  };
}

async function familyBackupCreate(event) {
  const openid = getOpenid();
  const user = await requireActiveUser(openid);
  const access = await requireMembership(event.familyId, ['admin'], db, openid);
  assert(commerce.entitlementFromFamily(access.family).active, 'MEMBERSHIP_REQUIRED', '完整家庭备份是会员权益，请先开通会员');
  const existing = await db.collection('export_tasks').where({ familyId: access.family._id, kind: 'family_backup' }).limit(30).get();
  const tasks = existing.data || [];
  assert(!tasks.some(function (task) { return ['pending', 'processing'].includes(task.status); }), 'BACKUP_IN_PROGRESS', '这份家谱已有备份正在生成');
  const latest = tasks.filter(function (task) { return task.completedAt; }).sort(function (left, right) {
    return new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime();
  })[0];
  assert(!latest || Date.now() - new Date(latest.completedAt).getTime() >= 7 * 24 * 60 * 60 * 1000, 'BACKUP_COOLDOWN', '完整备份每 7 天可生成一次');
  return mutate('family.backup.create', event, openid, async function (transaction) {
    const lockedFamily = await mustGet(transaction, 'families', access.family._id, 'FAMILY_NOT_FOUND', '家谱不存在或已删除');
    assert(!lockedFamily.backupTaskId, 'BACKUP_IN_PROGRESS', '这份家谱已有备份正在生成');
    assert(!lockedFamily.lastBackupCompletedAt || Date.now() - new Date(lockedFamily.lastBackupCompletedAt).getTime() >= 7 * 24 * 60 * 60 * 1000, 'BACKUP_COOLDOWN', '完整备份每 7 天可生成一次');
    const taskId = 'fexp_' + randomToken(18);
    await transaction.collection('export_tasks').doc(taskId).set({
      data: {
        kind: 'family_backup',
        familyId: access.family._id,
        familyName: access.family.name || '',
        userId: user._id,
        status: 'pending',
        progress: 0,
        parts: [],
        requestedAt: db.serverDate(),
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await transaction.collection('families').doc(access.family._id).update({ data: { backupTaskId: taskId, updatedAt: db.serverDate() } });
    return publicBackupTask({ _id: taskId, familyId: access.family._id, status: 'pending', progress: 0, parts: [], createdAt: new Date() });
  });
}

async function familyBackupStatus(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const task = await mustGet(db, 'export_tasks', cleanText(event.taskId, 80), 'BACKUP_NOT_FOUND', '家庭备份任务不存在');
  const access = await requireMembership(task.familyId, ['admin'], db, openid, { allowArchived: true });
  assert(task.kind === 'family_backup', 'BACKUP_NOT_FOUND', '家庭备份任务不存在');
  assert(commerce.entitlementFromFamily(access.family).active, 'MEMBERSHIP_REQUIRED', '完整家庭备份是会员权益，请先开通会员');
  return publicBackupTask(task);
}

async function familyBackupPartUrl(event) {
  const openid = getOpenid();
  await requireActiveUser(openid);
  const task = await mustGet(db, 'export_tasks', cleanText(event.taskId, 80), 'BACKUP_NOT_FOUND', '家庭备份任务不存在');
  const access = await requireMembership(task.familyId, ['admin'], db, openid, { allowArchived: true });
  assert(task.kind === 'family_backup' && task.status === 'completed', 'BACKUP_NOT_READY', '家庭备份尚未生成完成');
  assert(commerce.entitlementFromFamily(access.family).active, 'MEMBERSHIP_REQUIRED', '完整家庭备份是会员权益，请先开通会员');
  assert(task.expiresAt && new Date(task.expiresAt).getTime() > Date.now(), 'BACKUP_EXPIRED', '家庭备份领取时间已结束，请重新生成');
  const index = Math.max(0, Number(event.partIndex) || 0);
  const part = (task.parts || [])[index];
  assert(part && part.fileId, 'BACKUP_PART_NOT_FOUND', '备份分卷不存在');
  const result = await cloud.getTempFileURL({ fileList: [part.fileId] });
  const url = result.fileList && result.fileList[0] && result.fileList[0].tempFileURL;
  assert(url, 'BACKUP_URL_FAILED', '备份下载链接生成失败，请稍后重试');
  return { url: url, fileName: part.fileName, size: Number(part.size) || 0, expiresAt: task.expiresAt };
}

async function feedbackGroupGet() {
  const openid = getOpenid();
  await ensureUser(openid);
  const setting = await maybeGet(db, 'feedback_group_settings', 'active');
  if (!setting || !setting.fileId) return { available: false, qrCodeUrl: '' };
  try {
    const result = await cloud.getTempFileURL({ fileList: [setting.fileId] });
    const item = (result.fileList || [])[0] || {};
    return { available: Boolean(item.tempFileURL), qrCodeUrl: item.tempFileURL || '' };
  } catch (error) {
    return { available: false, qrCodeUrl: '' };
  }
}

const handlers = {
  'auth.login': authLogin,
  'auth.updateProfile': authUpdateProfile,
  'auth.updateAvatar': authUpdateAvatar,
  'account.export': accountExport,
  'account.exportStatus': accountExportStatus,
  'account.exportUrl': accountExportUrl,
  'account.requestDeletion': accountRequestDeletion,
  'account.cancelDeletion': accountCancelDeletion,
  'membership.catalog': membershipCatalog,
  'membership.status': membershipStatus,
  'payment.createOrder': paymentCreateOrder,
  'payment.clientCompleted': paymentClientCompleted,
  'payment.getOrder': paymentGetOrder,
  'payment.reconcileNow': paymentReconcileNow,
  'payment.listMine': paymentListMine,
  'payment.mockComplete': paymentMockComplete,
  'payment.mockRefund': paymentMockRefund,
  'family.create': familyCreate,
  'family.list': familyList,
  'family.update': familyUpdate,
  'family.archive': familyArchive,
  'family.restore': familyRestore,
  'family.dashboard': familyDashboard,
  'family.setPreference': familySetPreference,
  'family.markOnboardingShared': familyMarkOnboardingShared,
  'family.dismissShareReminder': familyDismissShareReminder,
  'family.activity.list': familyActivityList,
  'family.backup.create': familyBackupCreate,
  'family.backup.status': familyBackupStatus,
  'family.backup.partUrl': familyBackupPartUrl,
  'graph.get': graphGet,
  'membership.list': membershipList,
  'membership.updateRole': membershipUpdateRole,
  'membership.transferAdmin': membershipTransferAdmin,
  'membership.leave': membershipLeave,
  'person.get': personGet,
  'person.createRelated': personCreateRelated,
  'relation.linkExisting': relationLinkExisting,
  'relation.remove': relationRemove,
  'person.update': personUpdate,
  'person.delete': personDelete,
  'change.list': changeList,
  'change.review': changeReview,
  'invite.create': inviteCreate,
  'invite.list': inviteList,
  'invite.revoke': inviteRevoke,
  'invite.preview': invitePreview,
  'invite.accept': inviteAccept,
  'share.record': shareRecord,
  'report.create': reportCreate,
  'report.listMine': reportListMine,
  'media.prepare': mediaPrepare,
  'media.complete': mediaComplete,
  'media.getUrls': mediaGetUrls,
  'media.getStates': mediaGetStates,
  'media.getPresentation': mediaGetPresentation,
  'feedbackGroup.get': feedbackGroupGet,
  'examples.list': examplesList,
  'examples.get': examplesGet
};

exports.main = async function (event) {
  const startedAt = Date.now();
  const request = event || {};
  const type = cleanText(request.type, 80);
  const requestId = cleanText(request.requestId, 80) || randomToken(12);
  const context = cloud.getWXContext() || {};
  const anonymousActorId = context.OPENID ? userId(context.OPENID) : '';
  try {
    const handler = handlers[type];
    assert(handler, 'UNKNOWN_ACTION', '暂不支持这个操作');
    if (MUTATION_TYPES.has(type)) request.requestId = requestId;
    if (RATE_LIMITS[type]) await enforceRateLimit(getOpenid(), type);
    const data = await handler(request);
    console.log(JSON.stringify({ requestId: requestId, actorId: anonymousActorId, action: type, success: true, durationMs: Date.now() - startedAt, resultCode: 'OK' }));
    return success(data);
  } catch (error) {
    console.error(JSON.stringify({
      requestId: requestId,
      actorId: anonymousActorId,
      action: type,
      success: false,
      code: error.code || 'SERVER_ERROR',
      durationMs: Date.now() - startedAt,
      resultCode: error.code || 'SERVER_ERROR'
    }));
    return {
      success: false,
      code: error.code || 'SERVER_ERROR',
      message: error.code ? error.message : '服务暂时不可用，请稍后重试',
      details: error.details || null,
      requestId: requestId
    };
  }
};
