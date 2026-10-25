const api = require('./utils/api');
const contributionCache = require('./utils/contribution-cache');
const publicContent = require('./utils/public-content');
const growth = require('./utils/growth');
const environmentConfig = require('./config/env');
const launchAd = require('./utils/launch-ad');
const reading = require('./utils/reading-preference');
const activityLedger = require('./utils/activity-ledger');
const profileImages = require('./utils/profile-image-cache');
const LOGIN_CACHE_TTL = 24 * 60 * 60 * 1000;
const BUSINESS_CACHE_TTL = 60 * 60 * 1000;
const PENDING_BADGE_TTL = 5 * 60 * 1000;
const MEMBERSHIP_STATUS_TTL = 5 * 60 * 1000;

function emptyDataCache() {
  return {
    familyPages: { active: cacheEntry(), all: cacheEntry() },
    graph: {}, dashboard: {}, personDetail: {}, examplesList: {}, example: {}, invites: {},
    contributionSummary: {}, contributionList: {}, preference: {}, membershipStatus: {}, profile: cacheEntry()
  };
}

function cacheEntry() {
  return { data: null, updatedAt: 0, invalidated: false, promise: null, version: 0, promiseVersion: -1, forcedVersion: -1 };
}

function isFresh(entry) {
  return Boolean(entry && entry.data && !entry.invalidated && Date.now() - entry.updatedAt < (entry.ttl || BUSINESS_CACHE_TTL));
}

App({
  ...contributionCache,
  loginPromise: null,
  loginUpdatedAt: 0,
  dataCache: emptyDataCache(),

  globalData: {
    environment: environmentConfig.active,
    runtimeVersion: environmentConfig.runtimeVersion,
    env: environmentConfig.environments[environmentConfig.active].cloudEnv,
    user: null,
    familyList: [],
    currentFamily: null,
    loggedIn: false
  },

  onLaunch: function (options) {
    reading.refresh();
    const runtime = environmentConfig.resolveRuntimeEnvironment(wx);
    this.globalData.environment = runtime.active;
    this.globalData.runtimeVersion = runtime.runtimeVersion;
    this.globalData.env = runtime.environment.cloudEnv;
    if (!wx.cloud) {
      wx.showModal({
        title: '版本提示',
        content: '当前微信版本过低，请升级微信后使用有谱。',
        showCancel: false
      });
      return;
    }

    if (!this.globalData.env) {
      wx.showModal({
        title: '环境未配置',
        content: '当前构建缺少云开发环境，请联系开发人员。',
        showCancel: false
      });
      return;
    }

    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true
    });

    this.restoreLocalState();
    launchAd.begin(this, options);
    this._publicBrowsing = publicContent.isPublic(this._launchAd.target.path);
    if (!this._publicBrowsing) this.ensureLogin().catch(function () {});
  },

  onShow: function (options) {
    reading.refresh();
    growth.enter(options);
    if (options && options.path && options.path !== 'pages/launch-ad/index') this._publicBrowsing = publicContent.isPublic(options.path);
    if (this._publicBrowsing) return;
    const self = this;
    if (this._analyticsTimer) clearInterval(this._analyticsTimer);
    // Local date checks only; daily dedup prevents periodic cloud requests.
    this._analyticsTimer = setInterval(function () { self.recordVisibleActivity(); }, 60000);
    this.ensureLogin().then(function () {
      self.recordVisibleActivity();
      if (self._familyStatusStarted) return self.refreshPendingBadge();
    }).catch(function () { self.clearPendingBadge(); });
  },

  onHide: function () {
    if (this._badgeChangeTimer) clearTimeout(this._badgeChangeTimer);
    this._badgeChangeTimer = null;
    if (this._analyticsTimer) clearInterval(this._analyticsTimer);
    this._analyticsTimer = null;
  },

  loginScope: function () {
    try {
      const account = wx.getAccountInfoSync();
      const appId = account && account.miniProgram && account.miniProgram.appId;
      return appId && this.globalData.env ? appId + '|' + this.globalData.environment + '|' + this.globalData.env : '';
    } catch (error) { return ''; }
  },

  loginCacheKey: function (scope, actor) { return 'youpu_login_v1_' + encodeURIComponent(scope + '|' + actor); },

  readLoginCache: function () {
    const scope = this.loginScope();
    if (!scope) return null;
    try {
      const actor = wx.getStorageSync('youpu_login_actor_' + encodeURIComponent(scope));
      const value = actor && wx.getStorageSync(this.loginCacheKey(scope, actor));
      if (!value || value.version !== 1 || value.scope !== scope || !value.user || typeof actor !== 'string' || value.user._id !== actor || value.user.status !== 'active' ||
        typeof value.user.nickName !== 'string' || typeof value.user.avatarAssetId !== 'string' || value.accountState !== 'active' ||
        !Number.isFinite(value.fetchedAt) || value.fetchedAt <= 0 || value.fetchedAt > Date.now() ||
        value.expiresAt !== value.fetchedAt + LOGIN_CACHE_TTL || value.expiresAt <= Date.now()) return null;
      return value;
    } catch (error) { return null; }
  },

  persistLoginCache: function () {
    const scope = this.loginScope();
    const user = this.globalData.user;
    if (!scope || !user || this.globalData.accountState !== 'active' || !this.loginUpdatedAt) return;
    try {
      const previous = wx.getStorageSync('youpu_login_actor_' + encodeURIComponent(scope));
      if (previous && previous !== user._id) wx.removeStorageSync(this.loginCacheKey(scope, previous));
      wx.setStorageSync(this.loginCacheKey(scope, user._id), { version: 1, scope, user, accountState: 'active',
        fetchedAt: this.loginUpdatedAt, expiresAt: this.loginUpdatedAt + LOGIN_CACHE_TTL });
      wx.setStorageSync('youpu_login_actor_' + encodeURIComponent(scope), user._id);
    } catch (error) { /* A local cache failure must not fail a successful login. */ }
  },

  clearLoginCache: function (previousScope) {
    const scope = previousScope || this.loginScope();
    try {
      const actor = scope && wx.getStorageSync('youpu_login_actor_' + encodeURIComponent(scope));
      if (actor) wx.removeStorageSync(this.loginCacheKey(scope, actor));
      if (scope) wx.removeStorageSync('youpu_login_actor_' + encodeURIComponent(scope));
    } catch (error) {}
    this._loginCandidate = null;
    this.loginUpdatedAt = 0;
    this._inactiveLoginAt = 0;
  },

  restoreLocalState: function () {
    this._identityConfirmed = false;
    this._allowStoredFamilyRestore = true;
    this._loginCandidate = this.readLoginCache();
    try {
      const family = wx.getStorageSync('youpu_current_family');
      const previous = wx.getStorageSync('youpu_user');
      this._preferredFamilyActor = previous && previous._id || this._loginCandidate && this._loginCandidate.user._id || '';
      const savedScope = wx.getStorageSync('youpu_current_family_scope');
      const scope = this.loginScope() || this.globalData.environment + '|' + this.globalData.env;
      this._preferredFamilyId = (!savedScope || savedScope === scope + '|' + this._preferredFamilyActor) && family && family._id || '';
      if (savedScope && savedScope !== scope + '|' + this._preferredFamilyActor) this._allowStoredFamilyRestore = false;
    } catch (error) { this._preferredFamilyId = ''; this._preferredFamilyActor = ''; }
    this.globalData.user = null;
    this.globalData.currentFamily = null;
    try { wx.removeStorageSync('youpu_openid'); } catch (error) {}
  },

  ensureLogin: function (options) {
    this.ensureDataScope();
    const self = this;
    const force = Boolean(options && options.force);
    if (this.loginPromise) { if (force) this._loginForceRequested = true; return this.loginPromise; }
    if (!force && this.globalData.user && this.globalData.accountState === 'active' && this.loginUpdatedAt > 0 &&
      Date.now() >= this.loginUpdatedAt && Date.now() - this.loginUpdatedAt < LOGIN_CACHE_TTL) {
      return Promise.resolve({ user: this.globalData.user, accountState: 'active', deletion: null });
    }
    if (!force && this.globalData.user && this.globalData.accountState && this.globalData.accountState !== 'active' &&
      this._inactiveLoginAt > 0 && Date.now() >= this._inactiveLoginAt && Date.now() - this._inactiveLoginAt < 5 * 60 * 1000) {
      return Promise.resolve({ user: this.globalData.user, accountState: this.globalData.accountState, deletion: this.globalData.deletion || null });
    }
    let sessionVersion = this._sessionVersion || 0;
    const scope = this.loginScope();
    this._loginForceRequested = force;
    const candidate = !force && this._loginCandidate;
    this.loginPromise = Promise.resolve().then(async function () {
      const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const environment = self.globalData.environment + '|' + self.globalData.env;
      let data; let fetchedAt;
      if (candidate && candidate.scope === scope && candidate.expiresAt > Date.now() && candidate.fetchedAt <= Date.now() &&
        activityLedger.has(environment, candidate.user._id, day, 'foreground:')) {
        try {
          const identity = await api.call('auth.identity');
          self.assertSessionVersion(sessionVersion);
          if (scope !== self.loginScope()) throw Object.assign(new Error('环境已变化，请重新进入'), { code: 'ACCOUNT_SESSION_CHANGED' });
          if (identity.userId === candidate.user._id && !self._loginForceRequested) {
            data = { user: candidate.user, accountState: 'active', deletion: null }; fetchedAt = candidate.fetchedAt;
          } else self.clearLoginCache();
        } catch (error) {
          if (error.code !== 'UNKNOWN_ACTION') throw error;
        }
      }
      if (!data) { data = await api.call('auth.login', self._growthTouched ? { growthEntry: true } : undefined); fetchedAt = Date.now(); }
      self.assertSessionVersion(sessionVersion);
      if (scope !== self.loginScope()) throw Object.assign(new Error('环境已变化，请重新进入'), { code: 'ACCOUNT_SESSION_CHANGED' });
      const previous = self.globalData.user || candidate && candidate.user;
      if (previous && data.user && previous._id !== data.user._id) {
        self._sessionVersion = sessionVersion + 1; sessionVersion = self._sessionVersion;
        self.clearLoginCache(); self.clearPendingBadge(); self.dataCache = emptyDataCache(); api.clearMediaUrlCache();
        self.globalData.familyList = []; self.setCurrentFamily(null);
      }
      self.globalData.user = data.user;
      self.globalData.loggedIn = data.accountState === 'active';
      self.globalData.accountState = data.accountState || 'active';
      self.globalData.deletion = data.deletion || null;
      self._identityConfirmed = true;
      self._loginCandidate = null;
      if (self.globalData.accountState !== 'active') {
        self.clearLoginCache(); self.clearPendingBadge(); self.dataCache = emptyDataCache(); api.clearMediaUrlCache();
        self.globalData.familyList = []; self.setCurrentFamily(null);
        self._inactiveLoginAt = fetchedAt;
      } else {
        self.loginUpdatedAt = fetchedAt; self.persistLoginCache();
      }
      try { wx.setStorageSync('youpu_user', data.user); } catch (error) {}
      return data;
    }).catch(function (error) { console.error('有谱登录失败', error); throw error; }).then(function (data) {
      if ((self._sessionVersion || 0) === sessionVersion) self.loginPromise = null;
      return data;
    }, function (error) {
      if ((self._sessionVersion || 0) === sessionVersion) self.loginPromise = null;
      throw error;
    });
    return this.loginPromise;
  },

  confirmActivityReceipts: function (meta, identity, data, type) {
    if (!meta || !identity || identity.version !== (this._sessionVersion || 0) || identity.environment !== this.globalData.environment + '|' + this.globalData.env) return;
    const actor = type === 'auth.login' ? data && data.user && data.user._id : this.globalData.user && this.globalData.user._id;
    if (!actor || meta.actorId !== actor) return;
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    (meta.activityReceipts || []).forEach(function (receipt) {
      if (receipt.day !== day || ['foreground', 'family', 'example'].indexOf(receipt.kind) < 0) return;
      if (receipt.kind !== 'foreground' && !receipt.targetId) return;
      activityLedger.confirm(identity.environment, actor, day, receipt.kind + ':' + (receipt.targetId || ''));
    });
  },

  loadFamilies: function (options) {
    const self = this;
    let sessionVersion = this._sessionVersion || 0;
    return this.ensureLogin().then(function () {
      sessionVersion = self._sessionVersion || 0;
      if (self.globalData.accountState === 'pending_delete') {
        self.globalData.familyList = [];
        self.setCurrentFamily(null);
        return { families: [] };
      }
      return self.loadFamilyPages(false, options);
    }).then(function (data) {
      self.assertSessionVersion(sessionVersion);
      const families = data.families || [];
      self.globalData.familyList = families;

      const current = self.globalData.currentFamily;
      const preferred = self._preferredFamilyActor === (self.globalData.user && self.globalData.user._id) ? self._preferredFamilyId : '';
      const selectedId = current && current._id || preferred;
      const matched = selectedId && families.find(function (item) { return item._id === selectedId; });

      if (matched) {
        self.setCurrentFamily(matched);
      } else if (families.length > 0) {
        self.setCurrentFamily(families[0]);
      } else {
        self.setCurrentFamily(null);
      }

      return families;
    });
  },

  loadCached: function (entry, loader, options) {
    const self = this;
    const sessionVersion = this._sessionVersion || 0;
    const force = Boolean(options && options.force);
    if (!force && isFresh(entry)) return Promise.resolve(entry.data);
    if (force && entry.promise && entry.promiseVersion === (Number(entry.version) || 0) && entry.forcedVersion === entry.promiseVersion) {
      return entry.promise;
    }
    if (force && entry.promise && entry.promiseVersion === (Number(entry.version) || 0)) {
      this.invalidateEntry(entry);
    }
    const version = Number(entry.version) || 0;
    if (force) entry.forcedVersion = version;
    if (entry.promise && entry.promiseVersion === version) return entry.promise;
    const request = Promise.resolve().then(function () {
      self.assertSessionVersion(sessionVersion);
      return loader();
    }).then(function (data) {
      self.assertSessionVersion(sessionVersion);
      // A write can invalidate a cache while an earlier read is still in flight.
      // Do not let that response update the cache or a waiting page with stale data.
      if ((Number(entry.version) || 0) !== version) {
        return self.loadCached(entry, loader);
      }
      entry.data = data;
      entry.updatedAt = Date.now();
      entry.invalidated = false;
      return data;
    });
    entry.promise = request;
    entry.promiseVersion = version;
    return request.then(function (data) {
      if (entry.promise === request) {
        entry.promise = null;
        entry.promiseVersion = -1;
      }
      return data;
    }, function (error) {
      if (entry.promise === request) {
        entry.promise = null;
        entry.promiseVersion = -1;
      }
      throw error;
    });
  },

  ensureDataScope: function () {
    const scope = this.loginScope() || this.globalData.environment + '|' + this.globalData.env;
    if (this._dataScope && this._dataScope !== scope) {
      this.clearLoginCache(this._dataScope);
      this._dataScope = scope;
      this.clearCachedAccess('');
    } else this._dataScope = scope;
  },

  getCacheEntry: function (type, key) {
    this.ensureDataScope();
    if (type === 'familyPages') return this.dataCache.familyPages[key ? 'all' : 'active'];
    if (!this.dataCache[type]) this.dataCache[type] = {};
    const actor = this.globalData.user && this.globalData.user._id;
    const scopedKey = (actor ? actor + ':' : '') + String(key || '');
    if (!this.dataCache[type][scopedKey]) this.dataCache[type][scopedKey] = cacheEntry();
    return this.dataCache[type][scopedKey];
  },

  isCacheFresh: function (type, key) {
    return isFresh(this.getCacheEntry(type, key));
  },

  loadFamilyPages: function (includeArchived, options) {
    const self = this;
    const entry = this.getCacheEntry('familyPages', includeArchived);
    const all = this.getCacheEntry('familyPages', true);
    if (!includeArchived && !(options && options.force) && isFresh(all)) {
      return Promise.resolve(Object.assign({}, all.data, { families: (all.data.families || []).filter(family => family.status === 'active') }));
    }
    return this.loadCached(entry, function () {
    const families = [];
    function next(cursor) {
      return api.call('family.list', {
        includeArchived: Boolean(includeArchived),
        pageSize: 50,
        cursor: cursor || ''
      }).then(function (data) {
        families.push.apply(families, data.families || []);
        if (data.hasMore && data.nextCursor) return next(data.nextCursor);
        return { families: families, hasMore: false, nextCursor: '' };
      });
    }
    return next('');
    }, options);
  },

  getGraph: function (familyId, options) {
    this._familyStatusStarted = true;
    const entry = this.getCacheEntry('graph', familyId);
    const version = this._sessionVersion || 0;
    const request = this.loadCached(entry, function () {
      return api.call('graph.get', { familyId: familyId, includeStatus: true });
    }, options).then(data => { this.assertSessionVersion(version); this.seedFamilyStatus(familyId, data); this.recordFamilyVisit(familyId); return data; });
    entry.statusPromise = request; entry.statusPromiseVersion = Number(entry.version) || 0;
    const clear = () => { if (entry.statusPromise === request) entry.statusPromise = null; };
    request.then(clear, clear);
    return request;
  },

  getDashboard: function (familyId, options) {
    this._familyStatusStarted = true;
    const entry = this.getCacheEntry('dashboard', familyId);
    const version = this._sessionVersion || 0;
    const request = this.loadCached(entry, function () {
      return api.call('family.dashboard', { familyId: familyId });
    }, options).then(data => { this.assertSessionVersion(version); this.seedFamilyStatus(familyId, data); this.recordFamilyVisit(familyId); return data; });
    entry.statusPromise = request; entry.statusPromiseVersion = Number(entry.version) || 0;
    const clear = () => { if (entry.statusPromise === request) entry.statusPromise = null; };
    request.then(clear, clear);
    return request;
  },

  getMembershipStatus: function (familyId, options) {
    const environment = this.globalData.environment || '';
    const actorId = this.globalData.user && this.globalData.user._id || '';
    const entry = this.getCacheEntry('membershipStatus', environment + '|' + familyId);
    entry.familyId = familyId;
    if (!entry.ttl) entry.ttl = MEMBERSHIP_STATUS_TTL;
    const combined = this.statusRequest(familyId);
    if (!(options && options.force) && !isFresh(entry) && combined) {
      return combined.then(() => this.getMembershipStatus(familyId, options));
    }
    const self = this;
    return this.loadCached(entry, function () {
      return api.call('membership.status', { familyId: familyId }).then(function (data) {
        const expiresAt = data.membership && !data.membership.lifetime && data.membership.active
          ? new Date(data.membership.expiresAt).getTime() : NaN;
        entry.ttl = Number.isFinite(expiresAt) ? Math.max(1, Math.min(MEMBERSHIP_STATUS_TTL, expiresAt - Date.now())) : MEMBERSHIP_STATUS_TTL;
        return data;
      });
    }, options).then(function (data) {
      if (self.globalData.environment !== environment || (self.globalData.user && self.globalData.user._id || '') !== actorId) {
        throw Object.assign(new Error('账户或环境已变化，请重新进入'), { code: 'ACCOUNT_SESSION_CHANGED' });
      }
      return data;
    });
  },

  statusRequest: function (familyId) {
    for (const type of ['graph', 'dashboard']) {
      const entry = this.getCacheEntry(type, familyId);
      if (entry.statusPromise && entry.statusPromiseVersion === (Number(entry.version) || 0)) return entry.statusPromise;
    }
    return null;
  },

  seedFamilyStatus: function (familyId, data) {
    if (!data || !data.statusAsOf || !data.family || data.family._id !== familyId) return;
    const asOf = new Date(data.statusAsOf).getTime();
    if (!Number.isFinite(asOf) || asOf > Date.now() + 5000 || Date.now() - asOf >= MEMBERSHIP_STATUS_TTL) return;
    const at = Math.min(Date.now(), asOf);
    if (data.membershipStatus && data.membershipStatus.family && data.membershipStatus.family._id === familyId) {
      const entry = this.getCacheEntry('membershipStatus', this.globalData.environment + '|' + familyId);
      const expiry = data.membershipStatus.membership && data.membershipStatus.membership.active && !data.membershipStatus.membership.lifetime
        ? new Date(data.membershipStatus.membership.expiresAt).getTime() : NaN;
      if (!Number.isFinite(expiry) || expiry > Date.now()) {
        this.updateEntry(entry, Object.assign({}, data.membershipStatus, { family: data.family })); entry.familyId = familyId; entry.updatedAt = at;
        entry.ttl = Number.isFinite(expiry) ? Math.max(1, Math.min(MEMBERSHIP_STATUS_TTL, expiry - at)) : MEMBERSHIP_STATUS_TTL;
      }
    }
    const count = data.pendingCount !== undefined ? data.pendingCount : data.stats && data.stats.pendingCount;
    if (count !== undefined) this.setPendingBadgeCount(familyId, data.family.currentRole === 'viewer' ? 0 : count, at, data.family.currentRole);
  },

  invalidateMembershipStatus: function (familyId, verifiedFamily) {
    Object.keys(this.dataCache.membershipStatus || {}).forEach(function (key) {
      const entry = this.dataCache.membershipStatus[key];
      if ((!familyId || entry.familyId === familyId) && (!verifiedFamily || !entry.data || entry.data.family !== verifiedFamily)) this.invalidateEntry(entry);
    }, this);
  },

  recordVisit: function (kind, payload) {
    if (!this.globalData.loggedIn || !this.globalData.user) return;
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    if (this._analyticsDay !== date) { this._analyticsDay = date; this._analyticsVisits = {}; }
    const visits = this._analyticsVisits || (this._analyticsVisits = {});
    const environment = (this.globalData.environment || '') + '|' + (this.globalData.env || '');
    const actor = this.globalData.user._id;
    const event = kind + ':' + ((payload && (payload.familyId || payload.slug)) || '');
    const key = environment + ':' + actor + ':' + event;
    if (visits[key] || activityLedger.has(environment, actor, date, event)) return;
    const sessionVersion = this._sessionVersion || 0;
    visits[key] = true;
    api.call('analytics.track', Object.assign({ kind: kind }, payload || {})).then(() => {
      const currentDay = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      if (currentDay === date && (this._sessionVersion || 0) === sessionVersion
        && (this.globalData.environment || '') + '|' + (this.globalData.env || '') === environment
        && this.globalData.user && this.globalData.user._id === actor) {
        activityLedger.confirm(environment, actor, date, event);
      }
    }).catch(function () { delete visits[key]; });
  },

  recordVisibleActivity: function () {
    if (this._publicBrowsing) return;
    this.recordVisit('foreground');
    if (typeof getCurrentPages !== 'function') return;
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    if (!page || !page.data || page.data.loading || page.data.error) return;
    if (page.route === 'pages/example/index' && page.data.example) this.recordExampleVisit(page.data.slug);
    if (['pages/tree/index', 'pages/members/index', 'pages/family-manage/index'].includes(page.route)) {
      const family = page.data.currentFamily || page.data.family;
      if (family) this.recordFamilyVisit(family._id);
    }
  },

  recordFamilyVisit: function (familyId) { if (familyId) this.recordVisit('family', { familyId: familyId }); },
  recordExampleVisit: function (slug) { if (slug) this.recordVisit('example', { slug: slug }); },

  getPersonDetail: function (personId, options) {
    return this.loadCached(this.getCacheEntry('personDetail', personId), function () {
      return api.call('person.get', { personId: personId });
    }, options);
  },

  getExamplesList: function (tag, options) {
    const selectedTag = tag || '';
    return this.loadCached(this.getCacheEntry('examplesList', selectedTag), function () {
      return api.call('public.examples.list', { tag: selectedTag });
    }, options);
  },

  getExample: function (slug, options) {
    return this.loadCached(this.getCacheEntry('example', slug), function () {
      return api.call('public.examples.get', { slug: slug });
    }, options);
  },

  getPreference: function (familyId, options) {
    return this.loadCached(this.getCacheEntry('preference', familyId), function () {
      return api.call('family.getPreference', { familyId: familyId });
    }, options);
  },

  getInvites: function (familyId, cursor, options) {
    const pageCursor = cursor || '';
    const entry = this.getCacheEntry('invites', familyId + '|' + pageCursor);
    entry.familyId = familyId;
    return this.loadCached(entry, function () {
      return api.call('invite.list', { familyId: familyId, pageSize: 50, cursor: pageCursor });
    }, options);
  },

  updateEntry: function (entry, data, preserveAge) {
    const at = entry.updatedAt;
    this.invalidateEntry(entry);
    entry.data = data;
    entry.updatedAt = preserveAge ? at : Date.now();
    entry.invalidated = false;
  },

  updatePreference: function (familyId, preference) {
    const preferenceEntry = this.getCacheEntry('preference', familyId);
    if (preferenceEntry.data && preferenceEntry.data.family && !preferenceEntry.invalidated) {
      this.updateEntry(preferenceEntry, Object.assign({}, preferenceEntry.data, { preference: preference }), true);
    } else if (preferenceEntry.promise) {
      this.invalidateEntry(preferenceEntry);
    }
    const graphEntry = this.getCacheEntry('graph', familyId);
    if (graphEntry.data && !graphEntry.invalidated) {
      this.updateEntry(graphEntry, Object.assign({}, graphEntry.data, { preference: preference }), true);
    }
  },

  updatePersonDetail: function (personId, result) {
    if (result && result.person) this.updateEntry(this.getCacheEntry('personDetail', personId), result);
  },

  applyPersonUpdate: function (familyId, person) {
    if (!person || !person._id) return;
    this.invalidateContributions(familyId);
    const graphEntry = this.getCacheEntry('graph', familyId);
    if (graphEntry.data && !graphEntry.invalidated) {
      this.updateEntry(graphEntry, Object.assign({}, graphEntry.data, {
        persons: (graphEntry.data.persons || []).map(function (item) {
          return item._id === person._id ? person : item;
        })
      }), true);
    } else if (graphEntry.promise) {
      this.invalidateEntry(graphEntry);
    }
    Object.keys(this.dataCache.personDetail || {}).forEach(function (key) {
      const entry = this.dataCache.personDetail[key];
      if (!entry.data || entry.invalidated) {
        if (entry.promise) this.invalidateEntry(entry);
        return;
      }
      const isCurrent = entry.data.person && entry.data.person._id === person._id;
      const relatives = (entry.data.relatives || []).map(function (item) {
        return item.person && item.person._id === person._id ? Object.assign({}, item, { person: person }) : item;
      });
      if (isCurrent || relatives.some(function (item, index) { return item !== entry.data.relatives[index]; })) {
        this.updateEntry(entry, Object.assign({}, entry.data, { person: isCurrent ? person : entry.data.person, relatives: relatives }), true);
      }
    }, this);
    this.invalidateCache({ dashboard: familyId });
  },

  applyFamilyUpdate: function (family) {
    if (!family || !family._id) return;
    this.invalidateContributions(family._id);
    ['active', 'all'].forEach(function (name) {
      const entry = this.dataCache.familyPages[name];
      if (entry.data && !entry.invalidated) {
        this.updateEntry(entry, Object.assign({}, entry.data, {
          families: (entry.data.families || []).map(function (item) { return item._id === family._id ? family : item; })
        }), true);
      } else if (entry.promise) this.invalidateEntry(entry);
    }, this);
    ['graph', 'dashboard'].forEach(function (type) {
      const entry = this.getCacheEntry(type, family._id);
      if (entry.data && !entry.invalidated) this.updateEntry(entry, Object.assign({}, entry.data, { family: family }), true);
      else if (entry.promise) this.invalidateEntry(entry);
    }, this);
    this.globalData.familyList = this.globalData.familyList.map(function (item) { return item._id === family._id ? family : item; });
    if (this.getCurrentFamily() && this.getCurrentFamily()._id === family._id) this.setCurrentFamily(family);
  },

  invalidateInvites: function (familyId) {
    Object.keys(this.dataCache.invites || {}).forEach(function (key) {
      const entry = this.dataCache.invites[key];
      if (entry.familyId === familyId) this.invalidateEntry(entry);
    }, this);
  },

  clearCachedAccess: function (familyId) {
    if (!familyId) {
      this.dataCache = emptyDataCache();
      api.clearMediaUrlCache();
      this.clearLoginCache();
      this._sessionVersion = (this._sessionVersion || 0) + 1;
      this._identityConfirmed = false;
      this.loginPromise = null;
      this._familyCounterVersions = {};
      this.globalData.user = null;
      this.globalData.familyList = [];
      this.globalData.loggedIn = false;
      this.setCurrentFamily(null);
      return;
    }
    api.clearMediaUrlCache();
    this.invalidateFamilyData(familyId);
    this.globalData.familyList = this.globalData.familyList.filter(function (family) { return family._id !== familyId; });
    if (this.getCurrentFamily() && this.getCurrentFamily()._id === familyId) this.setCurrentFamily(null);
  },

  getProfileData: function (loader, options) {
    return this.loadCached(this.dataCache.profile, loader, options);
  },

  invalidateCache: function (options) {
    const config = options || {};
    if (config.families) {
      this.invalidateEntry(this.dataCache.familyPages.active);
      this.invalidateEntry(this.dataCache.familyPages.all);
    }
    if (config.profile) this.invalidateEntry(this.dataCache.profile);
    if (config.graph) this.invalidateEntry(this.getCacheEntry('graph', config.graph));
    if (config.dashboard) this.invalidateEntry(this.getCacheEntry('dashboard', config.dashboard));
    if (config.personDetail) this.invalidateEntry(this.getCacheEntry('personDetail', config.personDetail));
    if (config.preference) this.invalidateEntry(this.getCacheEntry('preference', config.preference));
  },

  invalidateEntry: function (entry) {
    entry.invalidated = true;
    entry.version = (Number(entry.version) || 0) + 1;
  },

  applyFamilyCounters: function (counters) {
    if (!counters || !counters.familyId || !Number.isFinite(counters.personCount) || !Number.isFinite(counters.relationCount) || !Number.isInteger(counters.relationRevision)) return false;
    const graph = this.getCacheEntry('graph', counters.familyId);
    const versions = this._familyCounterVersions || (this._familyCounterVersions = {});
    const counterKey = this.globalData.environment + '|' + this.globalData.env + '|' + (this.globalData.user && this.globalData.user._id || '') + '|' + counters.familyId;
    const previous = Math.max(Number(versions[counterKey] || 0), Number(graph.data && graph.data.relationRevision || 0));
    if (counters.relationRevision < previous) return false;
    versions[counterKey] = counters.relationRevision;
    const patch = family => family && family._id === counters.familyId ? Object.assign({}, family, { personCount: counters.personCount, relationCount: counters.relationCount }) : family;
    ['active', 'all'].forEach(name => {
      const entry = this.dataCache.familyPages[name];
      if (entry.data && !entry.invalidated) this.updateEntry(entry, Object.assign({}, entry.data, { families: (entry.data.families || []).map(patch) }), true);
      else if (entry.promise) this.invalidateEntry(entry);
    });
    this.globalData.familyList = (this.globalData.familyList || []).map(patch);
    if (this.globalData.currentFamily && this.globalData.currentFamily._id === counters.familyId) this.globalData.currentFamily = patch(this.globalData.currentFamily);
    return true;
  },

  invalidateFamilyContent: function (familyId, counters) {
    this.invalidateContributions(familyId);
    if (!this.applyFamilyCounters(counters)) this.invalidateCache({ families: true });
    this.invalidateCache({ graph: familyId, dashboard: familyId });
    Object.keys(this.dataCache.personDetail || {}).forEach(key => {
      const entry = this.dataCache.personDetail[key];
      if (entry.data && entry.data.person && entry.data.person.familyId === familyId) this.invalidateEntry(entry);
    });
  },

  handleFamilyMutation: function (type, payload, data) {
    const familyId = payload.familyId || data.familyId || data.familyCounters && data.familyCounters.familyId || data.person && data.person.familyId;
    if (!familyId) return;
    if (type === 'family.update') this.invalidateContributions(familyId);
    if (data.pending) { this.invalidateCache({ dashboard: familyId }); return; }
    if (type === 'person.update' && data.person) this.applyPersonUpdate(familyId, data.person);
    else if (type === 'change.review' && !data.approved) this.invalidateCache({ dashboard: familyId });
    else if (['person.createRelated', 'person.delete', 'relation.linkExisting', 'relation.remove', 'relation.reorderChildren', 'relation.reorderSpouses', 'change.review'].indexOf(type) >= 0) this.invalidateFamilyContent(familyId, data.familyCounters);
  },

  invalidateFamilyData: function (familyId) {
    this.invalidateContributions(familyId);
    this.invalidateMembershipStatus(familyId);
    if (this.globalData.currentFamily && this.globalData.currentFamily._id === familyId) this.clearPendingBadge();
    this.invalidateCache({
      families: true,
      profile: true,
      graph: familyId,
      dashboard: familyId
    });
    Object.keys(this.dataCache.personDetail || {}).forEach(function (key) {
      const entry = this.dataCache.personDetail[key];
      if (entry.data && entry.data.person && entry.data.person.familyId === familyId) this.invalidateEntry(entry);
    }, this);
    this.invalidateInvites(familyId);
  },

  clearPendingBadge: function () {
    if (this._badgeChangeTimer) clearTimeout(this._badgeChangeTimer);
    this._badgeChangeTimer = null;
    this._pendingBadgeVersion = (this._pendingBadgeVersion || 0) + 1;
    this._pendingBadgeRequest = null;
    this._pendingBadgeFamilyId = '';
    this._pendingBadgeCount = 0;
    this._pendingBadgeUpdatedAt = 0;
    this._pendingBadgeKey = '';
    if (typeof wx !== 'undefined' && wx.removeTabBarBadge) wx.removeTabBarBadge({ index: 1 });
  },

  setPendingBadgeCount: function (familyId, count, sourceAt, sourceRole) {
    const current = this.getCurrentFamily();
    if (!current || current._id !== familyId) return;
    this._pendingBadgeVersion = (this._pendingBadgeVersion || 0) + 1;
    this._pendingBadgeRequest = null;
    const value = Math.max(0, Math.floor(Number(count) || 0));
    this._pendingBadgeFamilyId = familyId;
    this._pendingBadgeRole = sourceRole || current.currentRole;
    this._pendingBadgeCount = value;
    this._pendingBadgeUpdatedAt = Number.isFinite(sourceAt) ? Math.min(sourceAt, Date.now()) : Date.now();
    this._pendingBadgeKey = (this.globalData.environment || '') + '|' + (this.globalData.user && this.globalData.user._id || '') + '|' + familyId;
    if (typeof wx === 'undefined') return;
    if (value && wx.setTabBarBadge) wx.setTabBarBadge({ index: 1, text: value > 99 ? '99+' : String(value) });
    else if (wx.removeTabBarBadge) wx.removeTabBarBadge({ index: 1 });
  },

  refreshPendingBadge: function (options) {
    const family = this.getCurrentFamily();
    if (!family || family.status === 'archived' || this.globalData.accountState === 'pending_delete') {
      this.clearPendingBadge();
      return Promise.resolve(0);
    }
    const familyId = family._id;
    const actorId = this.globalData.user && this.globalData.user._id || '';
    const environment = this.globalData.environment || '';
    const key = environment + '|' + actorId + '|' + familyId;
    const combined = this.statusRequest(familyId);
    if (!(options && options.force) && combined) return combined.then(() => this.refreshPendingBadge(options));
    if (!(options && options.force) && this._pendingBadgeKey === key && Date.now() - this._pendingBadgeUpdatedAt < PENDING_BADGE_TTL) {
      return Promise.resolve(this._pendingBadgeCount);
    }
    if (!(options && options.force) && this._pendingBadgeRequest && this._pendingBadgeRequest.key === key) {
      return this._pendingBadgeRequest.promise;
    }
    const version = this._pendingBadgeVersion = (this._pendingBadgeVersion || 0) + 1;
    const self = this;
    const request = { key: key, promise: null };
    request.promise = api.call('change.pendingCount', { familyId: familyId }).then(function (data) {
      if (version !== self._pendingBadgeVersion || !self.getCurrentFamily() || self.getCurrentFamily()._id !== familyId ||
        self.globalData.environment !== environment ||
        (self.globalData.user && self.globalData.user._id || '') !== actorId) return null;
      self.setPendingBadgeCount(familyId, data.count);
      return self._pendingBadgeCount;
    }).catch(function (error) {
      if (version === self._pendingBadgeVersion) self.clearPendingBadge();
      throw error;
    }).then(function (count) {
      if (self._pendingBadgeRequest === request) self._pendingBadgeRequest = null;
      return count;
    }, function (error) {
      if (self._pendingBadgeRequest === request) self._pendingBadgeRequest = null;
      throw error;
    });
    this._pendingBadgeRequest = request;
    return request.promise;
  },

  setCurrentFamily: function (family) {
    this._allowStoredFamilyRestore = false;
    const previous = this.globalData.currentFamily;
    this.globalData.currentFamily = family || null;
    if (family) {
      try { wx.setStorageSync('youpu_current_family', family); } catch (error) {}
      try { wx.setStorageSync('youpu_current_family_scope', (this.loginScope() || this.globalData.environment + '|' + this.globalData.env) + '|' + (this.globalData.user && this.globalData.user._id || '')); } catch (error) {}
      this._preferredFamilyId = family._id; this._preferredFamilyActor = this.globalData.user && this.globalData.user._id || '';
    } else {
      try { wx.removeStorageSync('youpu_current_family'); wx.removeStorageSync('youpu_current_family_scope'); } catch (error) {}
      this._preferredFamilyId = ''; this._preferredFamilyActor = '';
    }
    const changedFamily = (previous && previous._id || '') !== (family && family._id || '');
    const changedAccess = previous && family && !changedFamily &&
      JSON.stringify([previous.status, previous.currentRole]) !== JSON.stringify([family.status, family.currentRole]);
    const changedMembership = previous && family && !changedFamily && JSON.stringify(previous.membership) !== JSON.stringify(family.membership);
    if (changedFamily) this.invalidateMembershipStatus('', family);
    else if (changedAccess || changedMembership) this.invalidateMembershipStatus(family._id, family);
    const verifiedBadge = family && this._pendingBadgeFamilyId === family._id && this._pendingBadgeRole === family.currentRole &&
      this._pendingBadgeKey === this.globalData.environment + '|' + (this.globalData.user && this.globalData.user._id || '') + '|' + family._id &&
      Date.now() - this._pendingBadgeUpdatedAt < PENDING_BADGE_TTL;
    if ((changedFamily || changedAccess) && !verifiedBadge) {
      this.clearPendingBadge();
      if (this._badgeChangeTimer) clearTimeout(this._badgeChangeTimer);
      const self = this; const version = this._sessionVersion || 0;
      if (family) this._badgeChangeTimer = setTimeout(function () {
        self._badgeChangeTimer = null;
        if (version === (self._sessionVersion || 0) && self.getCurrentFamily() && self.getCurrentFamily()._id === family._id) self.refreshPendingBadge().catch(function () {});
      }, 0);
    }
  },

  getCurrentFamily: function () {
    this.ensureDataScope();
    if (!this.globalData.currentFamily && this._identityConfirmed !== false && this._allowStoredFamilyRestore === true) {
      const scope = this.loginScope() || this.globalData.environment + '|' + this.globalData.env;
      const actor = this.globalData.user && this.globalData.user._id || '';
      try { if (actor && wx.getStorageSync('youpu_current_family_scope') === scope + '|' + actor) this.globalData.currentFamily = wx.getStorageSync('youpu_current_family') || null; } catch (error) {}
    }
    return this.globalData.currentFamily;
  },

  setUser: function (user) {
    this.globalData.user = user;
    try { wx.setStorageSync('youpu_user', user); } catch (error) {}
    this.persistLoginCache();
    this.invalidateCache({ profile: true });
  },

  openPerspective: function (family, personId) {
    this.setCurrentFamily(family);
    wx.setStorageSync('youpu_pending_view', {
      mode: 'perspective',
      personId: personId
    });
  },

  openFullGraph: function (family) {
    if (family) this.setCurrentFamily(family);
    wx.setStorageSync('youpu_pending_view', {
      mode: 'full',
      personId: ''
    });
  },

  consumePendingView: function () {
    const view = wx.getStorageSync('youpu_pending_view') || null;
    wx.removeStorageSync('youpu_pending_view');
    return view;
  },

  assertSessionVersion: function (version) {
    if ((this._sessionVersion || 0) !== version) {
      const error = new Error('账户已重置，请重新进入');
      error.code = 'ACCOUNT_SESSION_CHANGED';
      throw error;
    }
  },

  clearTestSession: function () {
    reading.reset();
    this.clearLocalData();
    const keys = wx.getStorageInfoSync().keys || [];
    keys.forEach(function (key) {
      if (key.indexOf('youpu_') === 0) wx.removeStorageSync(key);
    });
  },

  clearLocalData: function () {
    this.clearLoginCache();
    this._identityConfirmed = false;
    profileImages.clear();
    activityLedger.clear((this.globalData.environment || '') + '|' + (this.globalData.env || ''), this.globalData.user && this.globalData.user._id);
    this._analyticsVisits = {};
    this._sessionVersion = (this._sessionVersion || 0) + 1;
    this.loginPromise = null;
    this.globalData.accountState = 'active';
    this.globalData.deletion = null;
    this.clearPendingBadge();
    api.clearMediaUrlCache();
    wx.removeStorageSync('youpu_user');
    wx.removeStorageSync('youpu_openid');
    wx.removeStorageSync('youpu_current_family');
    wx.removeStorageSync('youpu_pending_view');
    wx.removeStorageSync('youpu_avatar_cache');
    this.globalData.user = null;
    this.globalData.familyList = [];
    this.globalData.currentFamily = null;
    this.globalData.loggedIn = false;
    this.loginUpdatedAt = 0;
    this.dataCache = emptyDataCache();
    this._familyCounterVersions = {};
    this._familyStatusStarted = false;
  }
});
