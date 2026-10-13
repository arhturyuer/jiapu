const platformCapabilities = require('../../utils/platform-capabilities');
const launchAd = require('../../utils/launch-ad');
const app = getApp();
const api = require('../../utils/api');
const profileImages = require('../../utils/profile-image-cache');
const privacy = require('../../utils/privacy');
const formState = require('../../utils/form-state');
const adAccess = require('../../utils/ad-access');
const shareCard = require('../../utils/share-card');
const environmentConfig = require('../../config/env');
const myMiniProgramGuide = require('../../utils/my-miniprogram-guide');

function canResetTestAccount() {
  const runtime = environmentConfig.resolveRuntimeEnvironment(wx);
  return runtime.active === 'staging' && runtime.runtimeVersion === 'develop' &&
    app.globalData.environment === 'staging' && app.globalData.env === runtime.environment.cloudEnv;
}

function getCachedAvatarUrl(assetId) {
  const cached = profileImages.peekAvatar(app, assetId);
  return cached && cached.url || '';
}

function profileSession() {
  return JSON.stringify([app.globalData.env || '', app.globalData.user && app.globalData.user._id || '', app._sessionVersion || 0]);
}

Page(launchAd.wrap({
  data: {
    showMyMiniProgramGuide: false,
    myMiniProgramGuideStyle: '',
    myMiniProgramGuideArrowStyle: '',
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
    adLoaded: false, adFamilyId: '', adVersion: 0,
    adVisible: false,
    showTestReset: false,
    resettingTestAccount: false,
    feedbackLoading: true,
    feedbackError: '',
    feedbackAvailable: false,
    feedbackQrCodeUrl: '',
    feedbackVersion: 0
  },

  onShow: function () {
    myMiniProgramGuide.dismissManual(this);
    this._unloaded = false;
    this._feedbackHidden = false;
    this.setData({ showTestReset: canResetTestAccount() });
    if (this.data.resettingTestAccount) return;
    this.loadPage();
    this.loadFeedbackGroup();
    this._adPageHidden = false;
    adAccess.hide(this, false);
    app.ensureLogin().then(() => adAccess.refresh(this, app, 'profile', app.getCurrentFamily())).catch(function () {});
    if (app.refreshPendingBadge) app.refreshPendingBadge().catch(function () {});
  },

  onHide: function () { myMiniProgramGuide.dismissManual(this); this._pageVersion = (this._pageVersion || 0) + 1; this._feedbackHidden = true; this._feedbackVersion = (this._feedbackVersion || 0) + 1; this._adPageHidden = true; adAccess.hide(this, false); },
  onUnload: function () { myMiniProgramGuide.dismissManual(this); this._feedbackHidden = true; this._feedbackVersion = (this._feedbackVersion || 0) + 1; this._adPageHidden = true; adAccess.hide(this, false); this._unloaded = true; this._pageVersion = (this._pageVersion || 0) + 1; formState.clearLeaveAlert(this); },

  loadFeedbackGroup: function (options) {
    const self = this;
    if (this._unloaded || this._feedbackHidden || this.data.resettingTestAccount) return Promise.resolve();
    const version = this._feedbackVersion = (this._feedbackVersion || 0) + 1;
    const force = Boolean(options && (options.force || options.type === 'tap'));
    const cached = !force && profileImages.peekFeedback(app);
    this.setData({ feedbackLoading: !cached, feedbackError: '', feedbackAvailable: Boolean(cached), feedbackQrCodeUrl: cached ? cached.qrCodeUrl : '', feedbackVersion: version });
    const scope = JSON.stringify([app.globalData.env, app._sessionVersion || 0]);
    let actor = app.globalData.user && app.globalData.user._id || '';
    function isCurrent() {
      return scope === JSON.stringify([app.globalData.env, app._sessionVersion || 0]) && (!actor || actor === (app.globalData.user && app.globalData.user._id || '')) &&
        !self._unloaded && !self._feedbackHidden && !self.data.resettingTestAccount && version === self._feedbackVersion;
    }
    return app.ensureLogin().then(function () {
      if (!isCurrent()) return null;
      actor = app.globalData.user && app.globalData.user._id || '';
      return profileImages.getFeedback(app, { force: force });
    }).then(function (data) {
      if (!isCurrent() || !data) return;
      self.setData({
        feedbackLoading: false,
        feedbackAvailable: Boolean(data.available && data.qrCodeUrl),
        feedbackQrCodeUrl: data.available ? data.qrCodeUrl || '' : ''
      });
    }).catch(function (error) {
      if (!isCurrent()) return;
      self.setData({ feedbackLoading: false, feedbackError: api.userMessage(error, '反馈群信息加载失败，请稍后重试') });
    });
  },

  feedbackQrError: function (event) {
    const dataset = event.currentTarget.dataset;
    if (this._unloaded || this._feedbackHidden || this.data.resettingTestAccount ||
      Number(dataset.version) !== this._feedbackVersion || dataset.url !== this.data.feedbackQrCodeUrl) return;
    profileImages.discardFeedback(app);
    this.setData({ feedbackAvailable: false, feedbackQrCodeUrl: '', feedbackError: '二维码加载失败，请重新加载' });
  },

  previewFeedbackQrCode: function () {
    if (this._unloaded || this._feedbackHidden || this.data.resettingTestAccount || !this.data.feedbackAvailable || !this.data.feedbackQrCodeUrl) return;
    wx.previewImage({ current: this.data.feedbackQrCodeUrl, urls: [this.data.feedbackQrCodeUrl], showmenu: true });
  },

  loadPage: function (options) {
    const self = this;
    const config = options || {};
    const version = this._pageVersion = (this._pageVersion || 0) + 1;
    const hasContent = this._hasLoaded && !this.data.loading;
    const currentUser = app.globalData.user || {};
    const cachedAvatar = getCachedAvatarUrl(currentUser.avatarAssetId);
    if (!config.force && hasContent && app.isCacheFresh('profile') && this.data.user && this.data.user._id === currentUser._id &&
      this.data.avatarAssetId === (currentUser.avatarAssetId || '') && (!currentUser.avatarAssetId || cachedAvatar)) {
      if (cachedAvatar && this.data.avatarUrl !== cachedAvatar) this.setData({ avatarUrl: cachedAvatar });
      return Promise.resolve();
    }
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
        self._initialNickName = user.nickName || '';
        const cachedUrl = getCachedAvatarUrl(user.avatarAssetId);
        const pageData = {
          pending: false, user: user, accountState: accountState, deletion: deletion,
          nickName: user.nickName || '', avatarUrl: cachedUrl, avatarAssetId: user.avatarAssetId || '',
        };
        return pageData;
      });
    }, config).then(function (pageData) {
      if (self._unloaded || version !== self._pageVersion || self.data.resettingTestAccount) return null;
      const session = profileSession();
      if (!app.globalData.user || pageData.user._id !== app.globalData.user._id || (pageData.user.avatarAssetId || '') !== (app.globalData.user.avatarAssetId || '')) return null;
      if (pageData.pending) return pageData;
      const assetId = pageData.user.avatarAssetId || '';
      profileImages.replaceAvatar(app, assetId);
      return profileImages.getAvatar(app, assetId).then(function (item) {
        if (session !== profileSession() || version !== self._pageVersion) return null;
        const unavailable = item.status === 'rejected' || item.status === 'deleted';
        const preview = self.data.avatarAssetId === assetId ? self.data.avatarUrl : '';
        return Object.assign({}, pageData, { avatarUrl: unavailable ? '' : (item.url || preview || '') });
      }).catch(function () { return session === profileSession() && version === self._pageVersion ? Object.assign({}, pageData, { avatarUrl: getCachedAvatarUrl(assetId) }) : null; });
    }).then(function (pageData) {
      if (!pageData) return;
      if (self._unloaded || version !== self._pageVersion || self.data.resettingTestAccount) return;
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
      if (self._unloaded || version !== self._pageVersion || self.data.resettingTestAccount) return;
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
    if (this.data.resettingTestAccount || this.data.savingAvatar || this.data.savingProfile || this.data.accountState !== 'active') return Promise.resolve();
    let selectedPath = '';
    return privacy.ensurePrivacyAuthorized().then(function () {
      return platformCapabilities.chooseImage();
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
    const session = profileSession();
    this._pageVersion = (this._pageVersion || 0) + 1;
    this.setData({ avatarUrl: media.previewUrl || this.data.avatarUrl, avatarAssetId: media.assetId, savingAvatar: true }, function () { self.refreshProfileState(); });
    return api.call('auth.updateAvatar', { avatarAssetId: media.assetId }).then(function (data) {
      if (session !== profileSession() || self._unloaded) return data;
      self._pendingAvatarMedia = null;
      app.setUser(data.user);
      profileImages.replaceAvatar(app, media.assetId);
      const approved = (data.moderationStatus || media.moderationStatus) === 'approved';
      // Fetch the fresh presentation URL for approved avatars
      const fetchPresentation = approved
        ? profileImages.getAvatar(app, media.assetId).then(function (item) { return item.url || ''; }).catch(function () { return ''; })
        : Promise.resolve('');
      return fetchPresentation.then(function (freshUrl) {
        if (session !== profileSession() || self._unloaded || (app.globalData.user && app.globalData.user.avatarAssetId) !== media.assetId) return data;
        self.setData({ user: data.user, savingAvatar: false, avatarUrl: freshUrl || media.previewUrl || self.data.avatarUrl }, function () { self.refreshProfileState(); });
        wx.showToast({ title: freshUrl ? '头像已更新' : '头像已保存，等待审核', icon: freshUrl ? 'success' : 'none' });
        return data;
      });
    });
  },

  avatarError: function (event) {
    const dataset = event.currentTarget.dataset;
    if (this._unloaded || this._feedbackHidden || this.data.savingAvatar || dataset.asset !== this.data.avatarAssetId || dataset.url !== this.data.avatarUrl) return;
    profileImages.discardAvatar(app, this.data.avatarAssetId);
    this.setData({ avatarUrl: '' });
    const retryKey = profileSession() + '|' + this.data.avatarAssetId;
    if (this._avatarRetryKey === retryKey) return;
    this._avatarRetryKey = retryKey;
    this.loadPage({ force: true });
  },

  saveProfile: function () {
    const self = this;
    const newName = (this.data.nickName || '').trim();
    if (!newName || this.data.resettingTestAccount || this.data.savingProfile || this.data.savingAvatar || this.data.accountState !== 'active') return Promise.resolve();
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

  resetTestAccount: function () {
    const self = this;
    if (!canResetTestAccount() || this.data.resettingTestAccount || this.data.savingAvatar || this.data.savingProfile) return Promise.resolve();
    myMiniProgramGuide.dismissManual(this);
    const refreshFeedback = Boolean(this.data.feedbackVersion);
    this._feedbackVersion = (this._feedbackVersion || 0) + 1;
    this.setData({ resettingTestAccount: true });
    this._pageVersion = (this._pageVersion || 0) + 1;
    const confirmation = this._testResetCompleted ? Promise.resolve({ confirm: true }) : wx.showModal({
      title: '注销测试账户并重新体验？',
      content: '仅限测试环境：立即注销当前测试身份，清除本机体验记录，重新以空白账户进入。你将退出所有家谱；只有你一位管理员的家谱会归档。此操作没有冷静期，旧身份无法恢复。',
      confirmText: '注销重进', confirmColor: '#B43D3D'
    });
    return confirmation.then(function (result) {
      if (!result.confirm || self._unloaded) return null;
      if (self._testResetCompleted) return { reset: true };
      if (!self._testResetRequest) {
        self._testResetRequest = {
          idempotencyKey: 'test-reset-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
          expectedUserId: self.data.user && self.data.user._id || '', envVersion: 'develop'
        };
      }
      return api.call('account.resetTest', self._testResetRequest);
    }).then(function (data) {
      if (!data || !data.reset) return;
      if (!self._testResetCompleted) {
        self._testResetCompleted = true;
        app.clearTestSession();
        formState.clearLeaveAlert(self);
        if (!self._unloaded) self.setData({ user: null, nickName: '', avatarUrl: '', avatarAssetId: '', hasNameChanges: false, adVisible: false, accountState: 'active', deletion: null, feedbackLoading: false, feedbackError: '', feedbackAvailable: false, feedbackQrCodeUrl: '' });
      }
      return wx.reLaunch({ url: '/pages/tree/index' });
    }).catch(function (error) {
      if (self._unloaded) return;
      wx.showToast({ title: api.userMessage(error, self._testResetCompleted ? '注销完成，请再次点击重新进入' : '注销失败，请重试'), icon: 'none' });
    }).then(function () {
      if (!self._unloaded) self.setData({ resettingTestAccount: false });
      if (refreshFeedback && !self._testResetCompleted && !self._unloaded && !self._feedbackHidden) return self.loadFeedbackGroup();
    });
  },

  showPrivacy: function () { wx.navigateTo({ url: '/pages/privacy/index' }); },
  showMyMiniProgramHelp: function () { myMiniProgramGuide.showManual(this); },
  dismissMyMiniProgramGuide: function () { myMiniProgramGuide.dismissManual(this); },
  stopEvent: function () {},
  hideAd: function (event) { adAccess.error(this, false, event); },
  showAd: function (event) { adAccess.loaded(this, false, event); },
  openAdMembership: function () { adAccess.openMembership(this, app, false); },

  onShareAppMessage: function () {
    const card = shareCard.create({ kind: 'discovery', variant: 'intro' });
    api.call('share.record', { stage: 'prepared', kind: 'discovery' }).catch(function () {});
    return {
      title: card.title,
      path: card.path,
      imageUrl: card.imageUrl,
      success: function () {
        api.call('share.record', { stage: 'sent', kind: 'discovery' }).catch(function () {});
      }
    };
  },

  showAbout: function () { wx.navigateTo({ url: '/pages/about/index' }); }
}));
