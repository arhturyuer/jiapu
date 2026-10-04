const app = getApp();
const api = require('../../utils/api');
const graphLayout = require('../../utils/graph-layout');
const kinship = require('../../utils/kinship');
const graphViewport = require('../../utils/graph-viewport');
const graphGesturePage = require('../../utils/graph-gesture-page');
const graphCleanScreen = require('../../utils/graph-clean-screen');
const shareCard = require('../../utils/share-card');
const personGender = require('../../utils/person-gender');
const memberActions = require('../../utils/member-actions');
const commerceConfig = require('../../config/commerce');
const exampleDisplayPreference = require('../../utils/example-display-preference');
const examplePosterCode = require('../../utils/example-poster-code');
const treePosterFlow = require('../../utils/tree-poster-flow');
const MAX_INTERACTIVE_NODES = 80;

function exampleDetailUrl(slug, personId, source) {
  return '/pages/example-person-detail/index?slug=' + encodeURIComponent(slug) + '&id=' + encodeURIComponent(personId)
    + (source === 'share_menu' ? '&source=share_menu' : '');
}

function decodedScene(value) {
  try { return decodeURIComponent(value || ''); } catch (error) { return ''; }
}

Page(graphGesturePage.wrap({
  data: {
    selectedKinship: null,
    exampleTabs: [], selectedExampleTabId: '', tabsError: '',
    loading: true, error: '', slug: '', example: null, rawPersons: [], rawRelations: [], nodes: [], lines: [], junctions: [], crossings: [],
    canvasWidth: 750, canvasHeight: 900, graphScale: 1, graphX: 0, graphY: 0, graphScaleMin: 0.32, graphZoomClass: 'zoom-detail',
    isCleanScreen: false,
    pageOrientation: 'portrait', isLandscape: false, orientationChanging: false,
    collapsedPersonIds: [], hiddenBranchCount: 0, canExpandAll: false, nameLayout: 'horizontal', showChildRankBadge: false, showGenderBadge: false, showGenderColors: true, autoCollapseEnabled: true, viewMode: 'full', viewpointId: '', viewpointName: '',
    selectedPersonId: '', selectedPerson: null, showMemberSheet: false, memberAdUnitId: '', memberAdVisible: false, showPerspectiveSheet: false, perspectiveKeyword: '', perspectiveResults: [],
    posterGenerating: false,
    shareCard: shareCard.create({ kind: 'example' })
  },

  onLoad: function (options) {
    const value = options || {};
    this._scene = decodedScene(value.scene);
    this._defaultEntry = value.entry === 'default' && !value.slug && !value.scene;
    this._initialPersonId = value.personId || '';
    this._shareSource = this._scene ? 'example_poster' : (value.source || '');
    this.setData({ slug: this._scene ? '' : (value.slug || '') });
    const tabsPromise = this.loadExampleTabs();
    return this.loadExample({ tabsPromise: tabsPromise });
  },
  onShow: function () {
    this._hidden = false;
    if (app.recordExampleVisit && this.data.example && !this.data.loading && !this.data.error) app.recordExampleVisit(this.data.slug);
    this.resetPageOrientation();
    const tabsPromise = this._reloadTabsOnShow ? this.loadExampleTabs() : null;
    if (this._pendingExampleSlug) {
      const slug = this._pendingExampleSlug;
      this._pendingExampleSlug = '';
      if (slug === this.data.slug && !this._reloadOnShow && !this.data.error) this.applyDisplayPreference();
      else this.switchExample(slug);
    } else if (this._reloadOnShow) {
      this.loadExample({ tabsPromise: tabsPromise });
    } else if (!this.data.loading && !this.data.error) this.applyDisplayPreference();
    this._reloadTabsOnShow = false;
    this._reloadOnShow = false;
    this.syncPageOrientationSoon();
  },
  onHide: function () {
    this._hidden = true;
    this._reloadOnShow = this.data.loading || this._renderPending;
    this._loadRequestId = (this._loadRequestId || 0) + 1;
    this._reloadTabsOnShow = this._tabsLoading;
    this._tabsRequestId = (this._tabsRequestId || 0) + 1;
    treePosterFlow.cancel(this);
    this.resetPageOrientation();
  },
  onPullDownRefresh: function () { const tabsPromise = this.loadExampleTabs({ force: true }); this.loadExample({ force: true, tabsPromise: tabsPromise }).then(function () { wx.stopPullDownRefresh(); }); },
  onUnload: function () { this._unloaded = true; this._tabsRequestId = (this._tabsRequestId || 0) + 1; this._loadRequestId = (this._loadRequestId || 0) + 1; treePosterFlow.cancel(this); if (this._orientationTimer) clearTimeout(this._orientationTimer); if (this._perspectiveFilterTimer) clearTimeout(this._perspectiveFilterTimer); this.resetPageOrientation(); },

  loadExample: function (options) {
    graphGesturePage.invalidate(this);
    const self = this;
    const config = options || {};
    const requestId = this._loadRequestId = (this._loadRequestId || 0) + 1;
    const valid = function () { return requestId === self._loadRequestId && !self._unloaded && !self._hidden; };
    this._renderPending = false;
    this.setData({ loading: true, error: '' });
    let target;
    if (this._scene && !this.data.slug) {
      target = api.call('examples.resolvePoster', { scene: this._scene }).then(function (data) {
        if (valid()) self._initialPersonId = data.viewPersonId || '';
        return data.slug;
      });
    } else if (this._defaultEntry && (!this.data.slug || config.force)) {
      target = (config.tabsPromise || this.loadExampleTabs(config)).then(function (data) {
        if (!data) throw Object.assign(new Error(), { code: 'EXAMPLES_READ_FAILED' });
        if (!data.items || !data.items.length) throw Object.assign(new Error(), { code: 'EXAMPLES_EMPTY' });
        return data.items[0].slug;
      });
    } else target = Promise.resolve(this.data.slug);
    return target.then(function (slug) {
      if (!valid()) return null;
      if (!slug) throw Object.assign(new Error(), { code: 'EXAMPLE_SLUG_REQUIRED' });
      self.setData({ slug: slug });
      self.syncExampleTabs();
      return app.getExample(slug, config);
    }).then(function (data) {
      if (!data || !valid()) return;
      const example = data.example;
      const persons = (example.persons || []).map(function (person) {
        return personGender.decorate(Object.assign({}, person, { initial: (person.name || '家').slice(0, 1), metaText: person.birthDate ? person.birthDate.slice(0, 4) + '年' : '' }));
      });
      const relations = example.relations || [];
      const preference = exampleDisplayPreference.get(example.slug || self.data.slug, example.defaultDisplayPreference, example.publishedVersion);
      const collapsed = preference.autoCollapseEnabled
        ? graphLayout.suggestCollapsedIds(persons, relations, { limit: 36 })
        : [];
      self._graphViewport = null;
      self._renderPending = true;
      self.setData(Object.assign({ loading: false, example: example, rawPersons: persons, rawRelations: relations, perspectiveResults: persons, perspectiveKeyword: '', collapsedPersonIds: collapsed, selectedPersonId: '', selectedPerson: null, selectedKinship: null, showMemberSheet: false, showPerspectiveSheet: false, memberAdVisible: false, viewMode: 'full', viewpointId: '', viewpointName: '' }, preference), function () {
        if (!valid()) return;
        self.syncExampleTabs();
        self.syncPageChrome(self.data.isLandscape);
        const initialPersonId = self._initialPersonId;
        const render = function (viewport) {
          if (!valid()) return;
          self._renderPending = false;
          self._initialPersonId = '';
          self._graphViewport = viewport;
          if (initialPersonId && persons.some(function (person) { return person._id === initialPersonId; })) self.setPerspective(initialPersonId, { initialView: true });
          else self.renderGraph('full', '', { collapsedPersonIds: collapsed, nameLayout: preference.nameLayout, initialView: true });
        };
        if (self.createSelectorQuery || wx.createSelectorQuery) self.measureGraphViewport(self.getWindowSize(), render);
        else render(self.getGraphViewport());
        self.prepareExampleShare();
        if (['example_share', 'example_poster'].includes(self._shareSource) && !self._shareOpenRecorded) {
          self._shareOpenRecorded = true;
          api.call('share.record', { stage: 'opened', kind: 'example', slug: example.slug }).catch(function () {});
        }
      });
    }).catch(function (error) {
      if (!valid()) return;
      const fallback = error.code === 'EXAMPLES_EMPTY' ? '目前没有可体验的示例家谱'
        : error.code === 'EXAMPLE_SLUG_REQUIRED' ? '缺少示例家谱信息' : '示例家谱暂时不可用';
      self.setData({ loading: false, error: api.userMessage(error, fallback) });
    });
  },

  loadExampleTabs: function (options) {
    const self = this;
    const requestId = this._tabsRequestId = (this._tabsRequestId || 0) + 1;
    this._tabsLoading = true;
    return Promise.resolve().then(function () { return app.getExamplesList('', options || {}); }).then(function (data) {
      if (requestId === self._tabsRequestId && !self._unloaded && !self._hidden) {
        self._availableExamples = data.items || [];
        self._tabsLoading = false;
        self.setData({ tabsError: '' });
        self.syncExampleTabs();
      }
      return data;
    }).catch(function () {
      if (requestId === self._tabsRequestId && !self._unloaded && !self._hidden) {
        self._tabsLoading = false;
        self.setData({ tabsError: '示例列表暂不可用，点击重试' });
      }
      return null;
    });
  },
  retryExampleTabs: function () { return this.loadExampleTabs({ force: true }); },
  syncExampleTabs: function () {
    const slug = this.data.slug;
    const examples = (this._availableExamples || []).slice();
    const current = this.data.example;
    if (current && current.slug === slug && !examples.some(function (item) { return item.slug === slug; })) examples.unshift(current);
    const tabs = examples.map(function (item, index) {
      return { slug: item.slug, title: item.title || item.name || item.slug, id: 'example-tab-' + index };
    });
    const selected = tabs.find(function (item) { return item.slug === slug; });
    this.setData({ exampleTabs: tabs, selectedExampleTabId: selected ? selected.id : '' });
  },
  selectExampleTab: function (event) { return this.switchExample(event.currentTarget.dataset.slug); },
  switchExample: function (slug) {
    if (!slug || this._unloaded || (slug === this.data.slug && !this.data.error && !this.data.loading && !this._renderPending)) return;
    this._scene = '';
    this._defaultEntry = false;
    this._initialPersonId = '';
    treePosterFlow.cancel(this);
    this.setData({ slug: slug, viewMode: 'full', viewpointId: '', viewpointName: '', selectedPersonId: '', selectedPerson: null, selectedKinship: null, showMemberSheet: false, showPerspectiveSheet: false, memberAdVisible: false });
    this.syncExampleTabs();
    return this.loadExample();
  },

  openExamples: function () {
    const self = this;
    wx.navigateTo({
      url: '/pages/examples/index?select=1' + (this._shareSource === 'share_menu' ? '&source=share_menu' : ''),
      events: { exampleSelected: function (data) { if (!self._unloaded && data && data.slug) self._pendingExampleSlug = data.slug; } }
    });
  },

  applyDisplayPreference: function (savedPreference) {
    if (!this.data.example) return;
    // Returning from the settings page can leave the page data ahead of its
    // canvas (for example when a hidden page's previous refresh was dropped).
    // Always lay out the graph from the stored preference so card dimensions,
    // vertical names and connection coordinates remain in sync.
    const preference = savedPreference || exampleDisplayPreference.get(this.displayPreferenceSlug(), this.data.example.defaultDisplayPreference, this.data.example.publishedVersion);
    let collapsedPersonIds = this.data.collapsedPersonIds;
    if (preference.autoCollapseEnabled !== this.data.autoCollapseEnabled) {
      collapsedPersonIds = preference.autoCollapseEnabled
        ? graphLayout.suggestCollapsedIds(this.data.rawPersons, this.data.rawRelations, { limit: 36, focusId: this.data.viewpointId })
        : [];
    }
    this.renderGraph(this.data.viewMode, this.data.viewpointId, {
      preserveViewport: true,
      nameLayout: preference.nameLayout,
      collapsedPersonIds: collapsedPersonIds,
      statePatch: Object.assign({}, preference, { collapsedPersonIds: collapsedPersonIds })
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
    this.setData({ graphGestureConfig: graphGesturePage.config(this, transform), graphScale: transform.scale, graphX: transform.x, graphY: transform.y, graphZoomClass: graphViewport.zoomClassForScale(this.getGraphDisplayScale(transform.scale), this.data.graphZoomClass) });
  },
  getGraphDisplayScale: function (scale) { return scale * this.getGraphViewport().rpxToPx / 0.5; },
  getGraphViewport: function () {
    // Use the canvas measured by resize even if window info is still stale.
    if (this._graphViewport) return this._graphViewport;
    return this.fallbackGraphViewport(this.getWindowSize());
  },
  fallbackGraphViewport: function (size) {
    const width = Number(size.windowWidth) || 375;
    const height = Number(size.windowHeight) || 667;
    const safeBottom = size.safeArea ? Math.max(0, (Number(size.screenHeight) || height) - size.safeArea.bottom) : 0;
    const fullCanvas = width > height || this.data.isCleanScreen;
    const reserved = fullCanvas ? 0 : 354 * width / 750;
    return { width: width, height: Math.max(80, height - reserved - (fullCanvas ? 0 : safeBottom)), rpxToPx: width / 750, windowWidth: width };
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
    this.setData(Object.assign({ selectedKinship: this.data.showMemberSheet ? kinship.memberKinshipCard(kinshipDetails, selectedPersonId, viewpoint ? viewpoint.name : '', this.data.rawPersons) : null, nodes: result.nodes, lines: result.lines, junctions: result.junctions || [], crossings: result.crossings || [], canvasWidth: result.width, canvasHeight: result.height, viewpointName: viewpoint ? viewpoint.name : '', hiddenBranchCount: result.hiddenCount || 0, canExpandAll: (result.hiddenCount || 0) > 0 && this.data.rawPersons.length <= MAX_INTERACTIVE_NODES }, optionsValue.statePatch || {}), function () {
      if (optionsValue.preserveViewport) return;
      if (mode === 'perspective' && viewpointId) self.fitGraph(viewpointId, false, { minimumFocusScale: 0.6, initialView: optionsValue.initialView }); else self.fitGraph('', true, { initialView: optionsValue.initialView });
    });
  },
  fitGraph: function (focusPersonId, fitAll, optionsValue) {
    if (!this._lastLayout || !this._lastLayout.nodes.length) return;
    const options = optionsValue || {};
    if ((!this._graphViewport || this._graphViewport.left === undefined) && (this.createSelectorQuery || wx.createSelectorQuery)) {
      const page = this;
      const version = this._gestureVersion;
      const layout = this._lastLayout;
      this.measureGraphViewport(this.getWindowSize(), function (measured) {
        if (page._pageHidden || page._hidden || page._unloaded || page._lastLayout !== layout || page._gestureVersion !== version) return;
        page._graphViewport = measured;
        // A missing rect leaves the controls usable without retry recursion.
        if (measured.left === undefined) measured.left = 0;
        page.fitGraph(focusPersonId, fitAll, optionsValue);
      });
      return;
    }
    const viewport = this.getGraphViewport();
    this._graphViewport = viewport;
    this.commitGraphTransform((options.initialView ? graphViewport.initialTransform : graphViewport.fitTransform)(this._lastLayout, viewport, { relations: this.data.rawRelations, fitAll: fitAll, focusPersonId: focusPersonId, currentScale: this.getGraphTransform().scale, minimumScale: this.data.graphScaleMin, minimumFocusScale: (options.minimumFocusScale || 0) * this.data.graphScaleMin / graphViewport.MIN_SCALE }));
  },
  fitWholeGraph: function () { this.fitGraph('', true); },
  locateGraphFocus: function () { const id = this.data.selectedPersonId || this.data.viewpointId; this.fitGraph(id, !id, id ? { minimumFocusScale: 0.68 } : {}); },
  changeGraphScale: function (delta) { const current = this.getGraphTransform(); const normalizedDelta = delta * this.data.graphScaleMin / graphViewport.MIN_SCALE; this.commitGraphTransform(graphViewport.zoomAroundCenter(current, Math.round((current.scale + normalizedDelta) * 100) / 100, this.getGraphViewport(), { minimumScale: this.data.graphScaleMin })); },
  zoomGraphIn: function () { this.changeGraphScale(0.15); },
  zoomGraphOut: function () { this.changeGraphScale(-0.15); },
  toggleCleanScreen: function () { graphCleanScreen.toggle.call(this); },

  resetPageOrientation: function () {
    this._orientationResizeSequence = (this._orientationResizeSequence || 0) + 1;
    if (this._orientationTimer) clearTimeout(this._orientationTimer);
    this._orientationTimer = null;
    const needsReset = this.data.pageOrientation !== 'portrait' || this.data.isLandscape || this.data.orientationChanging || this.data.isCleanScreen;
    if (needsReset) {
      if (!this._orientationViewport) this._orientationViewport = this.getGraphViewport();
      if (!this._orientationTransform) this._orientationTransform = this.getGraphTransform();
      this._orientationTarget = 'portrait';
      this.setData({ pageOrientation: 'portrait', isLandscape: false, orientationChanging: false, isCleanScreen: false });
    }
    this.syncPageChrome(false);
  },
  syncPageChrome: function (isLandscape) {
    if (typeof wx === 'undefined') return;
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '有谱家谱·微信云开发·安全可靠' });
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
            else self.fitGraph(self.data.selectedPersonId || self.data.viewpointId, !(self.data.selectedPersonId || self.data.viewpointId), { initialView: true });
          }
          if (settled) { self._orientationViewport = null; self._orientationTransform = null; self._orientationTarget = ''; }
        });
      };
      if (wx.nextTick) wx.nextTick(measure); else setTimeout(measure, 0);
    });
  },
  measureGraphViewport: function (size, callback) {
    const width = Number(size.windowWidth) || 375; const height = Number(size.windowHeight) || 667;
    const fallback = this.fallbackGraphViewport(Object.assign({}, this.getWindowSize(), size));
    const query = this.createSelectorQuery ? this.createSelectorQuery() : wx.createSelectorQuery();
    query.select('.graph-viewport').boundingClientRect();
    query.exec(function (result) { const rect = result && result[0]; callback(rect && rect.width && rect.height ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, rpxToPx: width / 750, windowWidth: width } : fallback); });
  },
  openDisplaySettings: function () {
    const slug = this.displayPreferenceSlug();
    if (slug) wx.navigateTo({ url: '/pages/display-settings/index?exampleSlug=' + encodeURIComponent(slug) });
  },
  generatePoster: function () {
    const example = this.data.example;
    if (!example || this.data.posterGenerating || !this.data.nodes.length) return;
    const page = this;
    treePosterFlow.generate(this, {
      canvasId: 'example-poster-canvas',
      familyName: example.title || example.name || '示例家谱',
      prepareCode: function () {
        return examplePosterCode.get({
          slug: page.data.slug,
          viewMode: page.data.viewMode,
          viewPersonId: page.data.viewpointId
        });
      },
      onPrepared: function () {
        api.call('share.record', { stage: 'prepared', kind: 'example', slug: page.data.slug }).catch(function () {});
      },
      sharePayload: function () {
        return { kind: 'example', slug: page.data.slug };
      },
      entrancePath: function () {
        const path = '/pages/example/index?slug=' + encodeURIComponent(page.data.slug) + '&source=example_poster';
        return page.data.viewMode === 'perspective' && page.data.viewpointId
          ? path + '&personId=' + encodeURIComponent(page.data.viewpointId)
          : path;
      }
    });
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
    const app = typeof getApp === 'function' ? getApp() : {};
    const family = app.getCurrentFamily ? app.getCurrentFamily() : null;
    const memberAdUnitId = commerceConfig.resolveBanner(app.globalData && app.globalData.environment, 'memberSheet');
    if (person) this.setData({ selectedKinship: this.data.viewMode === 'perspective' ? kinship.memberKinshipCard(this._lastLayout && this._lastLayout.kinshipDetails, personId, this.data.viewpointName, this.data.rawPersons) : null,
      selectedPersonId: personId, selectedPerson: this.decorateSelectedPerson(person), showMemberSheet: true,
      memberAdUnitId: memberAdUnitId, memberAdVisible: Boolean(memberAdUnitId && !(family && family.membership && family.membership.active)) });
  },
  decorateSelectedPerson: function (person) {
    const node = (this._lastLayout && this._lastLayout.nodes || []).find(function (item) { return item._id === person._id; });
    return Object.assign({}, person, node ? { childRankLabel: node.childRankLabel || '' } : {}, memberActions.describe(person, this.data.rawPersons, this.data.rawRelations), {
      isCollapsed: this.data.collapsedPersonIds.indexOf(person._id) >= 0
    });
  },
  hideMemberAd: function () { this.setData({ memberAdVisible: false }); },
  clearGraphSelection: function () { if (this.data.selectedPersonId && !this.data.showMemberSheet) this.renderGraph(this.data.viewMode, this.data.viewpointId, { preserveViewport: true, selectedPersonId: '', statePatch: { selectedPersonId: '', selectedPerson: null } }); },
  closeMemberSheet: function () { this.setData({ showMemberSheet: false, selectedKinship: null }); },
  openPerspectiveSheet: function () { if (this.data.loading || this.data.error) return; this.setData({ showPerspectiveSheet: true, perspectiveKeyword: '', perspectiveResults: this.data.rawPersons }); },
  closePerspectiveSheet: function () { this.setData({ showPerspectiveSheet: false }); },
  filterPerspectives: function (event) { const keyword = (event.detail.value || '').trim(); this.setData({ perspectiveKeyword: keyword }); if (this._perspectiveFilterTimer) clearTimeout(this._perspectiveFilterTimer); const self = this; this._perspectiveFilterTimer = setTimeout(function () { self._perspectiveFilterTimer = null; self.setData({ perspectiveResults: self.data.rawPersons.filter(function (person) { return !keyword || person.name.indexOf(keyword) >= 0; }) }); }, 120); },
  selectPerspective: function (event) { this.setPerspective(event.currentTarget.dataset.id); this.closePerspectiveSheet(); },
  setPerspective: function (personId, options) {
    const collapsed = graphLayout.expandCollapsedIds(this.data.rawPersons, this.data.rawRelations, this.data.collapsedPersonIds, personId);
    this.renderGraph('perspective', personId, { initialView: Boolean(options && options.initialView), collapsedPersonIds: collapsed, selectedPersonId: '', statePatch: { viewMode: 'perspective', viewpointId: personId, collapsedPersonIds: collapsed, selectedPersonId: '', selectedPerson: null, showMemberSheet: false } });
  },
  useSelectedPerspective: function () { if (this.data.selectedPerson) { this.closeMemberSheet(); this.setPerspective(this.data.selectedPerson._id); } },
  showFullGraph: function () { if (this.data.loading || this.data.error) return; this.renderGraph('full', '', { initialView: true, selectedPersonId: '', statePatch: { viewMode: 'full', viewpointId: '', viewpointName: '', selectedPersonId: '', selectedPerson: null, showMemberSheet: false } }); },
  expandAllBranches: function () { if (this.data.autoCollapseEnabled && this.data.rawPersons.length > MAX_INTERACTIVE_NODES) return wx.showToast({ title: '家谱较大，请按分支展开', icon: 'none' }); this.renderGraph(this.data.viewMode, this.data.viewpointId, { collapsedPersonIds: [], statePatch: { collapsedPersonIds: [] } }); },
  expandBranch: function (event) { const id = event.currentTarget.dataset.id; let collapsed = this.data.collapsedPersonIds.filter(function (item) { return item !== id; }); if (this.data.autoCollapseEnabled && this.data.rawPersons.length > MAX_INTERACTIVE_NODES) collapsed = graphLayout.suggestCollapsedIds(this.data.rawPersons, this.data.rawRelations, { limit: MAX_INTERACTIVE_NODES, focusId: id }); this.renderGraph(this.data.viewMode, this.data.viewpointId, { collapsedPersonIds: collapsed, statePatch: { collapsedPersonIds: collapsed } }); },
  toggleSelectedBranch: function () { const person = this.data.selectedPerson; if (!person) return; const collapsed = this.data.collapsedPersonIds.slice(); const index = collapsed.indexOf(person._id); if (index >= 0) collapsed.splice(index, 1); else collapsed.push(person._id); this.renderGraph(this.data.viewMode, this.data.viewpointId, { collapsedPersonIds: collapsed, selectedPersonId: '', statePatch: { collapsedPersonIds: collapsed, selectedPersonId: '', selectedPerson: null, showMemberSheet: false } }); },
  openMemberDetail: function () { if (this.data.selectedPerson) wx.navigateTo({ url: exampleDetailUrl(this.data.slug, this.data.selectedPerson._id, this._shareSource) }); },
  explainCreate: function () { const self = this; wx.showModal({ title: '在自己的家谱中继续', content: '创建自己的家谱后，你可以添加亲属、编辑资料、管理关系并邀请家人共同维护。', confirmText: '去创建', success: function (result) { if (result.confirm) self.createFamily(); } }); },
  createFamily: function () {
    wx.navigateTo({ url: this._shareSource === 'share_menu'
      ? '/pages/create-family/index?source=share_menu&opened=1&example=' + encodeURIComponent(this.data.slug)
      : '/pages/create-family/index?source=example&example=' + encodeURIComponent(this.data.slug) });
  },
  prepareExampleShare: function () {
    const example = this.data.example || {};
    const self = this;
    const slug = this.data.slug;
    const requestId = this._loadRequestId;
    const options = {
      kind: 'example', exampleName: example.title, customTitle: example.shareTitle,
      path: '/pages/example/index?slug=' + encodeURIComponent(slug) + '&source=example_share'
    };
    this.setData({ shareCard: shareCard.create(options) });
    return shareCard.createAndRender(this, 'example-share-card', options).then(function (card) {
      if (!self._unloaded && !self._hidden && requestId === self._loadRequestId && slug === self.data.slug) self.setData({ shareCard: card });
    });
  },
  onShareAppMessage: function () {
    const card = this.data.shareCard || shareCard.create({ kind: 'example' });
    const slug = this.data.slug;
    api.call('share.record', { stage: 'prepared', kind: 'example', slug: slug }).catch(function () {});
    return {
      title: card.title,
      path: card.path + (this.data.viewMode === 'perspective' && this.data.viewpointId ? '&personId=' + encodeURIComponent(this.data.viewpointId) : ''),
      imageUrl: card.imageUrl,
      success: function () { api.call('share.record', { stage: 'sent', kind: 'example', slug: slug }).catch(function () {}); }
    };
  }
}));
