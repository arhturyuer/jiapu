const app = getApp();
const api = require('../../utils/api');
const privacy = require('../../utils/privacy');
const formState = require('../../utils/form-state');

function profileAvatarState(status) {
  if (status === 'approved') return { state: 'approved', text: '头像已保存并通过审核' };
  if (status === 'rejected' || status === 'deleted') return { state: 'rejected', text: '头像未通过，请重新选择' };
  if (status === 'pending' || status === 'review') return { state: 'pending', text: '头像已保存，审核通过后自动展示' };
  return { state: '', text: '' };
}

Page({
  data: {
    loading: true,
    user: null,
    nickName: '',
    avatarUrl: '',
    avatarAssetId: '',
    avatarState: '',
    avatarStateText: '',
    avatarError: '',
    savingAvatar: false,
    hasNameChanges: false,
    familyList: [],
    archivedFamilies: [],
    currentFamily: null,
    savingProfile: false,
    showFamilySheet: false
  },

  onShow: function () {
    this.loadPage();
  },

  onUnload: function () {
    formState.clearLeaveAlert(this);
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
        avatarState: '',
        avatarStateText: '',
        avatarError: '',
        savingAvatar: false,
        hasNameChanges: false,
        familyList: families,
        archivedFamilies: familyData.archived,
        currentFamily: app.getCurrentFamily()
      });
      self._initialNickName = user.nickName || '';
      formState.clearLeaveAlert(self);
      return Promise.all([
        api.getMediaUrls([avatarAssetId]),
        api.getMediaStates([avatarAssetId])
      ]).then(function (results) {
        const urls = results[0];
        const states = results[1];
        const presentation = profileAvatarState(states[avatarAssetId] || '');
        self.setData({
          avatarUrl: urls[avatarAssetId] || '',
          avatarState: presentation.state,
          avatarStateText: presentation.text
        });
      });
    }).catch(function (error) {
      self.setData({ loading: false });
      wx.showToast({ title: error.message || '页面加载失败', icon: 'none' });
    });
  },

  inputNickname: function (event) {
    const self = this;
    this.setData({ nickName: event.detail.value }, function () { self.refreshProfileState(); });
  },

  refreshProfileState: function () {
    const hasNameChanges = String(this.data.nickName || '').trim() !== String(this._initialNickName || '');
    if (this.data.hasNameChanges !== hasNameChanges) this.setData({ hasNameChanges: hasNameChanges });
    formState.syncLeaveAlert(
      this,
      hasNameChanges || this.data.savingAvatar || this.data.avatarState === 'failed',
      '名字或头像尚未保存，确定离开吗？'
    );
  },

  chooseAvatar: function () {
    const self = this;
    if (this.data.savingAvatar || this.data.savingProfile) return Promise.resolve();
    let selectedPath = '';
    return privacy.ensurePrivacyAuthorized().then(function () {
      return wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] });
    }).then(function (result) {
      const file = result.tempFiles[0];
      selectedPath = file.tempFilePath;
      self.setData({
        avatarUrl: selectedPath,
        savingAvatar: true,
        avatarState: 'uploading',
        avatarStateText: '正在上传头像…',
        avatarError: ''
      }, function () { self.refreshProfileState(); });
      return api.uploadImage(file.tempFilePath, 'user-avatars', {
        kind: 'user_avatar',
        size: file.size || 0
      });
    }).then(function (media) {
      self._pendingAvatarMedia = media;
      return self.saveProfileAvatar(media);
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) return;
      self.setData({
        avatarUrl: selectedPath || self.data.avatarUrl,
        savingAvatar: false,
        avatarState: 'failed',
        avatarStateText: '头像保存失败，点击重试',
        avatarError: error.message || error.errMsg || '头像保存失败'
      }, function () { self.refreshProfileState(); });
      wx.showToast({ title: error.message || error.errMsg || '头像上传失败', icon: 'none' });
    });
  },

  saveProfileAvatar: function (media) {
    const self = this;
    this.setData({
      avatarUrl: media.previewUrl || this.data.avatarUrl,
      avatarAssetId: media.assetId,
      savingAvatar: true,
      avatarState: 'saving',
      avatarStateText: '正在保存头像…',
      avatarError: ''
    }, function () { self.refreshProfileState(); });
    return api.call('auth.updateAvatar', { avatarAssetId: media.assetId }).then(function (data) {
      self._pendingAvatarMedia = null;
      app.setUser(data.user);
      const presentation = profileAvatarState(data.moderationStatus || media.moderationStatus);
      self.setData({
        user: data.user,
        savingAvatar: false,
        avatarState: presentation.state,
        avatarStateText: presentation.text
      }, function () { self.refreshProfileState(); });
      wx.showToast({
        title: media.ready ? '头像已更新' : '头像已保存，等待审核',
        icon: media.ready ? 'success' : 'none'
      });
      return data;
    });
  },

  retryAvatarSave: function () {
    if (this.data.savingAvatar || this.data.savingProfile) return;
    if (this._pendingAvatarMedia) {
      const self = this;
      this.saveProfileAvatar(this._pendingAvatarMedia).catch(function (error) {
        self.setData({
          savingAvatar: false,
          avatarState: 'failed',
          avatarStateText: '头像保存失败，点击重试',
          avatarError: error.message || '头像保存失败'
        }, function () { self.refreshProfileState(); });
      });
      return;
    }
    this.chooseAvatar();
  },

  saveProfile: function () {
    const self = this;
    if (!this.data.hasNameChanges || this.data.savingProfile || this.data.savingAvatar) return Promise.resolve();
    this.setData({ savingProfile: true });
    return api.call('auth.updateProfile', {
      nickName: this.data.nickName.trim()
    }).then(function (data) {
      app.setUser(data.user);
      self._initialNickName = data.user.nickName || '';
      self.setData({ user: data.user, nickName: data.user.nickName || '', hasNameChanges: false }, function () {
        self.refreshProfileState();
      });
      wx.showToast({ title: '名字已保存', icon: 'success' });
      return data;
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
