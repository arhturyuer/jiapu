const launchAd = require('../../utils/launch-ad');
const app = getApp();
const api = require('../../utils/api');

Page(launchAd.wrap({
  data: { fromShare: false },

  onLoad: function (options) {
    const fromShare = Boolean(options && options.source === 'share_menu');
    this.setData({ fromShare: fromShare });
    if (!fromShare) return;
    app.ensureLogin().then(function () {
      return api.call('share.record', { stage: 'opened', kind: 'discovery' });
    }).catch(function () {});
  },

  openExamples: function () {
    wx.navigateTo({ url: '/pages/examples/index' + (this.data.fromShare ? '?source=share_menu' : '') });
  },

  createFamily: function () {
    wx.navigateTo({ url: '/pages/create-family/index' + (this.data.fromShare ? '?source=share_menu&opened=1' : '') });
  }
}));
