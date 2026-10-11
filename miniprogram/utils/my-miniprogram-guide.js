const capabilities = require('./platform-capabilities');
const BROWSE_DELAY = 15000;
const DISPLAY_DURATION = 8000;
const REMINDER_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const QUERY_TIMEOUT = 3000;

function scope(app) {
  const data = app.globalData || {};
  const actor = data.user && data.user._id;
  return actor && data.environment ? 'youpu_my_miniprogram_' + data.environment + '_' + actor : '';
}

function read(key, platform) {
  if (!key) return null;
  try {
    const record = platform.getStorageSync(key);
    if (!record || typeof record !== 'object' || !Number.isInteger(record.shownCount)
      || record.shownCount < 0 || record.shownCount > 2) return null;
    return record;
  } catch (error) { return null; }
}

function write(key, record, platform) {
  try { platform.setStorageSync(key, record); } catch (error) { /* Optional local guidance. */ }
}

function due(record, now) {
  if (!record || record.added || record.shownCount >= 2) return false;
  if (record.shownCount === 0) return true;
  return Number.isFinite(record.lastShownAt) && now - record.lastShownAt >= REMINDER_INTERVAL;
}

function ready(page, app) {
  const data = page.data;
  const key = scope(app);
  return Boolean(key && app.globalData.loggedIn === true && page._myMiniProgramGraphScope === key
    && data.currentFamily && page._myMiniProgramGraphFamilyId === data.currentFamily._id
    && !data.loading && !data.loadError && !data.accountPending && data.nodes.length > 0 && !data.graphRendering);
}

function eligible(page, app) {
  const data = page.data;
  if (!ready(page, app)) return false;
  return !page._pageHidden && !page._hidden && !page._unloaded && !page._launchGate
    && !data.loading && !data.loadError && !data.accountPending && data.currentFamily
    && data.nodes.length > 0 && !data.graphRendering && !data.isLandscape && !data.isCleanScreen
    && !data.orientationChanging && !page._myMiniProgramTourActive && !page._myMiniProgramNotificationsActive && !page._graphGestureActive
    && !page._gesturePending && !data.posterGenerating
    && !data.showMemberSheet && !data.showFamilySheet && !data.showPerspectiveSheet
    && !data.showChildOrderSheet && !data.showShareSheet;
}

function placement(platform) {
  let windowWidth = 375;
  let menu;
  try {
    const info = platform.getWindowInfo ? platform.getWindowInfo() : platform.getSystemInfoSync();
    if (Number.isFinite(info.windowWidth) && info.windowWidth > 0) windowWidth = info.windowWidth;
    menu = platform.getMenuButtonBoundingClientRect && platform.getMenuButtonBoundingClientRect();
  } catch (error) { /* Use the page's top-right corner when menu geometry is unavailable. */ }
  const width = Math.min(300, windowWidth - 32);
  // The page starts below the native navigation bar, not at screen y=0.
  // Only the horizontal screen coordinate is shared with page coordinates.
  const target = menu && menu.width > 0 && menu.left > 0 ? menu.left + menu.width / 4 : windowWidth - 60;
  const arrow = Math.max(20, Math.min(width - 20, target - (windowWidth - 16 - width)));
  return { myMiniProgramGuideStyle: 'top:12px;right:16px;width:' + width + 'px;', myMiniProgramGuideArrowStyle: 'left:' + arrow + 'px;' };
}

function checkAdded(runtime, callback) {
  let finished = false;
  const timer = runtime.setTimeout(function () { finish(null); }, QUERY_TIMEOUT);
  function finish(value) {
    if (finished) return;
    finished = true;
    runtime.clearTimeout(timer);
    callback(value);
  }
  try {
    if (typeof runtime.wx.checkIsAddedToMyMiniProgram !== 'function') finish(null);
    else runtime.wx.checkIsAddedToMyMiniProgram({
      success: function (result) { finish(result && typeof result.added === 'boolean' ? result.added : null); },
      fail: function () { finish(null); }
    });
  } catch (error) { finish(null); }
  return function () { finished = true; runtime.clearTimeout(timer); };
}

function create(page, app, injected) {
  const runtime = injected || { wx: wx, now: Date.now, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval };
  let key = '';
  const owner = {};
  page._myMiniProgramGuideOwner = owner;
  let record = null;
  let interval;
  let completionTimer;
  let displayTimer;
  let queryCancel;
  let queryVersion = 0;
  let familyId = '';
  let readyAt = null;
  let shownAt = null;
  let presenting = false;
  let restoreTopAd = false;
  let stopped = false;

  function hide(restore) {
    if (page._myMiniProgramGuideOwner !== owner || !page.data.showMyMiniProgramGuide) return;
    page.setData({ showMyMiniProgramGuide: false });
    if (restore && restoreTopAd && !page._pageHidden && !page._hidden && !page._unloaded
      && key === scope(app) && page.data.currentFamily && page.data.currentFamily._id === familyId
      && !page.data.loading && !page.data.loadError && !page.data.accountPending && page.refreshTreeAd) {
      page.refreshTreeAd().catch(function () {});
    }
  }
  function cancelQuery() {
    queryVersion += 1;
    if (queryCancel) queryCancel();
    runtime.clearTimeout(completionTimer);
    queryCancel = null;
  }
  function stop(restore) {
    stopped = true;
    runtime.clearInterval(interval);
    runtime.clearTimeout(displayTimer);
    cancelQuery();
    hide(restore);
  }
  function sync() {
    if (stopped) return;
    if (!capabilities.canGuide(runtime.wx)) { stop(false); return; }
    if ((key && key !== scope(app)) || page._myMiniProgramGuideOwner !== owner) { stop(false); return; }
    const now = runtime.now();
    if (!key && ready(page, app)) {
      key = scope(app);
      record = read(key, runtime.wx);
      if (!record) {
        record = { shownCount: 0, lastShownAt: 0, added: false };
        write(key, record, runtime.wx);
      }
      if (!due(record, now)) { stop(false); return; }
      interval = runtime.setInterval(sync, 250);
    }
    const currentId = page.data.currentFamily && page.data.currentFamily._id;
    if (currentId !== familyId || !eligible(page, app)) {
      readyAt = null;
      cancelQuery();
      if (shownAt !== null || presenting) { stop(true); return; }
      familyId = currentId || '';
      if (!eligible(page, app)) return;
    }
    if (shownAt !== null) {
      if (now - shownAt >= DISPLAY_DURATION) stop(true);
      return;
    }
    if (!due(record, now)) { readyAt = null; return; }
    if (readyAt === null) readyAt = now;
    if (now - readyAt < BROWSE_DELAY || queryCancel || presenting) return;
    const version = ++queryVersion;
    // Defer completion so even a synchronous platform/mock callback cannot
    // race assignment of the cancellation handle.
    queryCancel = checkAdded(runtime, function (added) {
      completionTimer = runtime.setTimeout(function () {
        if (stopped || version !== queryVersion || key !== scope(app) || page._myMiniProgramGuideOwner !== owner) return;
        if (!eligible(page, app) || familyId !== page.data.currentFamily._id) {
          readyAt = null;
          cancelQuery();
          return;
        }
        queryCancel = null;
        if (added !== false) {
          if (added === true) write(key, Object.assign({}, record, { added: true, pendingFamilyId: '' }), runtime.wx);
          stop(false);
          return;
        }
        const latest = read(key, runtime.wx);
        if (!due(latest, runtime.now())) { stop(false); return; }
        presenting = true;
        restoreTopAd = Boolean(page.data.topAdVisible);
        if (restoreTopAd && page.dismissTopAd) page.dismissTopAd();
        page.setData(Object.assign({ showMyMiniProgramGuide: true }, placement(runtime.wx)), function () {
          if (stopped || version !== queryVersion || page._myMiniProgramGuideOwner !== owner) return;
          if (key !== scope(app) || !eligible(page, app) || familyId !== page.data.currentFamily._id
            || !page.data.showMyMiniProgramGuide) { stop(true); return; }
          shownAt = runtime.now();
          record = Object.assign({}, latest, { pendingFamilyId: '', shownCount: latest.shownCount + 1, lastShownAt: shownAt });
          write(key, record, runtime.wx);
          displayTimer = runtime.setTimeout(function () { stop(true); }, DISPLAY_DURATION);
        });
      }, 0);
    });
  }
  sync();
  return { sync: sync, stop: stop, pause: function () {
    readyAt = null;
    cancelQuery();
    if (shownAt !== null || presenting) stop(false);
  }, dismiss: function () { stop(true); } };
}

function dismissManual(page) {
  page._myMiniProgramManualVersion = (page._myMiniProgramManualVersion || 0) + 1;
  if (page._myMiniProgramManualTimer) clearTimeout(page._myMiniProgramManualTimer);
  page._myMiniProgramManualTimer = null;
  if (page.data.showMyMiniProgramGuide) page.setData({ showMyMiniProgramGuide: false });
}

function showManual(page) {
  if (!capabilities.canGuide()) return;
  if (page._unloaded || page._feedbackHidden || page.data.resettingTestAccount) return;
  dismissManual(page);
  const version = page._myMiniProgramManualVersion;
  // Explicit viewing is immediate and never changes the automatic reminder budget.
  page.setData(Object.assign({ showMyMiniProgramGuide: true }, placement(wx)), function () {
    if (version !== page._myMiniProgramManualVersion || page._unloaded || page._feedbackHidden) return;
    page._myMiniProgramManualTimer = setTimeout(function () {
      if (version === page._myMiniProgramManualVersion) dismissManual(page);
    }, DISPLAY_DURATION);
  });
}

function wrap(definition) {
  const app = getApp();
  Object.assign(definition.data, { showMyMiniProgramGuide: false, myMiniProgramGuideStyle: '', myMiniProgramGuideArrowStyle: '' });
  const onShow = definition.onShow;
  definition.onShow = function () {
    if (this._myMiniProgramGuide) this._myMiniProgramGuide.stop(false);
    const result = onShow && onShow.apply(this, arguments);
    this._myMiniProgramGuide = create(this, app);
    return result;
  };
  ['onHide', 'onUnload'].forEach(function (name) {
    const original = definition[name];
    definition[name] = function () {
      if (this._myMiniProgramGuide) this._myMiniProgramGuide.stop(false);
      return original && original.apply(this, arguments);
    };
  });
  // Synchronously withdraw a visible guide when an operation starts; the
  // lightweight timer handles asynchronous loading and layout completion.
  ['onGraphGestureState', 'switchFamily', 'toggleCleanScreen', 'togglePageOrientation', 'onPageResize',
    'openFamilySheet', 'showPerson', 'openMemberActions', 'openPerspectiveSheet', 'openChildOrderSheet',
    'openShareSheet', 'generatePoster', 'requestNotifications', 'loadPage'].forEach(function (name) {
    const original = definition[name];
    if (!original) return;
    definition[name] = function () {
      if (this._myMiniProgramGuide && (name === 'switchFamily' || name === 'loadPage')) this._myMiniProgramGuide.pause();
      const result = original.apply(this, arguments);
      if (this._myMiniProgramGuide) this._myMiniProgramGuide.sync();
      return result;
    };
  });
  return definition;
}

module.exports = { scope: scope, due: due, placement: placement, create: create, showManual: showManual, dismissManual: dismissManual, wrap: wrap };
