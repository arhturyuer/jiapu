const launchAd = require('../../utils/launch-ad');
Page(launchAd.wrap({
  onLoad: function (options) {
    wx.redirectTo({ url: '/pages/family-profile/index?familyId=' + encodeURIComponent(options.familyId || '') + '&edit=1' });
  }
}));
