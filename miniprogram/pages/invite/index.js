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
    viewText: '',
    actionText: '',
    isPerspective: false
  },

  onLoad: function (options) {
    let token = options.token || options.scene || '';
    try { token = decodeURIComponent(token); } catch (error) { token = ''; }
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
      if (data.alreadyJoined) {
        self.enterFamily(data);
        return;
      }
      self.setData({
        loading: false,
        preview: data,
        roleText: data.role === 'member' ? '共同维护' : '仅查看',
        viewText: data.viewMode === 'perspective'
          ? '从“' + data.viewPersonName + '”的视角查看'
          : '',
        actionText: data.role === 'member' ? '加入家谱' : '加入并查看',
        isPerspective: data.viewMode === 'perspective'
      });
    }).catch(function (error) {
      self.setData({ loading: false, invalid: true, errorMessage: api.userMessage(error, '邀请已经失效') });
    });
  },

  enterFamily: function (data) {
    const family = data.family;
    if (!family || !family._id) return;
    if (data.viewMode === 'perspective' && data.viewPersonId) {
      app.openPerspective(family, data.viewPersonId);
    } else {
      app.openFullGraph(family);
    }
    wx.switchTab({ url: '/pages/tree/index' });
  },

  acceptInvite: function () {
    const self = this;
    if (this.data.accepting) return;
    this.setData({ accepting: true });
    app.ensureLogin().then(function () {
      return api.call('invite.accept', { token: self.data.token });
    }).then(function (data) {
      wx.showToast({ title: (data.alreadyJoined ? '已进入' : '已加入') + data.family.name, icon: 'success' });
      setTimeout(function () { self.enterFamily(data); }, 600);
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '加入失败'), icon: 'none' });
    }).then(function () {
      self.setData({ accepting: false });
    });
  },

  goHome: function () {
    wx.switchTab({ url: '/pages/tree/index' });
  }
});
