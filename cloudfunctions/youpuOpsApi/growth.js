const analytics = require('./analytics');
const DAY = 86400000;
const ms = value => value ? new Date(value).getTime() : NaN;
function summarize(visitors, events, users, families, filters, trackingStartedAt) {
  const userMap = new Map(users.map(user => [user._id, user]));
  const groups = new Map();
  const zero = { visitors: 0, exampleVisitors: 0, createClicks: 0, newUsers: 0, createdUsers: 0, familiesWithRelatives: 0, loadErrorVisitors: 0 };
  const totals = { ...zero };
  const defaultEntry = { ...zero, mature: true, collaborationMature: true };
  const byVisitor = new Map();
  for (const event of events) {
    if (!byVisitor.has(event.visitorId)) byVisitor.set(event.visitorId, []);
    byVisitor.get(event.visitorId).push(event);
  }
  let mature = true; let collaborationMature = true;
  for (const visitor of visitors) {
    if (visitor.test || (filters.source !== 'all' && visitor.source !== filters.source)) continue;
    const first = ms(visitor.firstAt); const end = first + 7 * DAY;
    if (first > filters.asOf) continue;
    const isDefaultEntry = visitor.entryType === 'default_example';
    const key = visitor.page + '|' + visitor.slug + '|' + (visitor.entryType || '');
    if (!groups.has(key)) groups.set(key, { page: visitor.page, slug: visitor.slug, entryType: visitor.entryType || '', ...zero, mature: true, collaborationMature: true });
    const row = groups.get(key);
    const facts = (byVisitor.get(visitor._id) || []).filter(event => !event.test && ms(event.at) >= first && ms(event.at) < end && ms(event.at) <= filters.asOf);
    const user = userMap.get(visitor.userId);
    const registered = Boolean(user && ms(user.createdAt) >= first && ms(user.createdAt) < end && ms(user.createdAt) <= filters.asOf);
    // Only the first family of a new account belongs to this acquisition cohort.
    const createdAt = registered ? ms(user.firstCreatedFamilyAt) : NaN;
    const created = createdAt >= first && createdAt < end && createdAt <= filters.asOf;
    const firstFamily = created && families.filter(family => family.creatorId === user._id && ms(family.createdAt) === createdAt).sort((a, b) => String(a._id).localeCompare(String(b._id)))[0];
    const joinedAt = firstFamily && ms(firstFamily.firstRelativeJoinedAt);
    const values = { visitors: 1, exampleVisitors: Number(facts.some(event => event.event === 'example')), createClicks: Number(facts.some(event => event.event === 'create_click')), loadErrorVisitors: Number(facts.some(event => event.event === 'load_error' && event.entryType === 'default_example')),
      newUsers: Number(registered), createdUsers: Number(created), familiesWithRelatives: Number(Boolean(created && joinedAt >= createdAt && joinedAt < createdAt + 7 * DAY && joinedAt <= filters.asOf)) };
    for (const field of Object.keys(values)) { totals[field] += values[field]; row[field] += values[field]; }
    if (isDefaultEntry) {
      const entryValues = { ...values,
        exampleVisitors: Number(facts.some(event => event.event === 'example' && event.entryType === 'default_example')),
        createClicks: Number(facts.some(event => event.event === 'create_click' && event.entryType === 'default_example')) };
      for (const field of Object.keys(entryValues)) defaultEntry[field] += entryValues[field];
    }
    row.mature = row.mature && filters.asOf >= end;
    row.collaborationMature = row.collaborationMature && filters.asOf >= (created ? createdAt + 7 * DAY : first + 14 * DAY);
    mature = mature && row.mature;
    collaborationMature = collaborationMature && row.collaborationMature;
    if (isDefaultEntry) { defaultEntry.mature = defaultEntry.mature && row.mature; defaultEntry.collaborationMature = defaultEntry.collaborationMature && row.collaborationMature; }
  }
  function rates(row) { return { ...row, createRate: row.visitors ? Math.round(row.createdUsers / row.visitors * 10000) / 100 : null,
    relativeRate: row.createdUsers ? Math.round(row.familiesWithRelatives / row.createdUsers * 10000) / 100 : null,
    loadSuccessRate: row.visitors ? Math.round(row.exampleVisitors / row.visitors * 10000) / 100 : null,
    clickRate: row.visitors ? Math.round(row.createClicks / row.visitors * 10000) / 100 : null }; }
  const complete = Boolean(trackingStartedAt && analytics.day(trackingStartedAt) < filters.startDay);
  return { filters: { startDay: filters.startDay, endDay: filters.endDay, source: filters.source }, asOf: new Date(filters.asOf).toISOString(),
    trackingStartedAt: trackingStartedAt || null, complete, mature, collaborationMature, totals: rates(totals), defaultEntry: rates(defaultEntry),
    rows: Array.from(groups.values()).map(rates).sort((a, b) => b.visitors - a.visitors || (a.page + a.slug).localeCompare(b.page + b.slug)) };
}
function createService({ db, command, listAll, listByIds, maybeGet }) {
  async function summary(event) {
    const filters = analytics.range({ startDay: event.startDay, endDay: event.endDay, window: '7d' });
    filters.source = event.source || 'search';
    if (!['search', 'share', 'unknown', 'all'].includes(filters.source)) analytics.fail('GROWTH_INVALID_SOURCE', '来源无效');
    const [visitors, events, config] = await Promise.all([
      listAll('growth_visitors', { firstDay: command.gte(filters.startDay).and(command.lte(filters.endDay)) }, 20000),
      listAll('growth_events', { day: command.gte(filters.startDay).and(command.lte(analytics.day(Math.min(filters.asOf, filters.end + 7 * DAY)))) }, 20000),
      maybeGet('system_config', 'growth')
    ]);
    const users = await listByIds('users', '_id', visitors.filter(visitor => !visitor.test).map(visitor => visitor.userId).filter(Boolean), {}, 20000);
    const ids = users.filter(user => user.firstCreatedFamilyAt).map(user => user._id);
    const [families, history] = await Promise.all([
      listByIds('families', 'creatorId', ids, {}, 20000),
      listByIds('analytics_history', 'creatorId', ids, { kind: 'family' }, 20000)
    ]);
    const allFamilies = analytics.unique(history.map(row => ({ ...row, _id: row.entityId })).concat(families));
    return summarize(visitors, events, users, allFamilies, filters, config && config.trackingStartedAt);
  }
  return { summary };
}
module.exports = { createService, summarize };
