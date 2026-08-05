const app = getApp();
const api = require('../../utils/api');
const privacy = require('../../utils/privacy');
const formState = require('../../utils/form-state');
const format = require('../../utils/format');

var AVATAR_CACHE_KEY = 'youpu_avatar_cache';

function getCachedAvatarUrl(assetId) {
  if (!assetId) return '';
  try {
    var cache = wx.getStorageSync(AVATAR_CACHE_KEY) || {};
    var entry = cache[assetId];
    if (entry && entry.url) return entry.url;
  } catch (e) { /* ignore */ }
  return '';
}

function cacheAvatarUrl(assetId, url) {
  if (!assetId || !url) return;
  try {
    var cache = wx.getStorageSync(AVATAR_CACHE_KEY) || {};
    cache[assetId] = { url: url, time: Date.now() };
    wx.setStorageSync(AVATAR_CACHE_KEY, cache);
  } catch (e) { /* ignore */ }
}

function clearCachedAvatarUrl(assetId) {
  if (!assetId) return;
  try {
    var cache = wx.getStorageSync(AVATAR_CACHE_KEY) || {};
    delete cache[assetId];
    wx.setStorageSync(AVATAR_CACHE_KEY, cache);
  } catch (e) { /* ignore */ }
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
    savingAvatar: false,
    savingProfile: false,
    hasNameChanges: false,
    familyList: [],
    archivedFamilies: [],
    currentFamily: null,
    currentRoleText: '',
    currentFamilyUpdatedText: '',
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
        const pendingCachedUrl = getCachedAvatarUrl(user.avatarAssetId);
        self.setData({
          loading: false, accountState: accountState, deletion: deletion, user: user,
          nickName: user.nickName || '', avatarAssetId: user.avatarAssetId || '',
          avatarUrl: pendingCachedUrl, familyList: [], archivedFamilies: [], currentFamily: null
        });
        formState.clearLeaveAlert(self);
        return null;
      }
      return app.loadFamilyPages(true).then(function (result) {
        const grouped = splitFamilies(result.families);
        const currentFamily = reconcileCurrentFamily(grouped.active);
        self._initialNickName = user.nickName || '';
        const cachedUrl = getCachedAvatarUrl(user.avatarAssetId);
        self.setData({
          loading: false, accountState: accountState, deletion: deletion, user: user,
          nickName: user.nickName || '', avatarUrl: cachedUrl, avatarAssetId: user.avatarAssetId || '',
          savingAvatar: false, savingProfile: false,
          familyList: grouped.active, archivedFamilies: grouped.archived, currentFamily: currentFamily,
          currentRoleText: currentFamily ? format.roleText(currentFamily.currentRole) : '',
          currentFamilyUpdatedText: currentFamily && currentFamily.updatedAt ? '最近更新 ' + format.relativeTime(currentFamily.updatedAt) : ''
        });
        formState.clearLeaveAlert(self);
        if (!user.avatarAssetId) return null;
        return api.getMediaPresentation([user.avatarAssetId]).then(function (presentation) {
          const item = presentation[user.avatarAssetId] || {};
          const freshUrl = item.url || '';
          if (freshUrl) cacheAvatarUrl(user.avatarAssetId, freshUrl);
          else if (item.status === 'rejected' || item.status === 'deleted') clearCachedAvatarUrl(user.avatarAssetId);
          self.setData({ avatarUrl: freshUrl || cachedUrl });
        }).catch(function () {
          // keep cached url on error
        });
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: error.message || '页面加载失败，请检查网络后重试' });
    });
  },

  inputNickname: function (event) {
    const value = event.detail.value || '';
    const hasNameChanges = value.trim() !== String(this._initialNickName || '');
    this.setData({ nickName: value, hasNameChanges: hasNameChanges });
  },

  refreshProfileState: function () {
    formState.syncLeaveAlert(this, this.data.savingAvatar || this.data.savingProfile, '头像或名字尚未保存，确定离开吗？');
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
      self.setData({ avatarUrl: selectedPath, savingAvatar: true }, function () { self.refreshProfileState(); });
      return api.uploadImage(file.tempFilePath, 'user-avatars', { kind: 'user_avatar', size: file.size || 0 });
    }).then(function (media) {
      self._pendingAvatarMedia = media;
      return self.saveProfileAvatar(media);
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) return;
      self.setData({ avatarUrl: selectedPath || self.data.avatarUrl, savingAvatar: false }, function () { self.refreshProfileState(); });
      wx.showToast({ title: error.message || error.errMsg || '头像上传失败', icon: 'none' });
    });
  },

  saveProfileAvatar: function (media) {
    const self = this;
    this.setData({ avatarUrl: media.previewUrl || this.data.avatarUrl, avatarAssetId: media.assetId, savingAvatar: true }, function () { self.refreshProfileState(); });
    return api.call('auth.updateAvatar', { avatarAssetId: media.assetId }).then(function (data) {
      self._pendingAvatarMedia = null;
      app.setUser(data.user);
      const approved = (data.moderationStatus || media.moderationStatus) === 'approved';
      // Fetch the fresh presentation URL for approved avatars
      const fetchPresentation = approved
        ? api.getMediaPresentation([media.assetId]).then(function (result) {
            const item = result[media.assetId] || {};
            return item.url || '';
          }).catch(function () { return ''; })
        : Promise.resolve('');
      return fetchPresentation.then(function (freshUrl) {
        if (freshUrl) {
          cacheAvatarUrl(media.assetId, freshUrl);
        } else if (media.previewUrl) {
          cacheAvatarUrl(media.assetId, media.previewUrl);
        }
        self.setData({ user: data.user, savingAvatar: false, avatarUrl: freshUrl || media.previewUrl || self.data.avatarUrl }, function () { self.refreshProfileState(); });
        wx.showToast({ title: freshUrl ? '头像已更新' : '头像已保存，等待审核', icon: freshUrl ? 'success' : 'none' });
        return data;
      });
    });
  },

  saveProfile: function () {
    const self = this;
    const newName = (this.data.nickName || '').trim();
    if (!newName || this.data.savingProfile || this.data.savingAvatar || this.data.accountState !== 'active') return Promise.resolve();
    this.setData({ savingProfile: true });
    return api.call('auth.updateProfile', { nickName: newName }).then(function (data) {
      app.setUser(data.user);
      self._initialNickName = data.user.nickName || '';
      self.setData({ user: data.user, nickName: data.user.nickName || '', savingProfile: false, hasNameChanges: false });
      wx.showToast({ title: '名字已保存并同步', icon: 'success' });
      return data;
    }).catch(function (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
      self.setData({ savingProfile: false });
    });
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

  showAbout: function () { wx.showModal({ title: '关于有谱', content: '有谱由独立开发者打造，尝试用小程序与云端能力，让家谱记录更轻松、更便于协作。\n\n我们关注清晰的亲属关系、多人共同维护，以及家庭资料的隐私保护。\n\n愿每份家庭记忆，都能被好好保存。', showCancel: false, confirmText: '知道了' }); },
  stopEvent: function () {}
});
