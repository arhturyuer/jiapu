const crypto = require('crypto');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 40); }
function day(now) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }
async function read(scope, name, id) {
  try { return (await scope.collection(name).doc(id).get()).data || null; }
  catch (error) {
    if (/document with _id [^\s]+ does not exist/.test(String(error.errMsg || error.message))) return null;
    throw error;
  }
}
function publicTask(task) {
  if (!task) return null;
  return {
    taskId: task._id, requestId: task.requestId || '', status: task.status, stage: task.stage || 'snapshot',
    personCount: task.personCount || 0, relationCount: task.relationCount || 0,
    personsDone: task.personsDone || 0, relationsDone: task.relationsDone || 0,
    avatarsDone: task.avatarsDone || 0, avatarCount: task.avatarCount || 0,
    missingAvatars: task.status === 'completed' ? task.missingAvatars || [] : [],
    failureCode: task.failureCode || '', family: task.resultFamily || null
  };
}
function createService(options) {
  const { db, assert, getOpenid, requireActiveUser, requireMembership, membershipId, mutate, moderateText, dispatchJob } = options;
  async function dispatch(task) {
    if (task && (task.status === 'pending' || task.status === 'processing' && new Date(task.leaseUntil).getTime() <= Date.now())) {
      // A failed dispatch leaves the committed task available for a status read
      // to dispatch again. It must not turn an accepted request into a new copy.
      try { await dispatchJob('task.family-copy', task._id); }
      catch (error) { console.warn(JSON.stringify({ action: 'family.copy.dispatch', resultCode: error.code || 'DISPATCH_FAILED' })); }
    }
  }
  async function present(task, user) {
    const result = publicTask(task);
    if (result && task.status === 'completed') {
      const family = await read(db, 'families', task.targetFamilyId);
      const membership = await read(db, 'family_memberships', task.targetMembershipId);
      if (!family || family.status !== 'active' || !membership || membership.status !== 'active' || membership.userId !== user._id) {
        result.family = null;
        result.missingAvatars = [];
      } else result.family.currentRole = membership.role;
    }
    return result;
  }
  async function create(event) {
    const openid = getOpenid();
    const user = await requireActiveUser(openid);
    assert(typeof event.familyId === 'string' && event.familyId.length <= 80 && event.familyId.trim(), 'FAMILY_NOT_FOUND', '请选择家谱');
    const name = typeof event.name === 'string' ? event.name.trim() : '';
    assert(name && name.length <= 40 && !/[\u0000-\u001f]/.test(name), 'COPY_NAME_INVALID', '请填写 40 字以内的家谱名称');
    assert(typeof event.requestId === 'string' && event.requestId && event.requestId.length <= 80, 'REQUEST_ID_REQUIRED', '请重新打开复制页');
    const id = 'copy_' + digest(user._id + ':' + event.requestId);
    const fingerprint = digest(JSON.stringify([event.familyId, name]));
    const existing = await read(db, 'family_copy_tasks', id);
    if (existing) {
      assert(existing.inputHash === fingerprint, 'COPY_REQUEST_CHANGED', '请重新发起复制');
      await dispatch(existing);
      return present(existing, user);
    }
    await requireMembership(event.familyId, ['admin', 'member', 'viewer'], db, openid);
    await moderateText(openid, [name]);
    await mutate('family.copy.create', event, openid, async function (tx) {
      const access = await requireMembership(event.familyId, ['admin', 'member', 'viewer'], tx, openid);
      assert(!access.family.isExample && !access.family.exampleTemplateId, 'COPY_SOURCE_INVALID', '只能复制真实家谱');
      const actor = await read(tx, 'users', user._id);
      const active = actor.activeCopyTaskId ? await read(tx, 'family_copy_tasks', actor.activeCopyTaskId) : null;
      assert(!active || !['pending', 'processing'].includes(active.status), 'COPY_IN_PROGRESS', '已有家谱正在复制');
      const today = day(Date.now());
      const count = actor.copyDay === today ? Number(actor.copyCount || 0) : 0;
      assert(count < 3, 'COPY_DAILY_LIMIT', '今天已发起 3 次复制，请明天再试');
      const targetFamilyId = 'fcopy_' + digest(id);
      await tx.collection('family_copy_tasks').doc(id).set({ data: {
        userId: user._id, sourceFamilyId: event.familyId, sourceMembershipId: access.membership._id,
        targetFamilyId, targetMembershipId: membershipId(targetFamilyId, openid),
        inputHash: fingerprint, requestId: event.requestId, name, status: 'pending', stage: 'snapshot',
        personsDone: 0, relationsDone: 0, avatarsDone: 0, missingAvatars: [],
        cleanupPending: false, leaseUntil: new Date(0), createdAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      await tx.collection('users').doc(user._id).update({ data: { copyDay: today, copyCount: count + 1, activeCopyTaskId: id } });
      return { taskId: id };
    });
    const task = await read(db, 'family_copy_tasks', id);
    assert(task && task.inputHash === fingerprint, 'COPY_REQUEST_CHANGED', '请重新发起复制');
    await dispatch(task);
    return present(task, user);
  }
  async function status(event) {
    const user = await requireActiveUser(getOpenid());
    let task;
    if (event.taskId) {
      assert(typeof event.taskId === 'string' && event.taskId.length <= 80, 'COPY_NOT_FOUND', '复制记录不存在');
      task = await read(db, 'family_copy_tasks', event.taskId);
      assert(task && task.userId === user._id, 'COPY_NOT_FOUND', '复制记录不存在');
    } else {
      assert(typeof event.familyId === 'string' && event.familyId.length <= 80 && event.familyId, 'FAMILY_NOT_FOUND', '请选择家谱');
      // Query only this actor's tasks; no source membership is needed to learn
      // that a revoked task failed. Source contents are never returned here.
      const result = await db.collection('family_copy_tasks').where({ userId: user._id, sourceFamilyId: event.familyId }).orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(1).get();
      task = (result.data || [])[0];
    }
    await dispatch(task);
    const result = await present(task, user);
    return { task: result };
  }
  return { create, status };
}
module.exports = { createService, day, publicTask, read };
