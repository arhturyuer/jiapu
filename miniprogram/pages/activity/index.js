const api = require('../../utils/api');
const format = require('../../utils/format');

Page({
  data: { familyId: '', items: [], loading: true, loadingMore: false, hasMore: false, cursor: '', membershipRequired: false, action: '', actorName: '', from: '', to: '' },
  onLoad: function (options) { this.setData({ familyId: options.familyId || '' }); this.load(true); },
  onPullDownRefresh: function () { this.load(true).then(function () { wx.stopPullDownRefresh(); }); },
  load: function (reset) {
    const self = this;
    if (!this.data.familyId || (!reset && (!this.data.hasMore || this.data.loadingMore))) return Promise.resolve();
    this.setData(reset ? { loading: true, cursor: '' } : { loadingMore: true });
    return api.call('family.activity.list', { familyId: this.data.familyId, cursor: reset ? '' : this.data.cursor, pageSize: 30, action: this.data.action.trim(), actorName: this.data.actorName.trim(), from: this.data.from, to: this.data.to }).then(function (data) {
      const mapped = (data.items || []).map(function (item) { return Object.assign({}, item, { timeText: format.dateTimeText ? format.dateTimeText(item.createdAt) : new Date(item.createdAt).toLocaleString() }); });
      self.setData({ items: reset ? mapped : self.data.items.concat(mapped), loading: false, loadingMore: false, hasMore: data.hasMore, cursor: data.nextCursor || '', membershipRequired: data.membershipRequired });
    }).catch(function (error) { self.setData({ loading: false, loadingMore: false }); wx.showToast({ title: error.message || '历史加载失败', icon: 'none' }); });
  },
  inputAction: function (event) { this.setData({ action: event.detail.value || '' }); },
  inputActor: function (event) { this.setData({ actorName: event.detail.value || '' }); },
  changeFrom: function (event) { this.setData({ from: event.detail.value || '' }); },
  changeTo: function (event) { this.setData({ to: event.detail.value ? event.detail.value + 'T23:59:59+08:00' : '' }); },
  clearFilters: function () { this.setData({ action: '', actorName: '', from: '', to: '' }); this.load(true); },
  applyFilters: function () { this.load(true); },
  loadMore: function () { this.load(false); },
  openMembership: function () { wx.navigateTo({ url: '/pages/membership/index?familyId=' + this.data.familyId }); }
});
