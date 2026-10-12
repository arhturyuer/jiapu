const reading = require('./reading-preference');

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function fromInfo(info, size) {
  const device = info || {};
  const window = Object.assign({}, device, size || {});
  const width = positive(window.windowWidth, 375);
  const height = positive(window.windowHeight, 667);
  const platform = String(device.platform || '').toLowerCase();
  const desktop = ['windows', 'mac', 'linux'].indexOf(platform) >= 0;
  const tablet = /ipad|tablet|\bpad\b/i.test(String(device.model || '') + ' ' + String(device.deviceType || ''));
  return { width: width, height: height, platform: platform, desktop: desktop,
    largeDevice: desktop || tablet, wide: width >= 600,
    mode: width >= 1024 ? 'expanded' : width >= 600 ? 'medium' : 'compact',
    landscape: width > height, uiUnit: width >= 600 ? 0.5 : width / 750 };
}

function read(api, size) {
  const platform = api || (typeof wx !== 'undefined' ? wx : {});
  let device = {}, window = {};
  try { device = platform.getDeviceInfo ? platform.getDeviceInfo() : platform.getSystemInfoSync ? platform.getSystemInfoSync() : {}; } catch (error) {}
  try { window = platform.getWindowInfo ? platform.getWindowInfo() : device; } catch (error) {}
  return fromInfo(Object.assign({}, device, window), size);
}

function sync(page, size) {
  const layout = read(null, size);
  const patch = { deviceLayout: layout.mode, isDesktop: layout.desktop, isLargeDevice: layout.largeDevice, isWide: layout.wide };
  if (layout.largeDevice && Object.prototype.hasOwnProperty.call(page.data, 'pageOrientation')) patch.pageOrientation = 'auto';
  page.setData(patch);
  page._deviceLayout = layout;
  return layout;
}

function clear(page) {
  clearTimeout(page._deviceResizeTimer);
  page._deviceResizeTimer = null;
  page._deviceResizeSize = null;
}

function wrap(definition) {
  definition.data = Object.assign({ deviceLayout: 'compact', isDesktop: false, isLargeDevice: false, isWide: false }, definition.data);
  ['onLoad', 'onShow'].forEach(function (name) {
    const original = definition[name];
    definition[name] = function () {
      this._deviceHidden = false;
      reading.watchDock(this);
      reading.attach(this);
      const layout = sync(this);
      const result = original && original.apply(this, arguments);
      if (name === 'onShow' && !this._launchGate && this.applyPageResize && layout.largeDevice) {
        this.onResize({ size: { windowWidth: layout.width, windowHeight: layout.height } });
      }
      return result;
    };
  });
  const resize = definition.onResize;
  definition.onResize = function (event) {
    if (this._deviceHidden) return;
    const size = event && event.size;
    sync(this, size);
    if (resize) resize.call(this, event);
    if (!this.applyPageResize || !size) return;
    this._orientationResizeSequence = (this._orientationResizeSequence || 0) + 1;
    // page-meta and Page.onResize can both report the same frame. Commit the
    // latest size once, without re-running the graph layout or losing gestures.
    this._deviceResizeSize = size;
    if (this._deviceResizeTimer) return;
    const page = this;
    this._deviceResizeTimer = setTimeout(function () {
      page._deviceResizeTimer = null;
      const latest = page._deviceResizeSize;
      page._deviceResizeSize = null;
      if (!page._deviceHidden && latest) page.applyPageResize(latest);
    }, 60);
  };
  ['onHide', 'onUnload'].forEach(function (name) {
    const original = definition[name];
    definition[name] = function () {
      this._deviceHidden = true;
      reading.detach(this);
      clear(this);
      return original && original.apply(this, arguments);
    };
  });
  const ready = definition.onReady;
  definition.onReady = function () {
    const result = ready && ready.apply(this, arguments);
    reading.measureDock(this);
    return result;
  };
  if (!definition.openReadingSettings) definition.openReadingSettings = reading.open;
  return definition;
}

module.exports = { fromInfo: fromInfo, read: read, sync: sync, wrap: wrap };
