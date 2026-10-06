module.exports = {
  // 客户端原生模板开屏开关，与微信后台的封面广告开关独立。
  launchAdEnabled: { staging: true, production: true },
  // 人物广告用 wx.preloadAd 提前缓存数据；原生组件只在可见弹框内创建。
  memberAdDebugEnabled: { staging: false, production: false },
  // Only enable a platform after staging device checks confirm native video hides safely.
  memberAdReusePlatforms: { staging: { ios: true, android: true }, production: { ios: true, android: true } },
  launchAdUnits: {
    staging: 'adunit-84d9de0b742d77e1',
    production: 'adunit-84d9de0b742d77e1'
  },
  resolveLaunch: function (environment) {
    if (this.launchAdEnabled[environment] !== true) return '';
    return String(this.launchAdUnits[environment] || '').trim();
  },
  // 流量主开通后仅在对应环境填写。空字符串会让页面完全不渲染广告容器。
  bannerAdUnits: {
    staging: { treeTop: 'adunit-48f60f50925b53d9', family: '', profile: '', memberSheet: 'adunit-f0e7fed2bde51c0c' },
    production: { treeTop: 'adunit-48f60f50925b53d9', family: '', profile: '', memberSheet: 'adunit-f0e7fed2bde51c0c' }
  },
  resolveBanner: function (environment, placement) {
    const scope = this.bannerAdUnits[environment];
    return String((scope && scope[placement]) || '').trim();
  }
};
