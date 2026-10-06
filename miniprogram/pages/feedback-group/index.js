const launchAd = require('../../utils/launch-ad');
const api = require('../../utils/api');

Page(launchAd.wrap({
  data: { loading: true, error: '', available: false, qrCodeUrl: '' },

  onShow: function () { this.loadFeedbackGroup(); },

  loadFeedbackGroup: function () {
    const self = this;
    this.setData({ loading: true, error: '' });
    return api.call('feedbackGroup.get').then(function (data) {
      self.setData({ loading: false, available: Boolean(data.available && data.qrCodeUrl), qrCodeUrl: data.qrCodeUrl || '' });
    }).catch(function (error) {
      self.setData({ loading: false, error: api.userMessage(error, '反馈群信息加载失败，请稍后重试') });
    });
  },

  previewQrCode: function () {
    if (!this.data.qrCodeUrl) return;
    wx.previewImage({ current: this.data.qrCodeUrl, urls: [this.data.qrCodeUrl], showmenu: true });
  }
}));
