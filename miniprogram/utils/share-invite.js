const STORAGE_KEY = 'youpu_share_invite_cards';
const MAX_CACHE_ENTRIES = 40;

function cacheKey(options) {
  const config = options || {};
  return [
    config.ownerId || '',
    config.familyId || '',
    config.role || '',
    config.viewMode || 'full',
    config.viewPersonId || '',
    config.fingerprint || ''
  ].join('|');
}

function expirationTime(value) {
  if (value && typeof value === 'object' && value.$date) value = value.$date;
  const time = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function readCache() {
  try {
    const stored = wx.getStorageSync(STORAGE_KEY);
    return stored && typeof stored === 'object' ? stored : {};
  } catch (error) {
    return {};
  }
}

function writeCache(cache) {
  try { wx.setStorageSync(STORAGE_KEY, cache); } catch (error) { /* local cache is optional */ }
}

function prune(cache) {
  const now = Date.now();
  const validEntries = Object.keys(cache || {}).filter(function (key) {
    const entry = cache[key];
    return entry && entry.card && entry.card.path && expirationTime(entry.expiresAt) > now;
  }).sort(function (left, right) {
    return Number(cache[right].savedAt || 0) - Number(cache[left].savedAt || 0);
  }).slice(0, MAX_CACHE_ENTRIES);
  return validEntries.reduce(function (result, key) {
    result[key] = cache[key];
    return result;
  }, {});
}

function get(options) {
  const cache = prune(readCache());
  writeCache(cache);
  const entry = cache[cacheKey(options)];
  return entry ? entry.card : null;
}

function set(options, card, expiresAt) {
  const cache = prune(readCache());
  cache[cacheKey(options)] = {
    card: card,
    expiresAt: expiresAt,
    savedAt: Date.now()
  };
  writeCache(cache);
  return card;
}

module.exports = { get: get, set: set };
