const api = require('../../utils/api');
const graphLayout = require('../../utils/graph-layout');
const kinship = require('../../utils/kinship');
const graphViewport = require('../../utils/graph-viewport');
const shareCard = require('../../utils/share-card');
const personGender = require('../../utils/person-gender');
const exampleDisplayPreference = require('../../utils/example-display-preference');
const MAX_INTERACTIVE_NODES = 80;

function exampleDetailUrl(slug, personId) {
  return '/pages/example-person-detail/index?slug=' + encodeURIComponent(slug) + '&id=' + encodeURIComponent(personId);
}

Page({
  data: {
    selectedKinship: null,
    loading: true, error: '', slug: '', example: null, rawPersons: [], rawRelations: [], nodes: [], lines: [], junctions: [],
    canvasWidth: 750, canvasHeight: 900, graphScale: 1, graphX: 0, graphY: 0, graphScaleMin: 0.32, graphZoomClass: 'zoom-detail',
    pageOrientation: 'portrait', isLandscape: false, orientationChanging: false,
    collapsedPersonIds: [], hiddenBranchCount: 0, canExpandAll: false, nameLayout: 'horizontal', showChildRankBadge: false, showGenderBadge: false, showGenderColors: true, viewMode: 'full', viewpointId: '', viewpointName: '',
    selectedPersonId: '', selectedPerson: null, showMemberSheet: false, showPerspectiveSheet: false, perspectiveKeyword: '', perspectiveResults: [],
    showTour: false, tourStep: 1,
    shareCard: shareCard.create({ kind: 'example' })
  },

  onLoad: function (options) {
    const slug = options.slug || '';
    this._initialPersonId = options.personId || '';
    this._shareSource = options.source || '';
    this.setData({ slug: slug });
    if (!slug) this.setData({ loading: false, error: '缺少示例家谱信息' }); else this.loadExample();
  },
  onShow: function () {
    this.resetPageOrientation();
    this.applyDisplayPreference();
    this.syncPageOrientationSoon();
  },
  onHide: function () { this.resetPageOrientation(); },
  onPullDownRefresh: function () { this.loadExample().then(function () { wx.stopPullDownRefresh(); }); },
  onUnload: function () { if (this._graphSettleTimer) clearTimeout(this._graphSettleTimer); if (this._orientationTimer) clearTimeout(this._orientationTimer); this.syncPageChrome(false); },

  loadExample: function () {
    const self = this;
    if (!this.data.slug) return Promise.resolve();
    this.setData({ loading: true, error: '' });
    return api.call('examples.get', { slug: this.data.slug }).then(function (data) {
      const example = data.example;
      const persons = (example.persons || []).map(function (person) {
        return personGender.decorate(Object.assign({}, person, { initial: (person.name || '家').slice(0, 1), metaText: person.birthDate ? person.birthDate.slice(0, 4) + '年' : '' }));
      });
      const relations = example.relations || [];
      const collapsed = graphLayout.suggestCollapsedIds(persons, relations, { limit: 36 });
      const preference = exampleDisplayPreference.get(example.slug || self.data.slug);
      self.setData(Object.assign({ loading: false, example: example, rawPersons: persons, rawRelations: relations, perspectiveResults: persons, collapsedPersonIds: collapsed, selectedPersonId: '', selectedPerson: null }, preference), function () {
        self.syncPageChrome(self.data.isLandscape);
        const initialPersonId = self._initialPersonId;
        self._initialPersonId = '';
        if (initialPersonId && persons.some(function (person) { return person._id === initialPersonId; })) {
          self.setPerspective(initialPersonId);
        } else {
          self.renderGraph('full', '', { collapsedPersonIds: collapsed, nameLayout: preference.nameLayout });
        }
        if (!wx.getStorageSync('youpu_example_tour_' + example.slug)) self.setData({ showTour: true, tourStep: 1 });
        self.prepareExampleShare();
        if (self._shareSource === 'example_share' && !self._shareOpenRecorded) {
          self._shareOpenRecorded = true;
          api.call('share.record', { stage: 'opened', kind: 'example', slug: example.slug }).catch(function () {});
        }
      });
    }).catch(function (error) { self.setData({ loading: false, error: error.message || '示例家谱暂时不可用' }); });
  },

  applyDisplayPreference: function (savedPreference) {
    if (!this.data.example) return;
    // Returning from the settings page can leave the page data ahead of its
    // canvas (for example when a hidden page's previous refresh was dropped).
    // Always lay out the graph from the stored preference so card dimensions,
    // vertical names and connection coordinates remain in sync.
    const preference = exampleDisplayPreference.normalize(savedPreference || exampleDisplayPreference.get(this.displayPreferenceSlug()));
    this.renderGraph(this.data.viewMode, this.data.viewpointId, {
      preserveViewport: true,
      nameLayout: preference.nameLayout,
      statePatch: preference
    });
  },

  displayPreferenceSlug: function () {
    return (this.data.example && this.data.example.slug) || this.data.slug;
  },

  getGraphTransform: function () {
    return { scale: typeof this._currentGraphScale === 'number' ? this._currentGraphScale : this.data.graphScale, x: typeof this._currentGraphX === 'number' ? this._currentGraphX : this.data.graphX, y: typeof this._currentGraphY === 'number' ? this._currentGraphY : this.data.graphY };
  },
  commitGraphTransform: function (transform) {
    this._currentGraphScale = transform.scale; this._currentGraphX = transform.x; this._currentGraphY = transform.y;
    this.setData({ graphScale: transform.scale, graphX: transform.x, graphY: transform.y, graphZoomClass: graphViewport.zoomClassForScale(this.getGraphDisplayScale(transform.scale), this.data.graphZoomClass) });
  },
  getGraphDisplayScale: function (scale) { return scale * graphViewport.MIN_SCALE / (this.data.graphScaleMin || graphViewport.MIN_SCALE); },
  getGraphViewport: function () {
    const info = this.getWindowSize();
    const width = info.windowWidth || 375;
    if (this._graphViewport && this._graphViewport.windowWidth === width) return this._graphViewport;
    const height = info.windowHeight || 667;
    const isLandscape = width > height;
    return { width: width, height: Math.max(isLandscape ? 120 : 240, height - (isLandscape ? 0 : 316 * width / 750)), rpxToPx: width / 750, windowWidth: width };
  },
  getWindowSize: function () {
    try { return wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (error) { return { windowWidth: 375, windowHeight: 667 }; }
  },
  renderGraph: function (mode, viewpointId, renderOptions) {
    const optionsValue = renderOptions || {};
    const collapsedIds = optionsValue.collapsedPersonIds || this.data.collapsedPersonIds;
    const selectedPersonId = Object.prototype.hasOwnProperty.call(optionsValue, 'selectedPersonId') ? optionsValue.selectedPersonId : this.data.selectedPersonId;
    const nameLayout = optionsValue.nameLayout === 'vertical' ? 'vertical' : optionsValue.nameLayout === 'horizontal' ? 'horizontal' : this.data.nameLayout;
    if (!this._kinshipCache) this._kinshipCache = kinship.createKinshipCache();
    const kinshipDetails = mode === 'perspective' ? this._kinshipCache(this.data.rawPersons, this.data.rawRelations, viewpointId) : {};
    const result = graphLayout.layoutGraph(this.data.rawPersons, this.data.rawRelations, { mode: mode, viewpointId: viewpointId, nameLayout: nameLayout, collapsedIds: collapsedIds, selectedPersonId: selectedPersonId, kinshipDetails: kinshipDetails });
    const viewpoint = this.data.rawPersons.find(function (person) { return person._id === viewpointId; });
    const self = this;
    this._lastLayout = result;
    this.setData(Object.assign({ selectedKinship: this.data.showMemberSheet ? kinship.memberKinshipCard(kinshipDetails, selectedPersonId, viewpoint ? viewpoint.name : '', this.data.rawPersons) : null, nodes: result.nodes, lines: result.lines, junctions: result.junctions || [], canvasWidth: result.width, canvasHeight: result.height, viewpointName: viewpoint ? viewpoint.name : '', hiddenBranchCount: result.hiddenCount || 0, canExpandAll: (result.hiddenCount || 0) > 0 && this.data.rawPersons.length <= MAX_INTERACTIVE_NODES }, optionsValue.statePatch || {}), function () {
      if (optionsValue.preserveViewport) return;
      if (mode === 'perspective' && viewpointId) self.fitGraph(viewpointId, false, { minimumFocusScale: 0.6 }); else self.fitGraph('', true);
    });
  },
  fitGraph: function (focusPersonId, fitAll, optionsValue) {
    if (!this._lastLayout || !this._lastLayout.nodes.length) return;
    const options = optionsValue || {};
    this.commitGraphTransform(graphViewport.fitTransform(this._lastLayout, this.getGraphViewport(), { fitAll: fitAll, focusPersonId: focusPersonId, currentScale: this.getGraphTransform().scale, minimumScale: this.data.graphScaleMin, minimumFocusScale: (options.minimumFocusScale || 0) * this.data.graphScaleMin / graphViewport.MIN_SCALE }));
  },
  fitWholeGraph: function () { this.fitGraph('', true); },
  locateGraphFocus: function () { const id = this.data.selectedPersonId || this.data.viewpointId; this.fitGraph(id, !id, id ? { minimumFocusScale: 0.68 } : {}); },
  changeGraphScale: function (delta) { const current = this.getGraphTransform(); const normalizedDelta = delta * this.data.graphScaleMin / graphViewport.MIN_SCALE; this.commitGraphTransform(graphViewport.zoomAroundCenter(current, Math.round((current.scale + normalizedDelta) * 100) / 100, this.getGraphViewport(), { minimumScale: this.data.graphScaleMin })); },
  zoomGraphIn: function () { this.changeGraphScale(0.15); },
  zoomGraphOut: function () { this.changeGraphScale(-0.15); },
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
    const familyName = this.data.example && (this.data.example.title || this.data.example.name);
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: isLandscape && familyName ? familyName : '示例家谱' });
  },
  syncPageOrientationSoon: function () {
    const self = this;
    setTimeout(function () { const size = self.getWindowSize(); if (self._orientationViewport && size.windowWidth <= size.windowHeight) self.applyPageResize(size); }, 80);
  },
  togglePageOrientation: function () {
    if (this.data.orientationChanging) return;
    const target = this.data.isLandscape ? 'portrait' : 'landscape';
    this._orientationViewport = this.getGraphViewport(); this._orientationTransform = this.getGraphTransform(); this._orientationTarget = target;
    this.setData({ pageOrientation: target, orientationChanging: true });
    const self = this;
    if (this._orientationTimer) clearTimeout(this._orientationTimer);
    this._orientationTimer = setTimeout(function () {
      self._orientationTimer = null;
      const size = self.getWindowSize(); const actual = size.windowWidth > size.windowHeight ? 'landscape' : 'portrait';
      if (actual === target) return self.applyPageResize(size);
      self._orientationViewport = null; self._orientationTransform = null; self._orientationTarget = ''; self._graphViewport = null; self._orientationResizeSequence = (self._orientationResizeSequence || 0) + 1;
      self.setData({ pageOrientation: actual, isLandscape: actual === 'landscape', orientationChanging: false, graphScaleMin: graphViewport.minimumScaleForViewport({ rpxToPx: (size.windowWidth || 375) / 750 }) });
      self.syncPageChrome(actual === 'landscape');
      wx.showToast({ title: '屏幕方向切换失败，请重试', icon: 'none' });
    }, 1200);
  },
  onPageResize: function (event) { const size = event && event.detail && event.detail.size; if (size) this.applyPageResize(size); },
  applyPageResize: function (size) {
    const resizeSequence = (this._orientationResizeSequence || 0) + 1; this._orientationResizeSequence = resizeSequence;
    const width = Number(size.windowWidth) || 375; const height = Number(size.windowHeight) || 667;
    const actual = width > height ? 'landscape' : 'portrait';
    const minimumScale = graphViewport.minimumScaleForViewport({ width: width, height: height, rpxToPx: width / 750 });
    const previousViewport = this._orientationViewport || this._graphViewport;
    const previousTransform = this._orientationTransform || this.getGraphTransform();
    const target = this._orientationTarget; const settled = !target || target === actual;
    this.syncPageChrome(actual === 'landscape');
    if (settled && this._orientationTimer) clearTimeout(this._orientationTimer); if (settled) this._orientationTimer = null;
    const self = this;
    this.setData({ pageOrientation: target || actual, isLandscape: actual === 'landscape', orientationChanging: Boolean(target && !settled), graphScaleMin: minimumScale }, function () {
      if (resizeSequence !== self._orientationResizeSequence) return;
      const measure = function () {
        self.measureGraphViewport({ windowWidth: width, windowHeight: height }, function (nextViewport) {
          if (resizeSequence !== self._orientationResizeSequence) return;
          self._graphViewport = nextViewport;
          if (self._lastLayout && self._lastLayout.nodes.length) {
            if (previousViewport) self.commitGraphTransform(graphViewport.resizeTransform(previousTransform, previousViewport, nextViewport, { minimumScale: minimumScale }));
            else self.fitGraph(self.data.selectedPersonId || self.data.viewpointId, !(self.data.selectedPersonId || self.data.viewpointId));
          }
          if (settled) { self._orientationViewport = null; self._orientationTransform = null; self._orientationTarget = ''; }
        });
      };
      if (wx.nextTick) wx.nextTick(measure); else setTimeout(measure, 0);
    });
  },
  measureGraphViewport: function (size, callback) {
    const width = Number(size.windowWidth) || 375; const height = Number(size.windowHeight) || 667;
    const fallback = { width: width, height: Math.max(width > height ? 120 : 240, height - (width > height ? 0 : 316 * width / 750)), rpxToPx: width / 750, windowWidth: width };
    const query = this.createSelectorQuery ? this.createSelectorQuery() : wx.createSelectorQuery();
    query.select('.graph-viewport').boundingClientRect();
    query.exec(function (result) { const rect = result && result[0]; callback(rect && rect.width && rect.height ? { width: rect.width, height: rect.height, rpxToPx: width / 750, windowWidth: width } : fallback); });
  },
  openDisplaySettings: function () {
    const slug = this.displayPreferenceSlug();
    if (slug) wx.navigateTo({ url: '/pages/display-settings/index?exampleSlug=' + encodeURIComponent(slug) });
  },
  onGraphScale: function (event) { if (event.detail.scale) { this._currentGraphScale = event.detail.scale; this.scheduleGraphSettle(); } },
  onGraphChange: function (event) { if (typeof event.detail.x === 'number') this._currentGraphX = event.detail.x; if (typeof event.detail.y === 'number') this._currentGraphY = event.detail.y; this.scheduleGraphSettle(); },
  scheduleGraphSettle: function () {
    const self = this; if (this._graphSettleTimer) clearTimeout(this._graphSettleTimer);
    this._graphSettleTimer = setTimeout(function () { self._graphSettleTimer = null; const next = graphViewport.zoomClassForScale(self.getGraphDisplayScale(self.getGraphTransform().scale), self.data.graphZoomClass); if (next !== self.data.graphZoomClass) self.setData({ graphZoomClass: next }); }, 160);
  },

  showPerson: function (event) {
    const personId = event.currentTarget.dataset.id;
    const person = this.data.rawPersons.find(function (item) { return item._id === personId; });
    if (!person) return;
    if (this.data.selectedPersonId === personId) return this.openMemberActions(event);
    this.renderGraph(this.data.viewMode, this.data.viewpointId, { preserveViewport: true, selectedPersonId: personId, statePatch: { selectedPersonId: personId, selectedPerson: this.decorateSelectedPerson(person), showMemberSheet: false } });
  },
  openMemberActions: function (event) {
    const personId = event.currentTarget.dataset.id;
    const person = this.data.rawPersons.find(function (item) { return item._id === personId; });
    if (person) this.setData({ selectedKinship: this.data.viewMode === 'perspective' ? kinship.memberKinshipCard(this._lastLayout && this._lastLayout.kinshipDetails, personId, this.data.viewpointName, this.data.rawPersons) : null,
      selectedPersonId: personId, selectedPerson: this.decorateSelectedPerson(person), showMemberSheet: true });
  },
  decorateSelectedPerson: function (person) {
    const node = (this._lastLayout && this._lastLayout.nodes || []).find(function (item) { return item._id === person._id; });
    return Object.assign({}, person, node ? { childRankLabel: node.childRankLabel || '' } : {}, {
      isCollapsed: this.data.collapsedPersonIds.indexOf(person._id) >= 0
    });
  },
  clearGraphSelection: function () { if (this.data.selectedPersonId && !this.data.showMemberSheet) this.renderGraph(this.data.viewMode, this.data.viewpointId, { preserveViewport: true, selectedPersonId: '', statePatch: { selectedPersonId: '', selectedPerson: null } }); },
  closeMemberSheet: function () { this.setData({ showMemberSheet: false, selectedKinship: null }); },
  openPerspectiveSheet: function () { this.setData({ showPerspectiveSheet: true, perspectiveKeyword: '', perspectiveResults: this.data.rawPersons }); },
  closePerspectiveSheet: function () { this.setData({ showPerspectiveSheet: false }); },
  filterPerspectives: function (event) { const keyword = (event.detail.value || '').trim(); this.setData({ perspectiveKeyword: keyword, perspectiveResults: this.data.rawPersons.filter(function (person) { return !keyword || person.name.indexOf(keyword) >= 0; }) }); },
  selectPerspective: function (event) { this.setPerspective(event.currentTarget.dataset.id); this.closePerspectiveSheet(); },
  setPerspective: function (personId) {
    const collapsed = graphLayout.expandCollapsedIds(this.data.rawPersons, this.data.rawRelations, this.data.collapsedPersonIds, personId);
    this.renderGraph('perspective', personId, { collapsedPersonIds: collapsed, selectedPersonId: '', statePatch: { viewMode: 'perspective', viewpointId: personId, collapsedPersonIds: collapsed, selectedPersonId: '', selectedPerson: null, showMemberSheet: false } });
  },
  useSelectedPerspective: function () { if (this.data.selectedPerson) { this.closeMemberSheet(); this.setPerspective(this.data.selectedPerson._id); } },
  showFullGraph: function () { this.renderGraph('full', '', { selectedPersonId: '', statePatch: { viewMode: 'full', viewpointId: '', viewpointName: '', selectedPersonId: '', selectedPerson: null, showMemberSheet: false } }); },
  expandAllBranches: function () { if (this.data.rawPersons.length > MAX_INTERACTIVE_NODES) return wx.showToast({ title: '家谱较大，请按分支展开', icon: 'none' }); this.renderGraph(this.data.viewMode, this.data.viewpointId, { collapsedPersonIds: [], statePatch: { collapsedPersonIds: [] } }); },
  expandBranch: function (event) { const id = event.currentTarget.dataset.id; const collapsed = this.data.collapsedPersonIds.filter(function (item) { return item !== id; }); this.renderGraph(this.data.viewMode, this.data.viewpointId, { collapsedPersonIds: collapsed, statePatch: { collapsedPersonIds: collapsed } }); },
  toggleSelectedBranch: function () { const person = this.data.selectedPerson; if (!person) return; const collapsed = this.data.collapsedPersonIds.slice(); const index = collapsed.indexOf(person._id); if (index >= 0) collapsed.splice(index, 1); else collapsed.push(person._id); this.renderGraph(this.data.viewMode, this.data.viewpointId, { collapsedPersonIds: collapsed, selectedPersonId: '', statePatch: { collapsedPersonIds: collapsed, selectedPersonId: '', selectedPerson: null, showMemberSheet: false } }); },
  openMemberDetail: function () { if (this.data.selectedPerson) wx.navigateTo({ url: exampleDetailUrl(this.data.slug, this.data.selectedPerson._id) }); },
  explainCreate: function () { const self = this; wx.showModal({ title: '在自己的家谱中继续', content: '创建自己的家谱后，你可以添加亲属、编辑资料、管理关系并邀请家人共同维护。', confirmText: '去创建', success: function (result) { if (result.confirm) self.createFamily(); } }); },
  createFamily: function () { wx.navigateTo({ url: '/pages/create-family/index?source=example&example=' + encodeURIComponent(this.data.slug) }); },
  prepareExampleShare: function () {
    const example = this.data.example || {};
    const self = this;
    return shareCard.createAndRender(this, 'example-share-card', {
      kind: 'example', exampleName: example.title, customTitle: example.shareTitle,
      path: '/pages/example/index?slug=' + encodeURIComponent(this.data.slug) + '&source=example_share'
    }).then(function (card) { self.setData({ shareCard: card }); });
  },
  nextTour: function () { if (this.data.tourStep < 3) this.setData({ tourStep: this.data.tourStep + 1 }); else this.dismissTour(); },
  dismissTour: function () { wx.setStorageSync('youpu_example_tour_' + this.data.slug, true); this.setData({ showTour: false }); },
  onShareAppMessage: function () {
    const card = this.data.shareCard || shareCard.create({ kind: 'example' });
    const slug = this.data.slug;
    api.call('share.record', { stage: 'prepared', kind: 'example', slug: slug }).catch(function () {});
    return {
      title: card.title,
      path: card.path,
      imageUrl: card.imageUrl,
      success: function () { api.call('share.record', { stage: 'sent', kind: 'example', slug: slug }).catch(function () {}); }
    };
  }
});
