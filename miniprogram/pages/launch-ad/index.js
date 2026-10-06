const app = getApp();
const brand = require('../../config/brand');
const launchAd = require('../../utils/launch-ad');
const launchAdLayout = require('../../utils/launch-ad-layout');

Page({
  data: { brandLogo: brand.logo, brandSlogan: brand.launchSlogan,
    adUnitId: '', familyId: '', startupVisible: false, retrying: false, adVisible: false, loaded: false, seconds: 5, returning: false,
    safeTop: 64, safeBottom: 0, windowWidth: 375, windowHeight: 667, contentHeight: 487, templateWidth: 375 },
  onLoad: function () {
    this._hidden = false;
    const state = app._launchAd;
    if (!state || !state.target) {
      app._launchAd = { phase: 'finished', target: { path: 'pages/tree/index', query: {} } };
      this.finish();
      return;
    }
    if (state.phase === 'finished' || !state.unit) {
      this.finish();
      return;
    }
    this.setData({ startupVisible: true });
    this.updateLayout();
    return launchAd.prepare(app).then((family) => {
      if (this._hidden || this._unloaded || this._finished || this._buying) return;
      if (!family) return this.finish();
      this._loadTimer = setTimeout(() => this.finish(), 3000);
      this.setData({ adUnitId: state.unit, familyId: family._id, adVisible: true });
    });
  },
  updateLayout: function (size) {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {});
    const capsule = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
    const layout = launchAdLayout.fromWindow(Object.assign({}, info, size || {}), capsule, this._adRatio);
    this._windowSize = { width: layout.windowWidth, height: layout.windowHeight };
    this.setData(layout);
  },
  onResize: function (event) {
    if (!this._hidden && !this._unloaded && !this._finished) this.updateLayout(event && event.size);
  },
  onShow: function () {
    this._hidden = false;
    if (this._buying) {
      this._buying = false;
      this.finish();
    } else if (this._resumeAfterHide) this.finish();
  },
  onHide: function () {
    this._hidden = true;
    this.clearTimers();
    this.setData({ adVisible: false, loaded: false });
    this._resumeAfterHide = true;
    if (app._launchAd && app._launchAd.phase === 'checking') app._launchAd.phase = 'finished';
  },
  onUnload: function () {
    this._unloaded = true;
    this.clearTimers();
    if (app._launchAd && app._launchAd.phase === 'checking') app._launchAd.phase = 'finished';
  },
  clearTimers: function () {
    if (this._loadTimer) clearTimeout(this._loadTimer);
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    this._loadTimer = null;
    this._countdownTimer = null;
  },
  adLoad: function () {
    if (this._hidden || this._unloaded || this._finished || this._buying || this.data.loaded || !this.data.adVisible) return;
    this.clearTimers();
    this._deadline = Date.now() + 5000;
    this.setData({ loaded: true, seconds: 5 }, () => this.inspectLayout());
    this._countdownTimer = setInterval(() => {
      if (this._hidden || this._unloaded || this._finished) return;
      const seconds = Math.max(0, Math.ceil((this._deadline - Date.now()) / 1000));
      if (!seconds) this.finish();
      else this.setData({ seconds: seconds });
    }, 250);
  },
  inspectLayout: function () {
    if (!wx.createSelectorQuery
      || this._hidden || this._unloaded || this._finished || !this.data.adVisible) return;
    const query = wx.createSelectorQuery();
    const names = ['page', 'safeTop', 'content', 'template', 'nativeAd', 'actions'];
    ['.launch-page', '.launch-safe-top', '.launch-content', '.launch-template', '.launch-native-ad', '.launch-actions'].forEach(function (selector) {
      query.select(selector).boundingClientRect();
    });
    query.exec((rects) => {
      if (this._hidden || this._unloaded || this._finished || !this.data.adVisible) return;
      const nodes = {};
      names.forEach(function (name, index) {
        const rect = rects && rects[index];
        nodes[name] = rect ? { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom } : null;
      });
      const rect = nodes.nativeAd && nodes.nativeAd.height > 0 ? nodes.nativeAd : nodes.template;
      if (rect && rect.width > 0 && rect.height > 0) {
        this._adRatio = rect.height / rect.width;
        const width = launchAdLayout.fitWidth(this.data.windowWidth, this.data.contentHeight, this._adRatio);
        if (width !== this.data.templateWidth) this.setData({ templateWidth: width });
      }
      if (app.globalData.environment === 'staging') {
        console.info('开屏广告尺寸（staging）', { window: this._windowSize, nodes: nodes, templateWidth: this.data.templateWidth });
      }
    });
  },
  adError: function () { this.finish(); },
  adClose: function () { this.finish(); },
  finish: function () {
    if (this._finished || this._unloaded || this._hidden || this._buying) return;
    this._finished = true;
    this.clearTimers();
    const visible = this.data.startupVisible;
    const reset = { startupVisible: false, adVisible: false, loaded: false, returning: true, retrying: false };
    const restore = () => {
      if (this._unloaded) return;
      if (this._hidden) {
        this._finished = false;
        return;
      }
      launchAd.restore(app, { fail: () => {
        if (this._unloaded) return;
        this._finished = false;
        this.setData({ startupVisible: true, returning: false, retrying: true });
      } });
    };
    // Remove the rendered ad and controls before starting the page transition.
    // Disabled launches have no rendered content and can enter the target immediately.
    if (visible) this.setData(reset, restore);
    else {
      this.setData(reset);
      restore();
    }
  },
  openMembership: function () {
    if (this._hidden || this._unloaded || this._finished || this._buying || !this.data.loaded) return;
    const family = app.getCurrentFamily();
    if (!family || family._id !== this.data.familyId) return this.finish();
    this._buying = true;
    this.clearTimers();
    wx.navigateTo({ url: '/pages/membership/index?familyId=' + encodeURIComponent(family._id),
      fail: () => { this._buying = false; this.finish(); } });
  }
});
