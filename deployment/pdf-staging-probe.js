// Packaged temporarily by verify-pdf-staging.mjs, never in production functions.
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const pdf = require('./pdf-export');
const dispatcher = require('./job-dispatcher');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
function assert(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
async function read(scope, name, id) { try { return (await scope.collection(name).doc(id).get()).data || null; } catch (e) { if (/does not exist/.test(e.message || e.errMsg)) return null; throw e; } }
async function list(name, where) {
  let cursor = ''; const data = [];
  while (true) {
    const page = (await db.collection(name).where(Object.assign({}, where, cursor ? { _id: db.command.gt(cursor) } : {})).orderBy('_id', 'asc').limit(100).get()).data || [];
    data.push(...page); assert(data.length <= 5000, 'PROBE_LIMIT');
    if (page.length < 100) return data; cursor = page[page.length - 1]._id;
  }
}
const uid = (run, role) => 'pdf_probe_' + run + '_' + role;
function service(run, role) {
  const actor = uid(run, role);
  return pdf.createService({ db, cloud, assert, getOpenid: () => actor,
    posterCode: async task => {
      const client = await read(db, 'system_config', 'pdf_probe_' + run + '_client');
      if (client) {
        const where = task.source === 'family' ? { familyId: task.familyId } : { slug: task.slug };
        const candidates = await list('export_tasks', { ...where, userId: client.actorId, format: 'poster', status: 'completed' });
        const native = candidates.find(item => item.miniCodeBase64);
        assert(native, 'PROBE_NATIVE_CODE_REQUIRED');
        return { base64: native.miniCodeBase64, invitationId: native.miniCodeInvitationId || '' };
      }
      throw Object.assign(new Error('原生码验收必须使用已登录开发版用户 API'), { code: 'PROBE_WECHAT_REQUIRED' });
    },
    requireActiveUser: async () => { const user = await read(db, 'users', actor); assert(user && user.status === 'active', 'ACCOUNT_UNAVAILABLE'); return user; },
    requireMembership: async (familyId, roles, scope) => {
      const family = await read(scope, 'families', familyId); const membership = await read(scope, 'family_memberships', actor);
      assert(family && family.status === 'active' && membership && membership.familyId === familyId && membership.userId === actor && membership.status === 'active' && roles.includes(membership.role), 'NO_PERMISSION');
      return { family, membership };
    }, entitlement: family => ({ active: family.proLifetime === true }), dispatchJob: dispatcher.dispatchJob,
    mutate: async (type, event, openid, callback) => db.runTransaction(async tx => {
      const id = 'pdf_probe_' + crypto.createHash('sha256').update(actor + event.requestId).digest('hex').slice(0, 30);
      const previous = await read(tx, 'idempotency_records', id); if (previous) return previous.result;
      const result = await callback(tx);
      await tx.collection('idempotency_records').doc(id).set({ data: { actorId: actor, action: type, requestId: event.requestId, result } }); return result;
    })
  });
}
async function seed(event) {
  const familyId = 'pdf_probe_' + event.run;
  if (event.phase === 'start') {
    await db.collection('families').doc(familyId).set({ data: { name: 'PDF 虚构验收家谱', description: '仅供 staging 验收', status: 'active', proLifetime: true, personCount: 500, relationCount: 499, contentRevision: 0 } });
    for (const role of ['admin', 'member', 'viewer']) {
      const actor = uid(event.run, role);
      await db.collection('users').doc(actor).set({ data: { status: 'active' } });
      await db.collection('family_memberships').doc(actor).set({ data: { familyId, userId: actor, role, status: 'active' } });
    }
    const people = Array.from({ length: 12 }, (_, i) => ({ _id: 'e' + i, name: '公开人物' + i, gender: 'male', bio: '完整示例简介' }));
    const rels = people.slice(1).map((p, i) => ({ _id: 'er' + i, type: 'parent_child', fromPersonId: 'e0', toPersonId: p._id }));
    await db.collection('example_templates').doc(familyId).set({ data: { slug: familyId, status: 'published', title: 'PDF 虚构示例', publishedVersion: 1, publishedContent: { persons: people, relations: rels } } });
    return { seeded: true };
  }
  if (event.phase === 'persons') {
    for (let i = event.offset; i < Math.min(500, event.offset + 50); i += 1) {
      const id = familyId + '_p' + String(i).padStart(3, '0');
      await db.collection('persons').doc(id).set({ data: { familyId, name: '测试成员' + i, gender: i % 2 ? 'male' : 'female', lifeStatus: 'living', status: 'active', bio: i < 3 ? '完整虚构简介。'.repeat(40) : '虚构资料', birthDateInfo: { year: 1980, calendar: 'lunar', precision: 'year' }, birthPlace: '虚构地点' } });
      if (i) await db.collection('relations').doc(familyId + '_r' + i).set({ data: { familyId, type: 'parent_child', fromPersonId: familyId + '_p' + String(Math.floor((i - 1) / 2)).padStart(3, '0'), toPersonId: id, status: 'active' } });
    }
    return { seeded: true };
  }
  if (event.phase === 'avatars') {
    // One valid image and one unavailable asset exercise printing and fallback.
    const image = Buffer.from('/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAB4AFADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnQCabdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf//Z', 'base64');
    const uploaded = await cloud.uploadFile({ cloudPath: 'pdf-probe/' + event.run + '/avatar.jpg', fileContent: image });
    await db.collection('media_assets').doc(familyId + '_avatar').set({ data: { familyId, fileId: uploaded.fileID, status: 'active', moderationStatus: 'approved', size: image.length } });
    await db.collection('persons').doc(familyId + '_p000').update({ data: { avatarAssetId: familyId + '_avatar' } });
    await db.collection('persons').doc(familyId + '_p001').update({ data: { avatarAssetId: familyId + '_missing' } });
    return { seeded: true };
  }
  throw new Error('PROBE_PHASE');
}
exports.main = async event => {
  try {
    const actual = cloud.getWXContext().ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE;
    assert(actual === process.env.PROBE_ENV && actual !== 'cloud1-d5gs5yj4l283d9c6d' && event.secret === process.env.PROBE_SECRET && /^[a-f0-9]{12}$/.test(event.run || ''), 'PROBE_UNAUTHORIZED');
    const familyId = 'pdf_probe_' + event.run;
    let data;
    if (event.action === 'codeDiagnostic') {
      try {
        const result = await cloud.openapi.wxacode.getUnlimited({ scene: 'pdf_staging_diagnostic', page: 'pages/example/index', width: 430, isHyaline: true, envVersion: 'develop', checkPath: false });
        data = { available: true, isBuffer: Buffer.isBuffer(result), bufferType: typeof result.buffer, bytes: result.buffer && result.buffer.length || result.length || 0 };
      } catch (error) { data = { available: false, code: error.errCode || error.code || '', message: String(error.errMsg || error.message || '').slice(0, 240), hasAppId: Boolean(cloud.getWXContext().APPID) }; }
    }
    if (event.action === 'clientPrepare') {
      assert(/^u_[a-f0-9]{32}$/.test(event.actorId || ''), 'PROBE_CLIENT_ID');
      const actor = await read(db, 'users', event.actorId);
      const active = actor && actor.activePdfTaskId ? await read(db, 'export_tasks', actor.activePdfTaskId) : null;
      assert(actor && actor.status === 'active' && actor.openid && !['pending', 'processing'].includes(active && active.status), 'PROBE_CLIENT_BUSY');
      const today = require('./family-copy').day(Date.now());
      assert(actor.pdfDay !== today || Number(actor.pdfCount || 0) <= 18, 'PROBE_CLIENT_QUOTA');
      const snapshot = Object.fromEntries(['pdfDay', 'pdfCount', 'activePdfTaskId', 'latestPdfTaskId'].filter(key => actor[key] !== undefined).map(key => [key, actor[key]]));
      const key = 'pdf_probe_' + event.run + '_client';
      assert(!await read(db, 'system_config', key), 'PROBE_CLIENT_EXISTS');
      await db.collection('system_config').doc(key).set({ data: { actorId: actor._id, snapshot, day: today } });
      const baseId = 'u_' + crypto.createHash('sha256').update(actor.openid).digest('hex').slice(0, 32);
      const identityKey = actor._id === baseId ? actor.openid : actor.openid + ':' + actor._id;
      const memberId = 'fm_' + crypto.createHash('sha256').update(familyId + ':' + identityKey).digest('hex').slice(0, 32);
      assert(!await read(db, 'family_memberships', memberId), 'PROBE_CLIENT_MEMBER_EXISTS');
      await db.collection('family_memberships').doc(memberId).set({ data: { familyId, userId: actor._id, role: 'viewer', displayName: '虚构验收', status: 'active' } });
      data = { ready: true };
    }
    if (event.action === 'clientStatus') {
      const client = await read(db, 'system_config', familyId + '_client');
      const task = await read(db, 'export_tasks', event.taskId);
      assert(client && task && task.userId === client.actorId && (task.familyId === familyId || task.slug === familyId), 'PROBE_CLIENT_TASK');
      assert(!['pending', 'processing'].includes(task.status), 'PROBE_CLIENT_RUNNING');
      data = { status: task.status, failureCode: task.failureCode || '', nativeCodeReady: Boolean(task.miniCodeBase64) };
    }
    if (event.action === 'seed') data = await seed(event);
    if (event.action === 'start') {
      assert(['admin', 'member', 'viewer'].includes(event.role), 'PROBE_ROLE');
      const api = service(event.run, event.role);
      const input = { source: event.example ? 'example' : 'family', familyId: event.example ? '' : familyId, slug: event.example ? familyId : '', format: event.format, display: { nameLayout: event.vertical ? 'vertical' : 'horizontal', showGenderColors: true }, requestId: event.role + ':' + event.format + ':' + Boolean(event.example) };
      const task = await api.create(input); const duplicate = await api.create(input);
      assert(task.taskId === duplicate.taskId, 'PROBE_IDEMPOTENCY');
      const actor = await read(db, 'users', uid(event.run, event.role));
      data = { taskId: task.taskId, count: actor.pdfCount };
    }
    if (event.action === 'quota') {
      const actor = uid(event.run, 'admin'); const api = service(event.run, 'admin');
      const user = await read(db, 'users', actor);
      assert(user && !['pending', 'processing'].includes((await read(db, 'export_tasks', user.activePdfTaskId) || {}).status), 'PROBE_RUNNING');
      // Raise only this run's virtual actor to the boundary without creating
      // eighteen redundant PDF files; the service still creates task twenty.
      await db.collection('users').doc(actor).update({ data: { pdfCount: 19 } });
      const input = { source: 'example', slug: familyId, format: 'poster', requestId: 'quota-twenty' };
      const task = await api.create(input); const duplicate = await api.create(input);
      assert(task.taskId === duplicate.taskId && (await read(db, 'users', actor)).pdfCount === 20, 'PROBE_QUOTA_COUNT');
      data = { taskId: task.taskId, count: 20 };
    }
    if (event.action === 'quotaLimit') {
      let code;
      try { await service(event.run, 'admin').create({ source: 'example', slug: familyId, format: 'poster', requestId: 'quota-twenty-one' }); }
      catch (error) { code = error.code; }
      assert(code === 'PDF_DAILY_LIMIT' && (await read(db, 'users', uid(event.run, 'admin'))).pdfCount === 20, 'PROBE_QUOTA_LIMIT');
      data = { rejected: code, count: 20 };
    }
    if (event.action === 'status') {
      const api = service(event.run, event.role); const task = (await api.status({ taskId: event.taskId })).task;
      data = task;
      if (task.status === 'completed') {
        const first = await api.downloadUrl({ taskId: task.taskId }); const second = await api.downloadUrl({ taskId: task.taskId });
        assert(first.fileName === second.fileName, 'PROBE_DOWNLOAD');
        if (task.format === 'poster') {
          const stored = await read(db, 'export_tasks', task.taskId);
          assert(stored.miniCodeRequired && stored.miniCodeBase64, 'PROBE_CODE_MISSING');
          if (task.source === 'family') {
            const invitation = await read(db, 'invitations', stored.miniCodeInvitationId);
            assert(invitation && invitation.role === 'viewer' && invitation.purpose === 'poster' && invitation.viewMode === 'full' && invitation.expiresAt === null && invitation.maxUses === null, 'PROBE_CODE_POLICY');
            data.miniCodePolicy = { role: 'viewer', viewMode: 'full', expiresAt: null, maxUses: null };
          } else data.miniCodePolicy = { source: 'example', viewMode: 'full' };
        }
        data.download = first;
      }
    }
    if (event.action === 'gateway') {
      const response = await cloud.callFunction({ name: 'youpuUserApi', data: { type: 'pdf.create', source: 'family', familyId, format: 'poster', requestId: 'gateway-' + event.run } });
      assert(response.result && !response.result.success && ['UNAUTHENTICATED', 'NO_FAMILY_ACCESS'].includes(response.result.code), 'PROBE_GATEWAY');
      data = { rejected: response.result.code };
    }
    if (event.action === 'cleanup') {
      const tasks = await list('export_tasks', { familyId }); const examples = await list('export_tasks', { slug: familyId });
      assert(!tasks.concat(examples).some(t => ['pending', 'processing'].includes(t.status)), 'PROBE_RUNNING');
      const assets = await list('media_assets', { familyId });
      const client = await read(db, 'system_config', familyId + '_client');
      if (client) {
        const native = tasks.concat(examples).filter(task => task.userId === client.actorId);
        await db.runTransaction(async tx => {
          const actor = await read(tx, 'users', client.actorId);
          if (native.length) {
            const baseline = client.snapshot.pdfDay === client.day ? Number(client.snapshot.pdfCount || 0) : 0;
            assert(actor.pdfDay === client.day && actor.pdfCount === baseline + native.length && native.some(task => task._id === actor.latestPdfTaskId), 'PROBE_CLIENT_CHANGED');
            const fields = Object.fromEntries(['pdfDay', 'pdfCount', 'activePdfTaskId', 'latestPdfTaskId'].map(key => [key, client.snapshot[key] === undefined ? db.command.remove() : client.snapshot[key]]));
            await tx.collection('users').doc(client.actorId).update({ data: fields });
          }
        });
        const requests = new Set(native.map(task => task.requestId).concat(native.map(task => task._id + '-code')));
        for (const requestId of requests) for (const row of await list('idempotency_records', { actorId: client.actorId, requestId })) await db.collection('idempotency_records').doc(row._id).remove();
        await db.collection('system_config').doc(familyId + '_client').remove();
      }
      const files = tasks.concat(examples).map(t => t.fileId).concat(assets.map(a => a.fileId)).filter(Boolean);
      if (files.length) { const result = await cloud.deleteFile({ fileList: files }); assert((result.fileList || []).every(f => Number(f.status || 0) === 0), 'PROBE_FILE_CLEANUP'); }
      for (const task of tasks.concat(examples)) await db.collection('export_tasks').doc(task._id).remove();
      for (const name of ['persons', 'relations', 'media_assets', 'family_memberships', 'invitations', 'audit_logs']) for (const row of await list(name, { familyId })) await db.collection(name).doc(row._id).remove();
      for (const role of ['admin', 'member', 'viewer']) {
        const actor = uid(event.run, role); for (const row of await list('idempotency_records', { actorId: actor })) await db.collection('idempotency_records').doc(row._id).remove();
        await db.collection('users').doc(actor).remove();
      }
      await db.collection('families').doc(familyId).remove(); await db.collection('example_templates').doc(familyId).remove();
      data = { cleaned: true, clientPdfStateRestored: Boolean(client) };
    }
    assert(data, 'PROBE_ACTION'); return { success: true, data };
  } catch (error) { return { success: false, code: error.code || 'PROBE_FAILED', message: String(error.message).slice(0, 180) }; }
};
