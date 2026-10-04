const crypto = require('crypto');
const DAY_MS = 86400000;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function ms(value) { const result = new Date(value).getTime(); return Number.isFinite(result) && value ? result : NaN; }
function day(value) { return new Date(ms(value) + 8 * 3600000).toISOString().slice(0, 10); }
function midnight(value) { return Date.parse(value + 'T00:00:00+08:00'); }
function range(input = {}, now = new Date()) {
  const today = day(now);
  const startDay = input.startDay || today;
  const endDay = input.endDay || today;
  for (const value of [startDay, endDay]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(midnight(value)) || day(midnight(value)) !== value) fail('ANALYTICS_INVALID_RANGE', '请选择有效日期');
  }
  const start = midnight(startDay); const end = midnight(endDay) + DAY_MS;
  const window = input.window || 'day'; const paymentMode = input.paymentMode || 'live';
  if (end < start + DAY_MS || end - start > 90 * DAY_MS || endDay > today || !['day', '7d', '30d', 'asOf'].includes(window) || !['live', 'sandbox', 'mock', 'all'].includes(paymentMode)) fail('ANALYTICS_INVALID_RANGE', '最多查询 90 天，请检查日期、转化窗口和支付环境');
  const asOf = input.asOf ? ms(input.asOf) : ms(now);
  if (!Number.isFinite(asOf) || asOf > ms(now) || asOf < start) fail('ANALYTICS_INVALID_RANGE', '统计截止时间无效');
  return { startDay, endDay, window, paymentMode, start, end, asOf, today };
}
function unique(rows) { return Array.from(new Map((rows || []).map((row, index) => [row._id || 'missing_' + index, row])).values()); }
function rate(n, d) { return d ? Math.round(n / d * 10000) / 100 : null; }
function inRange(value, filters) { return ms(value) >= filters.start && ms(value) < filters.end && ms(value) <= filters.asOf; }
function conversion(at, createdAt, filters) {
  if (!Number.isFinite(ms(at)) || !Number.isFinite(ms(createdAt))) return false;
  const start = midnight(day(createdAt));
  const days = filters.window === 'day' ? 1 : filters.window === '7d' ? 7 : 30;
  const cutoff = filters.window === 'asOf' ? filters.asOf + 1 : Math.min(filters.asOf + 1, start + days * DAY_MS);
  return ms(at) >= ms(createdAt) && ms(at) < cutoff;
}
function build(input, filters) {
  const users = unique(input.users).filter(row => inRange(row.createdAt, filters));
  const families = unique(input.families).filter(row => inRange(row.createdAt, filters));
  const activity = unique((input.activity || []).map(row => Object.assign({}, row, { _id: row.kind + ':' + row.day + ':' + row.entityId }))).filter(row => row.day >= filters.startDay && row.day <= filters.endDay && (!row.createdAt || ms(row.createdAt) <= filters.asOf));
  const orders = unique(input.orders).filter(row => filters.paymentMode === 'all' || row.paymentMode === filters.paymentMode);
  const createdOrders = orders.filter(row => inRange(row.createdAt, filters));
  const paidOrders = orders.filter(row => inRange(row.paidAt, filters));
  const refundOrders = orders.filter(row => inRange(row.refundedAt, filters));
  const tracking = ms(input.trackingStartedAt);
  const complete = date => Number.isFinite(tracking) && midnight(date) >= tracking;
  const details = {
    newUsers: users,
    enteredUsers: users.filter(row => conversion(row.firstEnteredFamilyAt, row.createdAt, filters)),
    exampleUsers: users.filter(row => conversion(row.firstExampleViewedAt, row.createdAt, filters)),
    createdUsers: users.filter(row => conversion(row.firstCreatedFamilyAt, row.createdAt, filters)),
    joinedUsers: users.filter(row => conversion(row.firstJoinedFamilyAt, row.createdAt, filters)),
    newFamilies: families,
    familiesWithRelatives: families.filter(row => conversion(row.firstRelativeJoinedAt, row.createdAt, filters)),
    collaborativeFamilies: families.filter(row => row.status === 'active' && row.activeRelativeCount > 0),
    activeUsers: Array.from(new Set(activity.filter(row => row.kind === 'user').map(row => row.entityId))).map(_id => ({ _id })),
    activeFamilies: Array.from(new Set(activity.filter(row => row.kind === 'family').map(row => row.entityId))).map(_id => ({ _id })),
    orders: createdOrders,
    convertedOrders: createdOrders.filter(row => ms(row.paidAt) <= filters.asOf && ms(row.paidAt) >= ms(row.createdAt)),
    paidOrders,
    refundOrders,
    payingUsers: Array.from(new Set(paidOrders.map(row => row.payerUserId).filter(Boolean))).map(_id => ({ _id })),
    payingFamilies: Array.from(new Set(paidOrders.map(row => row.familyId).filter(Boolean))).map(_id => ({ _id }))
  };
  const sku = {};
  paidOrders.forEach(row => {
    const key = row.productId || 'unknown';
    if (!sku[key]) sku[key] = { productId: key, name: row.productName || key, orders: 0, gmvCents: 0 };
    sku[key].orders += 1; sku[key].gmvCents += Number(row.priceCents) || 0;
  });
  function metrics(selection, date) {
    const result = {};
    for (const key of ['newUsers', 'enteredUsers', 'exampleUsers', 'createdUsers', 'joinedUsers', 'newFamilies', 'familiesWithRelatives', 'collaborativeFamilies', 'orders', 'convertedOrders', 'paidOrders', 'refundOrders', 'payingUsers', 'payingFamilies']) result[key] = selection[key].length;
    result.activeUsers = selection.activeUsers.length; result.dau = result.activeUsers; result.activeFamilies = selection.activeFamilies.length;
    result.gmvCents = selection.paidOrders.reduce((sum, row) => sum + (Number(row.priceCents) || 0), 0);
    result.refundCents = selection.refundOrders.reduce((sum, row) => sum + (Number(row.priceCents) || 0), 0);
    result.netCents = result.gmvCents - result.refundCents;
    result.enterRate = rate(result.enteredUsers, result.newUsers); result.exampleRate = rate(result.exampleUsers, result.newUsers);
    result.createRate = rate(result.createdUsers, result.newUsers); result.joinRate = rate(result.joinedUsers, result.newUsers);
    result.relativeRate = rate(result.familiesWithRelatives, result.newFamilies); result.collaborationRate = rate(result.collaborativeFamilies, result.newFamilies);
    result.paymentRate = rate(result.convertedOrders, result.orders);
    result.aovCents = result.paidOrders ? Math.round(result.gmvCents / result.paidOrders) : null;
    result.arppuCents = result.payingUsers ? Math.round(result.gmvCents / result.payingUsers) : null;
    if (!complete(date)) for (const key of ['dau', 'activeUsers', 'activeFamilies', 'enteredUsers', 'enterRate', 'exampleUsers', 'exampleRate']) result[key] = null;
    return result;
  }
  const rows = []; const dailyDetails = {};
  for (let time = filters.start; time < filters.end; time += DAY_MS) {
    const date = day(time); const selection = {};
    for (const [key, values] of Object.entries(details)) {
      const field = key === 'paidOrders' ? 'paidAt' : key === 'refundOrders' ? 'refundedAt' : 'createdAt';
      selection[key] = values.filter(row => Number.isFinite(ms(row[field])) && day(row[field]) === date);
    }
    for (const [key, kind] of [['activeUsers', 'user'], ['activeFamilies', 'family']]) selection[key] = activity.filter(row => row.day === date && row.kind === kind).map(row => ({ _id: row.entityId }));
    selection.payingUsers = Array.from(new Set(selection.paidOrders.map(row => row.payerUserId).filter(Boolean))).map(_id => ({ _id }));
    selection.payingFamilies = Array.from(new Set(selection.paidOrders.map(row => row.familyId).filter(Boolean))).map(_id => ({ _id }));
    dailyDetails[date] = selection;
    rows.push(Object.assign(metrics(selection, date), { day: date, partial: date === filters.today, activityComplete: complete(date), mature: filters.window === 'asOf' || time + (filters.window === 'day' ? 1 : filters.window === '7d' ? 7 : 30) * DAY_MS <= filters.asOf }));
  }
  const totals = metrics(details, filters.startDay);
  const activityComplete = rows.every(row => row.activityComplete);
  totals.averageDau = activityComplete ? Math.round(rows.reduce((sum, row) => sum + row.dau, 0) / rows.length * 100) / 100 : null;
  totals.averageActiveFamilies = activityComplete ? Math.round(rows.reduce((sum, row) => sum + row.activeFamilies, 0) / rows.length * 100) / 100 : null;
  totals.activeMemberFamilies = input.activeMemberFamilies === undefined ? null : input.activeMemberFamilies;
  const report = { rows, totals, sku: Object.values(sku), timezone: 'Asia/Shanghai', filters: { startDay: filters.startDay, endDay: filters.endDay, window: filters.window, paymentMode: filters.paymentMode }, asOf: new Date(filters.asOf).toISOString(), generatedAt: new Date(filters.asOf).toISOString(), trackingStartedAt: input.trackingStartedAt || '', activityComplete, historyNote: '创建和加入由现存业务及保留记录补充；首次采集之前的访问无法恢复。当前协作与会员为查询时点状态。' };
  return { report, details, dailyDetails };
}
function summarize(input, filters) { return build(input, filters).report; }
function fingerprint(filters, metric) { return crypto.createHash('sha256').update(JSON.stringify([filters.startDay, filters.endDay, filters.window, filters.paymentMode, filters.asOf, metric])).digest('hex').slice(0, 24); }
function paginate(items, input, filters, metric) {
  const key = fingerprint(filters, metric); let after = '';
  if (input.cursor) {
    try { const parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); if (parsed.key !== key || typeof parsed.after !== 'string') throw new Error(); after = parsed.after; }
    catch (error) { fail('ANALYTICS_INVALID_CURSOR', '分页条件已改变，请重新查询'); }
  }
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 20));
  const sorted = [...items].sort((a, b) => a._id.localeCompare(b._id));
  const page = sorted.filter(row => row._id.localeCompare(after) > 0).slice(0, pageSize + 1);
  const hasMore = page.length > pageSize; const result = page.slice(0, pageSize);
  return { items: result, total: sorted.length, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ key, after: result[result.length - 1]._id })).toString('base64url') : '' };
}
module.exports = { DAY_MS, ms, day, midnight, range, unique, rate, conversion, inRange, build, summarize, paginate, fingerprint, fail };
