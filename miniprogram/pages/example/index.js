const api = require('../../utils/api');
const graphLayout = require('../../utils/graph-layout');
const graphViewport = require('../../utils/graph-viewport');
const MAX_INTERACTIVE_NODES = 80;

function exampleDetailUrl(slug, personId) {
  return '/pages/example-person-detail/index?slug=' + encodeURIComponent(slug) + '&id=' + encodeURIComponent(personId);
}

Page({
  data: {
    loading: true, error: '', slug: '', example: null, rawPersons: [], rawRelations: [], nodes: [], lines: [], junctions: [],
    canvasWidth: 750, canvasHeight: 900, graphScale: 1, graphX: 0, graphY: 0, graphScaleMin: 0.32, graphZoomClass: 'zoom-detail',
    collapsedPersonIds: [], hiddenBranchCount: 0, canExpandAll: false, viewMode: 'full', viewpointId: '', viewpointName: '',
    selectedPersonId: '', selectedPerson: null, showMemberSheet: false, showPerspectiveSheet: false, perspectiveKeyword: '', perspectiveResults: [],
    showTour: false, tourStep: 1
  },

  onLoad: function (options) {
    const slug = options.slug || '';
    this._initialPersonId = options.personId || '';
    this.setData({ slug: slug });
    if (!slug) this.setData({ loading: false, error: '缺少示例家谱信息' }); else this.loadExample();
  },
  onPullDownRefresh: function () { this.loadExample().then(function () { wx.stopPullDownRefresh(); }); },
  onUnload: function () { if (this._graphSettleTimer) clearTimeout(this._graphSettleTimer); },

  loadExample: function () {
    const self = this;
    if (!this.data.slug) return Promise.resolve();
    this.setData({ loading: true, error: '' });
    return api.call('examples.get', { slug: this.data.slug }).then(function (data) {
      const example = data.example;
      const persons = (example.persons || []).map(function (person) {
        return Object.assign({}, person, { initial: (person.name || '家').slice(0, 1), metaText: person.lifeStatus === 'deceased' ? '故' : person.birthDate ? person.birthDate.slice(0, 4) + '年' : '' });
      });
      const relations = example.relations || [];
      const collapsed = graphLayout.suggestCollapsedIds(persons, relations, { limit: 36 });
      self.setData({ loading: false, example: example, rawPersons: persons, rawRelations: relations, perspectiveResults: persons, collapsedPersonIds: collapsed, selectedPersonId: '', selectedPerson: null }, function () {
        const initialPersonId = self._initialPersonId;
        self._initialPersonId = '';
        if (initialPersonId && persons.some(function (person) { return person._id === initialPersonId; })) {
          self.setPerspective(initialPersonId);
        } else {
          self.renderGraph('full', '', { collapsedPersonIds: collapsed });
        }
        if (!wx.getStorageSync('youpu_example_tour_' + example.slug)) self.setData({ showTour: true, tourStep: 1 });
      });
    }).catch(function (error) { self.setData({ loading: false, error: error.message || '示例家谱暂时不可用' }); });
  },

  getGraphTransform: function () {
    return { scale: typeof this._currentGraphScale === 'number' ? this._currentGraphScale : this.data.graphScale, x: typeof this._currentGraphX === 'number' ? this._currentGraphX : this.data.graphX, y: typeof this._currentGraphY === 'number' ? this._currentGraphY : this.data.graphY };
  },
  commitGraphTransform: function (transform) {
    this._currentGraphScale = transform.scale; this._currentGraphX = transform.x; this._currentGraphY = transform.y;
    this.setData({ graphScale: transform.scale, graphX: transform.x, graphY: transform.y, graphZoomClass: graphViewport.zoomClassForScale(transform.scale, this.data.graphZoomClass) });
  },
  getGraphViewport: function () {
    let info = {};
    try { info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (error) { info = { windowWidth: 375, windowHeight: 667 }; }
    const width = info.windowWidth || 375;
    return { width: width, height: Math.max(240, (info.windowHeight || 667) - 316 * width / 750), rpxToPx: width / 750 };
  },
  renderGraph: function (mode, viewpointId, renderOptions) {
    const optionsValue = renderOptions || {};
    const collapsedIds = optionsValue.collapsedPersonIds || this.data.collapsedPersonIds;
    const selectedPersonId = Object.prototype.hasOwnProperty.call(optionsValue, 'selectedPersonId') ? optionsValue.selectedPersonId : this.data.selectedPersonId;
    const result = graphLayout.layoutGraph(this.data.rawPersons, this.data.rawRelations, { mode: mode, viewpointId: viewpointId, collapsedIds: collapsedIds, selectedPersonId: selectedPersonId });
    const viewpoint = this.data.rawPersons.find(function (person) { return person._id === viewpointId; });
    const self = this;
    this._lastLayout = result;
    this.setData(Object.assign({ nodes: result.nodes, lines: result.lines, junctions: result.junctions || [], canvasWidth: result.width, canvasHeight: result.height, viewpointName: viewpoint ? viewpoint.name : '', hiddenBranchCount: result.hiddenCount || 0, canExpandAll: (result.hiddenCount || 0) > 0 && this.data.rawPersons.length <= MAX_INTERACTIVE_NODES }, optionsValue.statePatch || {}), function () {
      if (optionsValue.preserveViewport) return;
      if (mode === 'perspective' && viewpointId) self.fitGraph(viewpointId, false, { minimumFocusScale: 0.6 }); else self.fitGraph('', true);
    });
  },
  fitGraph: function (focusPersonId, fitAll, optionsValue) {
    if (!this._lastLayout || !this._lastLayout.nodes.length) return;
    const options = optionsValue || {};
    this.commitGraphTransform(graphViewport.fitTransform(this._lastLayout, this.getGraphViewport(), { fitAll: fitAll, focusPersonId: focusPersonId, currentScale: this.getGraphTransform().scale, minimumScale: this.data.graphScaleMin, minimumFocusScale: options.minimumFocusScale || 0 }));
  },
  fitWholeGraph: function () { this.fitGraph('', true); },
  locateGraphFocus: function () { const id = this.data.selectedPersonId || this.data.viewpointId; this.fitGraph(id, !id, id ? { minimumFocusScale: 0.68 } : {}); },
  changeGraphScale: function (delta) { const current = this.getGraphTransform(); this.commitGraphTransform(graphViewport.zoomAroundCenter(current, Math.round((current.scale + delta) * 100) / 100, this.getGraphViewport(), { minimumScale: this.data.graphScaleMin })); },
  zoomGraphIn: function () { this.changeGraphScale(0.15); },
  zoomGraphOut: function () { this.changeGraphScale(-0.15); },
  onGraphScale: function (event) { if (event.detail.scale) { this._currentGraphScale = event.detail.scale; this.scheduleGraphSettle(); } },
  onGraphChange: function (event) { if (typeof event.detail.x === 'number') this._currentGraphX = event.detail.x; if (typeof event.detail.y === 'number') this._currentGraphY = event.detail.y; this.scheduleGraphSettle(); },
  scheduleGraphSettle: function () {
    const self = this; if (this._graphSettleTimer) clearTimeout(this._graphSettleTimer);
    this._graphSettleTimer = setTimeout(function () { self._graphSettleTimer = null; const next = graphViewport.zoomClassForScale(self.getGraphTransform().scale, self.data.graphZoomClass); if (next !== self.data.graphZoomClass) self.setData({ graphZoomClass: next }); }, 160);
  },

  showPerson: function (event) {
    const personId = event.currentTarget.dataset.id;
    const person = this.data.rawPersons.find(function (item) { return item._id === personId; });
    if (!person) return;
    if (this.data.selectedPersonId === personId) return this.openMemberActions(event);
    this.renderGraph(this.data.viewMode, this.data.viewpointId, { preserveViewport: true, selectedPersonId: personId, statePatch: { selectedPersonId: personId, selectedPerson: Object.assign({}, person, { isCollapsed: this.data.collapsedPersonIds.indexOf(personId) >= 0 }), showMemberSheet: false } });
  },
  openMemberActions: function (event) {
    const personId = event.currentTarget.dataset.id;
    const person = this.data.rawPersons.find(function (item) { return item._id === personId; });
    if (person) this.setData({ selectedPersonId: personId, selectedPerson: Object.assign({}, person, { isCollapsed: this.data.collapsedPersonIds.indexOf(personId) >= 0 }), showMemberSheet: true });
  },
  clearGraphSelection: function () { if (this.data.selectedPersonId && !this.data.showMemberSheet) this.renderGraph(this.data.viewMode, this.data.viewpointId, { preserveViewport: true, selectedPersonId: '', statePatch: { selectedPersonId: '', selectedPerson: null } }); },
  closeMemberSheet: function () { this.setData({ showMemberSheet: false }); },
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
  nextTour: function () { if (this.data.tourStep < 3) this.setData({ tourStep: this.data.tourStep + 1 }); else this.dismissTour(); },
  dismissTour: function () { wx.setStorageSync('youpu_example_tour_' + this.data.slug, true); this.setData({ showTour: false }); },
  onShareAppMessage: function () { const example = this.data.example || {}; return { title: example.shareTitle || ('看看“' + (example.title || '有谱示例') + '”'), path: '/pages/example/index?slug=' + encodeURIComponent(this.data.slug) }; }
});
