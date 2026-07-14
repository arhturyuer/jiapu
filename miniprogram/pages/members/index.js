const app = getApp();
const api = require('../../utils/api');
const format = require('../../utils/format');

Page({
  data: {
    loading: true,
    currentFamily: null,
    currentRole: 'viewer',
    isAdmin: false,
    stats: { personCount: 0, relationCount: 0, collaboratorCount: 0, completion: 0, pendingCount: 0 },
    collaborators: [],
    pendingChanges: [],
    recentActivities: [],
    showShareSheet: false,
    shareRole: 'member',
    shareReady: false,
    shareCreating: false,
    shareCard: null
  },

  onShow: function () {
    this.loadDashboard();
  },

  onPullDownRefresh: function () {
    this.loadDashboard().then(function () { wx.stopPullDownRefresh(); });
  },

  loadDashboard: function () {
    const self = this;
    this.setData({ loading: true });
    return app.loadFamilies().then(function () {
      const family = app.getCurrentFamily();
      self.setData({ currentFamily: family, loading: false });
      if (!family) return null;
      return api.call('family.dashboard', { familyId: family._id });
    }).then(function (data) {
      if (!data) return;
      const collaborators = (data.collaborators || []).map(function (item) {
        return Object.assign({}, item, {
          initial: (item.displayName || '家').slice(0, 1),
          roleText: format.roleText(item.role),
          avatarUrl: ''
        });
      });
      self.setData({
        loading: false,
        currentFamily: data.family,
        currentRole: data.family.currentRole,
        isAdmin: data.family.currentRole === 'admin',
        stats: data.stats,
        collaborators: collaborators,
        pendingChanges: data.pendingChanges || [],
        recentActivities: (data.recentActivities || []).map(function (item) {
          return Object.assign({}, item, { timeText: format.relativeTime(item.createdAt) });
        })
      });
      app.setCurrentFamily(data.family);
      return api.getMediaUrls(collaborators.map(function (item) { return item.avatarAssetId; })).then(function (urls) {
        self.setData({
          collaborators: collaborators.map(function (item) {
            return Object.assign({}, item, { avatarUrl: urls[item.avatarAssetId] || '' });
          })
        });
      });
    }).catch(function (error) {
      self.setData({ loading: false });
      wx.showToast({ title: error.message || '家庭数据加载失败', icon: 'none' });
    });
  },

  createFamily: function () {
    wx.navigateTo({ url: '/pages/create-family/index' });
  },

  openGraph: function () {
    wx.switchTab({ url: '/pages/tree/index' });
  },

  openFamilyManage: function () {
    if (!this.data.currentFamily) return;
    wx.navigateTo({ url: '/pages/family-manage/index?familyId=' + this.data.currentFamily._id });
  },

  reviewChange: function (event) {
    const self = this;
    const requestId = event.currentTarget.dataset.id;
    const decision = event.currentTarget.dataset.decision;
    const title = decision === 'approve' ? '通过这项修改？' : '拒绝这项修改？';
    wx.showModal({
      title: title,
      content: decision === 'approve' ? '通过后会立即更新家谱。' : '拒绝后不会改变家谱内容。',
      confirmText: decision === 'approve' ? '通过' : '拒绝',
      confirmColor: decision === 'approve' ? '#245C4A' : '#B43D3D'
    }).then(function (result) {
      if (!result.confirm) return null;
      return api.call('change.review', { requestId: requestId, decision: decision });
    }).then(function (data) {
      if (!data) return;
      wx.showToast({ title: decision === 'approve' ? '已通过' : '已拒绝', icon: 'success' });
      self.loadDashboard();
    }).catch(function (error) {
      wx.showToast({ title: error.message || '处理失败', icon: 'none' });
    });
  },

  openShareSheet: function () {
    this.setData({
      showShareSheet: true,
      shareRole: this.data.isAdmin ? 'member' : 'viewer',
      shareReady: false,
      shareCard: null
    });
  },

  closeShareSheet: function () {
    this.setData({ showShareSheet: false, shareReady: false, shareCard: null });
  },

  chooseShareRole: function (event) {
    this.setData({ shareRole: event.currentTarget.dataset.role, shareReady: false });
  },

  prepareShare: function () {
    const self = this;
    if (this.data.shareCreating) return;
    this.setData({ shareCreating: true });
    api.call('invite.create', {
      familyId: this.data.currentFamily._id,
      role: this.data.shareRole,
      viewMode: 'full'
    }).then(function (data) {
      self.setData({
        shareReady: true,
        shareCreating: false,
        shareCard: {
          title: data.familyName + '｜一起把家谱补完整',
          path: '/pages/invite/index?token=' + data.token
        }
      });
    }).catch(function (error) {
      self.setData({ shareCreating: false });
      wx.showToast({ title: error.message || '邀请生成失败', icon: 'none' });
    });
  },

  onShareAppMessage: function () {
    if (this.data.shareCard) return this.data.shareCard;
    return { title: '有谱｜一家人，共修一份家谱', path: '/pages/tree/index' };
  },

  stopEvent: function () {}
});
