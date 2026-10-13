function storageKey(environment, actor) {
  return 'youpu_activity_' + encodeURIComponent(environment || 'unknown') + '_' + encodeURIComponent(actor);
}

function read(environment, actor, day) {
  if (typeof wx === 'undefined' || !wx.getStorageSync) return {};
  try {
    const value = wx.getStorageSync(storageKey(environment, actor));
    return value && value.day === day && value.events && typeof value.events === 'object' && !Array.isArray(value.events) ? value.events : {};
  } catch (error) { return {}; }
}

function has(environment, actor, day, event) {
  return read(environment, actor, day)[event] === true;
}

function confirm(environment, actor, day, event) {
  if (typeof wx === 'undefined' || !wx.setStorageSync) return;
  try {
    const events = Object.assign({}, read(environment, actor, day), { [event]: true });
    const keys = Object.keys(events);
    // Local dedup is an optimization; exceeding the bound may send a duplicate
    // that the server's daily transaction will still deduplicate correctly.
    keys.slice(0, Math.max(0, keys.length - 200)).forEach(function (key) { delete events[key]; });
    wx.setStorageSync(storageKey(environment, actor), { day: day, events: events });
  } catch (error) { /* Storage failure must not fail a completed visit. */ }
}

function clear(environment, actor) {
  if (!actor || typeof wx === 'undefined' || !wx.removeStorageSync) return;
  try { wx.removeStorageSync(storageKey(environment, actor)); } catch (error) {}
}

module.exports = { has: has, confirm: confirm, clear: clear };
