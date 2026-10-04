const crypto = require('crypto');
const DAY_MS = 86400000;
function day(value) { return new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10); }
function id(kind, date, entity) { return 'a_' + crypto.createHash('sha256').update(kind + ':' + date + ':' + entity).digest('hex').slice(0, 40); }
async function get(scope, name, key) {
  try { return (await scope.collection(name).doc(key).get()).data || null; }
  catch (error) {
    if (/not.?exist|not.?found|不存在/i.test(String(error.errMsg || error.message || ''))) return null;
    throw error;
  }
}
async function firstConversion(db, scope, userId, field, at) {
  const user = await get(scope, 'users', userId);
  if (user && !user[field]) await scope.collection('users').doc(userId).update({ data: { [field]: at || db.serverDate() } });
}
function createTracker(db, now = () => new Date()) {
  let cachedDay = ''; const seen = new Set();
  return {
    async record(user, familyId, entered, example) {
      if (!user || user.status !== 'active') return;
      const date = day(now());
      if (cachedDay !== date) { cachedDay = date; seen.clear(); }
      const cacheKey = JSON.stringify([user._id, familyId || '', Boolean(entered), Boolean(example)]);
      if (seen.has(cacheKey)) return;
      await db.runTransaction(async scope => {
        for (const [kind, entityId] of [['user', user._id], ...(familyId ? [['family', familyId]] : [])]) {
          const key = id(kind, date, entityId);
          if (!await get(scope, 'analytics_activity_daily', key)) {
            await scope.collection('analytics_activity_daily').doc(key).set({ data: { day: date, kind, entityId, createdAt: db.serverDate() } });
          }
        }
        if (entered) await firstConversion(db, scope, user._id, 'firstEnteredFamilyAt');
        if (example) await firstConversion(db, scope, user._id, 'firstExampleViewedAt');
      });
      if (seen.size >= 5000) seen.clear();
      seen.add(cacheKey);
    }
  };
}
module.exports = { day, id, get, firstConversion, createTracker, DAY_MS };
