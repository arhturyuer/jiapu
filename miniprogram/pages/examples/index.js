const launchAd = require('../../utils/launch-ad');
const app = getApp();
const api = require('../../utils/api');

Page(launchAd.wrap({
  data: {
    loading: true,
    error: '',
    examples: [],
    tags: [],
    activeTag: '',
    overflowById: {},
    expandedById: {},
    shareSource: ''
  },

  onLoad: function (options) {
    this._selectionMode = Boolean(options && options.select === '1');
    this.setData({ shareSource: options && options.source === 'share_menu' ? 'share_menu' : '' });
    this.loadExamples();
  },

  onUnload: function () { if (this._tagTimer) clearTimeout(this._tagTimer); },

  onPullDownRefresh: function () {
    if (this._tagTimer) clearTimeout(this._tagTimer);
    this.loadExamples({ force: true }).then(function () { wx.stopPullDownRefresh(); });
  },

  loadExamples: function (options) {
    const self = this;
    this.loadRequestId = (this.loadRequestId || 0) + 1;
    const requestId = this.loadRequestId;
    this.setData({ loading: true, error: '' });
    return app.getExamplesList(this.data.activeTag, options).then(function (data) {
      if (requestId !== self.loadRequestId) return;
      self.setData({
        loading: false,
        examples: (data.items || []).map(function (item) {
          return Object.assign({}, item, { initial: (item.title || '谱').slice(0, 1) });
        }),
        tags: data.tags || [],
        overflowById: {},
        expandedById: {}
      }, function () { self.measureDescriptions(requestId); });
    }).catch(function (error) {
      if (requestId !== self.loadRequestId) return;
      self.setData({ loading: false, error: api.userMessage(error, '示例家谱暂时不可用') });
    });
  },

  measureDescriptions: function (requestId) {
    if (!wx.createSelectorQuery || !this.data.examples.length) return;
    const self = this;
    wx.createSelectorQuery().in(this)
      .selectAll('.card-desc-visible').boundingClientRect()
      .selectAll('.card-desc-measure').boundingClientRect()
      .exec(function (results) {
        if (requestId !== self.loadRequestId) return;
        const visible = results[0] || [];
        const full = results[1] || [];
        const overflowById = {};
        self.data.examples.forEach(function (item, index) {
          if (visible[index] && full[index] && full[index].height > visible[index].height + 1) {
            overflowById[item._id] = true;
          }
        });
        self.setData({ overflowById: overflowById });
      });
  },

  toggleDescription: function (event) {
    const id = event.currentTarget.dataset.id;
    if (!id || !this.data.overflowById[id]) return;
    const expandedById = Object.assign({}, this.data.expandedById);
    expandedById[id] = !expandedById[id];
    this.setData({ expandedById: expandedById });
  },

  chooseTag: function (event) {
    const tag = event.currentTarget.dataset.tag || '';
    if (tag === this.data.activeTag) return;
    this.setData({ activeTag: tag });
    this.loadRequestId = (this.loadRequestId || 0) + 1;
    if (this._tagTimer) clearTimeout(this._tagTimer);
    const self = this;
    this._tagTimer = setTimeout(function () { self._tagTimer = null; self.loadExamples(); }, 200);
  },

  openExample: function (event) {
    const slug = event.currentTarget.dataset.slug;
    if (slug && this._selectionMode) {
      if (this._selectionSubmitted) return;
      this._selectionSubmitted = true;
      this.getOpenerEventChannel().emit('exampleSelected', { slug: slug });
      const self = this;
      wx.navigateBack({ fail: function () { self._selectionSubmitted = false; } });
      return;
    }
    if (slug) wx.navigateTo({ url: '/pages/example/index?slug=' + encodeURIComponent(slug) + (this.data.shareSource ? '&source=share_menu' : '') });
  },

  createFamily: function () {
    wx.navigateTo({ url: this.data.shareSource
      ? '/pages/create-family/index?source=share_menu&opened=1'
      : '/pages/create-family/index?source=examples' });
  }
}));
