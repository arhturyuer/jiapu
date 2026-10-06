const launchAd = require('../../utils/launch-ad');
const releaseInfo = require('../../utils/release-info');

Page(launchAd.wrap({
  data: {
    currentVersion: '',
    releaseNotes: []
  },

  onShow: function () {
    this.setData(releaseInfo.getAboutReleaseInfo(typeof wx === 'undefined' ? null : wx));
  }
}));
