const crypto = require('crypto');
const RUNTIME_ENVIRONMENT = process.env.TCB_ENV || process.env.JOB_FUNCTION_NAMESPACE || '';
const BATCH_SIZE = 20;
const LEASE_MS = 960000; // Longer than the deployed 900s invocation ceiling.
const FAILURE_MESSAGES = {
  COPY_SOURCE_UNAVAILABLE: '原家谱或你的访问权限已变化，请重新确认后再试',
  COPY_ACCOUNT_UNAVAILABLE: '账户当前不能复制家谱',
  GRAPH_CHANGED: '家谱正在修改，请稍后重试',
  COPY_INVALID_GRAPH: '家谱关系资料异常，请联系管理员检查',
  COPY_LIMIT_EXCEEDED: '家谱超过 500 人或 2000 条关系，暂时无法复制',
  COPY_TIMEOUT: '复制任务等待时间过长，请重新发起',
  COPY_FAILED: '复制未完成，请稍后重试'
};
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 40); }
function fail(code) { throw Object.assign(new Error(FAILURE_MESSAGES[code] || FAILURE_MESSAGES.COPY_FAILED), { code }); }
async function read(scope, name, id) {
  try { return (await scope.collection(name).doc(id).get()).data || null; }
  catch (error) {
    if (/document with _id [^\s]+ does not exist/.test(String(error.errMsg || error.message))) return null;
    throw error;
  }
}
function id(task, kind, source) { return kind + '_' + hash(task._id + ':' + source); }
function fields(value, keys) {
  const result = {};
  keys.forEach(function (key) { if (value[key] !== undefined) result[key] = value[key]; });
  return result;
}
function validateGraph(persons, relations) {
  if (persons.length > 500 || relations.length > 2000) fail('COPY_LIMIT_EXCEEDED');
  const people = new Set(persons.map(p => p._id));
  if (people.size !== persons.length || persons.some(p => !p._id || !p.name)) fail('COPY_INVALID_GRAPH');
  const edges = new Set(); const children = new Map(); const indegree = new Map(persons.map(p => [p._id, 0]));
  for (const r of relations) {
    if (!['spouse', 'parent_child'].includes(r.type) || !people.has(r.fromPersonId) || !people.has(r.toPersonId) || r.fromPersonId === r.toPersonId) fail('COPY_INVALID_GRAPH');
    const pair = r.type === 'spouse' ? [r.fromPersonId, r.toPersonId].sort() : [r.fromPersonId, r.toPersonId];
    const key = r.type + ':' + pair.join(':');
    if (edges.has(key)) fail('COPY_INVALID_GRAPH');
    edges.add(key);
    if (r.type === 'parent_child') {
      if (!children.has(r.fromPersonId)) children.set(r.fromPersonId, []);
      children.get(r.fromPersonId).push(r.toPersonId);
      indegree.set(r.toPersonId, indegree.get(r.toPersonId) + 1);
    }
  }
  const queue = persons.filter(p => indegree.get(p._id) === 0).map(p => p._id); let seen = 0;
  for (let index = 0; index < queue.length; index += 1) {
    seen += 1;
    for (const child of children.get(queue[index]) || []) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  if (seen !== persons.length) fail('COPY_INVALID_GRAPH');
}
function createWorker(options) {
  const { db, cloud, dispatchJob } = options;
  const clock = options.now || Date.now;
  const environmentId = options.environmentId || RUNTIME_ENVIRONMENT;
  async function list(name, where, maximum) {
    const rows = []; let cursor = '';
    while (true) {
      const conditions = Object.assign({}, where, cursor ? { _id: db.command.gt(cursor) } : {});
      const page = (await db.collection(name).where(conditions).orderBy('_id', 'asc').limit(100).get()).data || [];
      rows.push(...page);
      if (rows.length > maximum) fail('COPY_LIMIT_EXCEEDED');
      if (page.length < 100) return rows;
      cursor = page[page.length - 1]._id;
    }
  }
  async function access(task, scope) {
    const user = await read(scope, 'users', task.userId);
    if (!user || user.status !== 'active') fail('COPY_ACCOUNT_UNAVAILABLE');
    const family = await read(scope, 'families', task.sourceFamilyId);
    const member = await read(scope, 'family_memberships', task.sourceMembershipId);
    if (!family || family.status !== 'active' || family.isExample || family.exampleTemplateId || !member || member.status !== 'active' || member.userId !== task.userId || member.familyId !== task.sourceFamilyId || !['admin', 'member', 'viewer'].includes(member.role)) fail('COPY_SOURCE_UNAVAILABLE');
    return { family, user };
  }
  async function owned(tx, task, token) {
    const current = await read(tx, 'family_copy_tasks', task._id);
    if (!current || current.status !== 'processing' || current.token !== token || new Date(current.leaseUntil).getTime() <= clock()) fail('COPY_LEASE_LOST');
    return current;
  }
  async function write(task, token, callback, patch) {
    return db.runTransaction(async function (tx) {
      const current = await owned(tx, task, token);
      if (callback) await callback(tx, current);
      await tx.collection('family_copy_tasks').doc(task._id).update({ data: Object.assign({}, patch, { updatedAt: db.serverDate() }) });
    });
  }
  async function snapshot(task, token) {
    const partial = await list('family_copy_chunks', { taskId: task._id }, 150);
    for (const chunk of partial) await write(task, token, async function (tx) { await tx.collection('family_copy_chunks').doc(chunk._id).remove(); }, {});
    let dataset;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = (await access(task, db)).family;
      const persons = await list('persons', { familyId: task.sourceFamilyId, status: 'active' }, 500);
      const relations = await list('relations', { familyId: task.sourceFamilyId, status: 'active' }, 2000);
      const after = (await access(task, db)).family;
      if (Number(before.contentRevision || 0) !== Number(after.contentRevision || 0)) continue;
      validateGraph(persons, relations);
      dataset = { description: before.description || '', persons, relations };
      break;
    }
    if (!dataset) fail('GRAPH_CHANGED');
    // Chunk documents keep even 500 long biographies below the document limit.
    for (const kind of ['persons', 'relations']) {
      for (let offset = 0; offset < dataset[kind].length; offset += BATCH_SIZE) {
        await write(task, token, async function (tx) {
          await tx.collection('family_copy_chunks').doc(id(task, kind, String(offset))).set({ data: {
            taskId: task._id, kind, offset, rows: dataset[kind].slice(offset, offset + BATCH_SIZE)
          } });
        }, {});
      }
    }
    await write(task, token, null, {
      snapshotReady: true, description: dataset.description, personCount: dataset.persons.length,
      relationCount: dataset.relations.length, avatarCount: dataset.persons.filter(p => p.avatarAssetId).length,
      stage: 'persons'
    });
    return dataset;
  }
  async function loadSnapshot(task) {
    const chunks = await list('family_copy_chunks', { taskId: task._id }, 150);
    function rows(kind) { return chunks.filter(c => c.kind === kind).sort((a, b) => a.offset - b.offset).flatMap(c => c.rows); }
    return { persons: rows('persons'), relations: rows('relations') };
  }
  async function release(tx, task) {
    const actor = await read(tx, 'users', task.userId);
    if (actor && actor.activeCopyTaskId === task._id) await tx.collection('users').doc(actor._id).update({ data: { activeCopyTaskId: '' } });
  }
  async function cleanup(task) {
    if (await read(db, 'families', task.targetFamilyId)) return; // Never touch a published copy.
    const assets = await list('media_assets', { familyId: task.targetFamilyId }, 500);
    for (let offset = 0; offset < assets.length; offset += 20) {
      const files = assets.slice(offset, offset + 20).map(a => a.fileId).filter(Boolean);
      if (files.length) {
        const result = await cloud.deleteFile({ fileList: files });
        if (!result.fileList || result.fileList.some(f => Number(f.status || 0) !== 0 && !/not.?found|not.?exist/i.test(f.errMsg || ''))) throw new Error('copy cleanup incomplete');
      }
    }
    for (const name of ['persons', 'relations', 'media_assets']) {
      const rows = await list(name, { familyId: task.targetFamilyId }, 2500);
      for (const row of rows) await db.collection(name).doc(row._id).remove();
    }
    await clearChunks(task);
    await db.collection('family_copy_tasks').doc(task._id).update({ data: { cleanupPending: false, cleanedAt: db.serverDate() } });
  }
  async function clearChunks(task) {
    const rows = await list('family_copy_chunks', { taskId: task._id }, 150);
    for (const row of rows) await db.collection('family_copy_chunks').doc(row._id).remove();
  }
  async function failed(task, token, code) {
    await db.runTransaction(async function (tx) {
      await owned(tx, task, token);
      await tx.collection('family_copy_tasks').doc(task._id).update({ data: {
        status: 'failed', failureCode: FAILURE_MESSAGES[code] ? code : 'COPY_FAILED',
        missingAvatars: [], token: '', cleanupPending: true, failedAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      await release(tx, task);
    });
    try { await cleanup(task); } catch (error) { /* Retention retries private temporary resources. */ }
  }
  async function defer(task, token) {
    await write(task, token, null, { status: 'pending', token: '', leaseUntil: new Date(0) });
    try { await dispatchJob('task.family-copy', task._id); } catch (error) { /* Status/retention redispatches pending work. */ }
    return { taskId: task._id, continued: true };
  }
  async function avatar(task, token, sourceId) {
    const asset = await read(db, 'media_assets', sourceId);
    if (!asset || asset.familyId !== task.sourceFamilyId || asset.kind !== 'person_avatar' || asset.status !== 'active' || asset.moderationStatus !== 'approved' || !asset.fileId) return { reason: 'unavailable' };
    const assetId = id(task, 'mcopy', sourceId);
    const existing = await read(db, 'media_assets', assetId);
    if (existing && existing.status === 'active') return { assetId };
    const prefix = String(asset.fileId).match(/^cloud:\/\/[^/]+\//);
    if (!prefix || environmentId && !String(asset.fileId).startsWith('cloud://' + environmentId + '.')) return { reason: 'unavailable' };
    const extension = /\.(jpg|jpeg|png|webp)$/i.exec(asset.cloudPath || asset.fileId);
    const cloudPath = 'family-copies/' + task._id + '/' + assetId + '.' + (extension ? extension[1].toLowerCase() : 'jpg');
    const expectedFileId = prefix[0] + cloudPath;
    // Reserve the deterministic file ID before upload so hard timeouts and
    // lost upload responses can be cleaned without listing the storage bucket.
    await write(task, token, async function (tx) {
      await tx.collection('media_assets').doc(assetId).set({ data: {
        ownerId: task.userId, familyId: task.targetFamilyId, kind: 'person_avatar',
        status: 'copying', moderationStatus: 'approved', fileId: expectedFileId, cloudPath,
        size: Number(asset.size || 0), createdAt: db.serverDate(), updatedAt: db.serverDate()
      } });
    }, {});
    try {
      const downloaded = await cloud.downloadFile({ fileID: asset.fileId });
      if (!downloaded.fileContent || !downloaded.fileContent.length || downloaded.fileContent.length > 5 * 1024 * 1024) return { reason: 'unavailable' };
      const uploaded = await cloud.uploadFile({ cloudPath, fileContent: downloaded.fileContent });
      if (!uploaded || uploaded.fileID !== expectedFileId) throw new Error('copy upload invalid');
      await write(task, token, async function (tx) {
        const current = await read(tx, 'media_assets', sourceId);
        if (!current || current.fileId !== asset.fileId || current.status !== 'active' || current.moderationStatus !== 'approved') fail('COPY_AVATAR_UNAVAILABLE');
        await tx.collection('media_assets').doc(assetId).update({ data: { status: 'active', size: downloaded.fileContent.length, updatedAt: db.serverDate() } });
      }, {});
      return { assetId };
    } catch (error) {
      if (error.code === 'COPY_LEASE_LOST') throw error;
      return { reason: error.code === 'COPY_AVATAR_UNAVAILABLE' ? 'unavailable' : 'transfer_failed' };
    }
  }
  async function processCopyTask(taskId) {
    const token = crypto.randomBytes(16).toString('hex');
    const task = await db.runTransaction(async function (tx) {
      const current = await read(tx, 'family_copy_tasks', taskId);
      if (!current || !['pending', 'processing'].includes(current.status)) return null;
      if (current.status === 'processing' && new Date(current.leaseUntil).getTime() > clock()) return null;
      await tx.collection('family_copy_tasks').doc(taskId).update({ data: { status: 'processing', token, leaseUntil: new Date(clock() + LEASE_MS), updatedAt: db.serverDate() } });
      return current;
    });
    if (!task) return { taskId, skipped: true };
    const start = clock();
    try {
      await access(task, db);
      const dataset = task.snapshotReady ? await loadSnapshot(task) : await snapshot(task, token);
      validateGraph(dataset.persons, dataset.relations);
      Object.assign(task, await read(db, 'family_copy_tasks', taskId));
      if (dataset.persons.length !== task.personCount || dataset.relations.length !== task.relationCount) fail('COPY_INVALID_GRAPH');
      for (let offset = task.personsDone || 0; offset < dataset.persons.length; offset += BATCH_SIZE) {
        if (clock() - start > 720000) return defer(task, token);
        const group = dataset.persons.slice(offset, offset + BATCH_SIZE);
        await write(task, token, async function (tx) {
          for (const person of group) await tx.collection('persons').doc(id(task, 'pcopy', person._id)).set({ data: Object.assign(fields(person, ['name', 'gender', 'birthPlace', 'bio', 'lifeStatus', 'birthDate', 'birthDateInfo', 'birthDateRange', 'deathDate', 'deathDateInfo', 'deathDateRange']), {
            familyId: task.targetFamilyId, avatarAssetId: '', status: 'active', createdBy: task.userId, createdAt: db.serverDate(), updatedAt: db.serverDate()
          }) });
        }, { personsDone: offset + group.length, stage: 'persons' });
      }
      await write(task, token, null, { stage: 'avatars' });
      const avatarPeople = dataset.persons.filter(p => p.avatarAssetId);
      const results = new Map();
      for (let offset = task.avatarsDone || 0; offset < avatarPeople.length; offset += 1) {
        if (clock() - start > 720000) return defer(task, token);
        const person = avatarPeople[offset];
        if (!results.has(person.avatarAssetId)) results.set(person.avatarAssetId, await avatar(task, token, person.avatarAssetId));
        const result = results.get(person.avatarAssetId);
        await write(task, token, async function (tx, current) {
          if (result.assetId) await tx.collection('persons').doc(id(task, 'pcopy', person._id)).update({ data: { avatarAssetId: result.assetId } });
          else await tx.collection('family_copy_tasks').doc(taskId).update({ data: { missingAvatars: (current.missingAvatars || []).concat({ personId: id(task, 'pcopy', person._id), name: person.name, reason: result.reason }) } });
        }, { avatarsDone: offset + 1 });
      }
      await write(task, token, null, { stage: 'relations' });
      for (let offset = task.relationsDone || 0; offset < dataset.relations.length; offset += BATCH_SIZE) {
        if (clock() - start > 720000) return defer(task, token);
        const group = dataset.relations.slice(offset, offset + BATCH_SIZE);
        await write(task, token, async function (tx) {
          for (const relation of group) {
            let from = id(task, 'pcopy', relation.fromPersonId); let to = id(task, 'pcopy', relation.toPersonId);
            if (relation.type === 'spouse' && from > to) [from, to] = [to, from];
            // Match the user API's canonical relation ID for future edits.
            const relationId = 'r_' + hash([task.targetFamilyId, relation.type, from, to].join(':'));
            await tx.collection('relations').doc(relationId).set({ data: Object.assign(fields(relation, ['childOrder', 'childOrderUpdatedAt']), {
              familyId: task.targetFamilyId, type: relation.type, fromPersonId: from, toPersonId: to,
              status: 'active', createdBy: task.userId, createdAt: db.serverDate(), updatedAt: db.serverDate()
            }) });
          }
        }, { relationsDone: offset + group.length });
      }
      await write(task, token, null, { stage: 'verify' });
      const people = await list('persons', { familyId: task.targetFamilyId, status: 'active' }, 500);
      const relations = await list('relations', { familyId: task.targetFamilyId, status: 'active' }, 2000);
      if (people.length !== dataset.persons.length || relations.length !== dataset.relations.length) fail('COPY_INVALID_GRAPH');
      validateGraph(people, relations);
      // Unreferenced failed avatar uploads are not retained in a successful copy.
      const used = new Set(people.map(p => p.avatarAssetId).filter(Boolean));
      const assets = await list('media_assets', { familyId: task.targetFamilyId }, 500);
      for (const asset of assets.filter(a => !used.has(a._id))) {
        const result = await cloud.deleteFile({ fileList: [asset.fileId] });
        if (!result.fileList || result.fileList.some(f => Number(f.status || 0) !== 0 && !/not.?found|not.?exist/i.test(f.errMsg || ''))) throw new Error('copy file cleanup failed');
        await write(task, token, async tx => { await tx.collection('media_assets').doc(asset._id).remove(); }, {});
      }
      await write(task, token, async function (tx) {
        const currentAccess = await access(task, tx);
        const user = currentAccess.user;
        const family = { name: task.name, description: task.description, creatorId: task.userId, status: 'active', privacy: 'private', schemaVersion: 3,
          personCount: people.length, relationCount: relations.length, relationRevision: relations.length, contentRevision: 0, adminCount: 1,
          createdAt: db.serverDate(), updatedAt: db.serverDate() };
        if (await read(tx, 'families', task.targetFamilyId)) fail('COPY_INVALID_GRAPH');
        await tx.collection('families').doc(task.targetFamilyId).set({ data: family });
        await tx.collection('family_memberships').doc(task.targetMembershipId).set({ data: {
          familyId: task.targetFamilyId, userId: task.userId, role: 'admin', displayName: user.nickName || '创建者', avatarAssetId: user.avatarAssetId || '',
          status: 'active', joinedAt: db.serverDate(), updatedAt: db.serverDate()
        } });
        if (!user.firstCreatedFamilyAt) await tx.collection('users').doc(user._id).update({ data: { firstCreatedFamilyAt: db.serverDate() } });
        await tx.collection('audit_logs').doc(id(task, 'acopy', 'completed')).set({ data: {
          familyId: task.targetFamilyId, actorId: task.userId, actorName: user.nickName || '一位家人', actorType: 'user',
          action: 'family.create', objectType: 'family', objectId: task.targetFamilyId, summary: '复制创建家谱', requestId: task._id, createdAt: db.serverDate()
        } });
        await release(tx, task);
      }, { status: 'completed', stage: 'completed', token: '', completedAt: db.serverDate(), resultFamily: {
        _id: task.targetFamilyId, name: task.name, description: task.description, status: 'active', currentRole: 'admin', personCount: people.length, relationCount: relations.length
      }, cleanupPending: true });
      try {
        await clearChunks(task);
        await db.collection('family_copy_tasks').doc(taskId).update({ data: { cleanupPending: false } });
      } catch (error) { /* Retention removes the remaining private snapshot. */ }
      return { taskId, completed: true };
    } catch (error) {
      if (error.code !== 'COPY_LEASE_LOST') {
        try { await failed(task, token, error.code); } catch (failure) { if (failure.code !== 'COPY_LEASE_LOST') throw failure; }
      }
      return { taskId, completed: false };
    }
  }
  async function maintenance() {
    const tasks = await list('family_copy_tasks', { cleanupPending: true }, 5000);
    for (const task of tasks) {
      try {
        if (task.status === 'completed') {
          await clearChunks(task);
          await db.collection('family_copy_tasks').doc(task._id).update({ data: { cleanupPending: false } });
        } else if (task.status === 'failed') await cleanup(task);
      } catch (error) { /* Preserve cleanupPending until deletion succeeds. */ }
    }
    for (const state of ['pending', 'processing']) {
      const waiting = await list('family_copy_tasks', { status: state }, 5000);
      for (const task of waiting) {
        if (state === 'processing' && new Date(task.leaseUntil).getTime() > clock()) continue;
        if (clock() - new Date(task.createdAt).getTime() > 24 * 3600000) {
          const token = crypto.randomBytes(16).toString('hex');
          const claimed = await db.runTransaction(async function (tx) {
            const current = await read(tx, 'family_copy_tasks', task._id);
            if (!current || !['pending', 'processing'].includes(current.status) || new Date(current.leaseUntil).getTime() > clock()) return false;
            await tx.collection('family_copy_tasks').doc(task._id).update({ data: { status: 'processing', token, leaseUntil: new Date(clock() + LEASE_MS) } });
            return true;
          });
          if (claimed) await failed(task, token, 'COPY_TIMEOUT');
        } else {
          try { await dispatchJob('task.family-copy', task._id); } catch (error) { /* Next retention run retries. */ }
        }
      }
    }
    return { cleaned: tasks.length };
  }
  return { process: processCopyTask, maintenance };
}
module.exports = { createWorker, validateGraph, FAILURE_MESSAGES, LEASE_MS };
