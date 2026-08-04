const app = getApp();
const api = require('../../utils/api');
const privacy = require('../../utils/privacy');
const formState = require('../../utils/form-state');
const format = require('../../utils/format');

function profileAvatarState(status) {
  if (status === 'approved') return { state: 'approved', text: '头像已通过审核，正在所有家谱中展示' };
  if (status === 'rejected' || status === 'deleted') return { state: 'rejected', text: '头像未通过审核，请重新选择' };
  if (status === 'pending' || status === 'review') return { state: 'pending', text: '头像已保存，审核通过后会自动展示' };
  return { state: '', text: '' };
}

function splitFamilies(items) {
  const active = [];
  const archived = [];
  (items || []).forEach(function (item) {
    if (item.status === 'archived') archived.push(Object.assign({}, item, {
      archiveStatusText: item.currentRole === 'admin'
        ? ('你可在 ' + format.dateText(item.purgeAt) + ' 前恢复')
        : '仅管理员可恢复'
    }));
    else if (item.status === 'active') active.push(item);
  });
  return { active: active, archived: archived };
}

function reconcileCurrentFamily(families) {
  const current = app.getCurrentFamily();
  const matched = current && families.find(function (item) { return item._id === current._id; });
  const next = matched || families[0] || null;
  app.globalData.familyList = families;
  app.setCurrentFamily(next);
  return next;
}

Page({
  data: {
    loading: true,
    error: '',
    accountState: 'active',
    deletion: null,
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
    currentRoleText: '',
    currentFamilyUpdatedText: '',
    savingProfile: false,
    showFamilySheet: false
  },

  onShow: function () { this.loadPage(); },

  onUnload: function () { formState.clearLeaveAlert(this); },

  loadPage: function () {
    const self = this;
    this.setData({ loading: true, error: '', showFamilySheet: false });
    return app.ensureLogin().then(function () {
      const user = app.globalData.user || {};
      const accountState = app.globalData.accountState || user.status || 'active';
      const deletion = app.globalData.deletion || null;
      if (accountState === 'pending_delete') {
        self.setData({
          loading: false, accountState: accountState, deletion: deletion, user: user,
          nickName: user.nickName || '', avatarAssetId: user.avatarAssetId || '',
          avatarUrl: '', avatarState: '', avatarStateText: '', familyList: [], archivedFamilies: [], currentFamily: null
        });
        formState.clearLeaveAlert(self);
        return null;
      }
      return app.loadFamilyPages(true).then(function (result) {
        const grouped = splitFamilies(result.families);
        const currentFamily = reconcileCurrentFamily(grouped.active);
        self._initialNickName = user.nickName || '';
        self.setData({
          loading: false, accountState: accountState, deletion: deletion, user: user,
          nickName: user.nickName || '', avatarUrl: '', avatarAssetId: user.avatarAssetId || '',
          avatarState: '', avatarStateText: '', avatarError: '', savingAvatar: false, hasNameChanges: false,
          familyList: grouped.active, archivedFamilies: grouped.archived, currentFamily: currentFamily,
          currentRoleText: currentFamily ? format.roleText(currentFamily.currentRole) : '',
          currentFamilyUpdatedText: currentFamily && currentFamily.updatedAt ? '最近更新 ' + format.relativeTime(currentFamily.updatedAt) : ''
        });
        formState.clearLeaveAlert(self);
        if (!user.avatarAssetId) return null;
        return api.getMediaPresentation([user.avatarAssetId]).then(function (presentation) {
          const item = presentation[user.avatarAssetId] || {};
          const avatarPresentation = profileAvatarState(item.status || '');
          self.setData({ avatarUrl: item.url || '', avatarState: avatarPresentation.state, avatarStateText: avatarPresentation.text });
        }).catch(function () {
          self.setData({ avatarState: 'unavailable', avatarStateText: '头像状态暂时无法更新，不影响其他功能' });
        });
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: error.message || '页面加载失败，请检查网络后重试' });
    });
  },

  inputNickname: function (event) {
    const self = this;
    this.setData({ nickName: event.detail.value }, function () { self.refreshProfileState(); });
  },

  refreshProfileState: function () {
    const hasNameChanges = String(this.data.nickName || '').trim() !== String(this._initialNickName || '');
    if (this.data.hasNameChanges !== hasNameChanges) this.setData({ hasNameChanges: hasNameChanges });
    formState.syncLeaveAlert(this, hasNameChanges || this.data.savingAvatar || this.data.avatarState === 'failed', '名字或头像尚未保存，确定离开吗？');
  },

  chooseAvatar: function () {
    const self = this;
    if (this.data.savingAvatar || this.data.savingProfile || this.data.accountState !== 'active') return Promise.resolve();
    let selectedPath = '';
    return privacy.ensurePrivacyAuthorized().then(function () {
      return wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] });
    }).then(function (result) {
      const file = result.tempFiles[0];
      selectedPath = file.tempFilePath;
      self.setData({ avatarUrl: selectedPath, savingAvatar: true, avatarState: 'uploading', avatarStateText: '正在上传头像…', avatarError: '' }, function () { self.refreshProfileState(); });
      return api.uploadImage(file.tempFilePath, 'user-avatars', { kind: 'user_avatar', size: file.size || 0 });
    }).then(function (media) {
      self._pendingAvatarMedia = media;
      return self.saveProfileAvatar(media);
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) return;
      self.setData({ avatarUrl: selectedPath || self.data.avatarUrl, savingAvatar: false, avatarState: 'failed', avatarStateText: '头像保存失败，请重新选择后重试', avatarError: error.message || error.errMsg || '头像保存失败' }, function () { self.refreshProfileState(); });
      wx.showToast({ title: error.message || error.errMsg || '头像上传失败', icon: 'none' });
    });
  },

  saveProfileAvatar: function (media) {
    const self = this;
    this.setData({ avatarUrl: media.previewUrl || this.data.avatarUrl, avatarAssetId: media.assetId, savingAvatar: true, avatarState: 'saving', avatarStateText: '正在保存头像…', avatarError: '' }, function () { self.refreshProfileState(); });
    return api.call('auth.updateAvatar', { avatarAssetId: media.assetId }).then(function (data) {
      self._pendingAvatarMedia = null;
      app.setUser(data.user);
      const presentation = profileAvatarState(data.moderationStatus || media.moderationStatus);
      self.setData({ user: data.user, savingAvatar: false, avatarState: presentation.state, avatarStateText: presentation.text }, function () { self.refreshProfileState(); });
      wx.showToast({ title: media.ready ? '头像已更新' : '头像已保存，等待审核', icon: media.ready ? 'success' : 'none' });
      return data;
    });
  },

  retryAvatarSave: function () {
    if (this.data.savingAvatar || this.data.savingProfile) return;
    if (this._pendingAvatarMedia) {
      const self = this;
      this.saveProfileAvatar(this._pendingAvatarMedia).catch(function (error) {
        self.setData({ savingAvatar: false, avatarState: 'failed', avatarStateText: '头像保存失败，请重新选择后重试', avatarError: error.message || '头像保存失败' }, function () { self.refreshProfileState(); });
      });
      return;
    }
    this.chooseAvatar();
  },

  saveProfile: function () {
    const self = this;
    if (!this.data.hasNameChanges || this.data.savingProfile || this.data.savingAvatar || this.data.accountState !== 'active') return Promise.resolve();
    this.setData({ savingProfile: true });
    return api.call('auth.updateProfile', { nickName: this.data.nickName.trim() }).then(function (data) {
      app.setUser(data.user);
      self._initialNickName = data.user.nickName || '';
      self.setData({ user: data.user, nickName: data.user.nickName || '', hasNameChanges: false }, function () { self.refreshProfileState(); });
      wx.showToast({ title: '名字已保存并同步', icon: 'success' });
      return data;
    }).catch(function (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }).then(function () { self.setData({ savingProfile: false }); });
  },

  openFamilySheet: function () { this.setData({ showFamilySheet: true }); },
  closeFamilySheet: function () { this.setData({ showFamilySheet: false }); },

  switchFamily: function (event) {
    const familyId = event.currentTarget.dataset.id;
    const family = this.data.familyList.find(function (item) { return item._id === familyId; });
    if (!family) return;
    app.setCurrentFamily(family);
    wx.setStorageSync('youpu_pending_view', { mode: 'full', personId: '' });
    this.setData({ currentFamily: family, currentRoleText: format.roleText(family.currentRole), currentFamilyUpdatedText: family.updatedAt ? '最近更新 ' + format.relativeTime(family.updatedAt) : '', showFamilySheet: false });
    wx.showModal({ title: '已切换到“' + family.name + '”', content: '现在去查看这份家谱吗？', confirmText: '去查看', cancelText: '留在这里' }).then(function (result) {
      if (result.confirm) wx.switchTab({ url: '/pages/tree/index' });
    });
  },

  openCurrentGraph: function () {
    if (!this.data.currentFamily) return;
    app.openFullGraph(this.data.currentFamily);
    wx.switchTab({ url: '/pages/tree/index' });
  },

  createFamily: function () { this.closeFamilySheet(); wx.navigateTo({ url: '/pages/create-family/index' }); },
  openExamples: function () { wx.navigateTo({ url: '/pages/examples/index' }); },
  explainInvitation: function () { wx.showModal({ title: '接受家人邀请', content: '请从家人发给你的家谱邀请卡进入。这样我们才能确认你要加入的家谱和权限。', showCancel: false, confirmText: '知道了' }); },
  showPrivacy: function () { wx.navigateTo({ url: '/pages/privacy/index' }); },

  openFamilyManage: function () {
    const family = this.data.currentFamily;
    if (!family) return;
    wx.navigateTo({ url: '/pages/family-manage/index?familyId=' + family._id });
  },

  openArchivedFamily: function (event) { wx.navigateTo({ url: '/pages/family-manage/index?familyId=' + event.currentTarget.dataset.id }); },

  clearCache: function () {
    wx.showModal({ title: '清除本机缓存？', content: '只会清除这台设备上的临时资料，不会退出微信登录，也不会删除云端家谱。' }).then(function (result) {
      if (!result.confirm) return;
      app.clearLocalData();
      wx.showToast({ title: '本机缓存已清除', icon: 'success' });
      setTimeout(function () { wx.reLaunch({ url: '/pages/tree/index' }); }, 500);
    });
  },

  showAbout: function () { wx.showModal({ title: '关于有谱', content: '有谱 · 一家人，共修一份家谱\n\n一个人快速创建，一家人共同补全，由少数管理员维护秩序。', showCancel: false, confirmText: '知道了' }); },
  stopEvent: function () {}
});
