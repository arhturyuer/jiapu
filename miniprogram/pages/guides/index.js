const launchAd = require('../../utils/launch-ad');
const api = require('../../utils/api');
const growth = require('../../utils/growth');
Page(launchAd.wrap({
  data: { guides: [], settings: null, loading: true, error: '' },
  onShow: function () { this._guideVisible = true; return this.loadGuides(); },
  onHide: function () { this._guideVisible = false; this._guideRequest = (this._guideRequest || 0) + 1; },
  onUnload: function () { this._unloaded = true; this._guideVisible = false; this._guideRequest = (this._guideRequest || 0) + 1; },
  loadGuides: function () {
    const self = this; const request = this._guideRequest = (this._guideRequest || 0) + 1;
    this.setData({ guides: [], settings: null, loading: true, error: '' });
    const items = [];
    function fetchPage(cursor) {
      return api.call('public.guides.list', { pageSize: 100, cursor: cursor || '' }).then(function (data) {
        if (!self._guideVisible || self._unloaded || request !== self._guideRequest) return null;
        items.push.apply(items, data.items || []);
        if (data.hasMore && data.nextCursor && items.length < 2000) return fetchPage(data.nextCursor);
        if (data.hasMore) throw new Error('指南列表过大，请稍后重试');
        return data;
      });
    }
    return fetchPage('').then(function (data) {
      if (!data || !self._guideVisible || self._unloaded || request !== self._guideRequest) return;
      self.setData({ guides: items, settings: data.settings, loading: false });
      growth.record('view', 'pages/guides/index');
    }).catch(function (error) {
      if (!self._guideVisible || self._unloaded || request !== self._guideRequest) return;
      self.setData({ loading: false, error: api.userMessage(error, '修谱指南读取失败，请重试') });
    });
  },
  createFamily: function () { return growth.create('pages/guides/index'); },
  onShareAppMessage: function () { return { title: this.data.settings ? this.data.settings.title : '有谱修谱指南', path: '/pages/guides/index' }; }
}, 'pages/guides/index'));
