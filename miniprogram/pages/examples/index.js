const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    error: '',
    examples: [],
    tags: [],
    activeTag: ''
  },

  onLoad: function () { this.loadExamples(); },

  onPullDownRefresh: function () {
    this.loadExamples().then(function () { wx.stopPullDownRefresh(); });
  },

  loadExamples: function () {
    const self = this;
    this.setData({ loading: true, error: '' });
    return api.call('examples.list', { tag: this.data.activeTag }).then(function (data) {
      self.setData({
        loading: false,
        examples: (data.items || []).map(function (item) {
          return Object.assign({}, item, { initial: (item.title || '谱').slice(0, 1) });
        }),
        tags: data.tags || []
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: api.userMessage(error, '示例家谱暂时不可用') });
    });
  },

  chooseTag: function (event) {
    const tag = event.currentTarget.dataset.tag || '';
    if (tag === this.data.activeTag) return;
    this.setData({ activeTag: tag }, this.loadExamples);
  },

  openExample: function (event) {
    const slug = event.currentTarget.dataset.slug;
    if (slug) wx.navigateTo({ url: '/pages/example/index?slug=' + encodeURIComponent(slug) });
  },

  createFamily: function () {
    wx.navigateTo({ url: '/pages/create-family/index?source=examples' });
  }
});
