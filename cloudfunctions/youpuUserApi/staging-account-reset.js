const { AsyncLocalStorage } = require('node:async_hooks');

// This namespace exists only in an explicitly enabled, independent staging
// deployment. Production keeps the original deterministic user IDs.
const PRODUCTION_ENV_ID = 'cloud1-d5gs5yj4l283d9c6d';
const identity = new AsyncLocalStorage();

function createService(options) {
  const { db, command, assert, hash, randomToken, listAll } = options;
  function usesTestIdentity(context) {
    const target = process.env.STAGING_ACCOUNT_RESET_ENV || '';
    const actual = process.env.TCB_ENV || process.env.SCF_NAMESPACE || context.ENV || '';
    return Boolean(target) &&
      target !== PRODUCTION_ENV_ID && actual === target && context.ENV === target;
  }
  function enabled(context) {
    return usesTestIdentity(context) && process.env.STAGING_ACCOUNT_RESET_ENABLED === '1';
  }
  function assertAllowed(context, event) {
    assert(enabled(context) && event.envVersion === 'develop', 'TEST_RESET_UNAVAILABLE', '此功能仅限测试环境开发版');
    assert(context.OPENID, 'LOGIN_REQUIRED', '请先登录');
  }
  async function read(scope, collection, id) {
    try {
      const result = await scope.collection(collection).doc(id).get();
      return result.data || null;
    } catch (error) {
      // The WeChat SDK reports only a missing document this way. Transport,
      // permission and missing-collection errors must never restore old IDs.
      const message = String(error && (error.errMsg || error.message) || error);
      if (/document with _id [^\s]+ does not exist/.test(message)) return null;
      throw error;
    }
  }
  function pointerId(openid) { return 'staging_identity_' + hash(openid, 32); }
  function currentUserId(openid, baseId) {
    const current = identity.getStore();
    return current && current.openid === openid ? current.userId : baseId;
  }
  function identityKey(openid) {
    const baseId = 'u_' + hash(openid, 32);
    const currentId = currentUserId(openid, baseId);
    return currentId === baseId ? openid : openid + ':' + currentId;
  }
  async function run(context, callback) {
    if (!usesTestIdentity(context) || !context.OPENID) return callback();
    const pointer = await read(db, 'system_config', pointerId(context.OPENID));
    assert(!pointer || /^u_[a-f0-9]{32}$/.test(pointer.userId || ''), 'TEST_IDENTITY_INVALID', '测试账户状态异常，请联系维护者');
    return identity.run({ openid: context.OPENID, userId: pointer ? pointer.userId : 'u_' + hash(context.OPENID, 32) }, callback);
  }
  async function reset(context, event) {
    assertAllowed(context, event);
    assert(event.requestId && event.expectedUserId, 'REQUEST_ID_REQUIRED', '请刷新我的页面后重试');
    const openid = context.OPENID;
    const baseId = 'u_' + hash(openid, 32);
    const recordId = 'idem_' + hash(openid + ':account.resetTest:' + event.requestId, 40);
    return db.runTransaction(async function (transaction) {
      const completed = await read(transaction, 'idempotency_records', recordId);
      if (completed && completed.status === 'completed') return completed.result;
      const pointer = await read(transaction, 'system_config', pointerId(openid));
      const oldId = pointer ? pointer.userId : baseId;
      assert(oldId === event.expectedUserId, 'TEST_ACCOUNT_CHANGED', '账户已变化，请刷新页面后重试');
      const user = await read(transaction, 'users', oldId);
      assert(user && ['active', 'pending_delete'].includes(user.status), 'ACCOUNT_UNAVAILABLE', '账户当前无法执行此操作');
      const deletion = await read(transaction, 'account_deletion_requests', 'del_' + oldId);
      assert(!deletion || deletion.status !== 'processing', 'DELETION_ALREADY_PROCESSING', '注销已开始执行，请稍后重试');
      // Lock this identity before discovering its associations. Staging
      // mutations lock the same user document, so old writes cannot slip in.
      await transaction.collection('users').doc(oldId).update({ data: {
        openid: command.remove(), nickName: '', avatarAssetId: '', status: 'deleted',
        deletionRequestedAt: command.remove(), deletionExecuteAt: command.remove(),
        deletedAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      // CloudBase transactions support doc operations only. Discover IDs with
      // ordinary queries, then recheck each document inside the transaction.
      const memberships = await listAll('family_memberships', { userId: oldId, status: 'active' }, 40);
      const invitations = await listAll('invitations', { createdBy: oldId, status: 'active' }, 100);
      const adminCount = memberships.filter(function (item) { return item.role === 'admin'; }).length;
      const operationCount = 10 + memberships.length * 2 + adminCount * 2 + invitations.length * 2;
      assert(operationCount <= 95, 'TEST_RESET_TOO_LARGE', '测试数据较多，请先退出部分家谱或撤销邀请后重试');
      let archivedFamilies = 0;
      for (const snapshot of memberships) {
        const membership = await read(transaction, 'family_memberships', snapshot._id);
        if (!membership || membership.userId !== oldId || membership.status !== 'active') continue;
        if (membership.role === 'admin') {
          const family = await read(transaction, 'families', membership.familyId);
          if (family) {
            const soleAdmin = Number(family.adminCount || 1) <= 1;
            const data = { adminCount: Math.max(0, Number(family.adminCount || 1) - 1), updatedAt: db.serverDate() };
            if (family.status === 'active' && soleAdmin) {
              Object.assign(data, { status: 'archived', archivedAt: db.serverDate(), purgeAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
              archivedFamilies += 1;
            }
            await transaction.collection('families').doc(membership.familyId).update({ data: data });
          }
        }
        await transaction.collection('family_memberships').doc(membership._id).update({ data: {
          status: 'account_deleted', displayName: '已注销用户', avatarAssetId: '', updatedAt: db.serverDate()
        } });
      }
      for (const snapshot of invitations) {
        const invitation = await read(transaction, 'invitations', snapshot._id);
        if (!invitation || invitation.createdBy !== oldId || invitation.status !== 'active') continue;
        await transaction.collection('invitations').doc(invitation._id).update({ data: {
          status: 'revoked', revokedReason: 'test_account_reset', updatedAt: db.serverDate()
        } });
      }
      if (deletion && deletion.status === 'pending') {
        await transaction.collection('account_deletion_requests').doc(deletion._id).update({ data: {
          status: 'cancelled', cancelledAt: db.serverDate(), updatedAt: db.serverDate()
        } });
      }
      const newId = 'u_' + hash(oldId + ':' + randomToken(24), 32);
      await transaction.collection('users').doc(newId).set({ data: {
        openid: openid, nickName: '', avatarAssetId: '', status: 'active',
        createdAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      await transaction.collection('system_config').doc(pointerId(openid)).set({ data: {
        kind: 'staging_test_identity', userId: newId, updatedAt: db.serverDate()
      } });
      const result = { reset: true, userId: newId, archivedFamilies: archivedFamilies };
      await transaction.collection('idempotency_records').doc(recordId).set({ data: {
        actorId: oldId, action: 'account.resetTest', requestId: event.requestId,
        status: 'completed', result: result, createdAt: db.serverDate(), updatedAt: db.serverDate(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      } });
      await transaction.collection('audit_logs').doc('test_reset_' + hash(recordId, 32)).set({ data: {
        actorId: oldId, actorType: 'user', actorName: '已注销测试用户', action: 'account.test_reset',
        objectType: 'user', objectId: oldId, requestId: event.requestId,
        summary: '注销测试身份并重新体验', createdAt: db.serverDate()
      } });
      return result;
    });
  }
  return { enabled, usesTestIdentity, assertAllowed, currentUserId, identityKey, run, reset };
}

module.exports = { createService };
