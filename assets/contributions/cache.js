const api = require('./api');
module.exports = {
  getContributionSummary: function (familyId, personId, options) {
    const entry = this.getCacheEntry('contributionSummary', JSON.stringify([familyId, personId || '']));
    entry.familyId = familyId;
    return this.loadCached(entry, function () { return api.call('contribution.summary', { familyId, personId: personId || '' }); }, options);
  },
  getContributionList: function (query, options) {
    const input = { familyId: query.familyId, personId: query.personId || '', authorKey: query.authorKey || '', cursor: query.cursor || '' };
    const entry = this.getCacheEntry('contributionList', JSON.stringify([input.familyId, input.personId, input.authorKey, input.cursor]));
    entry.familyId = input.familyId;
    return this.loadCached(entry, function () { return api.call('contribution.list', input); }, options);
  },
  invalidateContributions: function (familyId) {
    ['contributionSummary', 'contributionList'].forEach(function (type) {
      Object.keys(this.dataCache[type] || {}).forEach(function (key) {
        const entry = this.dataCache[type][key];
        if (entry.familyId === familyId) this.invalidateEntry(entry);
      }, this);
    }, this);
  }
};
