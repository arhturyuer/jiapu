const launchAd = require('../../utils/launch-ad');
const app = getApp();

Page(launchAd.wrap({
  data: { message: '正在打开家谱…' },
  onLoad: function (options) {
    const familyId = options.familyId || '';
    if (!familyId) return this.setData({ message: '家谱链接缺少信息' });
    const self = this;
    app.ensureLogin().then(function () {
      return app.loadFamilyPages(true, { force: true });
    }).then(function (result) {
      const family = (result.families || []).find(function (item) { return item._id === familyId && item.status === 'active'; });
      if (!family) throw new Error('这份家谱已无法访问');
      app.setCurrentFamily(family);
      wx.switchTab({ url: '/pages/members/index' });
    }).catch(function () { self.setData({ message: '这份家谱已无法访问，请从家庭页查看。' }); });
  },
  goFamily: function () { wx.switchTab({ url: '/pages/members/index' }); }
}));
