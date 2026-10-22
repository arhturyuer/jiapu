const crypto = require('crypto');
const seeds = require('./guides-seed.json');
async function read(scope, collection, id) {
  try { return (await scope.collection(collection).doc(id).get()).data || null; }
  catch (error) { if (/document.*(?:not.*exist|not.*found|does not exist)/i.test(String(error.errMsg || error.message))) return null; throw error; }
}
async function initialize(db) {
  // Each seed is checked inside its own transaction. Tombstones are retained,
  // so rerunning bootstrap never resurrects deleted or edited content.
  for (const seed of seeds) await db.runTransaction(async transaction => {
    const id = 'guide_' + crypto.createHash('sha256').update(seed.slug).digest('hex').slice(0, 40);
    if (await read(transaction, 'guides', id)) return;
    await transaction.collection('guides').doc(id).set({ data: {
      slug: seed.slug, draft: seed.draft, published: seed.draft, status: 'published', revision: 1,
      draftTitle: seed.draft.title, draftSortOrder: seed.draft.sortOrder,
      publishedTitle: seed.draft.title, publishedSummary: seed.draft.summary, publishedSortOrder: seed.draft.sortOrder,
      createdBy: 'system_seed', updatedBy: 'system_seed', createdAt: db.serverDate(), updatedAt: db.serverDate(), publishedAt: db.serverDate()
    } });
  });
  await db.runTransaction(async transaction => {
    if (await read(transaction, 'system_config', 'guide_settings')) return;
    const setting = { title: '把家人的名字、关系和故事整理成家谱', summary: '从准备资料到邀请家人、导出打印，按你当前的问题开始。' };
    await transaction.collection('system_config').doc('guide_settings').set({ data: { draft: setting, published: setting, revision: 1, updatedAt: db.serverDate() } });
  });
}
module.exports = { initialize, seeds };
