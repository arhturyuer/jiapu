const app = getApp();
const api = require('../../utils/api');
const format = require('../../utils/format');
const shareInvite = require('../../utils/share-invite');
const shareCard = require('../../utils/share-card');
const commerceConfig = require('../../config/commerce');
const membershipDisplay = require('../../utils/membership-display');
const subscribeNotifications = require('../../utils/subscribe-notifications');

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
    familyList: [],
    archivedFamilies: [],
    currentFamily: null,
    currentRole: 'viewer',
    isAdmin: false,
    stats: { personCount: 0, relationCount: 0, collaboratorCount: 0, completion: 0, pendingCount: 0 },
    pendingChanges: [],
    onboarding: { isCreator: false, sharedAt: null },
    showFamilySheet: false,
    showShareSheet: false,
    shareRole: 'member',
    shareReady: false,
    shareCreating: false,
    shareCard: null,
    showNotificationPrompt: false,
    notificationTemplates: null,
    systemShareCard: shareCard.create({ kind: 'discovery' }),
    membershipActive: false,
    membershipTierText: '免费版',
    membershipDetailText: '升级后全体家人共享会员权益',
    adUnitId: '',
    adVisible: false
  },

  onShow: function () {
    this.loadDashboard({ refreshDashboard: true });
    this.loadNotificationTemplates();
  },

  loadNotificationTemplates: function () {
    const self = this;
    return subscribeNotifications.loadTemplates().then(function (templates) {
      self.setData({ notificationTemplates: templates });
      return templates;
    }).catch(function () { return null; });
  },

  openNotificationSettings: function () { this.setData({ showNotificationPrompt: true }); },
  closeNotificationSettings: function () { this.setData({ showNotificationPrompt: false }); },

  requestNotifications: function (options) {
    const self = this;
    const silent = options && options.silent === true;
    subscribeNotifications.request(this.data.notificationTemplates, this.data.isAdmin).then(function (result) {
      if (!silent) subscribeNotifications.showResult(result);
      if (result.accepted) self.setData({ showNotificationPrompt: false });
    });
  },

  onPullDownRefresh: function () {
    this.loadDashboard({ force: true }).then(function () { wx.stopPullDownRefresh(); });
  },

  loadDashboard: function (options) {
    const self = this;
    const config = options || {};
    const requestId = this._loadRequestId = (this._loadRequestId || 0) + 1;
    const hasContent = this._hasLoaded && !this.data.loading;
    const currentFamily = app.getCurrentFamily();
    const displayedFamilyId = this.data.currentFamily && this.data.currentFamily._id;
    const currentFamilyId = currentFamily && currentFamily._id;
    const sameFamily = displayedFamilyId === currentFamilyId;
    if (!config.force && !config.refreshDashboard && hasContent && sameFamily && app.isCacheFresh('familyPages', true) && (!currentFamily || app.isCacheFresh('dashboard', currentFamily._id))) {
      return Promise.resolve();
    }
    if (!hasContent) this.setData({ loading: true });
    return app.ensureLogin().then(function () {
      if (app.globalData.accountState === 'pending_delete') return { families: [] };
      return app.loadFamilyPages(true, config);
    }).then(function (listData) {
      if (requestId !== self._loadRequestId) return null;
      if (!listData) return null;
      const grouped = splitFamilies(listData.families || []);
      const family = reconcileCurrentFamily(grouped.active);
      self.setData({
        familyList: grouped.active,
        archivedFamilies: grouped.archived,
        currentFamily: family,
        loading: false
      });
      if (!family) {
        self.setData({
          currentRole: 'viewer',
          isAdmin: false,
          stats: { personCount: 0, relationCount: 0, collaboratorCount: 0, completion: 0, pendingCount: 0 },
          pendingChanges: [],
          onboarding: { isCreator: false, sharedAt: null },
          showFamilySheet: false,
          membershipActive: false,
          membershipTierText: '免费版',
          membershipDetailText: '升级后全体家人共享会员权益',
          adVisible: false
        });
        self._hasLoaded = true;
        return null;
      }
      return app.getDashboard(family._id, { force: Boolean(config.force || config.refreshDashboard) });
    }).then(function (data) {
      if (requestId !== self._loadRequestId) return;
      if (!data) return;
      const membershipPresentation = membershipDisplay.fromFamily(data.family);
      self.setData({
        loading: false,
        currentFamily: data.family,
        currentRole: data.family.currentRole,
        isAdmin: data.family.currentRole === 'admin',
        stats: data.stats,
        onboarding: data.onboarding || { isCreator: false, sharedAt: null },
        pendingChanges: data.pendingChanges || [],
        membershipActive: membershipPresentation.active,
        membershipTierText: membershipPresentation.tierText,
        membershipDetailText: membershipPresentation.detailText,
        adUnitId: commerceConfig.resolveBanner(app.globalData.environment, 'family'),
        adVisible: Boolean(commerceConfig.resolveBanner(app.globalData.environment, 'family') && !(data.family.membership && data.family.membership.active))
      });
      shareCard.createAndRender(self, 'members-share-card', { kind: 'discovery' }).then(function (card) {
        self.setData({ systemShareCard: card });
      });
      app.setCurrentFamily(data.family);
      if (app.setPendingBadgeCount) app.setPendingBadgeCount(data.family._id, data.family.currentRole === 'viewer' ? 0 : data.stats.pendingCount);
      self._hasLoaded = true;
    }).catch(function (error) {
      if (requestId !== self._loadRequestId) return;
      if (!hasContent) {
        self.setData({ loading: false });
        wx.showToast({ title: api.userMessage(error, '家庭信息加载失败'), icon: 'none' });
      } else console.warn('后台刷新家庭看板失败，保留当前内容', error);
    });
  },

  createFamily: function () {
    this.closeFamilySheet();
    wx.navigateTo({ url: '/pages/create-family/index' });
  },

  openExamples: function () { wx.navigateTo({ url: '/pages/examples/index' }); },

  explainInvitation: function () {
    wx.showModal({
      title: '接受家人邀请',
      content: '请从家人发给你的家谱邀请卡进入。这样我们才能确认你要加入的家谱和权限。',
      showCancel: false,
      confirmText: '知道了'
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
    this.setData({ currentFamily: family, showFamilySheet: false });
    this.loadDashboard();
  },

  openArchivedFamily: function (event) {
    wx.navigateTo({ url: '/pages/family-manage/index?familyId=' + event.currentTarget.dataset.id });
  },

  openPersonList: function () {
    if (!this.data.currentFamily) return;
    wx.navigateTo({ url: '/pages/person-list/index?familyId=' + this.data.currentFamily._id });
  },

  openGraph: function () {
    app.openFullGraph(this.data.currentFamily);
    wx.switchTab({ url: '/pages/tree/index' });
  },

  openDisplaySettings: function () {
    if (!this.data.currentFamily) return;
    wx.navigateTo({ url: '/pages/display-settings/index?familyId=' + encodeURIComponent(this.data.currentFamily._id) });
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
      if (app.refreshPendingBadge) app.refreshPendingBadge({ force: true }).catch(function () {});
      self.loadDashboard({ force: true });
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '处理失败'), icon: 'none' });
    });
  },

  openShareSheet: function () {
    this._inviteShareStarted = false;
    this.setData({
      showShareSheet: true,
      shareRole: this.data.currentRole === 'viewer' ? 'viewer' : 'member',
      shareReady: false,
      shareCard: null,
      shareCreating: false
    }, this.prepareShare);
  },

  closeShareSheet: function () {
    const requestReminder = this._inviteShareStarted;
    this._inviteShareStarted = false;
    this._sharePreparationSequence = (this._sharePreparationSequence || 0) + 1;
    this.setData({ showShareSheet: false, shareReady: false, shareCard: null });
    if (requestReminder) this.requestNotifications({ silent: true });
  },

  chooseShareRole: function (event) {
    const role = event.currentTarget.dataset.role;
    if (!['member', 'viewer'].includes(role) || role === this.data.shareRole || (role === 'member' && this.data.currentRole === 'viewer')) return;
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
      app.invalidateInvites(family._id);
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
      wx.showToast({ title: api.userMessage(error, '微信邀请准备失败，请重试'), icon: 'none' });
    });
  },

  onShareAppMessage: function (event) {
    const self = this;
    if (event && event.from === 'button' && event.target && event.target.dataset && event.target.dataset.shareKind === 'review-reminder' &&
      this.data.currentRole === 'member' && this.data.pendingChanges.length && this.data.currentFamily) {
      const family = this.data.currentFamily;
      return {
        title: family.name + '有待审核的家谱修改，请管理员处理',
        path: '/pages/change-list/index?familyId=' + encodeURIComponent(family._id) + '&review=1'
      };
    }
    if (event && event.from === 'button' && this.data.shareCard) {
      const card = this.data.shareCard;
      const familyId = this.data.currentFamily && this.data.currentFamily._id;
      this._inviteShareStarted = true;
      return {
        title: card.title,
        path: card.path,
        imageUrl: card.imageUrl,
        success: function () {
          api.call('share.record', { stage: 'sent', invitationId: card.invitationId }).catch(function () {});
          if (self.data.currentRole !== 'admin') return;
          api.call('family.markOnboardingShared', {
            familyId: familyId,
            invitationId: card.invitationId
          }).then(function () {
            const updatedFamily = Object.assign({}, self.data.currentFamily, { sharedAt: new Date().toISOString() });
            app.invalidateFamilyData(self.data.currentFamily._id);
            app.setCurrentFamily(updatedFamily);
            self.setData({ currentFamily: updatedFamily });
            self.loadDashboard({ force: true });
          }).catch(function () {});
        }
      };
    }
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
