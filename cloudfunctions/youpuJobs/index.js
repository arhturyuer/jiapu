const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const subscriptionNotification = require('./subscription-notification');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const COLLECTIONS = [
  'users',
  'system_config',
  'families',
  'family_memberships',
  'user_family_preferences',
  'persons',
  'relations',
  'invitations',
  'change_requests',
  'audit_logs',
  'media_assets',
  'moderation_tasks',
  'reports',
  'notifications',
  'operators',
  'account_deletion_requests',
  'idempotency_records',
  'rate_limits',
  'export_tasks',
  'payment_orders',
  'payment_events',
  'membership_grants',
  'feedback_group_settings',
  'example_templates',
  'example_template_versions',
  'analytics_activity_daily',
  'analytics_daily',
  'analytics_reports',
  'analytics_snapshots',
  'analytics_snapshot_items',
  'analytics_history',
  'share_metrics_daily'
];

function hash(value, length) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length || 32);
}

async function deleteFilesStrict(fileIds) {
  const files = Array.from(new Set((fileIds || []).filter(Boolean)));
  if (!files.length) return;
  const result = await cloud.deleteFile({ fileList: files });
  const failed = (result.fileList || []).filter(function (item) {
    return item.status !== undefined && Number(item.status) !== 0;
  });
  if (failed.length) {
    const error = new Error('部分云存储文件删除失败');
    error.code = 'STORAGE_DELETE_FAILED';
    throw error;
  }
}

function assertAuthorized(event) {
  const expected = process.env.BOOTSTRAP_SECRET;
  const dispatchSecret = process.env.JOB_DISPATCH_SECRET;
  const context = cloud.getWXContext() || {};
  const hasUserIdentity = Boolean(context.OPENID || context.UNIONID || context.UID);
  const triggerName = event && (event.triggerName || event.TriggerName);
  const isKnownTimer = triggerName === 'youpu-retention-maintenance';
  const isTimer = event && (event.Type === 'Timer' || event.type === 'Timer' || isKnownTimer);
  if (isKnownTimer && isTimer && !hasUserIdentity) return;
  const isTaskDispatch = event && ['task.account-export', 'task.family-backup', 'task.notification'].includes(event.action || event.type);
  if (isTaskDispatch && !hasUserIdentity && dispatchSecret && event.internalSecret === dispatchSecret) return;
  if (!expected || expected === 'CHANGE_BEFORE_DEPLOY' || event.secret !== expected) {
    const error = new Error('后台任务鉴权失败');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
}

async function maybeGet(collectionName, id) {
  try {
    const result = await db.collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (error) {
    return null;
  }
}

async function ensureCollections(event) {
  const created = [];
  const existing = [];
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (error) {
      if (String(error.errMsg || error.message || '').toLowerCase().includes('exist')) {
        existing.push(name);
      } else {
        throw error;
      }
    }
  }
  await db.collection('system_config').doc('schema').set({
    data: {
      version: 10,
      graphPersonLimit: 500,
      archiveRetentionDays: 30,
      deletionCoolingDays: 7,
      updatedAt: db.serverDate()
    }
  });
  if (!await maybeGet('system_config', 'analytics')) {
    await db.collection('system_config').doc('analytics').set({ data: { trackingStartedAt: db.serverDate(), version: 1 } });
  }
  let initialOperator = null;
  const authUid = String((event && event.initialOperatorAuthUid) || '').trim().slice(0, 128);
  if (authUid) {
    const activeOperators = await db.collection('operators').where({ status: 'active' }).limit(1).get();
    if (!activeOperators.data || !activeOperators.data.length) {
      const operatorId = 'op_' + hash(authUid, 32);
      await db.collection('operators').doc(operatorId).set({
        data: {
          authUid: authUid,
          email: String(event.initialOperatorEmail || '').trim().toLowerCase().slice(0, 120),
          displayName: String(event.initialOperatorName || '初始超级管理员').trim().slice(0, 30),
          role: 'super_admin',
          status: 'active',
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
      initialOperator = operatorId;
    }
  }
  return { created: created, existing: existing, initialOperator: initialOperator };
}

async function updateMany(collectionName, where, data, limit) {
  let updated = 0;
  const hardLimit = limit || 1000;
  while (updated < hardLimit) {
    const page = await db.collection(collectionName).where(where).limit(100).get();
    if (!page.data || !page.data.length) break;
    for (const row of page.data) {
      await db.collection(collectionName).doc(row._id).update({ data: data });
      updated += 1;
    }
    if (page.data.length < 100) break;
  }
  return updated;
}

// 用于更新后仍然命中原查询的数据（例如同步成员展示资料）。
// 使用 skip 向后推进，避免始终重复更新第一页。
async function updateManyStable(collectionName, where, data, limit) {
  let updated = 0;
  const hardLimit = limit || 1000;
  while (updated < hardLimit) {
    const page = await db.collection(collectionName)
      .where(where)
      .skip(updated)
      .limit(Math.min(100, hardLimit - updated))
      .get();
    if (!page.data || !page.data.length) break;
    for (const row of page.data) {
      await db.collection(collectionName).doc(row._id).update({ data: data });
      updated += 1;
    }
    if (page.data.length < 100) break;
  }
  return updated;
}

async function removeMany(collectionName, where, limit) {
  let removed = 0;
  const hardLimit = limit || 2000;
  while (removed < hardLimit) {
    const page = await db.collection(collectionName).where(where).limit(100).get();
    if (!page.data || !page.data.length) break;
    for (const row of page.data) {
      await db.collection(collectionName).doc(row._id).remove();
      removed += 1;
    }
    if (page.data.length < 100) break;
  }
  return removed;
}

async function listAllForExport(collectionName, where, limit) {
  const hardLimit = limit || 50000;
  let offset = 0;
  const rows = [];
  while (rows.length < hardLimit) {
    const page = await db.collection(collectionName).where(where).skip(offset).limit(100).get();
    const items = page.data || [];
    rows.push.apply(rows, items);
    if (items.length < 100) return rows;
    offset += items.length;
  }
  const error = new Error('导出数据量超过当前任务安全上限，请联系微信客服');
  error.code = 'EXPORT_RESULT_LIMIT_EXCEEDED';
  throw error;
}

async function closeUserMemberships(userId) {
  let closed = 0;
  while (closed < 500) {
    const page = await db.collection('family_memberships').where({ userId: userId, status: 'active' }).limit(50).get();
    if (!page.data || !page.data.length) break;
    for (const item of page.data) {
      await db.runTransaction(async function (transaction) {
        const membershipResult = await transaction.collection('family_memberships').doc(item._id).get();
        const membership = membershipResult.data;
        if (!membership || membership.status !== 'active') return;
        await transaction.collection('family_memberships').doc(item._id).update({
          data: {
            status: 'account_deleted',
            displayName: '已注销用户',
            avatarAssetId: '',
            updatedAt: db.serverDate()
          }
        });
        if (membership.role === 'admin') {
          const familyResult = await transaction.collection('families').doc(membership.familyId).get();
          if (familyResult.data) {
            await transaction.collection('families').doc(membership.familyId).update({
              data: { adminCount: _.inc(-1), updatedAt: db.serverDate() }
            });
          }
        }
      });
      closed += 1;
    }
  }
  return closed;
}

async function anonymizeOwnedMedia(userId, anonymousActor) {
  let retained = 0;
  let deleted = 0;
  while (retained + deleted < 1000) {
    const page = await db.collection('media_assets').where({ ownerId: userId }).limit(50).get();
    if (!page.data || !page.data.length) break;
    const disposable = [];
    for (const asset of page.data) {
      const keepForFamily = Boolean(asset.familyId && asset.kind === 'person_avatar');
      if (keepForFamily) {
        await db.collection('media_assets').doc(asset._id).update({
          data: { ownerId: anonymousActor, ownershipStatus: 'account_anonymized', updatedAt: db.serverDate() }
        });
        retained += 1;
      } else {
        disposable.push(asset);
      }
    }
    if (disposable.length) {
      const fileIds = disposable.map(function (asset) { return asset.fileId; }).filter(Boolean);
      if (fileIds.length) await deleteFilesStrict(fileIds);
      for (const asset of disposable) {
        await db.collection('media_assets').doc(asset._id).update({
          data: {
            ownerId: anonymousActor,
            status: 'deleted',
            fileId: '',
            deletedAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        });
        deleted += 1;
      }
    }
  }
  return { retained: retained, deleted: deleted };
}

async function anonymizeUser(request) {
  const user = await maybeGet('users', request.userId);
  if (!user) {
    await db.collection('account_deletion_requests').doc(request._id).update({
      data: { status: 'completed', completedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    return { userId: request.userId, skipped: true };
  }
  const anonymousActor = 'deleted_' + hash(user._id + ':' + request._id, 24);
  const claimed = await db.runTransaction(async function (transaction) {
    const latestRequest = await transaction.collection('account_deletion_requests').doc(request._id).get();
    if (!latestRequest.data || latestRequest.data.status !== 'pending') return false;
    await transaction.collection('account_deletion_requests').doc(request._id).update({
      data: { status: 'processing', startedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    await transaction.collection('users').doc(user._id).update({
      data: {
        openid: _.remove(),
        nickName: '',
        avatarAssetId: '',
        status: 'deleted',
        anonymousActorId: anonymousActor,
        deletedAt: db.serverDate(),
        deletionRequestedAt: _.remove(),
        deletionExecuteAt: _.remove(),
        updatedAt: db.serverDate()
      }
    });
    return true;
  });
  if (!claimed) return { userId: request.userId, skipped: true, reason: 'already_claimed' };
  await closeUserMemberships(user._id);
  await updateMany('invitations', { createdBy: user._id, status: 'active' }, {
    status: 'revoked',
    revokedReason: 'account_deleted',
    revokedAt: db.serverDate(),
    updatedAt: db.serverDate()
  }, 1000);
  await updateMany('audit_logs', { actorId: user._id }, {
    actorId: anonymousActor,
    actorName: '已注销用户'
  }, 5000);
  await updateMany('payment_orders', { payerUserId: user._id }, {
    payerUserId: anonymousActor,
    payerAnalyticsId: user._id,
    payerAnonymizedAt: db.serverDate(),
    updatedAt: db.serverDate()
  }, 1000);
  await anonymizeOwnedMedia(user._id, anonymousActor);
  await db.collection('account_deletion_requests').doc(request._id).update({
    data: { status: 'completed', completedAt: db.serverDate(), updatedAt: db.serverDate() }
  });
  return { userId: request.userId, anonymousActorId: anonymousActor };
}

async function processDeletions() {
  const page = await db.collection('account_deletion_requests').where({
    status: 'pending',
    executeAt: _.lte(new Date())
  }).limit(20).get();
  const completed = [];
  const failed = [];
  for (const request of page.data || []) {
    try {
      completed.push(await anonymizeUser(request));
    } catch (error) {
      failed.push({ id: request._id, message: error.message });
      await db.collection('account_deletion_requests').doc(request._id).update({
        data: {
          status: 'failed',
          failureMessage: String(error.message || '').slice(0, 200),
          retryCount: _.inc(1),
          updatedAt: db.serverDate()
        }
      });
    }
  }
  return { completed: completed, failed: failed };
}

async function recoverStaleDeletions() {
  return updateMany('account_deletion_requests', {
    status: 'processing',
    startedAt: _.lte(new Date(Date.now() - 30 * 60 * 1000))
  }, {
    status: 'failed',
    failureMessage: '任务执行超时，等待人工重试',
    updatedAt: db.serverDate()
  }, 100);
}

async function claimFamilyDeletion(familyId, allowResume) {
  return db.runTransaction(async function (transaction) {
    const currentResult = await transaction.collection('families').doc(familyId).get();
    const current = currentResult.data;
    if (!current) return false;
    const archiveReady = current.status === 'archived' && current.purgeAt &&
      new Date(current.purgeAt).getTime() <= Date.now();
    const staleDeletion = allowResume && current.status === 'deleting' && current.deletionStartedAt &&
      new Date(current.deletionStartedAt).getTime() <= Date.now() - 30 * 60 * 1000;
    if (!archiveReady && !staleDeletion) return false;
    await transaction.collection('families').doc(familyId).update({
      data: { status: 'deleting', deletionStartedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    return true;
  });
}

async function deleteFamilyMediaFiles(familyId) {
  let deleted = 0;
  while (deleted < 1000) {
    const media = await db.collection('media_assets').where({
      familyId: familyId,
      fileId: _.neq('')
    }).limit(50).get();
    const assets = (media.data || []).filter(function (item) { return Boolean(item.fileId); });
    if (!assets.length) break;
    await deleteFilesStrict(assets.map(function (item) { return item.fileId; }));
    for (const asset of assets) {
      await db.collection('media_assets').doc(asset._id).update({
        data: { fileId: '', status: 'deleted', deletedAt: db.serverDate(), updatedAt: db.serverDate() }
      });
      deleted += 1;
    }
  }
  return deleted;
}

async function deleteFamilyBackupFiles(familyId) {
  const tasks = await listAllForExport('export_tasks', { familyId: familyId, kind: 'family_backup' }, 5000);
  const fileIds = [];
  tasks.forEach(function (task) {
    (task.parts || []).forEach(function (part) { if (part.fileId) fileIds.push(part.fileId); });
  });
  for (let index = 0; index < fileIds.length; index += 50) await deleteFilesStrict(fileIds.slice(index, index + 50));
  return fileIds.length;
}

async function preserveFamilyAnalytics(family) {
  const snapshot = {
    kind: 'family', entityId: family._id, createdAt: family.createdAt,
    creatorId: family.creatorId, status: 'deleted', cleaned: true,
    firstRelativeJoinedAt: family.firstRelativeJoinedAt || null
  };
  await db.collection('analytics_history').doc('family_' + family._id).set({ data: snapshot });
  let cursor = '';
  while (true) {
    const where = { familyId: family._id };
    if (cursor) where._id = _.gt(cursor);
    const page = await db.collection('family_memberships').where(where).orderBy('_id', 'asc').limit(100).get();
    for (const member of page.data || []) {
      await db.collection('analytics_history').doc('membership_' + member._id).set({ data: {
        kind: 'membership', entityId: member._id, familyId: family._id, userId: member.userId,
        firstJoinedAt: member.firstJoinedAt || member.joinedAt, joinedAt: member.joinedAt,
        status: 'deleted', cleaned: true
      } });
    }
    if (!page.data || page.data.length < 100) break;
    cursor = page.data[page.data.length - 1]._id;
  }
}

async function purgeFamily(family, allowResume) {
  const claimed = await claimFamilyDeletion(family._id, allowResume);
  if (!claimed) return { familyId: family._id, skipped: true };
  await preserveFamilyAnalytics(family);
  const deletedFiles = await deleteFamilyMediaFiles(family._id);
  const deletedBackupFiles = await deleteFamilyBackupFiles(family._id);
  const collections = [
    'family_memberships',
    'user_family_preferences',
    'persons',
    'relations',
    'invitations',
    'change_requests',
    'media_assets',
    'moderation_tasks',
    'reports',
    'notifications',
    'audit_logs',
    'membership_grants',
    'export_tasks'
  ];
  const removed = {};
  for (const collectionName of collections) {
    removed[collectionName] = await removeMany(collectionName, { familyId: family._id }, 5000);
  }
  await updateMany('payment_orders', { familyId: family._id, status: 'pending' }, {
    status: 'closed', closeReason: 'family_deleted', closedAt: db.serverDate(), updatedAt: db.serverDate()
  }, 5000);
  await updateManyStable('payment_orders', { familyId: family._id }, {
    familyDeletedAt: db.serverDate(), updatedAt: db.serverDate()
  }, 5000);
  await db.collection('families').doc(family._id).remove();
  return { familyId: family._id, deletedFiles: deletedFiles, deletedBackupFiles: deletedBackupFiles, removed: removed };
}

async function purgeArchivedFamilies() {
  const page = await db.collection('families').where({
    status: 'archived',
    purgeAt: _.lte(new Date())
  }).limit(2).get();
  const results = [];
  for (const family of page.data || []) results.push(await purgeFamily(family, false));
  const stale = await db.collection('families').where({
    status: 'deleting',
    deletionStartedAt: _.lte(new Date(Date.now() - 30 * 60 * 1000))
  }).limit(2).get();
  for (const family of stale.data || []) results.push(await purgeFamily(family, true));
  return results;
}

async function cleanTemporaryData() {
  const removedIdempotency = await removeMany('idempotency_records', { expiresAt: _.lte(new Date()) }, 2000);
  const removedRateLimits = await removeMany('rate_limits', { expiresAt: _.lte(new Date()) }, 2000);
  const rejectedMedia = await db.collection('media_assets').where({
    moderationStatus: 'rejected',
    retainForInvestigation: _.neq(true),
    updatedAt: _.lte(new Date(Date.now() - 24 * 60 * 60 * 1000))
  }).limit(100).get();
  // Operator-enforced violations are retained for investigation, rather than
  // being swept up by the normal 24-hour rejected-media cleanup.
  const disposableRejectedMedia = rejectedMedia.data || [];
  const fileIds = disposableRejectedMedia.map(function (item) { return item.fileId; }).filter(Boolean);
  let mediaCleanupSucceeded = true;
  if (fileIds.length) {
    try {
      await deleteFilesStrict(fileIds);
    } catch (error) {
      mediaCleanupSucceeded = false;
      console.error(JSON.stringify({ action: 'cleanup.rejected_media', resultCode: error.code || 'STORAGE_DELETE_FAILED' }));
    }
  }
  if (mediaCleanupSucceeded) {
    for (const asset of disposableRejectedMedia) {
      await db.collection('media_assets').doc(asset._id).update({
        data: { status: 'deleted', fileId: '', deletedAt: db.serverDate(), updatedAt: db.serverDate() }
      });
    }
  }
  const resolvedText = await db.collection('moderation_tasks').where({
    type: 'text',
    status: _.in(['approved', 'rejected']),
    updatedAt: _.lte(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
  }).limit(100).get();
  for (const task of resolvedText.data || []) {
    if (!task.content) continue;
    await db.collection('moderation_tasks').doc(task._id).update({
      data: { content: _.remove(), contentPurgedAt: db.serverDate() }
    });
  }
  return {
    removedIdempotency: removedIdempotency,
    removedRateLimits: removedRateLimits,
    removedMedia: mediaCleanupSucceeded ? disposableRejectedMedia.length : 0,
    purgedTextBodies: (resolvedText.data || []).filter(function (item) { return Boolean(item.content); }).length
  };
}

async function familyNameMap(memberships, changes) {
  const ids = new Set();
  (memberships || []).forEach(function (item) { if (item.familyId) ids.add(item.familyId); });
  (changes || []).forEach(function (item) { if (item.familyId) ids.add(item.familyId); });
  const names = {};
  for (const familyId of ids) {
    const family = await maybeGet('families', familyId);
    names[familyId] = family && family.name ? String(family.name).slice(0, 40) : '已删除家谱';
  }
  return names;
}

async function buildAccountExport(task) {
  const user = await maybeGet('users', task.userId);
  if (!user || user.status === 'deleted') {
    const error = new Error('账户已注销，无法生成导出文件');
    error.code = 'EXPORT_ACCOUNT_UNAVAILABLE';
    throw error;
  }
  const memberships = await listAllForExport('family_memberships', { userId: task.userId }, 50000);
  const changes = await listAllForExport('change_requests', { createdBy: task.userId }, 50000);
  const reports = await listAllForExport('reports', { reporterId: task.userId }, 50000);
  const familyNames = await familyNameMap(memberships, changes);
  return {
    exportedAt: new Date().toISOString(),
    account: {
      nickName: user.nickName || '',
      status: user.status || 'active',
      createdAt: user.createdAt || null
    },
    memberships: memberships.map(function (item) {
      return {
        familyName: familyNames[item.familyId] || '已删除家谱',
        role: item.role || 'viewer',
        status: item.status || '',
        joinedAt: item.joinedAt || null
      };
    }),
    changeRequests: changes.map(function (item) {
      return {
        familyName: familyNames[item.familyId] || '已删除家谱',
        type: item.type || '',
        status: item.status || '',
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null
      };
    }),
    reports: reports.map(function (item) {
      return {
        targetType: item.targetType || '',
        status: item.status || '',
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null
      };
    })
  };
}

async function claimExportTask(taskId, kind) {
  return db.runTransaction(async function (transaction) {
    let result;
    try {
      result = await transaction.collection('export_tasks').doc(taskId).get();
    } catch (error) {
      const message = String(error && (error.errMsg || error.message) || '').toLowerCase();
      if (message.includes('does not exist') || message.includes('not found') || message.includes('document_not_exist')) return null;
      throw error;
    }
    const task = result.data;
    if (!task || task.status !== 'pending') return null;
    if (kind === 'family_backup' && task.kind !== 'family_backup') return null;
    if (kind === 'account_export' && task.kind === 'family_backup') return null;
    await transaction.collection('export_tasks').doc(taskId).update({
      data: {
        status: 'processing',
        startedAt: db.serverDate(),
        failureCode: _.remove(),
        failureMessage: _.remove(),
        failedAt: _.remove(),
        updatedAt: db.serverDate()
      }
    });
    return task;
  });
}

async function processAccountExportTask(taskId) {
  const task = await claimExportTask(taskId, 'account_export');
  if (!task) return { taskId: taskId, skipped: true, reason: 'already_claimed' };
  try {
    const payload = await buildAccountExport(task);
    const content = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const cloudPath = ['exports', task.userId, taskId + '.json'].join('/');
    const uploaded = await cloud.uploadFile({ cloudPath: cloudPath, fileContent: content });
    if (!uploaded || !uploaded.fileID) throw new Error('导出文件上传失败');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.collection('export_tasks').doc(taskId).update({
      data: {
        status: 'completed', fileId: uploaded.fileID, cloudPath: cloudPath, size: content.length,
        completedAt: db.serverDate(), expiresAt: expiresAt, updatedAt: db.serverDate()
      }
    });
    return { taskId: taskId, completed: true };
  } catch (error) {
    await db.collection('export_tasks').doc(taskId).update({
      data: {
        status: 'failed', failureMessage: String(error.message || '导出任务失败').slice(0, 160),
        failedAt: db.serverDate(), updatedAt: db.serverDate()
      }
    });
    return { taskId: taskId, completed: false };
  }
}

function csvCell(value) {
  let output = value;
  if (value instanceof Date) output = value.toISOString();
  else if (value && typeof value === 'object') output = JSON.stringify(value);
  output = String(output === undefined || output === null ? '' : output);
  if (/^[=+\-@]/.test(output)) output = '\'' + output;
  return '"' + output.replace(/"/g, '""') + '"';
}

function toCsv(rows, columns) {
  const header = columns.map(function (column) { return csvCell(column.label); }).join(',');
  const body = (rows || []).map(function (row) {
    return columns.map(function (column) { return csvCell(row[column.key]); }).join(',');
  });
  return '\uFEFF' + [header].concat(body).join('\r\n');
}

function safeFileName(value, fallback) {
  const cleaned = String(value || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80);
  return cleaned || fallback;
}

function zipBuffer(entries) {
  return new Promise(function (resolve, reject) {
    const output = new PassThrough(); const chunks = [];
    output.on('data', function (chunk) { chunks.push(chunk); });
    output.on('end', function () { resolve(Buffer.concat(chunks)); });
    output.on('error', reject);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', function (error) { if (error.code !== 'ENOENT') reject(error); });
    archive.on('error', reject);
    archive.pipe(output);
    entries.forEach(function (entry) { archive.append(entry.content, { name: entry.name }); });
    archive.finalize().catch(reject);
  });
}

async function familyBackupDataset(task) {
  const family = await maybeGet('families', task.familyId);
  if (!family || family.status === 'deleted') throw new Error('家谱已永久删除，无法生成备份');
  const persons = await listAllForExport('persons', { familyId: task.familyId }, 50000);
  const relations = await listAllForExport('relations', { familyId: task.familyId }, 100000);
  const memberships = await listAllForExport('family_memberships', { familyId: task.familyId }, 50000);
  const changes = await listAllForExport('change_requests', { familyId: task.familyId }, 50000);
  const history = await listAllForExport('audit_logs', { familyId: task.familyId }, 100000);
  const media = await listAllForExport('media_assets', { familyId: task.familyId }, 50000);
  const userNames = {};
  for (const membership of memberships) {
    const user = membership.userId ? await maybeGet('users', membership.userId) : null;
    userNames[membership.userId] = user && user.status !== 'deleted' ? (user.nickName || '一位家人') : '已注销成员';
  }
  const approvedMedia = media.filter(function (item) { return item.status === 'active' && item.moderationStatus === 'approved' && Boolean(item.fileId); });
  const unavailable = media.filter(function (item) { return !(item.status === 'active' && item.moderationStatus === 'approved' && item.fileId); }).map(function (item) { return item._id; });
  const exportedAt = new Date().toISOString();
  const entries = [
    { name: '家谱信息.json', content: Buffer.from(JSON.stringify({ name: family.name || '', description: family.description || '', status: family.status || '', createdAt: family.createdAt || null, exportedAt: exportedAt }, null, 2)) },
    { name: '人物.csv', content: Buffer.from(toCsv(persons.map(function (item) { return { id: item._id, name: item.name, gender: item.gender, lifeStatus: item.lifeStatus, birthDate: item.birthDate, deathDate: item.deathDate, birthDateInfo: item.birthDateInfo ? JSON.stringify(item.birthDateInfo) : '', deathDateInfo: item.deathDateInfo ? JSON.stringify(item.deathDateInfo) : '', birthPlace: item.birthPlace, bio: item.bio, status: item.status }; }), [
      { key: 'id', label: '人物ID' }, { key: 'name', label: '姓名' }, { key: 'gender', label: '性别' }, { key: 'lifeStatus', label: '生存状态' }, { key: 'birthDate', label: '出生日期（公历）' }, { key: 'deathDate', label: '离世日期（公历）' }, { key: 'birthDateInfo', label: '出生时间原始历法和精度' }, { key: 'deathDateInfo', label: '离世时间原始历法和精度' }, { key: 'birthPlace', label: '出生地' }, { key: 'bio', label: '生平' }, { key: 'status', label: '状态' }
    ]), 'utf8') },
    { name: '关系.csv', content: Buffer.from(toCsv(relations.map(function (item) { return { id: item._id, type: item.type, from: item.fromPersonId, to: item.toPersonId, childOrder: item.childOrder, childOrderUpdatedAt: item.childOrderUpdatedAt, status: item.status }; }), [
      { key: 'id', label: '关系ID' }, { key: 'type', label: '关系类型' }, { key: 'from', label: '人物一' }, { key: 'to', label: '人物二' }, { key: 'childOrder', label: '子女排行顺序' }, { key: 'childOrderUpdatedAt', label: '排行更新时间' }, { key: 'status', label: '状态' }
    ]), 'utf8') },
    { name: '协作者.csv', content: Buffer.from(toCsv(memberships.map(function (item) { return { name: userNames[item.userId] || '一位家人', role: item.role, status: item.status, joinedAt: item.joinedAt }; }), [
      { key: 'name', label: '昵称' }, { key: 'role', label: '角色' }, { key: 'status', label: '状态' }, { key: 'joinedAt', label: '加入时间' }
    ]), 'utf8') },
    { name: '修改申请.csv', content: Buffer.from(toCsv(changes.map(function (item) { return { type: item.type, title: item.title, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt }; }), [
      { key: 'type', label: '类型' }, { key: 'title', label: '摘要' }, { key: 'status', label: '状态' }, { key: 'createdAt', label: '创建时间' }, { key: 'updatedAt', label: '更新时间' }
    ]), 'utf8') },
    { name: '完整变更历史.csv', content: Buffer.from(toCsv(history.map(function (item) { return { actorName: item.actorName || '一位家人', action: item.action, objectType: item.objectType, summary: item.summary, createdAt: item.createdAt }; }), [
      { key: 'actorName', label: '操作者' }, { key: 'action', label: '操作类型' }, { key: 'objectType', label: '对象类型' }, { key: 'summary', label: '摘要' }, { key: 'createdAt', label: '时间' }
    ]), 'utf8') }
  ];
  return { family: family, baseEntries: entries, media: approvedMedia, unavailable: unavailable, exportedAt: exportedAt };
}

async function buildFamilyBackup(task) {
  const dataset = await familyBackupDataset(task);
  const maxPartBytes = 100 * 1024 * 1024;
  const targetBytes = 92 * 1024 * 1024;
  const groups = [[]]; let currentSize = dataset.baseEntries.reduce(function (sum, item) { return sum + item.content.length; }, 0);
  dataset.media.forEach(function (asset) {
    const size = Math.max(1, Number(asset.size) || 5 * 1024 * 1024);
    if (groups[groups.length - 1].length && currentSize + size > targetBytes) { groups.push([]); currentSize = 0; }
    groups[groups.length - 1].push(asset); currentSize += size;
  });
  const uploadedParts = []; const missing = dataset.unavailable.slice();
  for (let partIndex = 0; partIndex < groups.length; partIndex += 1) {
    const partMedia = groups[partIndex];
    const entries = partIndex === 0 ? dataset.baseEntries.slice() : [];
    const manifest = { schemaVersion: 1, familyName: dataset.family.name || '', exportedAt: dataset.exportedAt, part: partIndex + 1, partCount: groups.length, includedMedia: [], missingOrReviewMedia: missing };
    for (const asset of partMedia) {
      try {
        const downloaded = await cloud.downloadFile({ fileID: asset.fileId });
        const extension = asset.extension || (asset.mimeType === 'image/png' ? '.png' : '.jpg');
        const mediaName = '家庭图片/' + safeFileName(asset._id, 'image') + (String(extension).charAt(0) === '.' ? extension : '.' + extension);
        entries.push({ name: mediaName, content: downloaded.fileContent });
        manifest.includedMedia.push({ assetId: asset._id, fileName: mediaName, kind: asset.kind || 'family_image' });
      } catch (error) { missing.push(asset._id); }
    }
    manifest.missingOrReviewMedia = Array.from(new Set(missing));
    entries.unshift({ name: 'manifest.json', content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
    const buffer = await zipBuffer(entries);
    if (buffer.length > maxPartBytes) throw new Error('单个备份分卷超过 100MB，请联系微信客服');
    const fileName = safeFileName(dataset.family.name, '家庭') + '-有谱完整备份-' + String(partIndex + 1).padStart(2, '0') + '.zip';
    const cloudPath = ['family-backups', task.familyId, task._id, fileName].join('/');
    const upload = await cloud.uploadFile({ cloudPath: cloudPath, fileContent: buffer });
    if (!upload || !upload.fileID) throw new Error('备份分卷上传失败');
    uploadedParts.push({ fileId: upload.fileID, cloudPath: cloudPath, fileName: fileName, size: buffer.length });
    await db.collection('export_tasks').doc(task._id).update({ data: { progress: Math.round((partIndex + 1) / groups.length * 95), parts: uploadedParts, unavailableMediaCount: missing.length, updatedAt: db.serverDate() } });
  }
  return { parts: uploadedParts, unavailableMediaCount: Array.from(new Set(missing)).length };
}

async function processFamilyBackupTask(taskId) {
  const task = await claimExportTask(taskId, 'family_backup');
  if (!task) return { taskId: taskId, skipped: true, reason: 'already_claimed' };
  try {
    const family = await maybeGet('families', task.familyId);
    if (!hasActiveMembership(family)) throw new Error('家庭会员已失效，未生成完整备份');
    const result = await buildFamilyBackup(Object.assign({ _id: taskId }, task));
    await db.collection('export_tasks').doc(taskId).update({ data: { status: 'completed', progress: 100, parts: result.parts, unavailableMediaCount: result.unavailableMediaCount, completedAt: db.serverDate(), expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000), updatedAt: db.serverDate() } });
    await db.collection('families').doc(task.familyId).update({ data: { backupTaskId: '', lastBackupCompletedAt: db.serverDate(), updatedAt: db.serverDate() } });
    return { taskId: taskId, completed: true };
  } catch (error) {
    await db.collection('export_tasks').doc(taskId).update({ data: { status: 'failed', failureMessage: String(error.message || '家庭备份生成失败').slice(0, 160), failedAt: db.serverDate(), updatedAt: db.serverDate() } });
    await db.collection('families').doc(task.familyId).update({ data: { backupTaskId: '', updatedAt: db.serverDate() } }).catch(function () {});
    return { taskId: taskId, completed: false };
  }
}

function hasActiveMembership(family, now) {
  if (!family || family.status !== 'active') return false;
  if (family.proLifetime) return true;
  const expiresAt = family.proExpiresAt ? new Date(family.proExpiresAt) : null;
  return Boolean(expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > (now || Date.now()));
}

async function expireExportTasks() {
  const page = await db.collection('export_tasks').where({
    status: _.in(['completed', 'download_issued']),
    expiresAt: _.lte(new Date())
  }).limit(50).get();
  const fileIds = [];
  (page.data || []).forEach(function (task) {
    if (task.fileId) fileIds.push(task.fileId);
    (task.parts || []).forEach(function (part) { if (part.fileId) fileIds.push(part.fileId); });
  });
  for (let index = 0; index < fileIds.length; index += 50) await deleteFilesStrict(fileIds.slice(index, index + 50));
  for (const task of page.data || []) {
    await db.collection('export_tasks').doc(task._id).update({
      data: { status: 'expired', fileId: '', parts: [], expiredAt: db.serverDate(), updatedAt: db.serverDate() }
    });
  }
  return (page.data || []).length;
}

async function recoverStaleExportTasks() {
  const page = await db.collection('export_tasks').where({
    status: 'processing',
    startedAt: _.lte(new Date(Date.now() - 30 * 60 * 1000))
  }).limit(50).get();
  let recovered = 0;
  for (const task of page.data || []) {
    const fileIds = [];
    if (task.fileId) fileIds.push(task.fileId);
    (task.parts || []).forEach(function (part) { if (part.fileId) fileIds.push(part.fileId); });
    for (let index = 0; index < fileIds.length; index += 50) {
      await deleteFilesStrict(fileIds.slice(index, index + 50)).catch(function () {});
    }
    await db.collection('export_tasks').doc(task._id).update({ data: {
      status: 'failed', fileId: '', parts: [], failureMessage: '后台任务执行超时，请重新申请',
      failedAt: db.serverDate(), updatedAt: db.serverDate()
    } });
    if (task.kind === 'family_backup' && task.familyId) {
      await db.collection('families').doc(task.familyId).update({
        data: { backupTaskId: '', updatedAt: db.serverDate() }
      }).catch(function () {});
    }
    recovered += 1;
  }
  return recovered;
}

async function processNotificationEvent(eventId) {
  const notification = await maybeGet('notifications', eventId);
  if (!notification || notification.kind !== 'subscription_event' || notification.status !== 'pending') return { processed: false };
  const state = String(process.env.NOTIFY_MINIPROGRAM_STATE || '');
  const templates = subscriptionNotification.templateConfig();
  const template = templates[notification.notificationType];
  if (!template || !['developer', 'trial', 'formal'].includes(state)) {
    await db.collection('notifications').doc(eventId).update({ data: { status: 'unavailable', resultCode: 'TEMPLATE_NOT_CONFIGURED', updatedAt: db.serverDate() } });
    return { processed: false, unavailable: true };
  }
  const family = await maybeGet('families', notification.familyId);
  const source = notification.notificationType === 'join'
    ? await maybeGet('family_memberships', notification.sourceId)
    : await maybeGet('change_requests', notification.sourceId);
  if (!family || family.status !== 'active' || !source || source.familyId !== notification.familyId ||
    (notification.notificationType === 'join' ? source.status !== 'active' : source.status !== 'pending')) {
    await db.collection('notifications').doc(eventId).update({ data: { status: 'skipped', resultCode: 'EVENT_NO_LONGER_ACTIVE', updatedAt: db.serverDate() } });
    return { processed: false, skipped: true };
  }
  const sourceUser = notification.notificationType === 'join' ? await maybeGet('users', source.userId) : null;
  const memberships = await listAllForExport('family_memberships', { familyId: notification.familyId, status: 'active' }, 50000);
  const recipientIds = subscriptionNotification.recipients(notification, memberships);
  let sent = 0;
  for (const recipientId of recipientIds) {
    const recipient = await maybeGet('users', recipientId);
    if (!recipient || recipient.status !== 'active' || !recipient.openid) continue;
    const deliveryId = 'nd_' + hash(eventId + ':' + recipientId, 40);
    const claimed = await db.runTransaction(async function (transaction) {
      let existing = null;
      try {
        const result = await transaction.collection('notifications').doc(deliveryId).get();
        existing = result.data || null;
      } catch (error) {}
      if (existing) return false;
      await transaction.collection('notifications').doc(deliveryId).set({ data: {
        kind: 'subscription_delivery', familyId: notification.familyId, eventId: eventId,
        recipientId: recipientId, status: 'sending', createdAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      return true;
    });
    if (!claimed) continue;
    const latestFamily = await maybeGet('families', notification.familyId);
    const latestSource = notification.notificationType === 'review' ? await maybeGet('change_requests', notification.sourceId) : source;
    const membership = memberships.find(function (item) { return item.userId === recipientId; });
    const latestMembership = membership ? await maybeGet('family_memberships', membership._id) : null;
    if (!latestFamily || latestFamily.status !== 'active' || !latestSource ||
      (notification.notificationType === 'review' && latestSource.status !== 'pending') ||
      !latestMembership || latestMembership.status !== 'active' ||
      (latestMembership.role !== 'admin' && !(notification.notificationType === 'join' && recipientId === notification.inviterId))) {
      await db.collection('notifications').doc(deliveryId).update({ data: { status: 'skipped', resultCode: 'RECIPIENT_NO_LONGER_ELIGIBLE', updatedAt: db.serverDate() } });
      continue;
    }
    const payload = subscriptionNotification.messagePayload(notification, family, source, template, sourceUser || {}, state);
    payload.touser = recipient.openid;
    try {
      const response = await cloud.openapi.subscribeMessage.send(payload);
      const code = Number(response && (response.errCode !== undefined ? response.errCode : response.errcode) || 0);
      await db.collection('notifications').doc(deliveryId).update({ data: {
        status: code === 0 ? 'sent' : 'failed', resultCode: String(code), updatedAt: db.serverDate()
      } });
      if (code === 0) sent += 1;
    } catch (error) {
      await db.collection('notifications').doc(deliveryId).update({ data: {
        status: 'failed', resultCode: String(error.errCode || error.errcode || error.code || 'SEND_FAILED').slice(0, 80), updatedAt: db.serverDate()
      } });
    }
  }
  await db.collection('notifications').doc(eventId).update({ data: { status: 'completed', sentCount: sent, updatedAt: db.serverDate() } });
  return { processed: true, sent: sent };
}

async function recoverPendingNotifications() {
  const result = await db.collection('notifications').where({ kind: 'subscription_event', status: 'pending' }).limit(20).get();
  for (const notification of result.data || []) await processNotificationEvent(notification._id);
  return (result.data || []).length;
}

async function retentionRun() {
  return {
    pendingNotifications: await recoverPendingNotifications(),
    recoveredDeletions: await recoverStaleDeletions(),
    deletions: await processDeletions(),
    archivedFamilies: await purgeArchivedFamilies(),
    cleanup: await cleanTemporaryData(),
    analyticsSnapshots: await removeMany('analytics_snapshots', { expiresAt: _.lt(new Date()) }, 5000),
    analyticsSnapshotItems: await removeMany('analytics_snapshot_items', { expiresAt: _.lt(new Date()) }, 5000),
    analyticsReports: await removeMany('analytics_reports', { expiresAt: _.lt(new Date()) }, 5000),
    staleExports: await recoverStaleExportTasks(),
    expiredExports: await expireExportTasks()
  };
}

function assertTrustedModerationCallback(event) {
  const context = cloud.getWXContext() || {};
  if (context.OPENID || context.UNIONID || context.UID) assertAuthorized(event);
}

async function moderationCallback(event) {
  assertTrustedModerationCallback(event);
  const traceId = event.traceId || event.trace_id || (event.result && event.result.trace_id);
  const suggest = event.suggest || (event.result && event.result.suggest) || 'review';
  if (!traceId) throw new Error('missing trace id');
  const result = await db.collection('media_assets').where({ traceId: traceId }).limit(1).get();
  if (!result.data || !result.data.length) return { matched: false };
  const asset = result.data[0];
  const moderationStatus = suggest === 'pass' ? 'approved' : (suggest === 'risky' ? 'rejected' : 'review');
  const taskId = 'mt_' + asset._id;
  // Review-mode uploads are admitted immediately. The callback is retained as
  // an audit signal, but must not change their visibility or recorded approval.
  if (asset.moderationMode === 'review') {
    await db.collection('media_assets').doc(asset._id).update({
      data: {
        machineDecision: suggest,
        moderationResult: event.result || { suggest: suggest },
        machineModeratedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await db.collection('moderation_tasks').doc(taskId).update({
      data: {
        machineDecision: suggest,
        result: event.result || { suggest: suggest },
        machineModeratedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    return { matched: true, assetId: asset._id, status: asset.moderationStatus, reviewMode: true };
  }
  await db.collection('media_assets').doc(asset._id).update({
    data: {
      moderationStatus: moderationStatus,
      status: moderationStatus === 'approved' ? 'active' : 'pending',
      moderationResult: event.result || { suggest: suggest },
      moderatedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  await db.collection('moderation_tasks').doc(taskId).set({
    data: {
      familyId: asset.familyId || '',
      assetId: asset._id,
      traceId: traceId,
      type: 'image',
      status: moderationStatus,
      admissionMode: asset.moderationMode || 'strict',
      reviewSource: 'machine',
      machineDecision: suggest,
      result: event.result || { suggest: suggest },
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  return { matched: true, assetId: asset._id, status: moderationStatus };
}

exports.main = async function (event) {
  const startedAt = Date.now();
  const request = event || {};
  const action = request.action || request.type;
  // CloudBase timer events use TriggerName in some runtime versions and
  // triggerName in others. Accept both without relaxing non-timer access.
  const triggerName = request.triggerName || request.TriggerName;
  const requestId = String(request.requestId || crypto.randomBytes(8).toString('hex')).slice(0, 80);
  try {
    if (action === 'moderation.callback' || request.traceId || request.trace_id) {
      const data = await moderationCallback(request);
      console.log(JSON.stringify({ requestId: requestId, actorId: 'system', action: 'moderation.callback', success: true, durationMs: Date.now() - startedAt, resultCode: 'OK' }));
      return { success: true, data: data, requestId: requestId };
    }
    assertAuthorized(request);
    let data;
    let resolvedAction = action;
    if (action === 'system.bootstrap') data = await ensureCollections(request);
    if (triggerName === 'youpu-retention-maintenance') {
      resolvedAction = 'maintenance.retention';
      data = await retentionRun();
    }
    if (!data && action === 'task.account-export') {
      resolvedAction = action;
      data = await processAccountExportTask(String(request.taskId || '').trim().slice(0, 80));
    }
    if (!data && action === 'task.family-backup') {
      resolvedAction = action;
      data = await processFamilyBackupTask(String(request.taskId || '').trim().slice(0, 80));
    }
    if (!data && action === 'task.notification') {
      resolvedAction = action;
      data = await processNotificationEvent(String(request.taskId || '').trim().slice(0, 80));
    }
    if (!data && action === 'maintenance.run') {
      resolvedAction = 'maintenance.run';
      data = await retentionRun();
    }
    if (!data) throw new Error('unknown job action');
    console.log(JSON.stringify({ requestId: requestId, actorId: 'system', action: resolvedAction, success: true, durationMs: Date.now() - startedAt, resultCode: 'OK' }));
    return { success: true, data: data, requestId: requestId };
  } catch (error) {
    console.error(JSON.stringify({ requestId: requestId, actorId: 'system', action: action || 'unknown', success: false, durationMs: Date.now() - startedAt, resultCode: error.code || 'JOB_FAILED' }));
    return { success: false, code: error.code || 'JOB_FAILED', message: error.message || '后台任务执行失败', requestId: requestId };
  }
};
