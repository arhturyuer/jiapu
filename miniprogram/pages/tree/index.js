const app = getApp();
const api = require('../../utils/api');
const graphLayout = require('../../utils/graph-layout');
const graphViewport = require('../../utils/graph-viewport');
const kinship = require('../../utils/kinship');
const personGender = require('../../utils/person-gender');
const childRank = require('../../utils/child-rank');
const personDate = require('../../utils/person-date');
const memberActions = require('../../utils/member-actions');
const commerceConfig = require('../../config/commerce');
const shareInvite = require('../../utils/share-invite');
const shareCard = require('../../utils/share-card');
const posterInvite = require('../../utils/poster-invite');
const treePosterFlow = require('../../utils/tree-poster-flow');
const subscribeNotifications = require('../../utils/subscribe-notifications');

const MAX_INTERACTIVE_NODES = 80;

Page({
  data: {
    selectedKinship: null,
    loading: true,
    loadError: '',
    accountPending: false,
    currentFamily: null,
    familyList: [],
    currentRole: 'viewer',
    canEdit: false,
    rawPersons: [],
    rawRelations: [],
    relationRevision: 0,
    nodes: [],
    lines: [],
    junctions: [],
    crossings: [],
    graphRendering: false,
    renderedCount: 0,
    totalVisibleCount: 0,
    hiddenBranchCount: 0,
    canExpandAll: false,
    collapsedPersonIds: [],
    canvasWidth: 750,
    canvasHeight: 900,
    graphScale: 1,
    graphX: 0,
    graphY: 0,
    graphZoomClass: 'zoom-detail',
    graphScaleMin: 0.32,
    pageOrientation: 'portrait',
    isLandscape: false,
    orientationChanging: false,
    nameLayout: 'horizontal',
    showChildRankBadge: false,
    showGenderBadge: false,
    showGenderColors: true,
    autoCollapseEnabled: true,
    viewMode: 'full',
    viewpointId: '',
    viewpointName: '',
    selectedPersonId: '',
    selectedPerson: null,
    showMemberSheet: false,
    memberAdUnitId: '',
    memberAdVisible: false,
    showFamilySheet: false,
    showPerspectiveSheet: false,
    showChildOrderSheet: false,
    childOrderParent: null,
    childOrderItems: [],
    childOrderDirty: false,
    childOrderSaving: false,
    showShareSheet: false,
    perspectiveKeyword: '',
    perspectiveResults: [],
    shareRole: 'member',
    shareMode: 'full',
    sharePersonId: '',
    sharePersonName: '',
    shareReady: false,
    shareCreating: false,
    shareCard: null,
    systemShareCard: shareCard.create({ kind: 'discovery' }),
    posterGenerating: false,
    showShareReminder: false,
    notificationTemplates: null
  },

  onShow: function () {
    if (app.refreshPendingBadge) app.refreshPendingBadge().catch(function () {});
    this.resetPageOrientation();
    const pendingView = app.consumePendingView();
    this.loadPage(pendingView);
    this.loadNotificationTemplates();
    this.syncPageOrientationSoon();
  },

  loadNotificationTemplates: function () {
    const self = this;
    return subscribeNotifications.loadTemplates().then(function (templates) {
      self.setData({ notificationTemplates: templates });
    }).catch(function () {});
  },

  requestNotifications: function (options) {
    const silent = options && options.silent === true;
    subscribeNotifications.request(this.data.notificationTemplates, this.data.currentRole === 'admin').then(function (result) {
      if (!silent) subscribeNotifications.showResult(result);
    });
  },

  onHide: function () {
    this.flushGraphPreference();
    treePosterFlow.cancel(this);
    this.resetPageOrientation();
  },

  onUnload: function () {
    this.flushGraphPreference();
    if (this._perspectiveFilterTimer) clearTimeout(this._perspectiveFilterTimer);
    treePosterFlow.cancel(this);
    if (this._graphSettleTimer) clearTimeout(this._graphSettleTimer);
    if (this._orientationTimer) clearTimeout(this._orientationTimer);
    this.syncPageChrome(false);
  },

  onPullDownRefresh: function () {
    this.loadPage(null, { force: true }).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  loadPage: function (pendingView, options) {
    const self = this;
    const config = options || {};
    const requestId = this._loadRequestId = (this._loadRequestId || 0) + 1;
    const returnFocus = this._relationReturnFocus;
    this._relationReturnFocus = null;
    const hasContent = this._hasLoaded && !this.data.loading;
    const familyIsFresh = app.isCacheFresh('familyPages', false);
    const currentFamily = app.getCurrentFamily();
    const graphIsFresh = currentFamily && app.isCacheFresh('graph', currentFamily._id);
    if (!config.force && !pendingView && hasContent && familyIsFresh && (!currentFamily || graphIsFresh)) {
      return Promise.resolve();
    }
    if (!hasContent) this.setData({ loading: true, loadError: '' });
    else this.setData({ loadError: '' });
    return app.loadFamilies(config).then(function (families) {
      if (requestId !== self._loadRequestId) return null;
      const currentFamily = app.getCurrentFamily();
      self.setData({
        familyList: families,
        currentFamily: currentFamily,
        accountPending: app.globalData.accountState === 'pending_delete',
        loading: false
      });
      self.syncPageChrome(self.data.isLandscape);
      if (!currentFamily) {
        self._hasLoaded = true;
        return null;
      }
      return app.getGraph(currentFamily._id, config).then(function (data) {
        if (requestId !== self._loadRequestId) return null;
        const persons = (data.persons || []).map(function (person) {
          return personGender.decorate(Object.assign({}, person, {
            avatar: '',
            initial: (person.name || '家').slice(0, 1),
            metaText: personDate.fromPerson(person, 'birth').year ? personDate.fromPerson(person, 'birth').year + '年' : ''
          }));
        });
        let mode = self.data.viewMode;
        let personId = self.data.viewpointId;
        if (pendingView) {
          mode = pendingView.mode || 'full';
          personId = pendingView.personId || '';
        }
        if (mode === 'perspective' && !persons.some(function (person) { return person._id === personId; })) {
          mode = 'full';
          personId = '';
        }
        const preference = data.preference || {};
        const autoCollapseEnabled = preference.autoCollapseEnabled !== false;
        let collapsedPersonIds = self.data.collapsedPersonIds;
        if (self._autoCollapseFamilyId !== data.family._id || self.data.autoCollapseEnabled !== autoCollapseEnabled) {
          collapsedPersonIds = autoCollapseEnabled
            ? graphLayout.suggestCollapsedIds(persons, data.relations || [], { limit: 36, focusId: personId })
            : [];
          self._autoCollapseFamilyId = data.family._id;
        }
        const nameLayout = preference.nameLayout === 'vertical' ? 'vertical' : 'horizontal';
        self.setData({
          currentFamily: data.family,
          currentRole: data.currentRole,
          canEdit: data.currentRole === 'admin' || data.currentRole === 'member',
          showShareReminder: self.shouldShowShareReminder(data.family),
          rawPersons: persons,
          rawRelations: data.relations || [],
          relationRevision: Number(data.relationRevision || 0),
          loading: false,
          nameLayout: nameLayout,
          showChildRankBadge: preference.showChildRankBadge === true,
          showGenderBadge: preference.showGenderBadge === true,
          showGenderColors: preference.showGenderColors !== false,
          autoCollapseEnabled: autoCollapseEnabled,
          viewMode: mode,
          viewpointId: personId,
          collapsedPersonIds: collapsedPersonIds,
          selectedPersonId: ''
        });
        self.syncPageChrome(self.data.isLandscape);
        shareCard.createAndRender(self, 'tree-share-card', { kind: 'discovery' }).then(function (card) {
          self.setData({ systemShareCard: card });
        });
        app.setCurrentFamily(data.family);
        const focusPersonId = !pendingView && returnFocus && returnFocus.familyId === data.family._id
          && persons.some(function (person) { return person._id === returnFocus.personId; }) ? returnFocus.personId : '';
        self.renderGraph(mode, personId, { nameLayout: nameLayout, focusPersonId: focusPersonId });
        self._hasLoaded = true;
        const tourKey = 'youpu_new_family_tour_' + data.family._id;
        if (wx.getStorageSync(tourKey)) {
          wx.removeStorageSync(tourKey);
          setTimeout(function () {
            wx.showModal({
              title: '这是你的第一张家谱',
              content: '拖动和缩放查看关系；点击一位家人可以查看资料、添加亲属。完成后到“家庭”页邀请家人一起补全。',
              confirmText: '开始看看',
              showCancel: false
            });
          }, 280);
        }
        const familyId = data.family._id;
        return api.getMediaUrls(persons.map(function (person) { return person.avatarAssetId; })).then(function (urls) {
          if (requestId !== self._loadRequestId) return data;
          if (!self.data.currentFamily || self.data.currentFamily._id !== familyId) return data;
          const resolvedPersons = persons.map(function (person) {
            return Object.assign({}, person, { avatar: urls[person.avatarAssetId] || '' });
          });
          const resolvedById = {};
          resolvedPersons.forEach(function (person) { resolvedById[person._id] = person; });
          const resolvedNodes = self.data.nodes.map(function (node) {
            return Object.assign({}, node, { avatar: resolvedById[node._id] ? resolvedById[node._id].avatar : '' });
          });
          self.setData({ rawPersons: resolvedPersons, nodes: resolvedNodes });
          return data;
        });
      });
    }).catch(function (error) {
      if (requestId !== self._loadRequestId) return;
      console.error('加载家谱失败', error);
      if (!hasContent) self.setData({ loading: false, loadError: api.userMessage(error, '家谱加载失败') });
      else console.warn('后台刷新家谱失败，保留当前内容', error);
    });
  },

  shouldShowShareReminder: function (family) {
    return Boolean(family
      && family.currentRole === 'admin'
      && Number(family.personCount || 0) >= 3
      && !family.sharedAt
      && !family.shareReminderDismissedAt);
  },

  renderGraph: function (mode, viewpointId, renderOptions) {
    const optionsValue = renderOptions || {};
    const collapsedIds = optionsValue.collapsedPersonIds || this.data.collapsedPersonIds;
    const nameLayout = optionsValue.nameLayout === 'vertical' ? 'vertical' : optionsValue.nameLayout === 'horizontal' ? 'horizontal' : this.data.nameLayout;
    const selectedPersonId = Object.prototype.hasOwnProperty.call(optionsValue, 'selectedPersonId')
      ? optionsValue.selectedPersonId
      : this.data.selectedPersonId;
    if (!this._kinshipCache) this._kinshipCache = kinship.createKinshipCache();
    const kinshipDetails = mode === 'perspective' ? this._kinshipCache(this.data.rawPersons, this.data.rawRelations, viewpointId) : {};
    const result = graphLayout.layoutGraph(
      this.data.rawPersons,
      this.data.rawRelations,
      {
        mode: mode,
        viewpointId: viewpointId,
        nameLayout: nameLayout,
        collapsedIds: collapsedIds,
        selectedPersonId: selectedPersonId,
        kinshipDetails: kinshipDetails
      }
    );
    const viewpoint = this.data.rawPersons.find(function (person) {
      return person._id === viewpointId;
    });
    const self = this;
    this._lastLayout = result;
    const patch = Object.assign({
      selectedKinship: this.data.showMemberSheet ? kinship.memberKinshipCard(kinshipDetails, selectedPersonId, viewpoint ? viewpoint.name : '', this.data.rawPersons) : null,
      nodes: result.nodes,
      lines: result.lines,
      junctions: result.junctions || [],
      crossings: result.crossings || [],
      canvasWidth: result.width,
      canvasHeight: result.height,
      viewpointName: viewpoint ? viewpoint.name : '',
      graphRendering: false,
      renderedCount: result.nodes.length,
      totalVisibleCount: result.nodes.length,
      hiddenBranchCount: result.hiddenCount || 0,
      canExpandAll: (result.hiddenCount || 0) > 0 && this.data.rawPersons.length <= MAX_INTERACTIVE_NODES
    }, optionsValue.statePatch || {});
    this.setData(patch, function () {
      if (optionsValue.preserveViewport) return;
      if (optionsValue.focusPersonId && result.nodes.some(function (node) { return node._id === optionsValue.focusPersonId; })) {
        self.fitGraph(optionsValue.focusPersonId, false, { minimumFocusScale: 0.6 });
      } else if (mode === 'perspective' && viewpointId) {
        self.fitGraph(viewpointId, false, { minimumFocusScale: 0.6 });
      } else {
        self.fitGraph('', true);
      }
    });
  },

  getGraphTransform: function () {
    return {
      scale: typeof this._currentGraphScale === 'number' ? this._currentGraphScale : this.data.graphScale,
      x: typeof this._currentGraphX === 'number' ? this._currentGraphX : this.data.graphX,
      y: typeof this._currentGraphY === 'number' ? this._currentGraphY : this.data.graphY
    };
  },

  commitGraphTransform: function (transform) {
    this._currentGraphScale = transform.scale;
    this._currentGraphX = transform.x;
    this._currentGraphY = transform.y;
    this.setData({
      graphScale: transform.scale,
      graphX: transform.x,
      graphY: transform.y,
      graphZoomClass: graphViewport.zoomClassForScale(this.getGraphDisplayScale(transform.scale), this.data.graphZoomClass)
    });
  },

  getGraphDisplayScale: function (scale) {
    return scale * graphViewport.MIN_SCALE / (this.data.graphScaleMin || graphViewport.MIN_SCALE);
  },

  getGraphViewport: function () {
    const info = this.getWindowSize();
    const width = info.windowWidth || 375;
    if (this._graphViewport && this._graphViewport.windowWidth === width) return this._graphViewport;
    const rpxToPx = width / 750;
    const isLandscape = width > (info.windowHeight || 667);
    return {
      width: width,
      height: Math.max(isLandscape ? 120 : 240, (info.windowHeight || 667) - (isLandscape ? 0 : 112 * rpxToPx)),
      rpxToPx: rpxToPx,
      windowWidth: width
    };
  },

  getWindowSize: function () {
    try {
      return wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (error) {
      return { windowWidth: 375, windowHeight: 667 };
    }
  },

  fitGraph: function (focusPersonId, fitAll, fitOptions) {
    const layout = this._lastLayout;
    if (!layout || !layout.nodes.length) return;
    const viewport = this.getGraphViewport();
    const optionsValue = fitOptions || {};
    const transform = graphViewport.fitTransform(layout, viewport, {
      fitAll: fitAll,
      focusPersonId: focusPersonId,
      currentScale: this.getGraphTransform().scale,
      minimumScale: this.data.graphScaleMin,
      minimumFocusScale: (optionsValue.minimumFocusScale || 0) * this.data.graphScaleMin / graphViewport.MIN_SCALE
    });
    this.commitGraphTransform(transform);
  },

  fitWholeGraph: function () {
    this.fitGraph('', true);
  },

  locateGraphFocus: function () {
    const focusId = this.data.selectedPersonId || this.data.viewpointId;
    if (focusId) this.fitGraph(focusId, false, { minimumFocusScale: 0.68 });
    else this.fitGraph('', true);
  },

  changeGraphScale: function (delta) {
    const current = this.getGraphTransform();
    const normalizedDelta = delta * this.data.graphScaleMin / graphViewport.MIN_SCALE;
    const next = Math.round((current.scale + normalizedDelta) * 100) / 100;
    const transform = graphViewport.zoomAroundCenter(current, next, this.getGraphViewport(), {
      minimumScale: this.data.graphScaleMin
    });
    this.commitGraphTransform(transform);
  },

  zoomGraphIn: function () {
    this.changeGraphScale(0.15);
  },

  zoomGraphOut: function () {
    this.changeGraphScale(-0.15);
  },

  resetPageOrientation: function () {
    this._orientationResizeSequence = (this._orientationResizeSequence || 0) + 1;
    if (this._orientationTimer) clearTimeout(this._orientationTimer);
    this._orientationTimer = null;
    const needsReset = this.data.pageOrientation !== 'portrait' || this.data.isLandscape || this.data.orientationChanging;
    if (needsReset) {
      if (!this._orientationViewport) this._orientationViewport = this.getGraphViewport();
      if (!this._orientationTransform) this._orientationTransform = this.getGraphTransform();
      this._orientationTarget = 'portrait';
      this.setData({ pageOrientation: 'portrait', isLandscape: false, orientationChanging: false });
    }
    this.syncPageChrome(false);
  },

  syncPageChrome: function (isLandscape) {
    if (typeof wx === 'undefined') return;
    const familyName = this.data.currentFamily && this.data.currentFamily.name;
    if (wx.setNavigationBarTitle) {
      wx.setNavigationBarTitle({ title: isLandscape && familyName ? familyName : '有谱' });
    }
    if (isLandscape) {
      if (wx.hideTabBar) wx.hideTabBar({ animation: false });
    } else if (wx.showTabBar) {
      wx.showTabBar({ animation: false });
    }
  },

  syncPageOrientationSoon: function () {
    const self = this;
    setTimeout(function () {
      const size = self.getWindowSize();
      if (self._orientationViewport && size.windowWidth <= size.windowHeight) self.applyPageResize(size);
    }, 80);
  },

  togglePageOrientation: function () {
    if (this.data.orientationChanging) return;
    const target = this.data.isLandscape ? 'portrait' : 'landscape';
    this._orientationViewport = this.getGraphViewport();
    this._orientationTransform = this.getGraphTransform();
    this._orientationTarget = target;
    this.setData({ pageOrientation: target, orientationChanging: true });
    const self = this;
    if (this._orientationTimer) clearTimeout(this._orientationTimer);
    this._orientationTimer = setTimeout(function () {
      self._orientationTimer = null;
      const size = self.getWindowSize();
      const actual = size.windowWidth > size.windowHeight ? 'landscape' : 'portrait';
      if (actual === target) {
        self.applyPageResize(size);
        return;
      }
      self._orientationViewport = null;
      self._orientationTransform = null;
      self._orientationTarget = '';
      self._graphViewport = null;
      self._orientationResizeSequence = (self._orientationResizeSequence || 0) + 1;
      self.setData({
        pageOrientation: actual,
        isLandscape: actual === 'landscape',
        orientationChanging: false,
        graphScaleMin: graphViewport.minimumScaleForViewport({ rpxToPx: (size.windowWidth || 375) / 750 })
      });
      self.syncPageChrome(actual === 'landscape');
      wx.showToast({ title: '屏幕方向切换失败，请重试', icon: 'none' });
    }, 1200);
  },

  onPageResize: function (event) {
    const size = event && event.detail && event.detail.size;
    if (!size) return;
    this.applyPageResize(size);
  },

  applyPageResize: function (size) {
    const resizeSequence = (this._orientationResizeSequence || 0) + 1;
    this._orientationResizeSequence = resizeSequence;
    const width = Number(size.windowWidth) || 375;
    const height = Number(size.windowHeight) || 667;
    const actual = width > height ? 'landscape' : 'portrait';
    const provisionalViewport = { width: width, height: height, rpxToPx: width / 750 };
    const minimumScale = graphViewport.minimumScaleForViewport(provisionalViewport);
    const previousViewport = this._orientationViewport || this._graphViewport;
    const previousTransform = this._orientationTransform || this.getGraphTransform();
    const target = this._orientationTarget;
    const settled = !target || target === actual;
    this.syncPageChrome(actual === 'landscape');
    if (settled && this._orientationTimer) clearTimeout(this._orientationTimer);
    if (settled) this._orientationTimer = null;
    const self = this;
    this.setData({
      pageOrientation: target || actual,
      isLandscape: actual === 'landscape',
      orientationChanging: Boolean(target && !settled),
      graphScaleMin: minimumScale
    }, function () {
      if (resizeSequence !== self._orientationResizeSequence) return;
      const measure = function () {
        self.measureGraphViewport({ windowWidth: width, windowHeight: height }, function (nextViewport) {
          if (resizeSequence !== self._orientationResizeSequence) return;
          self._graphViewport = nextViewport;
          if (self._lastLayout && self._lastLayout.nodes.length) {
            if (previousViewport) {
              self.commitGraphTransform(graphViewport.resizeTransform(previousTransform, previousViewport, nextViewport, {
                minimumScale: minimumScale
              }));
            } else {
              self.fitGraph(self.data.selectedPersonId || self.data.viewpointId, !(self.data.selectedPersonId || self.data.viewpointId));
            }
          }
          if (settled) {
            self._orientationViewport = null;
            self._orientationTransform = null;
            self._orientationTarget = '';
          }
        });
      };
      if (wx.nextTick) wx.nextTick(measure); else setTimeout(measure, 0);
    });
  },

  measureGraphViewport: function (size, callback) {
    const width = Number(size.windowWidth) || 375;
    const height = Number(size.windowHeight) || 667;
    const fallback = {
      width: width,
      height: Math.max(width > height ? 120 : 240, height - (width > height ? 0 : 112 * width / 750)),
      rpxToPx: width / 750,
      windowWidth: width
    };
    const query = this.createSelectorQuery ? this.createSelectorQuery() : wx.createSelectorQuery();
    query.select('.graph-viewport').boundingClientRect();
    query.exec(function (result) {
      const rect = result && result[0];
      callback(rect && rect.width && rect.height ? {
        width: rect.width,
        height: rect.height,
        rpxToPx: width / 750,
        windowWidth: width
      } : fallback);
    });
  },

  openDisplaySettings: function () {
    const family = this.data.currentFamily;
    if (!family) return;
    wx.navigateTo({ url: '/pages/display-settings/index?familyId=' + encodeURIComponent(family._id) });
  },

  generatePoster: function () {
    const family = this.data.currentFamily;
    if (!family || this.data.posterGenerating || !this.data.nodes.length) return;
    const ownerId = (app.globalData.user || {})._id || '';
    const page = this;
    treePosterFlow.generate(this, {
      canvasId: 'tree-poster-canvas',
      familyName: family.name,
      prepareCode: function () {
        return posterInvite.get({
          ownerId: ownerId,
          familyId: family._id,
          viewMode: page.data.viewMode,
          viewPersonId: page.data.viewpointId
        });
      },
      onPrepared: function (invitation) {
        api.call('share.record', { stage: 'prepared', invitationId: invitation.invitationId }).catch(function () {});
      },
      sharePayload: function (invitation) {
        return { invitationId: invitation.invitationId };
      },
      entrancePath: function (invitation) {
        return '/pages/invite/index?token=' + encodeURIComponent(invitation.token);
      }
    });
  },

  saveGraphPreference: function (family, nameLayout, viewMode, personId) {
    if (!family) return;
    this._pendingGraphPreference = {
      familyId: family._id,
      viewMode: viewMode || this.data.viewMode,
      personId: personId === undefined ? this.data.viewpointId : personId,
      nameLayout: nameLayout || this.data.nameLayout
    };
    if (this._graphPreferenceTimer) clearTimeout(this._graphPreferenceTimer);
    const self = this;
    this._graphPreferenceTimer = setTimeout(function () {
      self._graphPreferenceTimer = null;
      self.flushGraphPreference();
    }, 500);
  },

  flushGraphPreference: function () {
    if (this._graphPreferenceTimer) clearTimeout(this._graphPreferenceTimer);
    this._graphPreferenceTimer = null;
    if (this._graphPreferenceInFlight || !this._pendingGraphPreference) return this._graphPreferenceInFlight || Promise.resolve();
    const payload = this._pendingGraphPreference;
    this._pendingGraphPreference = null;
    if (JSON.stringify(payload) === this._lastSavedGraphPreference) return Promise.resolve();
    const self = this;
    this._graphPreferenceInFlight = api.call('family.setPreference', payload).then(function (data) {
      self._lastSavedGraphPreference = JSON.stringify(payload);
      if (data.preference) app.updatePreference(payload.familyId, data.preference);
    }).catch(function () {
      // A failed preference write leaves the last confirmed cache untouched.
    }).then(function () {
      self._graphPreferenceInFlight = null;
      if (self._pendingGraphPreference) return self.flushGraphPreference();
    });
    return this._graphPreferenceInFlight;
  },

  onGraphScale: function (event) {
    const scale = event.detail.scale;
    if (!scale) return;
    this._currentGraphScale = scale;
    this.scheduleGraphSettle();
  },

  onGraphChange: function (event) {
    if (typeof event.detail.x === 'number') this._currentGraphX = event.detail.x;
    if (typeof event.detail.y === 'number') this._currentGraphY = event.detail.y;
    this.scheduleGraphSettle();
  },

  scheduleGraphSettle: function () {
    const self = this;
    if (this._graphSettleTimer) clearTimeout(this._graphSettleTimer);
    this._graphSettleTimer = setTimeout(function () {
      self._graphSettleTimer = null;
      const scale = self.getGraphDisplayScale(self.getGraphTransform().scale);
      const nextClass = graphViewport.zoomClassForScale(scale, self.data.graphZoomClass);
      if (nextClass !== self.data.graphZoomClass) self.setData({ graphZoomClass: nextClass });
    }, 160);
  },

  expandAllBranches: function () {
    if (this.data.autoCollapseEnabled && this.data.rawPersons.length > MAX_INTERACTIVE_NODES) {
      wx.showToast({ title: '家谱较大，请按分支展开', icon: 'none' });
      return;
    }
    this.renderGraph(this.data.viewMode, this.data.viewpointId, {
      collapsedPersonIds: [],
      statePatch: { collapsedPersonIds: [] }
    });
  },

  expandBranch: function (event) {
    const personId = event.currentTarget.dataset.id;
    let collapsed = this.data.collapsedPersonIds.filter(function (id) { return id !== personId; });
    if (this.data.autoCollapseEnabled && this.data.rawPersons.length > MAX_INTERACTIVE_NODES) {
      collapsed = graphLayout.suggestCollapsedIds(this.data.rawPersons, this.data.rawRelations, {
        limit: MAX_INTERACTIVE_NODES,
        focusId: personId
      });
    }
    this.renderGraph(this.data.viewMode, this.data.viewpointId, {
      collapsedPersonIds: collapsed,
      statePatch: { collapsedPersonIds: collapsed }
    });
  },

  openCreateFamily: function () {
    wx.navigateTo({ url: '/pages/create-family/index' });
  },

  openExamples: function () {
    this.setData({ showFamilySheet: false });
    wx.navigateTo({ url: '/pages/examples/index' });
  },

  showAcceptInviteHelp: function () {
    wx.showModal({
      title: '接受家人邀请',
      content: '请从家庭微信群中打开家人发送的“有谱”邀请卡片。打开后会先显示家谱信息，再由你确认加入。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  openPrivacy: function () {
    wx.navigateTo({ url: '/pages/privacy/index' });
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
    this.flushGraphPreference();
    app.setCurrentFamily(family);
    this.setData({
      showFamilySheet: false,
      viewMode: 'full',
      viewpointId: '',
      viewpointName: '',
      collapsedPersonIds: [],
      selectedPersonId: ''
    });
    this._autoCollapseFamilyId = '';
    this.loadPage({ mode: 'full', personId: '' });
  },

  showPerson: function (event) {
    const personId = event.currentTarget.dataset.id;
    const person = this.data.rawPersons.find(function (item) { return item._id === personId; });
    if (!person) return;
    if (this.data.selectedPersonId === personId) {
      this.openMemberActions(event);
      return;
    }
    this.renderGraph(this.data.viewMode, this.data.viewpointId, {
      preserveViewport: true,
      selectedPersonId: personId,
      statePatch: {
        selectedPersonId: personId,
        selectedPerson: this.decorateSelectedPerson(person),
        showMemberSheet: false
      }
    });
  },

  openMemberActions: function (event) {
    const personId = event.currentTarget.dataset.id;
    const person = this.data.rawPersons.find(function (item) { return item._id === personId; });
    if (!person) return;
    const memberAdUnitId = commerceConfig.resolveBanner(app.globalData && app.globalData.environment, 'memberSheet');
    const family = this.data.currentFamily;
    this.setData({
      selectedKinship: this.data.viewMode === 'perspective' ? kinship.memberKinshipCard(this._lastLayout && this._lastLayout.kinshipDetails, personId, this.data.viewpointName, this.data.rawPersons) : null,
      selectedPersonId: personId,
      selectedPerson: this.decorateSelectedPerson(person),
      showMemberSheet: true,
      memberAdUnitId: memberAdUnitId,
      memberAdVisible: Boolean(memberAdUnitId && family && !(family.membership && family.membership.active))
    });
  },

  decorateSelectedPerson: function (person) {
    const node = (this._lastLayout && this._lastLayout.nodes || []).find(function (item) {
      return item._id === person._id;
    });
    return Object.assign({}, person, node ? {
      childRankLabel: node.childRankLabel || '',
      childRankBasisText: node.childRankBasisText || '',
      childRankConflict: Boolean(node.childRankConflict)
    } : {}, memberActions.describe(person, this.data.rawPersons, this.data.rawRelations), {
      isCollapsed: this.data.collapsedPersonIds.indexOf(person._id) >= 0
    });
  },

  clearGraphSelection: function () {
    if (!this.data.selectedPersonId || this.data.showMemberSheet) return;
    this.renderGraph(this.data.viewMode, this.data.viewpointId, {
      preserveViewport: true,
      selectedPersonId: '',
      statePatch: { selectedPersonId: '', selectedPerson: null }
    });
  },

  closeMemberSheet: function () {
    this.setData({ showMemberSheet: false, selectedKinship: null });
  },

  childOrderRows: function (orderedIds) {
    const self = this;
    const relationsByChild = {};
    this.data.rawRelations.forEach(function (relation) {
      if (relation.type === 'parent_child' && self.data.childOrderParent && relation.fromPersonId === self.data.childOrderParent._id) {
        relationsByChild[relation.toPersonId] = relation;
      }
    });
    const rows = orderedIds.map(function (personId) {
      const person = self.data.rawPersons.find(function (item) { return item._id === personId; });
      return person ? { person: person, relation: relationsByChild[personId] || {} } : null;
    }).filter(Boolean);
    const genderCounts = { male: 0, female: 0 };
    return rows.map(function (row, index) {
      const gender = row.person.gender;
      let label = '排行待确认';
      if (gender === 'male' || gender === 'female') {
        genderCounts[gender] += 1;
        label = childRank.rankLabel(gender, genderCounts[gender]);
      }
      return Object.assign({}, personGender.decorate(row.person), {
        initial: (row.person.name || '家').slice(0, 1),
        birthDateText: personDate.display(row.person, 'birth'),
        rankLabel: label,
        canMoveUp: index > 0 && childRank.canSwap(row, rows[index - 1]),
        canMoveDown: index < rows.length - 1 && childRank.canSwap(row, rows[index + 1])
      });
    });
  },

  openChildOrderSheet: function () {
    const parent = this.data.selectedPerson;
    if (!parent || !this.data.canEdit) return;
    const rankData = childRank.build(this.data.rawPersons, this.data.rawRelations);
    const orderedIds = rankData.parentOrders[parent._id] || [];
    if (orderedIds.length < 2) {
      wx.showToast({ title: '至少有两个孩子才需要排行', icon: 'none' });
      return;
    }
    this.setData({
      showMemberSheet: false,
      showChildOrderSheet: true,
      childOrderParent: parent,
      childOrderItems: []
    });
    this._childOrderOriginalIds = orderedIds.slice();
    this._childOrderIds = orderedIds.slice();
    this.setData({ childOrderItems: this.childOrderRows(this._childOrderIds), childOrderDirty: false });
  },

  closeChildOrderSheet: function () {
    if (this.data.childOrderSaving) return;
    this._childOrderIds = [];
    this._childOrderOriginalIds = [];
    this.setData({
      showChildOrderSheet: false,
      childOrderParent: null,
      childOrderItems: [],
      childOrderDirty: false
    });
  },

  moveChildOrder: function (event) {
    if (this.data.childOrderSaving) return;
    const personId = event.currentTarget.dataset.id;
    const direction = event.currentTarget.dataset.direction;
    const ids = (this._childOrderIds || []).slice();
    const index = ids.indexOf(personId);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const rows = this.childOrderRows(ids);
    if (!childRank.canSwap(
      { person: rows[index], relation: {} },
      { person: rows[target], relation: {} }
    )) {
      wx.showToast({ title: '两人出生日期已确定先后', icon: 'none' });
      return;
    }
    const swap = ids[index];
    ids[index] = ids[target];
    ids[target] = swap;
    this._childOrderIds = ids;
    this.setData({
      childOrderItems: this.childOrderRows(ids),
      childOrderDirty: ids.join('|') !== (this._childOrderOriginalIds || []).join('|')
    });
  },

  saveChildOrder: function () {
    const self = this;
    const parent = this.data.childOrderParent;
    if (!parent || !this.data.childOrderDirty || this.data.childOrderSaving) return;
    this.setData({ childOrderSaving: true });
    return api.call('relation.reorderChildren', {
      familyId: this.data.currentFamily._id,
      parentPersonId: parent._id,
      orderedChildIds: (this._childOrderIds || []).slice(),
      relationRevision: this.data.relationRevision
    }).then(function (data) {
      wx.showToast({ title: data.pending ? '已提交管理员审核' : '子女排行已更新', icon: data.pending ? 'none' : 'success' });
      if (data.pending && app.refreshPendingBadge) app.refreshPendingBadge({ force: true }).catch(function () {});
      self.setData({ childOrderSaving: false });
      self.closeChildOrderSheet();
      if (!data.pending) {
        app.invalidateFamilyData(self.data.currentFamily._id);
        return self.loadPage(null, { force: true });
      }
      return data;
    }).catch(function (error) {
      self.setData({ childOrderSaving: false });
      wx.showToast({ title: api.userMessage(error, '排行保存失败'), icon: 'none' });
    });
  },

  useSelectedPerspective: function () {
    const person = this.data.selectedPerson;
    if (!person) return;
    this.setPerspective(person._id);
    this.closeMemberSheet();
  },

  openPerspectiveSheet: function () {
    this.setData({
      showPerspectiveSheet: true,
      perspectiveKeyword: '',
      perspectiveResults: this.data.rawPersons
    });
  },

  closePerspectiveSheet: function () {
    this.setData({ showPerspectiveSheet: false });
  },

  filterPerspectives: function (event) {
    const keyword = event.detail.value.trim();
    this.setData({ perspectiveKeyword: keyword });
    if (this._perspectiveFilterTimer) clearTimeout(this._perspectiveFilterTimer);
    const self = this;
    this._perspectiveFilterTimer = setTimeout(function () {
      self._perspectiveFilterTimer = null;
      self.setData({ perspectiveResults: self.data.rawPersons.filter(function (person) {
        return !keyword || person.name.indexOf(keyword) >= 0;
      }) });
    }, 120);
  },

  selectPerspective: function (event) {
    this.setPerspective(event.currentTarget.dataset.id);
    this.closePerspectiveSheet();
  },

  setPerspective: function (personId) {
    const family = this.data.currentFamily;
    if (!family) return;
    const expandedIds = graphLayout.expandCollapsedIds(
      this.data.rawPersons,
      this.data.rawRelations,
      this.data.collapsedPersonIds,
      personId
    );
    this.renderGraph('perspective', personId, {
      collapsedPersonIds: expandedIds,
      selectedPersonId: '',
      statePatch: {
        viewMode: 'perspective',
        viewpointId: personId,
        collapsedPersonIds: expandedIds,
        selectedPersonId: '',
        selectedPerson: null
      }
    });
    this.saveGraphPreference(family, this.data.nameLayout, 'perspective', personId);
  },

  showFullGraph: function () {
    const family = this.data.currentFamily;
    this.renderGraph('full', '', {
      selectedPersonId: '',
      statePatch: {
        viewMode: 'full',
        viewpointId: '',
        viewpointName: '',
        selectedPersonId: '',
        selectedPerson: null
      }
    });
    if (family) this.saveGraphPreference(family, this.data.nameLayout, 'full', '');
  },

  openMemberDetail: function () {
    const person = this.data.selectedPerson;
    if (!person) return;
    this.closeMemberSheet();
    wx.navigateTo({ url: '/pages/member-detail/index?id=' + person._id });
  },

  toggleSelectedBranch: function () {
    const person = this.data.selectedPerson;
    if (!person) return;
    const collapsed = this.data.collapsedPersonIds.slice();
    const index = collapsed.indexOf(person._id);
    if (index >= 0) collapsed.splice(index, 1);
    else collapsed.push(person._id);
    this.renderGraph(this.data.viewMode, this.data.viewpointId, {
      collapsedPersonIds: collapsed,
      selectedPersonId: '',
      statePatch: {
        collapsedPersonIds: collapsed,
        selectedPersonId: '',
        showMemberSheet: false,
        selectedPerson: null
      }
    });
  },

  chooseRelation: function (event) {
    const person = this.data.selectedPerson;
    const relationType = event.currentTarget.dataset.type;
    if (!person || !this.data.canEdit || !person.relationOptions.some(function (option) { return option.key === relationType; })) return;
    this._relationReturnFocus = { familyId: this.data.currentFamily._id, personId: person._id };
    this.closeMemberSheet();
    wx.navigateTo({
      url: '/pages/add-member/index?familyId=' + this.data.currentFamily._id + '&anchorId=' + person._id + '&anchorName=' + encodeURIComponent(person.name) + '&relationType=' + relationType
    });
  },

  hideMemberAd: function () {
    this.setData({ memberAdVisible: false });
  },

  startShare: function () {
    this.openShareSheet(this.data.viewMode, this.data.viewpointId, this.data.viewpointName);
  },

  dismissShareReminder: function () {
    const self = this;
    const family = this.data.currentFamily;
    if (!family || !this.data.showShareReminder) return;
    api.call('family.dismissShareReminder', { familyId: family._id }).then(function () {
      const updatedFamily = Object.assign({}, family, { shareReminderDismissedAt: new Date().toISOString() });
      app.invalidateFamilyData(family._id);
      app.setCurrentFamily(updatedFamily);
      self.setData({
        showShareReminder: false,
        currentFamily: updatedFamily
      });
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '暂时无法关闭提醒'), icon: 'none' });
    });
  },

  shareSelectedPerson: function () {
    const person = this.data.selectedPerson;
    if (!person) return;
    this.closeMemberSheet();
    this.openShareSheet('perspective', person._id, person.name);
  },

  openShareSheet: function (mode, personId, personName) {
    this._inviteShareStarted = false;
    this.setData({
      showShareSheet: true,
      shareMode: mode || 'full',
      sharePersonId: personId || '',
      sharePersonName: personName || '',
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
      viewMode: this.data.shareMode,
      viewPersonId: this.data.sharePersonId,
      fingerprint: shareCard.fingerprint({
        kind: this.data.shareMode === 'perspective' ? 'family_perspective' : 'family_full',
        familyName: family.name,
        personCount: family.personCount,
        role: this.data.shareRole,
        personName: this.data.sharePersonName,
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
      viewMode: this.data.shareMode,
      viewPersonId: this.data.sharePersonId
    }).then(function (data) {
      app.invalidateInvites(family._id);
      if (sequence !== self._sharePreparationSequence || !self.data.showShareSheet) return;
      return shareCard.createAndRender(self, 'tree-share-card', {
        kind: data.viewMode === 'perspective' ? 'family_perspective' : 'family_full',
        familyName: data.familyName,
        personCount: family.personCount,
        personName: data.viewPersonName,
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
    const card = this.data.shareCard;
    const self = this;
    if (event && event.from === 'button' && card) {
      this._inviteShareStarted = true;
      return {
        title: card.title,
        path: card.path,
        imageUrl: card.imageUrl,
        success: function () {
          api.call('share.record', { stage: 'sent', invitationId: card.invitationId }).catch(function () {});
          if (self.data.currentRole !== 'admin') return;
          api.call('family.markOnboardingShared', {
            familyId: self.data.currentFamily._id,
            invitationId: card.invitationId
          }).then(function () {
            const family = self.data.currentFamily;
            const updatedFamily = Object.assign({}, family, { sharedAt: new Date().toISOString() });
            app.invalidateFamilyData(family._id);
            app.setCurrentFamily(updatedFamily);
            self.setData({ showShareReminder: false, currentFamily: updatedFamily });
            self.loadPage(null, { force: true });
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

  stopEvent: function () {}
});
