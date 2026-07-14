const app = getApp();
const api = require('../../utils/api');
const privacy = require('../../utils/privacy');

Page({
  data: {
    loading: true,
    user: null,
    nickName: '',
    avatarUrl: '',
    avatarAssetId: '',
    familyList: [],
    archivedFamilies: [],
    currentFamily: null,
    savingProfile: false,
    showFamilySheet: false
  },

  onShow: function () {
    this.loadPage();
  },

  loadPage: function () {
    const self = this;
    this.setData({ loading: true });
    return app.loadFamilies().then(function (families) {
      if (app.globalData.accountState === 'pending_delete') return { families: families, archived: [] };
      return app.loadFamilyPages(true).then(function (data) {
        return {
          families: families,
          archived: (data.families || []).filter(function (item) { return item.status === 'archived'; })
        };
      });
    }).then(function (familyData) {
      const families = familyData.families;
      const user = app.globalData.user || {};
      const avatarAssetId = user.avatarAssetId || '';
      self.setData({
        loading: false,
        user: user,
        nickName: user.nickName || '',
        avatarUrl: '',
        avatarAssetId: avatarAssetId,
        familyList: families,
        archivedFamilies: familyData.archived,
        currentFamily: app.getCurrentFamily()
      });
      return api.getMediaUrls([avatarAssetId]).then(function (urls) {
        if (urls[avatarAssetId]) self.setData({ avatarUrl: urls[avatarAssetId] });
      });
    }).catch(function (error) {
      self.setData({ loading: false });
      wx.showToast({ title: error.message || '页面加载失败', icon: 'none' });
    });
  },

  inputNickname: function (event) {
    this.setData({ nickName: event.detail.value });
  },

  chooseAvatar: function () {
    const self = this;
    privacy.ensurePrivacyAuthorized().then(function () {
      return wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] });
    }).then(function (result) {
      wx.showLoading({ title: '上传中' });
      const file = result.tempFiles[0];
      return api.uploadImage(file.tempFilePath, 'user-avatars', {
        kind: 'user_avatar',
        size: file.size || 0
      });
    }).then(function (media) {
      self.setData({ avatarUrl: media.previewUrl, avatarAssetId: media.assetId });
      if (!media.ready) wx.showToast({ title: '头像将在审核通过后展示', icon: 'none' });
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) return;
      wx.showToast({ title: error.message || '头像上传失败', icon: 'none' });
    }).then(function () {
      wx.hideLoading();
    });
  },

  saveProfile: function () {
    const self = this;
    if (this.data.savingProfile) return;
    this.setData({ savingProfile: true });
    api.call('auth.updateProfile', {
      nickName: this.data.nickName.trim(),
      avatarAssetId: this.data.avatarAssetId
    }).then(function (data) {
      app.setUser(data.user);
      self.setData({ user: data.user });
      wx.showToast({ title: '资料已保存', icon: 'success' });
    }).catch(function (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }).then(function () {
      self.setData({ savingProfile: false });
    });
  },

  openFamilySheet: function () {
    this.setData({ showFamilySheet: true });
  },

  closeFamilySheet: function () {
    this.setData({ showFamilySheet: false });
  },

  switchFamily: function (event) {
    const familyId = event.currentTarget.dataset.id;
    const family = this.data.familyList.find(function (item) { return item._id === familyId; });
    if (!family) return;
    app.setCurrentFamily(family);
    wx.setStorageSync('youpu_pending_view', { mode: 'full', personId: '' });
    this.setData({ currentFamily: family, showFamilySheet: false });
    wx.showToast({ title: '已切换到' + family.name, icon: 'none' });
  },

  createFamily: function () {
    this.closeFamilySheet();
    wx.navigateTo({ url: '/pages/create-family/index' });
  },

  showPrivacy: function () {
    wx.navigateTo({ url: '/pages/privacy/index' });
  },

  openFamilyManage: function () {
    const family = this.data.currentFamily;
    if (!family) {
      wx.showToast({ title: '请先创建家谱', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/family-manage/index?familyId=' + family._id });
  },

  openArchivedFamily: function (event) {
    wx.navigateTo({ url: '/pages/family-manage/index?familyId=' + event.currentTarget.dataset.id });
  },

  clearCache: function () {
    wx.showModal({
      title: '清除本地缓存？',
      content: '不会删除云端家谱，下次打开需要重新加载。'
    }).then(function (result) {
      if (!result.confirm) return;
      app.clearLocalData();
      wx.showToast({ title: '缓存已清除', icon: 'success' });
      setTimeout(function () { wx.reLaunch({ url: '/pages/tree/index' }); }, 500);
    });
  },

  showAbout: function () {
    wx.showModal({
      title: '关于有谱',
      content: '有谱 · 一家人，共修一份家谱\n\n一个人快速创建，一家人共同补全，由少数管理员维护秩序。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  stopEvent: function () {}
});
