const app = getApp();
const api = require('../../utils/api');
const privacy = require('../../utils/privacy');
const formState = require('../../utils/form-state');
const commerceConfig = require('../../config/commerce');

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
    adUnitId: '',
    adVisible: false
  },

  onShow: function () { this.loadPage(); },

  onUnload: function () { formState.clearLeaveAlert(this); },

  loadPage: function (options) {
    const self = this;
    const config = options || {};
    const hasContent = this._hasLoaded && !this.data.loading;
    if (!config.force && hasContent && app.isCacheFresh('profile')) return Promise.resolve();
    if (!hasContent) this.setData({ loading: true, error: '' });
    else this.setData({ error: '' });
    return app.getProfileData(function () {
      return app.ensureLogin(config).then(function () {
        const user = app.globalData.user || {};
        const accountState = app.globalData.accountState || user.status || 'active';
        const deletion = app.globalData.deletion || null;
        if (accountState === 'pending_delete') {
          return { pending: true, user: user, accountState: accountState, deletion: deletion };
        }
        const currentFamily = app.getCurrentFamily();
        const adUnitId = commerceConfig.resolveBanner(app.globalData.environment, 'profile');
        self._initialNickName = user.nickName || '';
        const cachedUrl = getCachedAvatarUrl(user.avatarAssetId);
        const pageData = {
          pending: false, user: user, accountState: accountState, deletion: deletion,
          nickName: user.nickName || '', avatarUrl: cachedUrl, avatarAssetId: user.avatarAssetId || '',
          adUnitId: adUnitId,
          adVisible: Boolean(currentFamily && !(currentFamily.membership && currentFamily.membership.active) && adUnitId)
        };
        if (!user.avatarAssetId) return pageData;
        return api.getMediaPresentation([user.avatarAssetId]).then(function (presentation) {
          const item = presentation[user.avatarAssetId] || {};
          const freshUrl = item.url || '';
          if (freshUrl) cacheAvatarUrl(user.avatarAssetId, freshUrl);
          const unavailable = item.status === 'rejected' || item.status === 'deleted';
          if (unavailable) clearCachedAvatarUrl(user.avatarAssetId);
          pageData.avatarUrl = unavailable ? '' : (freshUrl || cachedUrl);
          return pageData;
        }).catch(function () {
          return pageData;
        });
      });
    }, config).then(function (pageData) {
      if (pageData.pending) {
        const cachedUrl = getCachedAvatarUrl(pageData.user.avatarAssetId);
        self.setData({
          loading: false, accountState: pageData.accountState, deletion: pageData.deletion, user: pageData.user,
          nickName: pageData.user.nickName || '', avatarAssetId: pageData.user.avatarAssetId || '', avatarUrl: cachedUrl,
          adUnitId: '', adVisible: false
        });
      } else {
        self.setData(Object.assign({ loading: false, savingAvatar: false, savingProfile: false }, pageData));
      }
      self._hasLoaded = true;
      formState.clearLeaveAlert(self);
    }).catch(function (error) {
      if (!hasContent) self.setData({ loading: false, error: api.userMessage(error, '页面加载失败，请检查网络后重试') });
      else console.warn('后台刷新我的页面失败，保留当前内容', error);
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
      wx.showToast({ title: api.userMessage(error, '头像上传失败'), icon: 'none' });
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
      if (app.invalidateCache) app.invalidateCache({ profile: true });
      wx.showToast({ title: '名字已保存并同步', icon: 'success' });
      return data;
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '保存失败'), icon: 'none' });
      self.setData({ savingProfile: false });
    });
  },

  showPrivacy: function () { wx.navigateTo({ url: '/pages/privacy/index' }); },
  showFeedbackGroup: function () { wx.navigateTo({ url: '/pages/feedback-group/index' }); },
  hideAd: function () { this.setData({ adVisible: false }); },

  showAbout: function () { wx.navigateTo({ url: '/pages/about/index' }); }
});
