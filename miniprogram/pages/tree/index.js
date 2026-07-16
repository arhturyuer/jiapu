const app = getApp();
const api = require('../../utils/api');
const graphLayout = require('../../utils/graph-layout');
const graphViewport = require('../../utils/graph-viewport');

const MAX_INTERACTIVE_NODES = 80;

Page({
  data: {
    loading: true,
    loadError: '',
    accountPending: false,
    currentFamily: null,
    familyList: [],
    currentRole: 'viewer',
    canEdit: false,
    rawPersons: [],
    rawRelations: [],
    nodes: [],
    lines: [],
    junctions: [],
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
    viewMode: 'full',
    viewpointId: '',
    viewpointName: '',
    selectedPersonId: '',
    selectedPerson: null,
    showMemberSheet: false,
    showFamilySheet: false,
    showPerspectiveSheet: false,
    showRelationSheet: false,
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
    relationOptions: [
      { key: 'father', label: '父亲' },
      { key: 'mother', label: '母亲' },
      { key: 'spouse', label: '伴侣' },
      { key: 'son', label: '儿子' },
      { key: 'daughter', label: '女儿' }
    ]
  },

  onShow: function () {
    const pendingView = app.consumePendingView();
    this.loadPage(pendingView);
  },

  onUnload: function () {
    if (this._graphSettleTimer) clearTimeout(this._graphSettleTimer);
  },

  onPullDownRefresh: function () {
    this.loadPage().then(function () {
      wx.stopPullDownRefresh();
    });
  },

  loadPage: function (pendingView) {
    const self = this;
    this.setData({ loading: true, loadError: '' });
    return app.loadFamilies().then(function (families) {
      const currentFamily = app.getCurrentFamily();
      self.setData({
        familyList: families,
        currentFamily: currentFamily,
        accountPending: app.globalData.accountState === 'pending_delete',
        loading: false
      });
      if (!currentFamily) return null;
      return api.call('graph.get', { familyId: currentFamily._id }).then(function (data) {
        const persons = (data.persons || []).map(function (person) {
          return Object.assign({}, person, {
            avatar: '',
            initial: (person.name || '家').slice(0, 1),
            metaText: person.lifeStatus === 'deceased'
              ? '故'
              : person.birthDate
                ? person.birthDate.slice(0, 4) + '年'
                : ''
          });
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
        let collapsedPersonIds = self.data.collapsedPersonIds;
        if (self._autoCollapseFamilyId !== data.family._id) {
          collapsedPersonIds = graphLayout.suggestCollapsedIds(persons, data.relations || [], {
            limit: 36,
            focusId: personId
          });
          self._autoCollapseFamilyId = data.family._id;
        }
        self.setData({
          currentFamily: data.family,
          currentRole: data.currentRole,
          canEdit: data.currentRole === 'admin' || data.currentRole === 'member',
          rawPersons: persons,
          rawRelations: data.relations || [],
          loading: false,
          viewMode: mode,
          viewpointId: personId,
          collapsedPersonIds: collapsedPersonIds,
          selectedPersonId: ''
        });
        app.setCurrentFamily(data.family);
        self.renderGraph(mode, personId);
        const familyId = data.family._id;
        return api.getMediaUrls(persons.map(function (person) { return person.avatarAssetId; })).then(function (urls) {
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
      console.error('加载家谱失败', error);
      self.setData({ loading: false, loadError: error.message || '家谱加载失败' });
    });
  },

  renderGraph: function (mode, viewpointId, renderOptions) {
    const optionsValue = renderOptions || {};
    const collapsedIds = optionsValue.collapsedPersonIds || this.data.collapsedPersonIds;
    const selectedPersonId = Object.prototype.hasOwnProperty.call(optionsValue, 'selectedPersonId')
      ? optionsValue.selectedPersonId
      : this.data.selectedPersonId;
    const result = graphLayout.layoutGraph(
      this.data.rawPersons,
      this.data.rawRelations,
      {
        mode: mode,
        viewpointId: viewpointId,
        collapsedIds: collapsedIds,
        selectedPersonId: selectedPersonId
      }
    );
    const viewpoint = this.data.rawPersons.find(function (person) {
      return person._id === viewpointId;
    });
    const self = this;
    this._lastLayout = result;
    const patch = Object.assign({
      nodes: result.nodes,
      lines: result.lines,
      junctions: result.junctions || [],
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
      if (mode === 'perspective' && viewpointId) {
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
      graphZoomClass: graphViewport.zoomClassForScale(transform.scale, this.data.graphZoomClass)
    });
  },

  getGraphViewport: function () {
    let info = {};
    try {
      info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (error) {
      info = { windowWidth: 375, windowHeight: 667 };
    }
    const width = info.windowWidth || 375;
    const rpxToPx = width / 750;
    return {
      width: width,
      height: Math.max(240, (info.windowHeight || 667) - 232 * rpxToPx),
      rpxToPx: rpxToPx
    };
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
      minimumFocusScale: optionsValue.minimumFocusScale || 0
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
    const next = Math.round((current.scale + delta) * 100) / 100;
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
      const scale = self.getGraphTransform().scale;
      const nextClass = graphViewport.zoomClassForScale(scale, self.data.graphZoomClass);
      if (nextClass !== self.data.graphZoomClass) self.setData({ graphZoomClass: nextClass });
    }, 160);
  },

  expandAllBranches: function () {
    if (this.data.rawPersons.length > MAX_INTERACTIVE_NODES) {
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
    if (this.data.rawPersons.length > MAX_INTERACTIVE_NODES) {
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
        selectedPerson: Object.assign({}, person, {
          isCollapsed: this.data.collapsedPersonIds.indexOf(personId) >= 0
        }),
        showMemberSheet: false
      }
    });
  },

  openMemberActions: function (event) {
    const personId = event.currentTarget.dataset.id;
    const person = this.data.rawPersons.find(function (item) { return item._id === personId; });
    if (!person) return;
    this.setData({
      selectedPersonId: personId,
      selectedPerson: Object.assign({}, person, {
        isCollapsed: this.data.collapsedPersonIds.indexOf(personId) >= 0
      }),
      showMemberSheet: true
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
    this.setData({ showMemberSheet: false });
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
    const results = this.data.rawPersons.filter(function (person) {
      return !keyword || person.name.indexOf(keyword) >= 0;
    });
    this.setData({ perspectiveKeyword: keyword, perspectiveResults: results });
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
    api.call('family.setPreference', {
      familyId: family._id,
      viewMode: 'perspective',
      personId: personId
    }).catch(function () {});
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
    if (family) {
      api.call('family.setPreference', {
        familyId: family._id,
        viewMode: 'full',
        personId: ''
      }).catch(function () {});
    }
  },

  openMemberDetail: function () {
    const person = this.data.selectedPerson;
    if (!person) return;
    this.closeMemberSheet();
    wx.navigateTo({ url: '/pages/member-detail/index?id=' + person._id });
  },

  openEditMember: function () {
    const person = this.data.selectedPerson;
    if (!person) return;
    this.closeMemberSheet();
    wx.navigateTo({ url: '/pages/edit-member/index?id=' + person._id });
  },

  openRelationSheet: function () {
    if (!this.data.canEdit) {
      wx.showToast({ title: '当前身份只能查看家谱', icon: 'none' });
      return;
    }
    this.setData({ showMemberSheet: false, showRelationSheet: true });
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

  closeRelationSheet: function () {
    this.setData({ showRelationSheet: false, selectedPerson: null });
  },

  chooseRelation: function (event) {
    const person = this.data.selectedPerson;
    const relationType = event.currentTarget.dataset.type;
    if (!person) return;
    this.setData({ showRelationSheet: false, selectedPerson: null });
    wx.navigateTo({
      url: '/pages/add-member/index?familyId=' + this.data.currentFamily._id + '&anchorId=' + person._id + '&anchorName=' + encodeURIComponent(person.name) + '&relationType=' + relationType
    });
  },

  startShare: function () {
    this.openShareSheet(this.data.viewMode, this.data.viewpointId, this.data.viewpointName);
  },

  shareSelectedPerson: function () {
    const person = this.data.selectedPerson;
    if (!person) return;
    this.closeMemberSheet();
    this.openShareSheet('perspective', person._id, person.name);
  },

  openShareSheet: function (mode, personId, personName) {
    this.setData({
      showShareSheet: true,
      shareMode: mode || 'full',
      sharePersonId: personId || '',
      sharePersonName: personName || '',
      shareRole: this.data.currentRole === 'admin' ? 'member' : 'viewer',
      shareReady: false,
      shareCard: null
    });
  },

  closeShareSheet: function () {
    this.setData({ showShareSheet: false, shareReady: false, shareCard: null });
  },

  chooseShareRole: function (event) {
    this.setData({ shareRole: event.currentTarget.dataset.role, shareReady: false });
  },

  prepareShare: function () {
    const self = this;
    if (this.data.shareCreating) return;
    this.setData({ shareCreating: true });
    api.call('invite.create', {
      familyId: this.data.currentFamily._id,
      role: this.data.shareRole,
      viewMode: this.data.shareMode,
      viewPersonId: this.data.sharePersonId
    }).then(function (data) {
      const title = data.viewMode === 'perspective'
        ? '从' + data.viewPersonName + '看' + data.familyName
        : data.familyName + '｜一起把家谱补完整';
      self.setData({
        shareReady: true,
        shareCreating: false,
        shareCard: {
          title: title,
          path: '/pages/invite/index?token=' + data.token
        }
      });
    }).catch(function (error) {
      self.setData({ shareCreating: false });
      wx.showToast({ title: error.message || '邀请生成失败', icon: 'none' });
    });
  },

  onShareAppMessage: function () {
    const card = this.data.shareCard;
    if (card) return { title: card.title, path: card.path };
    const family = this.data.currentFamily;
    return {
      title: family ? family.name + '｜有谱' : '有谱｜一家人，共修一份家谱',
      path: '/pages/tree/index'
    };
  },

  stopEvent: function () {}
});
