const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const archiver = require('archiver');
const { PassThrough } = require('stream');

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
  'backup_manifests',
  'profile_sync_tasks',
  'rate_limits',
  'export_tasks',
  'payment_orders',
  'payment_events',
  'membership_grants',
  'commerce_metrics_daily',
  'feedback_group_settings',
  'example_templates',
  'example_template_versions',
  'share_metrics_daily'
];

function hash(value, length) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length || 32);
}

function paymentNotifyFunctionName() {
  return String(process.env.PAYMENT_MODE || '').toLowerCase() === 'live'
    ? 'youpuPaymentNotifyV2'
    : 'youpuPaymentNotify';
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
  const context = cloud.getWXContext() || {};
  const hasUserIdentity = Boolean(context.OPENID || context.UNIONID || context.UID);
  const triggerName = event && (event.triggerName || event.TriggerName);
  const isKnownTimer = event && [
    'youpu-frequent-maintenance',
    'youpu-profile-maintenance',
    'youpu-hourly-maintenance',
    'youpu-daily-maintenance'
  ].includes(triggerName);
  const isTimer = event && (event.Type === 'Timer' || event.type === 'Timer' || isKnownTimer);
  if (isTimer && !hasUserIdentity) return;
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
      version: 8,
      graphPersonLimit: 500,
      archiveRetentionDays: 30,
      deletionCoolingDays: 7,
      updatedAt: db.serverDate()
    }
  });
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

async function syncProfiles() {
  const page = await db.collection('profile_sync_tasks').where({ status: 'pending' }).limit(20).get();
  let synced = 0;
  for (const task of page.data || []) {
    try {
      await updateManyStable('family_memberships', { userId: task.userId, status: 'active' }, {
        displayName: task.displayName || '家人',
        avatarAssetId: task.avatarAssetId || '',
        updatedAt: db.serverDate()
      }, 500);
      await db.collection('profile_sync_tasks').doc(task._id).update({
        data: { status: 'completed', completedAt: db.serverDate(), updatedAt: db.serverDate() }
      });
      synced += 1;
    } catch (error) {
      await db.collection('profile_sync_tasks').doc(task._id).update({
        data: { status: 'failed', errorCode: 'SYNC_FAILED', updatedAt: db.serverDate() }
      });
    }
  }
  return { processed: (page.data || []).length, synced: synced };
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

async function expireInvitations() {
  const now = new Date();
  const expired = await updateMany('invitations', {
    status: 'active',
    expiresAt: _.lte(now)
  }, {
    status: 'expired',
    updatedAt: db.serverDate()
  }, 1000);
  const activePage = await db.collection('invitations').where({ status: 'active' }).limit(100).get();
  let exhausted = 0;
  for (const invitation of activePage.data || []) {
    if ((invitation.useCount || 0) < invitation.maxUses) continue;
    await db.collection('invitations').doc(invitation._id).update({
      data: { status: 'exhausted', updatedAt: db.serverDate() }
    });
    exhausted += 1;
  }
  return { expired: expired, exhausted: exhausted };
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

async function purgeFamily(family, allowResume) {
  const claimed = await claimFamilyDeletion(family._id, allowResume);
  if (!claimed) return { familyId: family._id, skipped: true };
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

async function claimExportTask(taskId) {
  return db.runTransaction(async function (transaction) {
    const result = await transaction.collection('export_tasks').doc(taskId).get();
    const task = result.data;
    if (!task || task.status !== 'pending') return null;
    await transaction.collection('export_tasks').doc(taskId).update({
      data: { status: 'processing', startedAt: db.serverDate(), updatedAt: db.serverDate() }
    });
    return task;
  });
}

async function processExportTasks() {
  const page = await db.collection('export_tasks').where({ status: 'pending' }).limit(2).get();
  const completed = [];
  const failed = [];
  for (const queued of page.data || []) {
    if (queued.kind === 'family_backup') continue;
    const task = await claimExportTask(queued._id);
    if (!task) continue;
    try {
      const payload = await buildAccountExport(task);
      const content = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
      const cloudPath = ['exports', task.userId, queued._id + '.json'].join('/');
      const uploaded = await cloud.uploadFile({ cloudPath: cloudPath, fileContent: content });
      if (!uploaded || !uploaded.fileID) throw new Error('导出文件上传失败');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.collection('export_tasks').doc(queued._id).update({
        data: {
          status: 'completed', fileId: uploaded.fileID, cloudPath: cloudPath, size: content.length,
          completedAt: db.serverDate(), expiresAt: expiresAt, updatedAt: db.serverDate()
        }
      });
      completed.push(queued._id);
    } catch (error) {
      await db.collection('export_tasks').doc(queued._id).update({
        data: {
          status: 'failed', failureMessage: String(error.message || '导出任务失败').slice(0, 160),
          failedAt: db.serverDate(), updatedAt: db.serverDate()
        }
      });
      failed.push(queued._id);
    }
  }
  return { completed: completed, failed: failed };
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
    { name: '人物.csv', content: Buffer.from(toCsv(persons.map(function (item) { return { id: item._id, name: item.name, gender: item.gender, lifeStatus: item.lifeStatus, birthDate: item.birthDate, deathDate: item.deathDate, birthPlace: item.birthPlace, bio: item.bio, status: item.status }; }), [
      { key: 'id', label: '人物ID' }, { key: 'name', label: '姓名' }, { key: 'gender', label: '性别' }, { key: 'lifeStatus', label: '生存状态' }, { key: 'birthDate', label: '出生日期' }, { key: 'deathDate', label: '离世日期' }, { key: 'birthPlace', label: '出生地' }, { key: 'bio', label: '生平' }, { key: 'status', label: '状态' }
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

async function processFamilyBackupTasks() {
  const stale = await db.collection('export_tasks').where({ kind: 'family_backup', status: 'processing', startedAt: _.lte(new Date(Date.now() - 30 * 60 * 1000)) }).limit(10).get();
  for (const task of stale.data || []) {
    const staleFiles = (task.parts || []).map(function (part) { return part.fileId; }).filter(Boolean);
    for (let index = 0; index < staleFiles.length; index += 50) await deleteFilesStrict(staleFiles.slice(index, index + 50)).catch(function () {});
    await db.collection('export_tasks').doc(task._id).update({ data: { status: 'failed', parts: [], failureMessage: '备份任务超时，请重新生成', failedAt: db.serverDate(), updatedAt: db.serverDate() } });
    await db.collection('families').doc(task.familyId).update({ data: { backupTaskId: '', updatedAt: db.serverDate() } }).catch(function () {});
  }
  const page = await db.collection('export_tasks').where({ kind: 'family_backup', status: 'pending' }).limit(1).get();
  const completed = []; const failed = [];
  for (const queued of page.data || []) {
    const task = await claimExportTask(queued._id);
    if (!task) continue;
    try {
      const family = await maybeGet('families', task.familyId);
      if (!hasActiveMembership(family)) {
        await db.collection('export_tasks').doc(queued._id).update({ data: {
          status: 'failed', failureMessage: '家庭会员已失效，未生成完整备份', failedAt: db.serverDate(), updatedAt: db.serverDate()
        } });
        await db.collection('families').doc(task.familyId).update({ data: { backupTaskId: '', updatedAt: db.serverDate() } }).catch(function () {});
        failed.push(queued._id);
        continue;
      }
      const result = await buildFamilyBackup(Object.assign({ _id: queued._id }, task));
      await db.collection('export_tasks').doc(queued._id).update({ data: { status: 'completed', progress: 100, parts: result.parts, unavailableMediaCount: result.unavailableMediaCount, completedAt: db.serverDate(), expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000), updatedAt: db.serverDate() } });
      await db.collection('families').doc(task.familyId).update({ data: { backupTaskId: '', lastBackupCompletedAt: db.serverDate(), updatedAt: db.serverDate() } });
      completed.push(queued._id);
    } catch (error) {
      await db.collection('export_tasks').doc(queued._id).update({ data: { status: 'failed', failureMessage: String(error.message || '家庭备份生成失败').slice(0, 160), failedAt: db.serverDate(), updatedAt: db.serverDate() } });
      await db.collection('families').doc(task.familyId).update({ data: { backupTaskId: '', updatedAt: db.serverDate() } }).catch(function () {});
      failed.push(queued._id);
    }
  }
  return { completed: completed, failed: failed };
}

async function paymentAccessToken() {
  const appId = String(process.env.VP_APP_ID || '');
  const appSecret = String(process.env.VP_APP_SECRET || '');
  if (!appId || !appSecret) throw new Error('虚拟支付查单缺少 AppID/AppSecret');
  const response = await fetch('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(appId) + '&secret=' + encodeURIComponent(appSecret));
  const payload = await response.json().catch(function () { return {}; });
  if (!response.ok || !payload.access_token) throw new Error('获取微信 access_token 失败');
  return payload.access_token;
}

function paymentEnvironment(order) {
  if (Number(order && order.paymentEnv) === 1 || (order && order.paymentMode === 'sandbox')) return 1;
  return 0;
}

function hasActiveMembership(family, now) {
  if (!family || family.status !== 'active') return false;
  if (family.proLifetime) return true;
  const expiresAt = family.proExpiresAt ? new Date(family.proExpiresAt) : null;
  return Boolean(expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > (now || Date.now()));
}

function isPaidOrder(result) {
  const source = result || {};
  return Number(source.order_state || source.orderState) === 1 || [2, 3, 4].includes(Number(source.status)) || String(source.status || '').toLowerCase() === 'paid';
}

async function queryPaidOrder(order, accessToken) {
  const payer = await maybeGet('users', order.payerUserId);
  if (!payer || !payer.openid) throw new Error('订单付款身份已不可用');
  const appKey = String(process.env.VP_APP_KEY || '');
  if (!appKey) throw new Error('虚拟支付查单缺少 AppKey');
  const wxOrderId = String(order.wxOrderId || '').trim();
  const body = JSON.stringify(wxOrderId
    ? { openid: payer.openid, env: paymentEnvironment(order), wx_order_id: wxOrderId }
    : { openid: payer.openid, env: paymentEnvironment(order), order_id: order._id });
  const paySig = crypto.createHmac('sha256', appKey).update('/xpay/query_order&' + body, 'utf8').digest('hex');
  const response = await fetch('https://api.weixin.qq.com/xpay/query_order?access_token=' + encodeURIComponent(accessToken) + '&pay_sig=' + paySig, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body
  });
  const payload = await response.json().catch(function () { return {}; });
  if (!response.ok || Number(payload.errcode || 0) !== 0) {
    const errorCode = Number(payload.errcode);
    const errorMessage = String(payload.errmsg || '未知错误').replace(/[\r\n]/g, ' ').slice(0, 80);
    const error = new Error('微信 query_order 返回失败 [' + (Number.isFinite(errorCode) ? errorCode : response.status) + ']: ' + errorMessage);
    error.code = errorCode === 268490002 ? 'PAYMENT_QUERY_NOT_FOUND' : 'PAYMENT_QUERY_UNAVAILABLE';
    throw error;
  }
  return payload.order || payload;
}

async function reconcilePendingPayments() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const recoveryCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [page, timedOutPage] = await Promise.all([
    db.collection('payment_orders').where({ status: 'pending', createdAt: _.lte(cutoff) }).limit(20).get(),
    db.collection('payment_orders').where({ status: 'closed', closeReason: 'payment_timeout', updatedAt: _.gte(recoveryCutoff) }).limit(20).get()
  ]);
  const mode = String(process.env.PAYMENT_MODE || 'mock').toLowerCase();
  const checked = [];
  let accessToken = '';
  const orders = (page.data || []).concat(timedOutPage.data || []).filter(function (order, index, rows) {
    return rows.findIndex(function (item) { return item._id === order._id; }) === index;
  });
  for (const order of orders) {
    if (!['sandbox', 'live'].includes(mode)) {
      const mockExpired = order.expiresAt && new Date(order.expiresAt).getTime() <= Date.now();
      await db.collection('payment_orders').doc(order._id).update({ data: { status: mockExpired ? 'closed' : 'pending', closeReason: mockExpired ? 'payment_timeout' : '', reconcileStatus: mockExpired ? 'closed_unpaid' : 'mock_waiting', lastQueriedAt: db.serverDate(), updatedAt: db.serverDate() } });
      checked.push(order._id); continue;
    }
    if (order.paymentMode !== mode || paymentEnvironment(order) !== (mode === 'sandbox' ? 1 : 0)) continue;
    try {
      if (!accessToken) accessToken = await paymentAccessToken();
      const result = await queryPaidOrder(order, accessToken);
      const paid = isPaidOrder(result);
      if (paid) {
        const notification = await cloud.callFunction({ name: paymentNotifyFunctionName(), data: { internalSecret: process.env.VP_INTERNAL_NOTIFY_SECRET, Event: 'xpay_goods_deliver_notify', MchOrderNo: result.mch_order_no || result.wx_order_id || result.wxOrderId, OutTradeNo: order._id, ProductId: order.productId, Quantity: 1 } });
        const notificationResult = notification && notification.result || {};
        if (Number(notificationResult.ErrCode) !== 0) throw new Error('支付发货处理未成功');
      }
      const expired = !paid && order.expiresAt && new Date(order.expiresAt).getTime() <= Date.now();
      const reconcileUpdate = paid
        ? { reconcileStatus: 'delivery_requested', lastQueriedAt: db.serverDate(), updatedAt: db.serverDate() }
        : { status: expired ? 'closed' : 'pending', closeReason: expired ? 'payment_timeout' : '', reconcileStatus: expired ? 'closed_unpaid' : 'not_paid', lastQueriedAt: db.serverDate(), updatedAt: db.serverDate() };
      await db.collection('payment_orders').doc(order._id).update({ data: reconcileUpdate });
      checked.push(order._id);
    } catch (error) {
      const status = error && error.code === 'PAYMENT_QUERY_NOT_FOUND' ? 'query_not_found' : 'query_failed';
      await db.collection('payment_orders').doc(order._id).update({ data: { reconcileStatus: status, reconcileMessage: String(error.message || '查单失败').slice(0, 120), lastQueriedAt: db.serverDate(), updatedAt: db.serverDate() } });
    }
  }
  return checked;
}

async function updateCommerceMetricsDaily() {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [created, paidToday, refundedToday, paidThisMonth, lifetimeFamilies, fixedFamilies] = await Promise.all([
    listAllForExport('payment_orders', { createdAt: _.gte(dayStart).and(_.lt(dayEnd)) }, 20000),
    listAllForExport('payment_orders', { paidAt: _.gte(dayStart).and(_.lt(dayEnd)) }, 20000),
    listAllForExport('payment_orders', { refundedAt: _.gte(dayStart).and(_.lt(dayEnd)) }, 20000),
    listAllForExport('payment_orders', { paidAt: _.gte(monthStart) }, 50000),
    db.collection('families').where({ status: 'active', proLifetime: true }).count(),
    db.collection('families').where({ status: 'active', proExpiresAt: _.gt(now) }).count()
  ]);
  const gmvCents = paidToday.reduce(function (sum, item) { return sum + Number(item.priceCents || 0); }, 0);
  const refundCents = refundedToday.reduce(function (sum, item) { return sum + Number(item.priceCents || 0); }, 0);
  const monthGmvCents = paidThisMonth.reduce(function (sum, item) { return sum + Number(item.priceCents || 0); }, 0);
  const sku = {};
  paidToday.forEach(function (item) { sku[item.productId] = (sku[item.productId] || 0) + 1; });
  const ratio = Math.round(monthGmvCents / 10000000 * 1000) / 10;
  const alertLevel = ratio >= 100 ? 100 : ratio >= 90 ? 90 : ratio >= 80 ? 80 : 0;
  const day = [dayStart.getFullYear(), String(dayStart.getMonth() + 1).padStart(2, '0'), String(dayStart.getDate()).padStart(2, '0')].join('-');
  const id = 'commerce_' + day.replace(/-/g, '');
  const previous = await maybeGet('commerce_metrics_daily', id);
  await db.collection('commerce_metrics_daily').doc(id).set({ data: {
    day: day, createdOrders: created.length, paidOrders: paidToday.length,
    refundedOrders: refundedToday.length, gmvCents: gmvCents, refundCents: refundCents,
    sku: sku, activeMemberFamilies: Number(lifetimeFamilies.total || 0) + Number(fixedFamilies.total || 0),
    monthGmvCents: monthGmvCents, monthlyLimitCents: 10000000, monthlyLimitPercent: ratio,
    alertLevel: alertLevel, updatedAt: db.serverDate()
  } });
  if (alertLevel && alertLevel > Number(previous && previous.alertLevel || 0)) console.warn(JSON.stringify({ action: 'commerce.monthly_limit_alert', alertLevel: alertLevel, monthlyLimitPercent: ratio }));
  return { day: day, gmvCents: gmvCents, refundCents: refundCents, alertLevel: alertLevel };
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

async function createBackupManifest() {
  const counts = {};
  for (const collectionName of COLLECTIONS) {
    if (collectionName === 'backup_manifests') continue;
    try {
      const result = await db.collection(collectionName).count();
      counts[collectionName] = result.total || 0;
    } catch (error) {
      counts[collectionName] = -1;
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  await db.collection('backup_manifests').doc('backup_' + date).set({
    data: {
      date: date,
      counts: counts,
      platformBackupRequired: true,
      createdAt: db.serverDate()
    }
  });
  return counts;
}

async function dailyRun() {
  return {
    invitations: await expireInvitations(),
    archivedFamilies: await purgeArchivedFamilies(),
    cleanup: await cleanTemporaryData(),
    expiredExports: await expireExportTasks(),
    backupManifest: await createBackupManifest()
  };
}

async function frequentRun() {
  return { exports: await processExportTasks(), familyBackups: await processFamilyBackupTasks(), payments: await reconcilePendingPayments(), commerceMetrics: await updateCommerceMetricsDaily() };
}

async function profileRun() {
  return { profileSync: await syncProfiles() };
}

async function hourlyRun() {
  return {
    recoveredDeletions: await recoverStaleDeletions(),
    deletions: await processDeletions()
  };
}

async function maintenanceRun() {
  return {
    frequent: await frequentRun(),
    profile: await profileRun(),
    hourly: await hourlyRun(),
    daily: await dailyRun()
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
    if (triggerName === 'youpu-frequent-maintenance') {
      resolvedAction = 'maintenance.frequent';
      data = await frequentRun();
    }
    if (triggerName === 'youpu-profile-maintenance') {
      resolvedAction = 'maintenance.profile';
      data = await profileRun();
    }
    if (triggerName === 'youpu-hourly-maintenance') {
      resolvedAction = 'maintenance.hourly';
      data = await hourlyRun();
    }
    if (triggerName === 'youpu-daily-maintenance') {
      resolvedAction = 'maintenance.daily';
      data = await dailyRun();
    }
    if (!data && action === 'maintenance.run') {
      resolvedAction = 'maintenance.run';
      data = await maintenanceRun();
    }
    if (!data) throw new Error('unknown job action');
    console.log(JSON.stringify({ requestId: requestId, actorId: 'system', action: resolvedAction, success: true, durationMs: Date.now() - startedAt, resultCode: 'OK' }));
    return { success: true, data: data, requestId: requestId };
  } catch (error) {
    console.error(JSON.stringify({ requestId: requestId, actorId: 'system', action: action || 'unknown', success: false, durationMs: Date.now() - startedAt, resultCode: error.code || 'JOB_FAILED' }));
    return { success: false, code: error.code || 'JOB_FAILED', message: error.message || '后台任务执行失败', requestId: requestId };
  }
};
