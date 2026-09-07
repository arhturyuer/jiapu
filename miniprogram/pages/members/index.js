const app = getApp();
const api = require('../../utils/api');
const format = require('../../utils/format');
const shareInvite = require('../../utils/share-invite');
const shareCard = require('../../utils/share-card');
const commerceConfig = require('../../config/commerce');
const membershipDisplay = require('../../utils/membership-display');

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
    onboarding: { isCreator: false, sharedAt: null },
    showShareSheet: false,
    shareRole: 'member',
    shareReady: false,
    shareCreating: false,
    shareCard: null,
    systemShareCard: shareCard.create({ kind: 'discovery' }),
    membershipActive: false,
    membershipTierText: '免费版',
    membershipDetailText: '升级后全体家人共享会员权益',
    adUnitId: '',
    adVisible: false
  },

  onShow: function () {
    this.loadDashboard();
  },

  onPullDownRefresh: function () {
    this.loadDashboard({ force: true }).then(function () { wx.stopPullDownRefresh(); });
  },

  loadDashboard: function (options) {
    const self = this;
    const config = options || {};
    const hasContent = this._hasLoaded && !this.data.loading;
    const currentFamily = app.getCurrentFamily();
    if (!config.force && hasContent && app.isCacheFresh('familyPages', false) && (!currentFamily || app.isCacheFresh('dashboard', currentFamily._id))) {
      return Promise.resolve();
    }
    if (!hasContent) this.setData({ loading: true });
    return app.loadFamilies(config).then(function () {
      const family = app.getCurrentFamily();
      self.setData({ currentFamily: family, loading: false });
      if (!family) {
        self._hasLoaded = true;
        return null;
      }
      return app.getDashboard(family._id, config);
    }).then(function (data) {
      if (!data) return;
      const collaborators = (data.collaborators || []).map(function (item) {
        return Object.assign({}, item, {
          initial: (item.displayName || '家').slice(0, 1),
          roleText: format.roleText(item.role),
          avatarUrl: ''
        });
      });
      const membershipPresentation = membershipDisplay.fromFamily(data.family);
      self.setData({
        loading: false,
        currentFamily: data.family,
        currentRole: data.family.currentRole,
        isAdmin: data.family.currentRole === 'admin',
        stats: data.stats,
        onboarding: data.onboarding || { isCreator: false, sharedAt: null },
        collaborators: collaborators,
        pendingChanges: data.pendingChanges || [],
        membershipActive: membershipPresentation.active,
        membershipTierText: membershipPresentation.tierText,
        membershipDetailText: membershipPresentation.detailText,
        adUnitId: commerceConfig.resolveBanner(app.globalData.environment, 'family'),
        adVisible: Boolean(commerceConfig.resolveBanner(app.globalData.environment, 'family') && !(data.family.membership && data.family.membership.active)),
        recentActivities: (data.recentActivities || []).map(function (item) {
          return Object.assign({}, item, { timeText: format.relativeTime(item.createdAt) });
        })
      });
      shareCard.createAndRender(self, 'members-share-card', { kind: 'discovery' }).then(function (card) {
        self.setData({ systemShareCard: card });
      });
      app.setCurrentFamily(data.family);
      self._hasLoaded = true;
      return api.getMediaUrls(collaborators.map(function (item) { return item.avatarAssetId; })).then(function (urls) {
        self.setData({
          collaborators: collaborators.map(function (item) {
            return Object.assign({}, item, { avatarUrl: urls[item.avatarAssetId] || '' });
          })
        });
      });
    }).catch(function (error) {
      if (!hasContent) {
        self.setData({ loading: false });
        wx.showToast({ title: error.message || '家庭数据加载失败', icon: 'none' });
      } else console.warn('后台刷新家庭看板失败，保留当前内容', error);
    });
  },

  createFamily: function () {
    wx.navigateTo({ url: '/pages/create-family/index' });
  },

  openPersonList: function () {
    if (!this.data.currentFamily) return;
    wx.navigateTo({ url: '/pages/person-list/index?familyId=' + this.data.currentFamily._id });
  },

  openGraph: function () {
    app.openFullGraph(this.data.currentFamily);
    wx.switchTab({ url: '/pages/tree/index' });
  },

  openCollaborators: function () {
    if (!this.data.currentFamily) return;
    wx.navigateTo({ url: '/pages/family-manage/index?familyId=' + this.data.currentFamily._id + '&section=collaborators' });
  },

  openPendingChanges: function () {
    if (!this.data.currentFamily) return;
    wx.navigateTo({ url: '/pages/change-list/index?familyId=' + this.data.currentFamily._id });
  },

  openFamilyManage: function () {
    if (!this.data.currentFamily) return;
    wx.navigateTo({ url: '/pages/family-manage/index?familyId=' + this.data.currentFamily._id });
  },

  openMembership: function () { if (this.data.currentFamily) wx.navigateTo({ url: '/pages/membership/index?familyId=' + this.data.currentFamily._id }); },
  openActivity: function () { if (this.data.currentFamily) wx.navigateTo({ url: '/pages/activity/index?familyId=' + this.data.currentFamily._id }); },
  openFamilyBackup: function () { if (this.data.currentFamily) wx.navigateTo({ url: '/pages/family-backup/index?familyId=' + this.data.currentFamily._id }); },
  hideAd: function () { this.setData({ adVisible: false }); },

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
      app.invalidateFamilyData(self.data.currentFamily && self.data.currentFamily._id);
      self.loadDashboard({ force: true });
    }).catch(function (error) {
      wx.showToast({ title: error.message || '处理失败', icon: 'none' });
    });
  },

  openShareSheet: function () {
    this.setData({
      showShareSheet: true,
      shareRole: this.data.isAdmin ? 'member' : 'viewer',
      shareReady: false,
      shareCard: null,
      shareCreating: false
    }, this.prepareShare);
  },

  closeShareSheet: function () {
    this._sharePreparationSequence = (this._sharePreparationSequence || 0) + 1;
    this.setData({ showShareSheet: false, shareReady: false, shareCard: null });
  },

  chooseShareRole: function (event) {
    const role = event.currentTarget.dataset.role;
    if (!role || role === this.data.shareRole) return;
    this.setData({ shareRole: role, shareReady: false, shareCard: null }, this.prepareShare);
  },

  prepareShare: function () {
    const self = this;
    const family = this.data.currentFamily;
    if (!family) return;
    const shareContext = {
      ownerId: (app.globalData.user || {})._id || '',
      familyId: family._id,
      role: this.data.shareRole,
      viewMode: 'full',
      viewPersonId: '',
      fingerprint: shareCard.fingerprint({
        kind: 'family_full', familyName: family.name,
        personCount: this.data.stats.personCount || family.personCount,
        role: this.data.shareRole,
        inviterName: ((app.globalData.user || {}).nickName || '一位家人')
      })
    };
    const cachedCard = shareInvite.get(shareContext);
    const sequence = (this._sharePreparationSequence || 0) + 1;
    this._sharePreparationSequence = sequence;
    if (cachedCard) {
      this.setData({ shareReady: true, shareCreating: false, shareCard: cachedCard });
      return;
    }
    this.setData({ shareCreating: true });
    api.call('invite.create', {
      familyId: family._id,
      role: this.data.shareRole,
      viewMode: 'full'
    }).then(function (data) {
      if (sequence !== self._sharePreparationSequence || !self.data.showShareSheet) return;
      return shareCard.createAndRender(self, 'members-share-card', {
        kind: 'family_full', familyName: data.familyName,
        personCount: self.data.stats.personCount || family.personCount,
        inviterName: ((app.globalData.user || {}).nickName || '一位家人'),
        role: data.role,
        path: '/pages/invite/index?token=' + data.token
      }).then(function (card) {
        if (sequence !== self._sharePreparationSequence || !self.data.showShareSheet) return;
        card.invitationId = data.invitationId;
        shareInvite.set(shareContext, card, data.expiresAt);
        api.call('share.record', { stage: 'prepared', invitationId: data.invitationId }).catch(function () {});
        app.invalidateCache({ dashboard: family._id });
        self.setData({ shareReady: true, shareCreating: false, shareCard: card });
      });
    }).catch(function (error) {
      if (sequence !== self._sharePreparationSequence || !self.data.showShareSheet) return;
      self.setData({ shareCreating: false });
      wx.showToast({ title: error.message || '微信邀请准备失败，请重试', icon: 'none' });
    });
  },

  onShareAppMessage: function (event) {
    const self = this;
    if (event && event.from === 'button' && this.data.shareCard) return {
      title: this.data.shareCard.title,
      path: this.data.shareCard.path,
      imageUrl: this.data.shareCard.imageUrl,
      success: function () {
        api.call('share.record', { stage: 'sent', invitationId: self.data.shareCard.invitationId }).catch(function () {});
        api.call('family.markOnboardingShared', {
          familyId: self.data.currentFamily._id,
          invitationId: self.data.shareCard.invitationId
        }).then(function () {
          const updatedFamily = Object.assign({}, self.data.currentFamily, { sharedAt: new Date().toISOString() });
          app.invalidateFamilyData(self.data.currentFamily._id);
          app.setCurrentFamily(updatedFamily);
          self.setData({
            currentFamily: updatedFamily
          });
          self.loadDashboard({ force: true });
        }).catch(function () {});
      }
    };
    const discovery = this.data.systemShareCard || shareCard.create({ kind: 'discovery' });
    api.call('share.record', { stage: 'prepared', kind: 'discovery' }).catch(function () {});
    return {
      title: discovery.title,
      path: discovery.path,
      imageUrl: discovery.imageUrl,
      success: function () { api.call('share.record', { stage: 'sent', kind: 'discovery' }).catch(function () {}); }
    };
  },

  continueOnboardingAdd: function () {
    this.openGraph();
  },

  stopEvent: function () {}
});
