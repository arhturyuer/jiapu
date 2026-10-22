const commerceConfig = require('../config/commerce');
const adAccess = require('./ad-access');
const deviceLayout = require('./device-layout');
const publicContent = require('./public-content');
const growth = require('./growth');
const LAUNCH_PAGE = 'pages/launch-ad/index';
const TAB_PAGES = ['pages/tree/index', 'pages/members/index', 'pages/profile/index'];

function begin(app, options) {
  const unit = commerceConfig.resolveLaunch(app.globalData.environment);
  const supported = typeof wx.canIUse === 'function' && wx.canIUse('ad-custom');
  const entry = options || {};
  const target = publicContent.defaultTarget(entry, Boolean(app._preferredFamilyId || app.globalData.currentFamily || app.getCurrentFamily && app.getCurrentFamily()));
  app._launchAd = { phase: !publicContent.isPublic(target.path) && unit && supported ? 'pending' : 'finished', unit: unit,
    entry: entry, target: target, family: null };
}

// Membership is checked on the launch page, never while a business page is visible.
function prepare(app) {
  const state = app._launchAd;
  if (!state || (state.phase !== 'pending' && state.phase !== 'routing')) return Promise.resolve(null);
  state.phase = 'checking';
  return Promise.resolve().then(function () {
    if (state.phase !== 'checking') return;
    return app.loadFamilies({ force: true });
  }).then(function () {
    if (state.phase !== 'checking') return null;
    const family = app.getCurrentFamily();
    if (!adAccess.eligible(family)) {
      state.phase = 'finished';
      return null;
    }
    state.family = family;
    state.phase = 'showing';
    return family;
  }).catch(function () {
    if (state.phase === 'checking') state.phase = 'finished';
    return null;
  });
}

function url(target) {
  const query = Object.keys(target.query || {}).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(String(target.query[key]));
  }).join('&');
  return '/' + target.path + (query ? '?' + query : '');
}

function restore(app, callbacks) {
  const state = app._launchAd;
  if (!state || !state.target) return;
  state.phase = 'finished';
  state.restoring = true;
  const target = state.target;
  const options = Object.assign({}, callbacks, { url: TAB_PAGES.indexOf(target.path) >= 0 ? '/' + target.path : url(target) });
  if (TAB_PAGES.indexOf(target.path) >= 0) wx.switchTab(options);
  else wx.redirectTo(options);
}

// Wrap page definitions explicitly, leaving the global Page constructor intact.
// Deferred lifecycle calls also support retained tab pages after switchTab.
function wrap(definition, publicPath) {
  const app = getApp();
  if (publicPath) {
    ['onLoad', 'onShow'].forEach(function (name) {
      const original = definition[name];
      definition[name] = function () {
        app._publicBrowsing = true;
        this._growthHidden = false;
        const page = this;
        const result = original && original.apply(page, arguments);
        Promise.resolve(result).then(function () {
          if (page._unloaded || page._growthHidden || page._hidden || page.data.loading || page.data.error) return;
          if (publicPath === 'pages/legal/index') return;
          const slug = page.data.slug || page.data.guide && page.data.guide.slug || '';
          Promise.resolve(page._landingReceipt).then(function () {
            if (!page._growthHidden && !page._unloaded) growth.record(publicPath === 'pages/example/index' ? 'example' : 'view', publicPath, slug, page.data.isDefaultEntry ? 'default_example' : '');
          });
        }).catch(function () {});
        return result;
      };
    });
    ['onHide', 'onUnload'].forEach(function (name) {
      const original = definition[name];
      definition[name] = function () { this._growthHidden = true; if (original) return original.apply(this, arguments); };
    });
    return deviceLayout.wrap(definition);
  }
  const originals = {};
  ['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload'].forEach(function (name) { originals[name] = definition[name]; });
  function enqueue(page, name, args) {
    const queue = page._launchGate.queue;
    const existing = queue.find(function (item) { return item.name === name; });
    if (existing) existing.args = args;
    else queue.push({ name: name, args: args });
  }
  function resume(page) {
    const gate = page._launchGate;
    if (!gate || gate.unloaded || !gate.visible) return;
    page._launchGate = null;
    if (app._launchAd && app._launchAd.target && page.route === app._launchAd.target.path) app._launchAd.restoring = false;
    let result;
    gate.queue.forEach(function (item) {
      if (originals[item.name]) result = originals[item.name].apply(page, item.args);
    });
    return result;
  }
  definition.onLoad = function (options) {
    const page = this;
    app._publicBrowsing = false;
    const state = app._launchAd;
    if (!state || state.phase !== 'pending') {
      if (state && state.restoring && state.target && page.route === state.target.path) {
        options = state.target.query;
        state.restoring = false;
      }
      return originals.onLoad && originals.onLoad.call(page, options);
    }
    state.phase = 'routing';
    state.target = { path: page.route || state.entry.path || 'pages/tree/index', query: Object.assign({}, options || state.entry.query || {}) };
    page._launchGate = { queue: [], visible: true, unloaded: false };
    enqueue(page, 'onLoad', [options]);
    wx.redirectTo({ url: '/' + LAUNCH_PAGE, fail: function () {
      state.phase = 'finished';
      resume(page);
    } });
  };
  ['onShow', 'onReady'].forEach(function (name) {
    definition[name] = function () {
      if (name === 'onShow') app._publicBrowsing = false;
      if (!this._launchGate) return originals[name] && originals[name].apply(this, arguments);
      if (name === 'onShow') this._launchGate.visible = true;
      enqueue(this, name, Array.from(arguments));
      if (app._launchAd.phase === 'finished') return resume(this);
    };
  });
  ['onHide', 'onUnload'].forEach(function (name) {
    definition[name] = function () {
      if (!this._launchGate) return originals[name] && originals[name].apply(this, arguments);
      this._launchGate.visible = false;
      if (name === 'onUnload') this._launchGate.unloaded = true;
    };
  });
  return deviceLayout.wrap(definition);
}

module.exports = { begin: begin, prepare: prepare, wrap: wrap, restore: restore, url: url };
