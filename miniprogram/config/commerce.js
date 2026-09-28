module.exports = {
  // 流量主开通后仅在对应环境填写。空字符串会让页面完全不渲染广告容器。
  bannerAdUnits: {
    staging: { family: '', profile: '', memberSheet: '' },
    production: { family: '', profile: '', memberSheet: '' }
  },
  resolveBanner: function (environment, placement) {
    const scope = environment === 'production' ? this.bannerAdUnits.production : this.bannerAdUnits.staging;
    return String((scope && scope[placement]) || '').trim();
  }
};
