const REPORT_TTL = 5 * 60 * 1000;

export function createReportCache(loader, now = Date.now) {
  const entries = new Map();
  return async function (filters) {
    const key = JSON.stringify([filters.startDay, filters.endDay, filters.window, filters.paymentMode]);
    const cached = entries.get(key);
    if (cached && cached.promise) return cached.promise;
    if (cached && cached.expiresAt > now()) return cached.data;
    const entry = {};
    entries.set(key, entry);
    entry.promise = Promise.resolve().then(() => loader(filters)).then(data => {
      entry.data = data;
      // A server cache hit may already be several minutes old. Do not add
      // another full client TTL to that existing snapshot's age.
      const asOf = Date.parse(data.asOf);
      entry.expiresAt = Number.isFinite(asOf) ? Math.min(now() + REPORT_TTL, asOf + REPORT_TTL) : now();
      entry.promise = null;
      if (entries.size > 50) {
        for (const [oldKey, oldEntry] of entries) {
          if (oldKey !== key && !oldEntry.promise) { entries.delete(oldKey); break; }
        }
      }
      return data;
    }, error => { if (entries.get(key) === entry) entries.delete(key); throw error; });
    return entry.promise;
  };
}
