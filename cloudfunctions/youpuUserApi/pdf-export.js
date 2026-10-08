const crypto = require('crypto');
const { read, day } = require('./family-copy');
const ROLES = ['admin', 'member', 'viewer'];
const digest = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 40);
function displayOptions(value) {
  const source = value || {};
  return {
    nameLayout: source.nameLayout === 'vertical' ? 'vertical' : 'horizontal',
    showGenderColors: source.showGenderColors !== false,
    showGenderBadge: source.showGenderBadge === true,
    showChildRankBadge: source.showChildRankBadge === true
  };
}
function publicTask(task) {
  if (!task) return null;
  return {
    taskId: task._id, source: task.source, familyId: task.familyId || '', slug: task.slug || '',
    format: task.format, status: task.status, progress: Number(task.progress || 0),
    fileName: task.fileName || '', size: Number(task.size || 0), pageCount: Number(task.pageCount || 0),
    personCount: Number(task.personCount || 0), relationCount: Number(task.relationCount || 0),
    unavailableMediaCount: Number(task.unavailableMediaCount || 0), expiresAt: task.expiresAt || null,
    failureCode: task.status === 'failed' ? task.failureCode || 'PDF_FAILED' : '',
    failureMessage: task.status === 'failed' ? task.failureMessage || 'PDF 生成失败，请重试' : ''
  };
}
function createService(options) {
  const { db, cloud, assert, getOpenid, requireActiveUser, requireMembership, entitlement, mutate, dispatchJob } = options;
  async function authorize(input, scope, openid) {
    if (input.source === 'example') {
      const rows = await scope.collection('example_templates').where({ slug: input.slug, status: 'published' }).limit(1).get();
      assert(rows.data && rows.data[0] && rows.data[0].publishedContent, 'EXAMPLE_NOT_FOUND', '示例已下架或不存在');
      return rows.data[0];
    }
    const access = await requireMembership(input.familyId, ROLES, scope, openid);
    assert(entitlement(access.family).active, 'MEMBERSHIP_REQUIRED', 'PDF 导出是家庭会员权益，请先开通会员');
    return access.family;
  }
  function inputFrom(event) {
    assert(['family', 'example'].includes(event.source), 'PDF_SOURCE_INVALID', '请选择家谱');
    assert(['poster', 'book'].includes(event.format), 'PDF_FORMAT_INVALID', '请选择 PDF 格式');
    const key = event.source === 'family' ? event.familyId : event.slug;
    assert(typeof key === 'string' && key.trim() && key.length <= 80, 'PDF_SOURCE_INVALID', '请选择家谱');
    return { source: event.source, familyId: event.source === 'family' ? key : '', slug: event.source === 'example' ? key : '', format: event.format, display: displayOptions(event.display) };
  }
  async function dispatch(task, openid) {
    if (!task || task.status !== 'pending') return task;
    if (task.miniCodeRequired && !task.miniCodeBase64) {
      try {
        const code = await options.posterCode(task);
        const bytes = code && typeof code.base64 === 'string' ? Buffer.from(code.base64, 'base64') : null;
        assert(bytes && bytes.length > 8 && bytes.length < 512000 &&
          (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' || bytes.subarray(0, 3).toString('hex') === 'ffd8ff'),
        'PDF_MINI_CODE_FAILED', '小程序码生成失败，请重试原任务');
        await db.runTransaction(async tx => {
          await authorize(task, tx, openid);
          const current = await read(tx, 'export_tasks', task._id);
          if (current && current.status === 'pending' && current.attempt === task.attempt && !current.miniCodeBase64) {
            await tx.collection('export_tasks').doc(task._id).update({ data: { miniCodeBase64: code.base64, miniCodeInvitationId: code.invitationId || '', updatedAt: db.serverDate() } });
          }
        });
      } catch (error) {
        await db.runTransaction(async tx => {
          const current = await read(tx, 'export_tasks', task._id);
          if (current && current.status === 'pending' && current.attempt === task.attempt && !current.miniCodeBase64) {
            await tx.collection('export_tasks').doc(task._id).update({ data: { status: 'failed', failureCode: 'PDF_MINI_CODE_FAILED', failureMessage: '小程序码生成失败，请重试原任务', failedAt: db.serverDate(), updatedAt: db.serverDate() } });
          }
        });
      }
      task = await read(db, 'export_tasks', task._id);
    }
    if (task.status === 'pending' && (!task.miniCodeRequired || task.miniCodeBase64)) {
      try { await dispatchJob('task.pdf-export', task._id); }
      catch (error) { console.warn(JSON.stringify({ action: 'pdf.dispatch', code: error.code || 'DISPATCH_FAILED' })); }
    }
    return task;
  }
  async function taskFor(event, user) {
    const actor = await read(db, 'users', user._id);
    const id = event.taskId || actor.latestPdfTaskId;
    if (!id) return null;
    assert(typeof id === 'string' && id.length <= 80, 'PDF_NOT_FOUND', 'PDF 任务不存在');
    const task = await read(db, 'export_tasks', id);
    if (!event.taskId && (!task || event.familyId && task.familyId !== event.familyId || event.slug && task.slug !== event.slug)) return null;
    assert(task && task.kind === 'family_pdf' && task.userId === user._id, 'PDF_NOT_FOUND', 'PDF 任务不存在');
    return task;
  }
  async function create(event) {
    const openid = getOpenid(); const user = await requireActiveUser(openid); const input = inputFrom(event);
    assert(typeof event.requestId === 'string' && event.requestId.length > 0 && event.requestId.length <= 80, 'REQUEST_ID_REQUIRED', '请重新发起生成');
    const id = event.retryTaskId || 'pdf_' + digest(user._id + ':' + event.requestId);
    assert(typeof id === 'string' && id.length <= 80, 'PDF_NOT_FOUND', 'PDF 任务不存在');
    const fingerprint = digest(JSON.stringify(input));
    await authorize(input, db, openid);
    await mutate('pdf.create', event, openid, async function (tx) {
      await authorize(input, tx, openid);
      const existing = await read(tx, 'export_tasks', id);
      if (existing) {
        assert(existing.kind === 'family_pdf' && existing.userId === user._id && existing.inputHash === fingerprint, 'PDF_REQUEST_CHANGED', '生成参数已改变，请重新发起');
        if (!event.retryTaskId || existing.status !== 'failed') return { taskId: id };
        assert(Date.now() - new Date(existing.createdAt).getTime() < 72 * 3600000, 'PDF_EXPIRED', '任务已过期，请重新生成');
      } else assert(!event.retryTaskId, 'PDF_NOT_FOUND', 'PDF 任务不存在');
      const actor = await read(tx, 'users', user._id);
      const active = actor.activePdfTaskId ? await read(tx, 'export_tasks', actor.activePdfTaskId) : null;
      assert(!active || !['pending', 'processing'].includes(active.status), 'PDF_IN_PROGRESS', '已有 PDF 正在生成，请稍后查看');
      const today = day(Date.now()); const count = actor.pdfDay === today ? Number(actor.pdfCount || 0) : 0;
      if (!existing) assert(count < 20, 'PDF_DAILY_LIMIT', '今天已生成 20 次 PDF，请明天再试');
      const data = Object.assign({}, input, {
        kind: 'family_pdf', userId: user._id, status: 'pending', progress: 0, inputHash: fingerprint,
        requestId: event.requestId, attempt: Number(existing && existing.attempt || 0) + 1,
        failureCode: '', failureMessage: '', updatedAt: db.serverDate(),
        createdAt: existing ? existing.createdAt : db.serverDate(),
        miniCodeRequired: input.format === 'poster',
        miniCodeBase64: existing && existing.miniCodeBase64 || '',
        miniCodeInvitationId: existing && existing.miniCodeInvitationId || ''
      });
      await tx.collection('export_tasks').doc(id).set({ data });
      await tx.collection('users').doc(user._id).update({ data: { pdfDay: today, pdfCount: count + (existing ? 0 : 1), activePdfTaskId: id, latestPdfTaskId: id } });
      return { taskId: id };
    });
    const task = await read(db, 'export_tasks', id);
    assert(task && task.inputHash === fingerprint, 'PDF_REQUEST_CHANGED', '生成参数已改变，请重新发起');
    return publicTask(await dispatch(task, openid));
  }
  async function status(event) {
    const openid = getOpenid(); const user = await requireActiveUser(openid); const task = await taskFor(event, user);
    if (!task) return { task: null };
    await authorize(task, db, openid);
    return { task: publicTask(await dispatch(task, openid)) };
  }
  async function downloadUrl(event) {
    const openid = getOpenid(); const user = await requireActiveUser(openid); const task = await taskFor(event, user);
    assert(task, 'PDF_NOT_FOUND', 'PDF 任务不存在');
    await authorize(task, db, openid);
    assert(task.status === 'completed' && task.fileId && new Date(task.expiresAt).getTime() > Date.now(), 'PDF_EXPIRED', '文件尚未完成或已经过期，请重新生成');
    const response = await cloud.getTempFileURL({ fileList: [task.fileId] });
    const url = response.fileList && response.fileList[0] && response.fileList[0].tempFileURL;
    assert(url, 'PDF_DOWNLOAD_FAILED', '下载链接生成失败，请重试');
    return { url, fileName: task.fileName, expiresAt: task.expiresAt };
  }
  return { create, status, downloadUrl };
}
module.exports = { createService, publicTask, displayOptions };
