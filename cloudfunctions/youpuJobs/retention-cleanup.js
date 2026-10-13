// Keep business and media deletion workflows outside the batching allowlist.
const COLLECTIONS = new Set(['idempotency_records', 'rate_limits', 'analytics_snapshots', 'analytics_snapshot_items', 'analytics_reports']);

async function removeExpired(db, collectionName, where, limit) {
  if (!COLLECTIONS.has(collectionName) || !where || !where.expiresAt) throw new Error('RETENTION_BATCH_REJECTED');
  let removed = 0;
  let selected = 0;
  const hardLimit = limit || 2000;
  // Bound selected IDs as well as removals: a document's expiry can be extended
  // between selection and deletion, so zero removals must not spin forever.
  while (selected < hardLimit) {
    const page = await db.collection(collectionName).where(where).limit(Math.min(100, hardLimit - selected)).get();
    const ids = (page.data || []).map(row => row._id).filter(Boolean).slice(0, hardLimit - selected);
    if (!ids.length) break;
    selected += ids.length;
    const result = await db.collection(collectionName).where(db.command.and([
      where, { _id: db.command.in(ids) }
    ])).remove();
    const count = Number(result && result.stats && result.stats.removed) || 0;
    removed += count;
    if (!count || ids.length < 100) break;
  }
  return removed;
}

module.exports = { supports: name => COLLECTIONS.has(name), removeExpired };
