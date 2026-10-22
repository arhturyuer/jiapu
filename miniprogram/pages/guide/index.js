const launchAd = require('../../utils/launch-ad');
const api = require('../../utils/api');
const growth = require('../../utils/growth');
Page(launchAd.wrap({
  data: { guide: null, related: [], loading: true, error: '' },
  onLoad: function (options) { this._guideSlug = options && options.slug || ''; },
  onShow: function () { this._guideVisible = true; return this.loadGuide(); },
  onHide: function () { this._guideVisible = false; this._guideRequest = (this._guideRequest || 0) + 1; },
  onUnload: function () { this._unloaded = true; this._guideVisible = false; this._guideRequest = (this._guideRequest || 0) + 1; },
  loadGuide: function () {
    const self = this; const request = this._guideRequest = (this._guideRequest || 0) + 1;
    this.setData({ guide: null, related: [], loading: true, error: '' });
    wx.setNavigationBarTitle({ title: '修谱指南' });
    return api.call('public.guides.get', { slug: this._guideSlug }).then(function (data) {
      if (!self._guideVisible || self._unloaded || request !== self._guideRequest) return;
      self.setData({ guide: data.guide, related: data.related || [], loading: false });
      wx.setNavigationBarTitle({ title: data.guide.title + ' · 有谱家谱' });
      growth.record('view', 'pages/guide/index', data.guide.slug);
    }).catch(function (error) {
      if (!self._guideVisible || self._unloaded || request !== self._guideRequest) return;
      self.setData({ loading: false, error: api.userMessage(error, '这篇指南暂不可用，请查看其他修谱指南。') });
    });
  },
  createFamily: function () { if (this.data.guide) return growth.create('pages/guide/index', this.data.guide.slug); },
  onShareAppMessage: function () { const guide = this.data.guide; return guide ? { title: guide.title, path: '/pages/guide/index?slug=' + guide.slug } : { title: '有谱修谱指南', path: '/pages/guides/index' }; }
}, 'pages/guide/index'));
