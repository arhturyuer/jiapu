const reading = require('../../utils/reading-preference');
const navigationLayout = require('../../utils/navigation-layout');

Component({
  options: { virtualHost: true },
  properties: {
    title: { type: String, value: '有谱' },
    titleSwitchable: { type: Boolean, value: false },
    home: { type: Boolean, value: false, observer: function () { if (this._attached) this.updateLayout(); } },
    pageGutter: { type: Boolean, value: false, observer: function () { if (this._attached) this.updateLayout(); } },
    back: { type: Boolean, value: false, observer: function () { if (this._attached) this.updateLayout(); } }
  },
  data: { height: 64, titleHeight: 44, navigationStyle: '', rowStyle: '', titleStyle: '', backStyle: '', canGoBack: false, homeNavigating: false },
  lifetimes: {
    attached: function () {
      this._attached = true;
      this._deviceHidden = false;
      reading.attach(this);
      this.updateLayout();
    },
    detached: function () { this._attached = false; this._deviceHidden = true; reading.detach(this); }
  },
  pageLifetimes: {
    show: function () { this._deviceHidden = false; this._homeNavigation = null; this.setData({ homeNavigating: false }); reading.attach(this); this.updateLayout(); },
    hide: function () { this._deviceHidden = true; reading.detach(this); },
    resize: function (event) {
      const size = event && (event.size || event);
      this.updateLayout(size);
      if (wx.nextTick) wx.nextTick(() => this.updateLayout(size));
    }
  },
  methods: {
    onReadingChange: function () { this.updateLayout(); },
    updateLayout: function (size) {
      if (!this._attached || this._deviceHidden) return;
      let info = {}, capsule;
      try { info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (error) {}
      try { capsule = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect(); } catch (error) {}
      const window = Object.assign({}, info, size || {});
      const result = navigationLayout.layout(window, capsule,
        { bodySize: this.data.readingBodySize, elderMode: this.data.elderMode, back: this.data.back || this.data.home, pageGutter: this.data.pageGutter });
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const patch = { height: result.height, titleHeight: result.rowHeight, canGoBack: pages.length > 1,
        navigationStyle: 'height:' + result.height + 'px;',
        rowStyle: 'top:' + result.status + 'px;height:' + result.rowHeight + 'px;',
        titleStyle: 'left:' + result.titleLeft + 'px;right:' + result.right + 'px;width:' + result.titleWidth + 'px;font-size:' + result.fontSize + 'px;',
        backStyle: 'left:' + result.left + 'px;width:' + result.target + 'px;height:' + result.target + 'px;' };
      const key = JSON.stringify(patch);
      if (key === this._layoutKey) return;
      this._layoutKey = key;
      this.setData(patch, () => {
        if (this._attached && !this._deviceHidden && key === this._layoutKey) this.triggerEvent('layout', { height: result.height,
          size: { windowWidth: window.windowWidth, windowHeight: window.windowHeight } });
      });
    },
    switchTitle: function () {
      if (!this._attached || this._deviceHidden || !this.data.titleSwitchable) return;
      this.triggerEvent('titleswitch');
    },
    goHome: function () {
      if (!this._attached || this._deviceHidden || !this.data.home || this._homeNavigation) return;
      const navigation = {};
      this._homeNavigation = navigation;
      this.setData({ homeNavigating: true });
      const failed = () => {
        if (this._homeNavigation !== navigation || !this._attached || this._deviceHidden) return;
        this._homeNavigation = null;
        this.setData({ homeNavigating: false });
        wx.showToast({ title: '暂时无法返回，请重试', icon: 'none' });
      };
      try {
        // Keep the lock through success; page show resets it if this page is retained.
        wx.switchTab({ url: '/pages/tree/index', fail: failed });
      } catch (error) { failed(); }
    },
    goBack: function () {
      const home = function () { wx.switchTab({ url: '/pages/tree/index' }); };
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      if (pages.length > 1) wx.navigateBack({ delta: 1, fail: home });
      else home();
    }
  }
});
