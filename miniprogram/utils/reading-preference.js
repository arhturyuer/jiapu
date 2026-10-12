const STORAGE_KEY = 'youpu_reading_preference_v1';
const SCALES = [1, 1.25, 1.5, 2];
const listeners = new Set();
let preference = null;
let systemScale = 1;

function api() { return typeof wx === 'undefined' ? {} : wx; }

function normalize(value) {
  const source = value || {};
  return { elderMode: source.elderMode === true, fontScale: SCALES.indexOf(source.fontScale) >= 0 ? source.fontScale : 'system' };
}

function refreshSystem() {
  let info = {};
  try { if (api().getAppBaseInfo) info = api().getAppBaseInfo(); } catch (error) {}
  const scale = Number(info && info.fontSizeScaleFactor);
  systemScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return systemScale;
}

function get() {
  if (!preference) {
    try { preference = normalize(api().getStorageSync && api().getStorageSync(STORAGE_KEY)); } catch (error) { preference = normalize(); }
  }
  return Object.assign({}, preference);
}

function fontKey(size) { return '--reading-font-' + String(size).replace('.', '_'); }

function snapshot() {
  const value = get();
  const factor = value.fontScale === 'system' ? systemScale : value.fontScale;
  const modeFactor = value.elderMode ? 1.25 : 1;
  const style = ['--reading-body:' + (16 * modeFactor * factor) + 'px', '--reading-small:' + ((value.elderMode ? 18 : 14) * factor) + 'px',
    '--reading-target:' + (value.elderMode ? 60 : 44) + 'px', '--graph-content-scale:' + (modeFactor * factor)];
  // Cover existing half-pixel sizes without tying typography to window width.
  for (let size = 0.5; size <= 80; size += 0.5) {
    const base = size < 14 ? 14 : size < 16 ? 16 : size;
    style.push(fontKey(size) + ':' + Math.max(value.elderMode ? 18 : 14, base * modeFactor) * factor + 'px');
  }
  return Object.assign({}, value, { factor: factor, contentScale: modeFactor * factor,
    readingLarge: value.elderMode || factor > 1, readingStyle: style.join(';') + ';', bodySize: 16 * modeFactor * factor });
}

function notify() { listeners.forEach(function (listener) { listener(); }); }

function save(patch) {
  preference = normalize(Object.assign({}, get(), patch));
  let persisted = true;
  try { if (api().setStorageSync) api().setStorageSync(STORAGE_KEY, preference); else persisted = false; } catch (error) { persisted = false; }
  notify();
  return { preference: get(), persisted: persisted };
}

function reset() { return save({ elderMode: false, fontScale: 'system' }); }
function refresh() { const previous = systemScale; refreshSystem(); if (previous !== systemScale) notify(); }
function subscribe(listener) { listeners.add(listener); return function () { listeners.delete(listener); }; }

function sync(page) {
  const next = snapshot();
  const previous = page._readingSnapshot;
  page._readingSnapshot = next;
  if (previous && previous.readingStyle === next.readingStyle) return;
  page.setData({ elderMode: next.elderMode, readingLarge: next.readingLarge,
    readingStyle: next.readingStyle, readingBodySize: next.bodySize, graphContentScale: next.contentScale }, function () {
    if (page.onReadingChange) page.onReadingChange(previous, next);
    measureDock(page);
  });
}

function attach(page) {
  refresh();
  if (!page._readingUnsubscribe) page._readingUnsubscribe = subscribe(function () { if (!page._deviceHidden) sync(page); });
  sync(page);
}

function detach(page) {
  if (page._readingUnsubscribe) page._readingUnsubscribe();
  page._readingUnsubscribe = null;
  clearTimeout(page._readingDockTimer);
  page._readingDockTimer = null;
}

function measureDock(page) {
  if (page._deviceHidden || !page.createSelectorQuery || !/pages\/(add-member|edit-member|membership)\/index/.test(page.route || '')) return;
  clearTimeout(page._readingDockTimer);
  page._readingDockTimer = setTimeout(function () {
    page._readingDockTimer = null;
    if (page._deviceHidden) return;
    const query = page.createSelectorQuery();
    query.select('.submit-actions').boundingClientRect();
    query.select('.purchase-dock').boundingClientRect();
    query.exec(function (rects) {
      const rect = rects && (rects[0] || rects[1]);
      if (page._deviceHidden || !rect || !rect.height || rect.height === page._readingDockHeight) return;
      page._readingDockHeight = rect.height;
      page.setData({ readingDockStyle: '--reading-dock-space:' + (rect.height + 24) + 'px;' });
    });
  }, 0);
}

function watchDock(page) {
  if (page._readingDockWatched || !/pages\/(add-member|edit-member|membership)\/index/.test(page.route || '')) return;
  page._readingDockWatched = true;
  const original = page.setData;
  page.setData = function (patch, callback) {
    const result = original.call(this, patch, callback);
    if (!Object.prototype.hasOwnProperty.call(patch, 'readingDockStyle')) measureDock(this);
    return result;
  };
}

function open() { if (api().navigateTo) api().navigateTo({ url: '/pages/reading-settings/index' }); }

module.exports = { STORAGE_KEY: STORAGE_KEY, SCALES: SCALES, normalize: normalize, get: get, snapshot: snapshot,
  refresh: refresh, save: save, reset: reset, subscribe: subscribe, sync: sync, attach: attach, detach: detach,
  measureDock: measureDock, watchDock: watchDock, open: open };
