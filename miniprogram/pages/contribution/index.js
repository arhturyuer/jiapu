const launchAd = require('../../utils/launch-ad');
const api = require('../../utils/api');
const format = require('../../utils/format');
const app = getApp();
function dateTimeText(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '时间不详';
  return format.dateText(value) + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}
function decorate(item) {
  const changes = (item.changes || []).map(function (change, index) { return Object.assign({}, change, { displayKey: String(index) }); });
  const first = changes[0];
  const summaryText = changes.length === 1 && first.field !== 'person' && first.field !== 'relation'
    ? (first.before === '不详' || first.before === '未设置' ? '补充了' : '修改了') + first.objectName + '的' + first.label
    : item.summary;
  return Object.assign({}, item, { changes, summaryText, timeText: dateTimeText(item.createdAt), reviewTimeText: item.reviewedAt ? dateTimeText(item.reviewedAt) : '' });
}
Page(launchAd.wrap({
  data: { familyId: '', personId: '', items: [], authors: [{ key: '', name: '全部编写者' }], authorIndex: 0, authorKey: '', loading: true, loadingMore: false, error: '', moreError: '', hasMore: false, cursor: '' },
  onLoad: function (options) { this.setData({ familyId: options.familyId || '', personId: options.personId || '' }); },
  onShow: function () { return this.load(true); },
  onHide: function () { this._revision = (this._revision || 0) + 1; },
  onUnload: function () { this._revision = (this._revision || 0) + 1; },
  onPullDownRefresh: function () { return this.load(true, { force: true }).then(function () { wx.stopPullDownRefresh(); }); },
  changeAuthor: function (event) {
    const index = Number(event.detail.value) || 0;
    const author = this.data.authors[index] || this.data.authors[0];
    this.setData({ authorIndex: index, authorKey: author.key });
    return this.load(true);
  },
  load: function (reset, options) {
    if (!reset && (this.data.loading || this.data.loadingMore || !this.data.hasMore)) return Promise.resolve();
    const revision = this._revision = (this._revision || 0) + 1;
    const self = this;
    const query = { familyId: this.data.familyId, personId: this.data.personId, authorKey: this.data.authorKey, cursor: reset ? '' : this.data.cursor };
    this.setData(reset ? { loading: true, loadingMore: false, error: '', moreError: '' } : { loadingMore: true, moreError: '' });
    return Promise.all([
      reset ? app.getContributionSummary(query.familyId, query.personId, options) : Promise.resolve(null),
      app.getContributionList(query, options)
    ]).then(function (results) {
      if (revision !== self._revision) return;
      const summary = results[0], data = results[1];
      const updates = { loading: false, loadingMore: false, items: (reset ? [] : self.data.items).concat((data.items || []).map(decorate)), hasMore: Boolean(data.hasMore), cursor: data.nextCursor || '' };
      if (summary) {
        updates.authors = [{ key: '', name: '全部编写者' }].concat((summary.authors || []).map(author => ({ key: author.key, name: author.name })));
        updates.authorIndex = Math.max(0, updates.authors.findIndex(author => author.key === query.authorKey));
        // A removed/anonymized author no longer matches the old selection.
        if (query.authorKey && updates.authorIndex === 0) {
          self.setData({ authors: updates.authors, authorIndex: 0, authorKey: '' });
          return self.load(true, options);
        }
      }
      self.setData(updates);
    }).catch(function (error) {
      if (revision !== self._revision) return;
      const message = api.userMessage(error, '编写记录加载失败，请重试');
      self.setData(reset ? { loading: false, error: message } : { loadingMore: false, moreError: message });
    });
  },
  retry: function () { return this.load(true, { force: true }); },
  loadMore: function () { return this.load(false); }
}));
