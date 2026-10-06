const api = require('./api');
const commerceConfig = require('../config/commerce');
const memberLayout = require('./member-ad-layout');

function eligible(family, now) {
  if (!family || !family._id || family.status !== 'active' || !family.membership) return false;
  const membership = family.membership;
  if (membership.lifetime) return false;
  if (membership.active === false) return true;
  if (membership.active !== true || !membership.expiresAt) return false;
  const expiry = new Date(membership.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry <= (now === undefined ? Date.now() : now);
}

function fields(member) {
  if (member === 'treeTop') return { visible: 'topAdVisible', loaded: 'topAdLoaded', unit: 'topAdUnitId', family: 'topAdFamilyId', version: 'topAdVersion' };
  return member
    ? { visible: 'memberAdVisible', loaded: 'memberAdLoaded', unit: 'memberAdUnitId', family: 'memberAdFamilyId', version: 'memberAdVersion' }
    : { visible: 'adVisible', loaded: 'adLoaded', unit: 'adUnitId', family: 'adFamilyId', version: 'adVersion' };
}

function reserveMemberSpace(app, family, page) {
  if (!commerceConfig.resolveBanner(app.globalData && app.globalData.environment, 'memberSheet')
    || !family || !family._id || family.status !== 'active'
    || (app.globalData && app.globalData.accountState === 'pending_delete')
    || (typeof wx !== 'undefined' && wx.canIUse && !wx.canIUse('ad-custom'))) return false;
  if (page && (!page._memberAdCache || !page._memberAdCache.canDisplay
    || page._memberAdCache.key !== memberKey(app, family))) return false;
  return eligible(family);
}

function scheduleExpiry(page, app, cache, expiresAt) {
  const delay = expiresAt - Date.now();
  if (!(delay > 0)) return;
  cache.expiryTimer = setTimeout(function () {
    if (page._memberAdCache !== cache || page._adPageHidden || page._unloaded) return;
    if (Date.now() < expiresAt) return scheduleExpiry(page, app, cache, expiresAt);
    hide(page, true);
    preloadMember(page, app, app.getCurrentFamily(), true);
  }, Math.min(delay, 2147483647));
  if (cache.expiryTimer.unref) cache.expiryTimer.unref();
}

function hide(page, member, reservedFamily, keepRequest) {
  const keys = fields(member);
  if (!page._adVersions) page._adVersions = {};
  const version = (page._adVersions[keys.version] || 0) + 1;
  page._adVersions[keys.version] = version;
  const patch = { [keys.visible]: false, [keys.loaded]: false, [keys.family]: '', [keys.version]: version };
  if (member === true) {
    memberLayout.clearLoadTimer(page._memberAdCache);
    if (page._memberAdCache && page._memberAdCache.expiryTimer) clearTimeout(page._memberAdCache.expiryTimer);
    if (!keepRequest) page._adMembershipRequest = null;
    page._memberAdCache = null;
    patch.memberAdMounted = false;
    patch.memberAdReserved = Boolean(reservedFamily);
    patch[keys.family] = reservedFamily ? reservedFamily._id : '';
    patch.memberAdPreloadState = 'idle';
    patch.memberAdWidth = 0;
    patch.memberAdLayoutPending = false;
  }
  page.setData(patch);
}

// Share only in-flight requests, not rights across page entries or different families.
function familyStatus(page, app, family) {
  const current = app.getCurrentFamily();
  const key = memberKey(app, current && current._id === family._id ? current : family);
  if (page._adMembershipRequest && page._adMembershipRequest.key === key) return page._adMembershipRequest.promise;
  const request = { key: key };
  page._adMembershipRequest = request;
  request.promise = api.call('membership.status', { familyId: family._id }).finally(function () {
    if (page._adMembershipRequest === request) page._adMembershipRequest = null;
  });
  return request.promise;
}

function refresh(page, app, placement, family, isAllowed) {
  if (placement === 'memberSheet') return preloadMember(page, app, family, true);
  const member = placement === 'treeTop' ? 'treeTop' : false;
  const keys = fields(member);
  hide(page, member);
  const version = page._adVersions[keys.version];
  const unit = commerceConfig.resolveBanner(app.globalData && app.globalData.environment, placement);
  if (!unit || (isAllowed && !isAllowed()) || !family || !family._id || family.status !== 'active'
    || (app.globalData && app.globalData.accountState === 'pending_delete')) return Promise.resolve();
  const familyId = family._id;
  const statusKey = memberKey(app, app.getCurrentFamily() || family);
  return familyStatus(page, app, family).then(function (data) {
    const current = app.getCurrentFamily();
    if (page._adVersions[keys.version] !== version || page._adPageHidden || page._unloaded) return;
    if ((isAllowed && !isAllowed()) || !current || current._id !== familyId) return;
    if (!data.family || data.family._id !== familyId) return;
    if (memberKey(app, current) !== statusKey && memberKey(app, current) !== memberKey(app, data.family)) return;
    if (app.applyFamilyUpdate) app.applyFamilyUpdate(data.family);
    if (!eligible(data.family)) return;
    page.setData({ [keys.unit]: unit, [keys.family]: familyId, [keys.visible]: true });
  }).catch(function () {});
}

function loaded(page, member, event) {
  const keys = fields(member);
  if (!(member === true ? page.data.memberAdMounted : page.data[keys.visible]) || page._adPageHidden || page._unloaded) return;
  if (!event || !event.currentTarget || Number(event.currentTarget.dataset.version) !== page.data[keys.version]) return;
  if (member === true && page._memberAdCache && !page._memberAdCache.valid()) return;
  const patch = { [keys.loaded]: true };
  if (member === true && page._memberAdCache) {
    memberLayout.clearLoadTimer(page._memberAdCache);
    page._memberAdCache.state = 'ready';
    patch.memberAdPreloadState = 'ready';
    memberLayout.inspect(page, page._memberAdCache.app, 'loaded');
  }
  page.setData(patch);
}

function error(page, member, event) {
  const keys = fields(member);
  if (event && event.currentTarget && Number(event.currentTarget.dataset.version) !== page.data[keys.version]) return;
  const cache = member === true && page._memberAdCache;
  if (cache && cache.canDisplay) {
    if (!page.data.memberAdMounted) return;
    memberLayout.fail(page, cache);
    return;
  }
  hide(page, member);
  if (cache) {
    cache.state = 'failed';
    cache.canDisplay = false;
    cache.layoutSequence = (cache.layoutSequence || 0) + 1;
    cache.version = page.data.memberAdVersion;
    page._memberAdCache = cache;
    page.setData({ memberAdPreloadState: 'failed' });
  }
}

function memberKey(app, family) {
  const membership = family.membership || {};
  return JSON.stringify([app.globalData && app.globalData.environment,
    commerceConfig.resolveBanner(app.globalData && app.globalData.environment, 'memberSheet'),
    family._id, family.status, membership.active, Boolean(membership.lifetime), membership.expiresAt || '', eligible(family)]);
}

function preloadMemberData(page, app, cache, unit) {
  if (!cache.canDisplay || !cache.valid()) return;
  if (typeof wx === 'undefined' || typeof wx.preloadAd !== 'function') {
    cache.dataPreloadState = 'unsupported';
  } else {
    // The SDK registers each unit once and replenishes its data cache after use.
    // Preloading data creates no visual component and exposes no ready callback.
    if (!app._memberAdPreloadUnits) app._memberAdPreloadUnits = new Set();
    try {
      if (!app._memberAdPreloadUnits.has(unit)) {
        wx.preloadAd([{ unitId: unit, type: 'custom' }]);
        app._memberAdPreloadUnits.add(unit);
      }
      cache.dataPreloadState = 'requested';
    } catch (error) {
      cache.dataPreloadState = 'failed';
    }
  }
  memberLayout.diagnose(page, app, 'data-preload-' + cache.dataPreloadState);
}

function preloadMember(page, app, family, force) {
  const current = app.getCurrentFamily && app.getCurrentFamily();
  if (current && family && current._id === family._id) family = current;
  const environment = app.globalData && app.globalData.environment;
  const unit = commerceConfig.resolveBanner(environment, 'memberSheet');
  if (!unit || !family || !family._id || family.status !== 'active' || !current || current._id !== family._id
    || page._adPageHidden || page._unloaded || (app.globalData && app.globalData.accountState === 'pending_delete')
    || (typeof wx !== 'undefined' && wx.canIUse && !wx.canIUse('ad-custom'))) {
    hide(page, true);
    return Promise.resolve();
  }
  const key = memberKey(app, family);
  if (!force && page._memberAdCache && page._memberAdCache.key === key) return page._memberAdCache.promise;
  hide(page, true, null, true);
  const cache = { key: key, familyId: family._id, version: page.data.memberAdVersion, state: 'checking', dismissed: false, app: app };
  page._memberAdCache = cache;
  page.setData({ memberAdFamilyId: family._id, memberAdPreloadState: 'checking',
    memberAdReserved: false });
  function valid(responseFamily) {
    const active = app.getCurrentFamily && app.getCurrentFamily();
    if (page._memberAdCache !== cache || page.data.memberAdVersion !== cache.version
      || page._adPageHidden || page._unloaded) return false;
    const sharedUpdate = responseFamily && responseFamily._id === cache.familyId
      && active && memberKey(app, active) === memberKey(app, responseFamily);
    if ((app.globalData && app.globalData.environment) !== environment
      || !active || active._id !== cache.familyId || (memberKey(app, active) !== cache.key && !sharedUpdate)
      || (app.globalData && app.globalData.accountState === 'pending_delete')
      || commerceConfig.resolveBanner(app.globalData && app.globalData.environment, 'memberSheet') !== unit) {
      hide(page, true);
      return false;
    }
    return true;
  }
  cache.valid = valid;
  cache.promise = familyStatus(page, app, family).then(function (data) {
    if (!valid(data.family)) return;
    if (!data.family || data.family._id !== cache.familyId) {
      error(page, true);
      return;
    }
    if (app.applyFamilyUpdate) app.applyFamilyUpdate(data.family);
    cache.key = memberKey(app, data.family);
    if (!eligible(data.family)) {
      cache.state = 'disabled';
      page.setData({ memberAdVisible: false, memberAdLoaded: false, memberAdReserved: false, memberAdPreloadState: 'disabled' });
      const expiresAt = new Date(data.family.membership && data.family.membership.expiresAt).getTime();
      if (data.family.membership && data.family.membership.active === true && !data.family.membership.lifetime) {
        scheduleExpiry(page, app, cache, expiresAt);
      }
      return;
    }
    cache.canDisplay = true;
    preloadMemberData(page, app, cache, unit);
    cache.state = 'sizing';
    page.setData({ memberAdUnitId: unit, memberAdFamilyId: cache.familyId,
      memberAdPreloadState: cache.state, memberAdReserved: Boolean(page.data.showMemberSheet && !cache.dismissed) });
    return memberLayout.prepare(page, app);
  }).catch(function () { if (valid()) error(page, true); });
  return cache.promise;
}

function openMember(page, app, family) {
  if (page._memberAdCache) page._memberAdCache.dismissed = false;
  const previous = page._memberAdCache;
  const retry = Boolean(previous && previous.state === 'failed' && !previous.canDisplay);
  if (previous && previous.state === 'failed' && previous.canDisplay) previous.state = 'waiting-visible';
  const pending = preloadMember(page, app, family, retry);
  const cache = page._memberAdCache;
  page.setData({ memberAdReserved: Boolean(cache && cache.canDisplay && !cache.dismissed
    && reserveMemberSpace(app, app.getCurrentFamily())) });
  return pending.then(function () {
    if (page._memberAdCache !== cache || !cache || !cache.valid()) return;
    if (!page.data.memberAdVisible && cache === previous) return memberLayout.prepare(page, app);
    memberLayout.inspect(page, app, 'opened');
  });
}

function closeMember(page) {
  const cache = page._memberAdCache;
  if (!canReuseMember(cache && cache.app)) {
    memberLayout.remove(page, cache);
    if (cache && cache.canDisplay && cache.state !== 'failed') cache.state = 'waiting-visible';
  }
  page.setData({ memberAdReserved: false, memberAdVisible: false,
    memberAdPreloadState: cache ? cache.state : 'idle' });
}

function canReuseMember(app) {
  if (!app || typeof wx === 'undefined') return false;
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {});
    const scope = commerceConfig.memberAdReusePlatforms[app.globalData && app.globalData.environment];
    return Boolean(scope && scope[String(info.platform || '').toLowerCase()] === true);
  } catch (error) { return false; }
}

function dismissMember(page) {
  if (page._memberAdCache) page._memberAdCache.dismissed = true;
  closeMember(page);
}

function openMembership(page, app, member) {
  const keys = fields(member);
  const current = app.getCurrentFamily();
  if (!current || current._id !== page.data[keys.family] || page._adPageHidden || page._unloaded) return;
  if (member === true) {
    if (!page.data.memberAdReserved || !page.data.showMemberSheet || current.status !== 'active') return;
    hide(page, true);
    page.setData({ showMemberSheet: false });
  } else if (!page.data[keys.visible] || !page.data[keys.loaded]) return;
  wx.navigateTo({ url: '/pages/membership/index?familyId=' + encodeURIComponent(current._id) });
}

module.exports = { eligible: eligible, reserveMemberSpace: reserveMemberSpace, refresh: refresh, hide: hide, loaded: loaded, error: error,
  resizeMember: function (page, app) { return memberLayout.prepare(page, app, true); },
  preloadMember: preloadMember, openMember: openMember, closeMember: closeMember, dismissMember: dismissMember, openMembership: openMembership };
