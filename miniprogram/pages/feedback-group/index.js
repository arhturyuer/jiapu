const launchAd = require('../../utils/launch-ad');
const api = require('../../utils/api');
const app = getApp();
const profileImages = require('../../utils/profile-image-cache');

Page(launchAd.wrap({
  data: { loading: true, error: '', available: false, qrCodeUrl: '' },

  onShow: function () { this._hidden = false; this.loadFeedbackGroup(); },
  onHide: function () { this._hidden = true; this._version = (this._version || 0) + 1; },
  onUnload: function () { this.onHide(); },

  loadFeedbackGroup: function (options) {
    const self = this;
    const force = Boolean(options && (options.force || options.type === 'tap'));
    const cached = !force && profileImages.peekFeedback(app);
    const version = this._version = (this._version || 0) + 1;
    const scope = JSON.stringify([app.globalData.env, app._sessionVersion || 0]);
    let actor = app.globalData.user && app.globalData.user._id || '';
    function current() {
      return !self._hidden && version === self._version && scope === JSON.stringify([app.globalData.env, app._sessionVersion || 0]) &&
        (!actor || actor === (app.globalData.user && app.globalData.user._id || ''));
    }
    this.setData({ loading: !cached, error: '', available: Boolean(cached), qrCodeUrl: cached ? cached.qrCodeUrl : '' });
    return app.ensureLogin().then(function () {
      if (!current()) return null;
      actor = app.globalData.user && app.globalData.user._id || '';
      return profileImages.getFeedback(app, { force: force });
    }).then(function (data) {
      if (!data || !current()) return;
      self.setData({ loading: false, available: Boolean(data.available && data.qrCodeUrl), qrCodeUrl: data.qrCodeUrl || '' });
    }).catch(function (error) {
      if (!current()) return;
      self.setData({ loading: false, error: api.userMessage(error, '反馈群信息加载失败，请稍后重试') });
    });
  },

  qrError: function (event) {
    if (this._hidden || event.currentTarget.dataset.url !== this.data.qrCodeUrl) return;
    profileImages.discardFeedback(app);
    this.setData({ available: false, qrCodeUrl: '', error: '二维码加载失败，请重新加载' });
  },

  previewQrCode: function () {
    if (!this.data.qrCodeUrl) return;
    wx.previewImage({ current: this.data.qrCodeUrl, urls: [this.data.qrCodeUrl], showmenu: true });
  }
}));
