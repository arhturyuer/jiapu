const cloud = require('wx-server-sdk');
const crypto = require('crypto');

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
  'rate_limits'
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
  const context = cloud.getWXContext() || {};
  const hasUserIdentity = Boolean(context.OPENID || context.UNIONID || context.UID);
  const isKnownTimer = event && [
    'youpu-frequent-maintenance',
    'youpu-daily-maintenance'
  ].includes(event.triggerName);
  const isTimer = event && (event.Type === 'Timer' || isKnownTimer);
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
      _id: 'schema',
      version: 3,
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
          _id: operatorId,
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
    actorId: anonymousActor
  }, 5000);
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

async function purgeFamily(family, allowResume) {
  const claimed = await claimFamilyDeletion(family._id, allowResume);
  if (!claimed) return { familyId: family._id, skipped: true };
  const deletedFiles = await deleteFamilyMediaFiles(family._id);
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
    'notifications'
  ];
  const removed = {};
  for (const collectionName of collections) {
    removed[collectionName] = await removeMany(collectionName, { familyId: family._id }, 5000);
  }
  await db.collection('families').doc(family._id).remove();
  return { familyId: family._id, deletedFiles: deletedFiles, removed: removed };
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
    updatedAt: _.lte(new Date(Date.now() - 24 * 60 * 60 * 1000))
  }).limit(100).get();
  const fileIds = (rejectedMedia.data || []).map(function (item) { return item.fileId; }).filter(Boolean);
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
    for (const asset of rejectedMedia.data || []) {
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
    removedMedia: mediaCleanupSucceeded && rejectedMedia.data ? rejectedMedia.data.length : 0,
    purgedTextBodies: (resolvedText.data || []).filter(function (item) { return Boolean(item.content); }).length
  };
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
      _id: 'backup_' + date,
      date: date,
      counts: counts,
      platformBackupRequired: true,
      createdAt: db.serverDate()
    }
  });
  return counts;
}

async function maintenanceRun() {
  return {
    recoveredDeletions: await recoverStaleDeletions(),
    profileSync: await syncProfiles(),
    invitations: await expireInvitations(),
    deletions: await processDeletions(),
    archivedFamilies: await purgeArchivedFamilies(),
    cleanup: await cleanTemporaryData(),
    backupManifest: await createBackupManifest()
  };
}

async function frequentRun() {
  return {
    recoveredDeletions: await recoverStaleDeletions(),
    profileSync: await syncProfiles(),
    invitations: await expireInvitations(),
    deletions: await processDeletions()
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
  await db.collection('media_assets').doc(asset._id).update({
    data: {
      moderationStatus: moderationStatus,
      status: moderationStatus === 'approved' ? 'active' : 'pending',
      moderationResult: event.result || { suggest: suggest },
      moderatedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  const taskId = 'mt_' + asset._id;
  await db.collection('moderation_tasks').doc(taskId).set({
    data: {
      _id: taskId,
      familyId: asset.familyId || '',
      assetId: asset._id,
      traceId: traceId,
      type: 'image',
      status: moderationStatus,
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
    if (request.triggerName === 'youpu-frequent-maintenance') {
      resolvedAction = 'maintenance.frequent';
      data = await frequentRun();
    }
    if (!data && (action === 'maintenance.run' || request.Type === 'Timer' || request.triggerName === 'youpu-daily-maintenance')) {
      resolvedAction = 'maintenance.daily';
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
