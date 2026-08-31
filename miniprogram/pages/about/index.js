const releaseInfo = require('../../utils/release-info');

Page({
  data: {
    currentVersion: '',
    releaseNotes: []
  },

  onShow: function () {
    this.setData(releaseInfo.getAboutReleaseInfo(typeof wx === 'undefined' ? null : wx));
  }
});
