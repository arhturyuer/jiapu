const launchAd = require('../../utils/launch-ad');
const app = getApp();
const growth = require('../../utils/growth');

Page(launchAd.wrap({
  data: { fromShare: false },

  onLoad: function (options) {
    const fromShare = Boolean(options && options.source === 'share_menu');
    this.setData({ fromShare: fromShare });
    if (fromShare && !this._shareOpenRecorded) {
      this._shareOpenRecorded = true;
      growth.shareOpen('discovery');
    }
  },

  enterFamily: function () { wx.switchTab({ url: '/pages/tree/index' }); },

  openExamples: function () {
    wx.navigateTo({ url: '/pages/examples/index' + (this.data.fromShare ? '?source=share_menu' : '') });
  },

  createFamily: function () {
    return growth.create('pages/share-intro/index', '', '/pages/create-family/index' + (this.data.fromShare ? '?source=share_menu&opened=1' : ''));
  }
}, 'pages/share-intro/index'));
