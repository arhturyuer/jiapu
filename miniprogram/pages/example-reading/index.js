const launchAd = require('../../utils/launch-ad');
const app = getApp();
const growth = require('../../utils/growth');
Page(launchAd.wrap({
  data: { loading: true, error: '', slug: '', example: null },
  onLoad: function (options) { this.setData({ slug: options && options.slug || '' }); return this.load(); },
  onUnload: function () { this._unloaded = true; this._request = (this._request || 0) + 1; },
  load: function () {
    const self = this; const request = this._request = (this._request || 0) + 1;
    this.setData({ loading: true, error: '' });
    if (!this.data.slug) { this.setData({ loading: false, error: '缺少示例信息，请从示例列表重新选择。' }); return; }
    return app.getExample(this.data.slug, { force: true }).then(function (data) {
      if (self._unloaded || request !== self._request) return;
      self.setData({ loading: false, example: data.example });
      wx.setNavigationBarTitle({ title: data.example.title + ' · 示例说明' });
      growth.record('view', 'pages/example-reading/index', self.data.slug);
    }).catch(function () { if (!self._unloaded && request === self._request) self.setData({ loading: false, error: '示例暂不可用或已下架，请重试或查看其他示例。' }); });
  },
  createFamily: function () { return growth.create('pages/example-reading/index', this.data.slug); }
}, 'pages/example-reading/index'));
