const analytics = require('./analytics');
const crypto = require('crypto');
const LIMIT = 20000;
const CHUNK = 100;
const USER_METRICS = new Set(['newUsers', 'enteredUsers', 'exampleUsers', 'createdUsers', 'joinedUsers', 'activeUsers', 'payingUsers']);
const FAMILY_METRICS = new Set(['newFamilies', 'familiesWithRelatives', 'collaborativeFamilies', 'activeFamilies', 'payingFamilies', 'activeMemberFamilies']);
const ORDER_METRICS = new Set(['orders', 'convertedOrders', 'paidOrders', 'refundOrders']);
function mergeFirst(row, field, at) {
  if (Number.isFinite(analytics.ms(at)) && (!row[field] || analytics.ms(at) < analytics.ms(row[field]))) row[field] = at;
}
function createService({ db, command: _, listAll, listByIds: readByIds, maybeGet }, now = () => new Date()) {
  async function listByIds(...args) {
    const rows = await readByIds(...args);
    if (rows.length > LIMIT) analytics.fail('RESULT_LIMIT_EXCEEDED', '关联记录超过统计上限，请缩小日期范围');
    return rows;
  }
  const between = (start, end) => _.gte(new Date(start)).and(_.lt(new Date(end)));
  async function load(filters) {
    const [users, currentFamilies, history, activity, created, paid, refunds, metadata, lifetime, fixed] = await Promise.all([
      listAll('users', { createdAt: between(filters.start, filters.end) }, LIMIT),
      listAll('families', { createdAt: between(filters.start, filters.end) }, LIMIT),
      listAll('analytics_history', { kind: 'family', createdAt: between(filters.start, filters.end) }, LIMIT),
      listAll('analytics_activity_daily', { day: _.gte(filters.startDay).and(_.lte(filters.endDay)) }, LIMIT),
      listAll('payment_orders', { createdAt: between(filters.start, filters.end) }, LIMIT),
      listAll('payment_orders', { paidAt: between(filters.start, filters.end) }, LIMIT),
      listAll('payment_orders', { refundedAt: between(filters.start, filters.end) }, LIMIT),
      maybeGet('system_config', 'analytics'),
      listAll('families', { status: 'active', proLifetime: true }, LIMIT),
      listAll('families', { status: 'active', proExpiresAt: _.gt(new Date(filters.asOf)) }, LIMIT)
    ]);
    const families = analytics.unique(history.map(row => Object.assign({}, row, { _id: row.entityId })).concat(currentFamilies));
    const [createdFamilies, createdHistory, userMembers, familyMembers, historyMembers, historyUserMembers, userJoins, familyJoins] = await Promise.all([
      listByIds('families', 'creatorId', users.map(row => row._id), {}, LIMIT),
      listByIds('analytics_history', 'creatorId', users.map(row => row._id), { kind: 'family' }, LIMIT),
      listByIds('family_memberships', 'userId', users.map(row => row._id), {}, LIMIT),
      listByIds('family_memberships', 'familyId', families.map(row => row._id), {}, LIMIT),
      listByIds('analytics_history', 'familyId', families.map(row => row._id), { kind: 'membership' }, LIMIT),
      listByIds('analytics_history', 'userId', users.map(row => row._id), { kind: 'membership' }, LIMIT),
      listByIds('audit_logs', 'actorId', users.flatMap(row => [row._id, row.anonymousActorId].filter(Boolean)), { action: 'membership.join' }, LIMIT),
      listByIds('audit_logs', 'familyId', families.map(row => row._id), { action: 'membership.join' }, LIMIT)
    ]);
    const members = analytics.unique(historyMembers.concat(historyUserMembers).map(row => Object.assign({}, row, { _id: row.entityId })).concat(userMembers, familyMembers));
    const joins = analytics.unique(userJoins.concat(familyJoins));
    const referenced = Array.from(new Set(members.map(row => row.familyId).concat(joins.map(row => row.familyId))));
    const [parents, parentHistory] = await Promise.all([
      listByIds('families', '_id', referenced, {}, LIMIT),
      listByIds('analytics_history', 'entityId', referenced, { kind: 'family' }, LIMIT)
    ]);
    const allFamilies = analytics.unique(createdHistory.concat(parentHistory).map(row => Object.assign({}, row, { _id: row.entityId })).concat(createdFamilies, parents, families));
    const familyMap = new Map(allFamilies.map(row => [row._id, row]));
    const userMap = new Map(users.map(row => [row._id, row]));
    const referencedUsers = await listByIds('users', '_id', allFamilies.map(row => row.creatorId).concat(members.map(row => row.userId)), {}, LIMIT);
    const actorMap = new Map(referencedUsers.concat(users).flatMap(row => [row._id, row.anonymousActorId].filter(Boolean).map(actor => [actor, row])));
    for (const family of allFamilies) {
      const user = userMap.get(family.creatorId);
      if (user) mergeFirst(user, 'firstCreatedFamilyAt', family.createdAt);
    }
    for (const family of families) { family.activeRelativeCount = 0; family.relativeCount = 0; }
    const seen = new Set();
    for (const member of members) {
      const family = familyMap.get(member.familyId);
      if (!family || member.userId === family.creatorId) continue;
      const first = member.firstJoinedAt || member.joinedAt;
      if (analytics.ms(first) > filters.asOf) continue;
      mergeFirst(family, 'firstRelativeJoinedAt', first);
      const user = userMap.get(member.userId);
      if (user) mergeFirst(user, 'firstJoinedFamilyAt', first);
      const key = member.familyId + ':' + member.userId;
      if (!seen.has(key)) {
        seen.add(key); family.relativeCount = (family.relativeCount || 0) + 1;
        if (member.status === 'active') family.activeRelativeCount = (family.activeRelativeCount || 0) + 1;
      }
    }
    // A retained join audit can recover a first join that an old client overwrote.
    for (const join of joins) {
      const family = familyMap.get(join.familyId);
      const user = actorMap.get(join.actorId);
      const actor = user ? user._id : join.actorId;
      if (!family || family.creatorId === actor || analytics.ms(join.createdAt) > filters.asOf) continue;
      mergeFirst(family, 'firstRelativeJoinedAt', join.createdAt);
      if (user) mergeFirst(user, 'firstJoinedFamilyAt', join.createdAt);
      const key = join.familyId + ':' + actor;
      if (!seen.has(key)) { seen.add(key); family.relativeCount = (family.relativeCount || 0) + 1; }
    }
    // The same family can have both a lifetime flag and an expiry; count its ID once.
    const memberFamilies = analytics.unique(lifetime.concat(fixed));
    const orders = analytics.unique(created.concat(paid, refunds)).map(row => Object.assign({}, row, { payerUserId: row.payerAnalyticsId || row.payerUserId }));
    const input = { users, families, activity, orders, trackingStartedAt: metadata && metadata.trackingStartedAt, activeMemberFamilies: memberFamilies.length };
    const result = analytics.build(input, filters);
    result.details.activeMemberFamilies = memberFamilies;
    const [detailUsers, detailFamilies] = await Promise.all([
      listByIds('users', '_id', result.details.activeUsers.concat(result.details.payingUsers).map(row => row._id), {}, LIMIT),
      listByIds('families', '_id', result.details.activeFamilies.concat(result.details.payingFamilies).map(row => row._id), {}, LIMIT)
    ]);
    const detailUserMap = new Map(detailUsers.concat(users).map(row => [row._id, row]));
    const detailFamilyMap = new Map(detailFamilies.concat(families).map(row => [row._id, row]));
    for (const key of ['activeUsers', 'payingUsers']) result.details[key] = result.details[key].map(row => detailUserMap.get(row._id) || Object.assign({}, row, { cleaned: true }));
    for (const key of ['activeFamilies', 'payingFamilies']) result.details[key] = result.details[key].map(row => detailFamilyMap.get(row._id) || Object.assign({}, row, { cleaned: true }));
    return result;
  }
  function safeItem(row, metric) {
    const kind = USER_METRICS.has(metric) ? 'user' : FAMILY_METRICS.has(metric) ? 'family' : 'order';
    const allowed = kind === 'user' ? ['createdAt', 'firstEnteredFamilyAt', 'firstExampleViewedAt', 'firstCreatedFamilyAt', 'firstJoinedFamilyAt', 'status']
      : kind === 'family' ? ['createdAt', 'creatorId', 'firstRelativeJoinedAt', 'relativeCount', 'activeRelativeCount', 'status']
        : ['createdAt', 'paidAt', 'refundedAt', 'familyId', 'productId', 'productName', 'priceCents', 'paymentMode', 'status'];
    const item = { _id: row._id, kind, cleaned: Boolean(row.cleaned || row.status === 'deleted') };
    for (const field of allowed) if (row[field] !== undefined) item[field] = row[field];
    return item;
  }
  async function summary(event) {
    const filters = analytics.range(event, now());
    const key = 'report_' + analytics.fingerprint(Object.assign({}, filters, { asOf: event.asOf ? filters.asOf : 0 }), 'summary');
    const cached = await maybeGet('analytics_reports', key);
    if (cached && analytics.ms(cached.expiresAt) > filters.asOf) return cached.report;
    const result = await load(filters);
    const snapshotId = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(filters.asOf + analytics.DAY_MS);
    const report = Object.assign(result.report, { snapshotId });
    const counts = {};
    const writes = [];
    const groups = Object.assign({}, result.details);
    const enrichedMaps = new Map(Object.entries(result.details).map(([metric, items]) => [metric, new Map(items.map(row => [row._id, row]))]));
    for (const [date, selection] of Object.entries(result.dailyDetails)) {
      for (const [metric, values] of Object.entries(selection)) {
        const enriched = enrichedMaps.get(metric);
        groups[metric + '_day_' + date] = values.map(row => enriched.get(row._id) || row);
      }
    }
    for (const [groupKey, raw] of Object.entries(groups)) {
      const metric = groupKey.split('_day_')[0];
      const items = raw.map(row => safeItem(row, metric)).sort((a, b) => a._id.localeCompare(b._id));
      counts[groupKey] = items.length;
      for (let offset = 0; offset < items.length; offset += CHUNK) {
        writes.push(() => db.collection('analytics_snapshot_items').doc(snapshotId + '_' + groupKey + '_' + offset).set({ data: { group: snapshotId + ':' + groupKey, offset, items: items.slice(offset, offset + CHUNK), expiresAt } }));
      }
    }
    // Persist anonymous daily aggregates independently of source-record retention.
    for (const row of report.rows) {
      writes.push(() => db.collection('analytics_daily').doc(row.day + '_' + filters.window + '_' + filters.paymentMode).set({ data: { row, day: row.day, window: filters.window, paymentMode: filters.paymentMode, asOf: report.asOf } }));
    }
    for (let offset = 0; offset < writes.length; offset += 8) await Promise.all(writes.slice(offset, offset + 8).map(write => write()));
    await db.collection('analytics_snapshots').doc(snapshotId).set({ data: { filters: report.filters, asOf: report.asOf, counts, expiresAt } });
    await db.collection('analytics_reports').doc(key).set({ data: { report, expiresAt: new Date(filters.asOf + 30000) } });
    return report;
  }
  async function details(event) {
    const metric = String(event.metric || '');
    if (!USER_METRICS.has(metric) && !FAMILY_METRICS.has(metric) && !ORDER_METRICS.has(metric)) analytics.fail('ANALYTICS_INVALID_METRIC', '该指标不支持明细');
    if (!/^[a-f0-9]{32}$/.test(event.snapshotId || '')) analytics.fail('ANALYTICS_INVALID_SNAPSHOT', '请先查询统计数据');
    const snapshot = await maybeGet('analytics_snapshots', event.snapshotId);
    if (!snapshot || analytics.ms(snapshot.expiresAt) <= analytics.ms(now())) analytics.fail('ANALYTICS_SNAPSHOT_EXPIRED', '统计快照已过期，请重新查询');
    for (const key of ['startDay', 'endDay', 'window', 'paymentMode']) if (event[key] !== snapshot.filters[key]) analytics.fail('ANALYTICS_INVALID_CURSOR', '明细筛选与统计结果不一致，请重新查询');
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(event.pageSize) || 20)));
    if (event.day && (!/^\d{4}-\d{2}-\d{2}$/.test(event.day) || event.day < snapshot.filters.startDay || event.day > snapshot.filters.endDay)) analytics.fail('ANALYTICS_INVALID_RANGE', '明细日期必须在已查询范围内');
    const groupKey = event.day ? metric + '_day_' + event.day : metric;
    if (event.day && !Object.prototype.hasOwnProperty.call(snapshot.counts, groupKey)) analytics.fail('ANALYTICS_INVALID_RANGE', '该日期或指标没有每日明细');
    const group = event.snapshotId + ':' + groupKey;
    let offset = 0;
    if (event.cursor) {
      try { const cursor = JSON.parse(Buffer.from(event.cursor, 'base64url').toString()); if (cursor.group !== group || !Number.isInteger(cursor.offset) || cursor.offset < 0) throw new Error(); offset = cursor.offset; }
      catch (error) { analytics.fail('ANALYTICS_INVALID_CURSOR', '分页条件已改变，请重新查询'); }
    }
    const total = snapshot.counts[groupKey] || 0;
    const start = Math.floor(offset / CHUNK) * CHUNK;
    const batches = await db.collection('analytics_snapshot_items').where({ group, offset: _.gte(start).and(_.lt(offset + pageSize)) }).orderBy('offset', 'asc').limit(2).get();
    const items = (batches.data || []).flatMap(batch => batch.items).slice(offset - start, offset - start + pageSize);
    const hasMore = offset + items.length < total;
    if (hasMore && !items.length) analytics.fail('ANALYTICS_SNAPSHOT_EXPIRED', '统计明细不完整，请重新查询');
    return { items, total, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ group, offset: offset + items.length })).toString('base64url') : '', asOf: snapshot.asOf };
  }
  return { summary, details, load };
}
module.exports = { createService, mergeFirst };
