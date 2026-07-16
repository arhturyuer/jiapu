const app = getApp();
const api = require('../../utils/api');
const format = require('../../utils/format');

function decorateChanges(items) {
  const statusLabels = { pending: '待处理', approved: '已通过', rejected: '未通过' };
  return (items || []).map(function (item) {
    return Object.assign({}, item, {
      statusText: statusLabels[item.status] || '已处理',
      timeText: format.relativeTime(item.status === 'pending' ? item.createdAt : item.updatedAt || item.createdAt)
    });
  });
}

Page({
  data: {
    familyId: '',
    family: null,
    currentRole: 'viewer',
    isAdmin: false,
    loading: true,
    error: '',
    activeStatus: 'pending',
    statusTabs: [
      { key: 'pending', label: '待处理' },
      { key: 'approved', label: '已通过' },
      { key: 'rejected', label: '未通过' }
    ],
    changes: [],
    cursor: '',
    hasMore: false,
    loadingMore: false,
    reviewingId: ''
  },

  onLoad: function (options) {
    const familyId = options.familyId || '';
    this.setData({ familyId: familyId });
    if (!familyId) this.setData({ loading: false, error: '缺少家谱信息，请返回后重试。' });
  },

  onShow: function () {
    if (this.data.familyId) this.loadPage();
  },

  onPullDownRefresh: function () {
    this.loadPage().then(function () { wx.stopPullDownRefresh(); });
  },

  onReachBottom: function () {
    this.loadMore();
  },

  loadPage: function () {
    const self = this;
    this.setData({ loading: true, error: '' });
    return app.loadFamilies().then(function (families) {
      const family = families.find(function (item) { return item._id === self.data.familyId; });
      if (!family) throw new Error('你已无法访问这份家谱');
      self.setData({
        family: family,
        currentRole: family.currentRole,
        isAdmin: family.currentRole === 'admin'
      });
      if (family.currentRole === 'viewer') {
        self.setData({ loading: false, changes: [], cursor: '', hasMore: false });
        return null;
      }
      return self.loadChanges(true);
    }).catch(function (error) {
      self.setData({ loading: false, error: error.message || '申请列表加载失败' });
    });
  },

  switchStatus: function (event) {
    const status = event.currentTarget.dataset.status;
    if (status === this.data.activeStatus || this.data.loading) return;
    this.setData({ activeStatus: status, loading: true, error: '' });
    this.loadChanges(true).catch(function () {});
  },

  loadChanges: function (reset) {
    const self = this;
    const version = (this._requestVersion || 0) + 1;
    this._requestVersion = version;
    if (!reset) this.setData({ loadingMore: true });
    return api.call('change.list', {
      familyId: this.data.familyId,
      status: this.data.activeStatus,
      pageSize: 20,
      cursor: reset ? '' : this.data.cursor
    }).then(function (data) {
      if (version !== self._requestVersion) return;
      const nextChanges = decorateChanges(data.items);
      self.setData({
        loading: false,
        loadingMore: false,
        changes: reset ? nextChanges : self.data.changes.concat(nextChanges),
        cursor: data.nextCursor || '',
        hasMore: Boolean(data.hasMore)
      });
    }).catch(function (error) {
      if (version !== self._requestVersion) return;
      self.setData({ loading: false, loadingMore: false, error: error.message || '申请列表加载失败' });
      throw error;
    });
  },

  loadMore: function () {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.loadChanges(false).catch(function () {});
  },

  reviewChange: function (event) {
    const self = this;
    const requestId = event.currentTarget.dataset.id;
    const decision = event.currentTarget.dataset.decision;
    if (!this.data.isAdmin || this.data.reviewingId) return;
    wx.showModal({
      title: decision === 'approve' ? '通过这项修改？' : '拒绝这项修改？',
      content: decision === 'approve' ? '通过后会立即更新家谱。' : '拒绝后不会改变家谱内容。',
      confirmText: decision === 'approve' ? '通过' : '拒绝',
      confirmColor: decision === 'approve' ? '#245C4A' : '#B43D3D'
    }).then(function (result) {
      if (!result.confirm) return null;
      self.setData({ reviewingId: requestId });
      return api.call('change.review', { requestId: requestId, decision: decision });
    }).then(function (data) {
      if (!data) return;
      wx.showToast({ title: decision === 'approve' ? '已通过' : '已拒绝', icon: 'success' });
      return self.loadChanges(true);
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.includes('cancel')) return;
      wx.showToast({ title: error.message || '处理失败', icon: 'none' });
    }).then(function () {
      self.setData({ reviewingId: '' });
    });
  }
});
