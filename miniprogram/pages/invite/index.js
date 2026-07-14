const app = getApp();
const api = require('../../utils/api');

Page({
  data: {
    token: '',
    loading: true,
    accepting: false,
    invalid: false,
    errorMessage: '',
    preview: null,
    roleText: '',
    viewText: ''
  },

  onLoad: function (options) {
    const token = options.token || '';
    this.setData({ token: token });
    if (!token) {
      this.setData({ loading: false, invalid: true, errorMessage: '邀请链接不完整' });
      return;
    }
    this.loadPreview();
  },

  loadPreview: function () {
    const self = this;
    api.call('invite.preview', { token: this.data.token }).then(function (data) {
      self.setData({
        loading: false,
        preview: data,
        roleText: data.role === 'member' ? '共同补全家谱' : '查看家谱',
        viewText: data.viewMode === 'perspective'
          ? '打开后将从“' + data.viewPersonName + '”的视角查看'
          : '打开后先查看完整家谱'
      });
    }).catch(function (error) {
      self.setData({ loading: false, invalid: true, errorMessage: error.message || '邀请已经失效' });
    });
  },

  acceptInvite: function () {
    const self = this;
    if (this.data.accepting) return;
    this.setData({ accepting: true });
    app.ensureLogin().then(function () {
      return api.call('invite.accept', { token: self.data.token });
    }).then(function (data) {
      app.setCurrentFamily(data.family);
      wx.setStorageSync('youpu_pending_view', {
        mode: data.viewMode || 'full',
        personId: data.viewPersonId || ''
      });
      wx.showToast({ title: '已加入' + data.family.name, icon: 'success' });
      setTimeout(function () { wx.switchTab({ url: '/pages/tree/index' }); }, 600);
    }).catch(function (error) {
      wx.showToast({ title: error.message || '加入失败', icon: 'none' });
    }).then(function () {
      self.setData({ accepting: false });
    });
  },

  goHome: function () {
    wx.switchTab({ url: '/pages/tree/index' });
  },

  reportInvite: function () {
    const preview = this.data.preview;
    if (!preview || !preview.invitationId) return;
    wx.navigateTo({
      url: '/pages/report/index?familyId=' + preview.family._id +
        '&targetType=invitation&targetId=' + preview.invitationId +
        '&targetName=' + encodeURIComponent('这条家庭邀请') +
        '&inviteToken=' + encodeURIComponent(this.data.token)
    });
  }
});
