const app = getApp();
const api = require('../../utils/api');
const graphLayout = require('../../utils/graph-layout');

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
    graphRendering: false,
    renderedCount: 0,
    totalVisibleCount: 0,
    hiddenBranchCount: 0,
    collapsedPersonIds: [],
    canvasWidth: 750,
    canvasHeight: 900,
    viewMode: 'full',
    viewpointId: '',
    viewpointName: '',
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
        self.setData({
          currentFamily: data.family,
          currentRole: data.currentRole,
          canEdit: data.currentRole === 'admin' || data.currentRole === 'member',
          rawPersons: persons,
          rawRelations: data.relations || [],
          loading: false,
          viewMode: mode,
          viewpointId: personId
        });
        app.setCurrentFamily(data.family);
        self.renderGraph(mode, personId);
        return api.getMediaUrls(persons.map(function (person) { return person.avatarAssetId; })).then(function (urls) {
          const resolvedPersons = persons.map(function (person) {
            return Object.assign({}, person, { avatar: urls[person.avatarAssetId] || '' });
          });
          self.setData({ rawPersons: resolvedPersons });
          self.renderGraph(mode, personId);
          return data;
        });
      });
    }).catch(function (error) {
      console.error('加载家谱失败', error);
      self.setData({ loading: false, loadError: error.message || '家谱加载失败' });
    });
  },

  renderGraph: function (mode, viewpointId) {
    const result = graphLayout.layoutGraph(
      this.data.rawPersons,
      this.data.rawRelations,
      {
        mode: mode,
        viewpointId: viewpointId,
        collapsedIds: this.data.collapsedPersonIds
      }
    );
    const viewpoint = this.data.rawPersons.find(function (person) {
      return person._id === viewpointId;
    });
    this._renderVersion = (this._renderVersion || 0) + 1;
    const renderVersion = this._renderVersion;
    const self = this;
    let nodeIndex = 0;
    let lineIndex = 0;
    this.setData({
      nodes: [],
      lines: [],
      canvasWidth: result.width,
      canvasHeight: result.height,
      viewpointName: viewpoint ? viewpoint.name : '',
      graphRendering: result.nodes.length > 0,
      renderedCount: 0,
      totalVisibleCount: result.nodes.length,
      hiddenBranchCount: result.hiddenCount || 0
    });

    function appendBatch() {
      if (self._renderVersion !== renderVersion) return;
      const patch = {};
      const nextNodeIndex = Math.min(nodeIndex + 70, result.nodes.length);
      const nextLineIndex = Math.min(lineIndex + 100, result.lines.length);
      for (let index = nodeIndex; index < nextNodeIndex; index += 1) {
        patch['nodes[' + index + ']'] = result.nodes[index];
      }
      for (let index = lineIndex; index < nextLineIndex; index += 1) {
        patch['lines[' + index + ']'] = result.lines[index];
      }
      nodeIndex = nextNodeIndex;
      lineIndex = nextLineIndex;
      patch.renderedCount = nodeIndex;
      patch.graphRendering = nodeIndex < result.nodes.length || lineIndex < result.lines.length;
      self.setData(patch, function () {
        if (patch.graphRendering) setTimeout(appendBatch, 16);
      });
    }

    if (result.nodes.length) appendBatch();
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
      collapsedPersonIds: []
    });
    this.loadPage({ mode: 'full', personId: '' });
  },

  showPerson: function (event) {
    const personId = event.currentTarget.dataset.id;
    const person = this.data.rawPersons.find(function (item) { return item._id === personId; });
    if (!person) return;
    this.setData({
      selectedPerson: Object.assign({}, person, {
        isCollapsed: this.data.collapsedPersonIds.indexOf(personId) >= 0
      }),
      showMemberSheet: true
    });
  },

  closeMemberSheet: function () {
    this.setData({ showMemberSheet: false, selectedPerson: null });
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
    this.setData({ viewMode: 'perspective', viewpointId: personId });
    this.renderGraph('perspective', personId);
    api.call('family.setPreference', {
      familyId: family._id,
      viewMode: 'perspective',
      personId: personId
    }).catch(function () {});
  },

  showFullGraph: function () {
    const family = this.data.currentFamily;
    this.setData({ viewMode: 'full', viewpointId: '', viewpointName: '' });
    this.renderGraph('full', '');
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
    this.setData({ collapsedPersonIds: collapsed, showMemberSheet: false, selectedPerson: null });
    this.renderGraph(this.data.viewMode, this.data.viewpointId);
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
