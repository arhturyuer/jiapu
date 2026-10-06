const commerce = require('../config/commerce');
const LOAD_TIMEOUT = 10000;

function afterView() {
  return new Promise(function (resolve) {
    if (typeof wx !== 'undefined' && wx.nextTick) wx.nextTick(resolve);
    else setTimeout(resolve, 0);
  });
}

function commit(page, patch) {
  return new Promise(function (resolve) { page.setData(patch, resolve); });
}

function measure(page, selectors) {
  return new Promise(function (resolve) {
    try {
      const query = page.createSelectorQuery ? page.createSelectorQuery()
        : (typeof wx !== 'undefined' && wx.createSelectorQuery ? wx.createSelectorQuery().in(page) : null);
      if (!query) return resolve([]);
      selectors.forEach(function (selector) { query.select(selector).boundingClientRect(); });
      query.exec(function (rects) { resolve(rects || []); });
    } catch (error) { resolve([]); }
  });
}

function diagnose(page, app, stage, rects) {
  if (!app.globalData || app.globalData.environment !== 'staging'
    || !commerce.memberAdDebugEnabled.staging) return;
  console.info('人物广告尺寸（staging）', {
    stage: stage, sheetOpen: Boolean(page.data.showMemberSheet),
    mounted: Boolean(page.data.memberAdMounted), loaded: Boolean(page.data.memberAdLoaded),
    dataPreloadState: page._memberAdCache && page._memberAdCache.dataPreloadState || 'idle',
    width: page.data.memberAdWidth || 0, version: page.data.memberAdVersion,
    nodes: (rects || []).map(function (rect) {
      return rect ? { width: rect.width, height: rect.height } : null;
    })
  });
}

function inspect(page, app, stage) {
  if (!app.globalData || app.globalData.environment !== 'staging'
    || !commerce.memberAdDebugEnabled.staging) return;
  const cache = page._memberAdCache;
  const version = page.data.memberAdVersion;
  afterView().then(function () {
    return measure(page, ['.member-sheet-ad-visible-slot', '.member-sheet-ad']);
  }).then(function (rects) {
    if (cache && cache === page._memberAdCache && cache.valid() && version === page.data.memberAdVersion) {
      diagnose(page, app, stage, rects);
    }
  });
}

function clearLoadTimer(cache) {
  if (cache && cache.loadTimer) clearTimeout(cache.loadTimer);
  if (cache) cache.loadTimer = null;
}

function remove(page, cache) {
  clearLoadTimer(cache);
  if (!page._adVersions) page._adVersions = {};
  const version = Math.max(page.data.memberAdVersion || 0, page._adVersions.memberAdVersion || 0) + 1;
  page._adVersions.memberAdVersion = version;
  if (cache) cache.version = version;
  page.setData({ memberAdVersion: version, memberAdMounted: false, memberAdVisible: false, memberAdLoaded: false });
}

function fail(page, cache) {
  if (!cache || !cache.valid() || !cache.canDisplay) return;
  cache.layoutSequence = (cache.layoutSequence || 0) + 1;
  cache.layoutPromise = null;
  cache.state = 'failed';
  remove(page, cache);
  page.setData({ memberAdPreloadState: 'failed', memberAdLayoutPending: false,
    memberAdReserved: Boolean(page.data.showMemberSheet && !cache.dismissed) });
}

async function mount(page, app, cache) {
  function valid() {
    return cache.valid() && page.data.showMemberSheet && page.data.memberAdReserved
      && !cache.dismissed && cache.canDisplay && cache.state !== 'failed'
      && !page.data.memberAdLayoutPending && page.data.memberAdWidth > 0;
  }
  if (!valid()) return;
  if (page.data.memberAdMounted) {
    page.setData({ memberAdVisible: true });
    inspect(page, app, 'reuse');
    return;
  }
  const version = cache.version;
  await afterView();
  if (!valid() || cache.version !== version || page.data.memberAdMounted) return;
  cache.state = 'loading';
  await commit(page, { memberAdMounted: true, memberAdVisible: true, memberAdPreloadState: 'loading' });
  if (!cache.valid() || cache.version !== version || !page.data.memberAdMounted || page.data.memberAdLoaded) return;
  clearLoadTimer(cache);
  cache.loadTimer = setTimeout(function () {
    if (cache.valid() && cache.version === version && page.data.memberAdMounted && !page.data.memberAdLoaded) fail(page, cache);
  }, LOAD_TIMEOUT);
  if (cache.loadTimer.unref) cache.loadTimer.unref();
  inspect(page, app, 'created');
}

// The probe contains only ordinary views. It can measure the future sheet before opening.
function prepare(page, app, force) {
  const cache = page._memberAdCache;
  if (!cache || !cache.canDisplay || !cache.valid()) return Promise.resolve();
  if (!force && cache.layoutPromise) return cache.layoutPromise;
  if (!force && page.data.memberAdWidth > 0) return mount(page, app, cache);
  const sequence = (cache.layoutSequence || 0) + 1;
  cache.layoutSequence = sequence;
  function valid() { return cache.layoutSequence === sequence && cache.valid() && cache.canDisplay; }
  page.setData({ memberAdLayoutPending: true });
  cache.layoutPromise = (async function () {
    let rect;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await afterView();
      if (!valid()) return;
      const rects = await measure(page, ['.member-sheet-ad-measure-slot']);
      if (!valid()) return;
      diagnose(page, app, attempt ? 'measure-retry' : 'measure', rects);
      rect = rects[0];
      if (rect && Number.isFinite(rect.width) && rect.width > 0) break;
    }
    if (!rect || !Number.isFinite(rect.width) || rect.width <= 0) {
      remove(page, cache);
      if (cache.state !== 'failed') cache.state = 'waiting-visible';
      page.setData({ memberAdWidth: 0, memberAdLayoutPending: false, memberAdPreloadState: cache.state });
      return;
    }
    const width = Math.round(rect.width * 100) / 100;
    if (Math.abs((page.data.memberAdWidth || 0) - width) > 0.5) {
      remove(page, cache);
      if (cache.state !== 'failed') cache.state = 'waiting-visible';
      await commit(page, { memberAdWidth: width, memberAdPreloadState: cache.state });
      if (!valid()) return;
    }
    page.setData({ memberAdLayoutPending: false });
    return mount(page, app, cache);
  })().finally(function () {
    if (cache.layoutSequence === sequence) cache.layoutPromise = null;
  });
  return cache.layoutPromise;
}

module.exports = { prepare: prepare, inspect: inspect, diagnose: diagnose, remove: remove, fail: fail, clearLoadTimer: clearLoadTimer };
