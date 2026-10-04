const api = require('./utils/api');
const environmentConfig = require('./config/env');
const LOGIN_CACHE_TTL = 60 * 1000;
const BUSINESS_CACHE_TTL = 60 * 60 * 1000;

function emptyDataCache() {
  return {
    familyPages: { active: cacheEntry(), all: cacheEntry() },
    graph: {}, dashboard: {}, personDetail: {}, examplesList: {}, example: {}, invites: {},
    preference: {}, profile: cacheEntry()
  };
}

function cacheEntry() {
  return { data: null, updatedAt: 0, invalidated: false, promise: null, version: 0, promiseVersion: -1, forcedVersion: -1 };
}

function isFresh(entry) {
  return Boolean(entry && entry.data && !entry.invalidated && Date.now() - entry.updatedAt < BUSINESS_CACHE_TTL);
}

App({
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

  onLaunch: function () {
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
    this.ensureLogin().catch(function () {});
  },

  onShow: function () {
    const self = this;
    if (this._analyticsTimer) clearInterval(this._analyticsTimer);
    // Local date checks only; daily dedup prevents periodic cloud requests.
    this._analyticsTimer = setInterval(function () { self.recordVisibleActivity(); }, 60000);
    this.ensureLogin().then(function () {
      self.recordVisibleActivity();
      return self.refreshPendingBadge();
    }).catch(function () { self.clearPendingBadge(); });
  },

  onHide: function () {
    if (this._analyticsTimer) clearInterval(this._analyticsTimer);
    this._analyticsTimer = null;
  },

  restoreLocalState: function () {
    this.globalData.user = wx.getStorageSync('youpu_user') || null;
    wx.removeStorageSync('youpu_openid');
    this.globalData.currentFamily = wx.getStorageSync('youpu_current_family') || null;
  },

  ensureLogin: function (options) {
    const self = this;
    const force = Boolean(options && options.force);
    if (this.loginPromise) return this.loginPromise;
    if (!force && this.globalData.user && Date.now() - this.loginUpdatedAt < LOGIN_CACHE_TTL) {
      return Promise.resolve({
        user: this.globalData.user,
        accountState: this.globalData.accountState || 'active',
        deletion: this.globalData.deletion || null
      });
    }

    const sessionVersion = this._sessionVersion || 0;
    this.loginPromise = api.call('auth.login').then(function (data) {
      self.assertSessionVersion(sessionVersion);
      if (self.globalData.user && data.user && self.globalData.user._id !== data.user._id) {
        self.dataCache = emptyDataCache();
        api.clearMediaUrlCache();
        self.globalData.familyList = [];
        self.setCurrentFamily(null);
      }
      self.globalData.user = data.user;
      self.globalData.loggedIn = data.accountState === 'active';
      self.globalData.accountState = data.accountState || 'active';
      self.globalData.deletion = data.deletion || null;
      if (self.globalData.accountState !== 'active') {
        self.dataCache = emptyDataCache();
        api.clearMediaUrlCache();
        self.globalData.familyList = [];
        self.setCurrentFamily(null);
      }
      self.loginUpdatedAt = Date.now();
      wx.setStorageSync('youpu_user', data.user);
      return data;
    }).catch(function (error) {
      console.error('有谱登录失败', error);
      throw error;
    }).then(function (data) {
      if ((self._sessionVersion || 0) === sessionVersion) self.loginPromise = null;
      return data;
    }, function (error) {
      if ((self._sessionVersion || 0) === sessionVersion) self.loginPromise = null;
      throw error;
    });

    return this.loginPromise;
  },

  loadFamilies: function (options) {
    const self = this;
    const sessionVersion = this._sessionVersion || 0;
    return this.ensureLogin().then(function () {
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
      const matched = current && families.find(function (item) {
        return item._id === current._id;
      });

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

  getCacheEntry: function (type, key) {
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
    const entry = this.getCacheEntry('graph', familyId);
    return this.loadCached(entry, function () {
      return api.call('graph.get', { familyId: familyId });
    }, options).then(data => { this.recordFamilyVisit(familyId); return data; });
  },

  getDashboard: function (familyId, options) {
    const entry = this.getCacheEntry('dashboard', familyId);
    return this.loadCached(entry, function () {
      return api.call('family.dashboard', { familyId: familyId });
    }, options).then(data => { this.recordFamilyVisit(familyId); return data; });
  },

  recordVisit: function (kind, payload) {
    if (!this.globalData.loggedIn || !this.globalData.user) return;
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    if (this._analyticsDay !== date) { this._analyticsDay = date; this._analyticsVisits = {}; }
    const visits = this._analyticsVisits || (this._analyticsVisits = {});
    const key = this.globalData.user._id + ':' + kind + ':' + ((payload && (payload.familyId || payload.slug)) || '');
    if (visits[key]) return;
    visits[key] = true;
    api.call('analytics.track', Object.assign({ kind: kind }, payload || {})).catch(function () { delete visits[key]; });
  },

  recordVisibleActivity: function () {
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
      return api.call('examples.list', { tag: selectedTag });
    }, options);
  },

  getExample: function (slug, options) {
    return this.loadCached(this.getCacheEntry('example', slug), function () {
      return api.call('examples.get', { slug: slug });
    }, options).then(data => { this.recordExampleVisit(slug); return data; });
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

  updateEntry: function (entry, data) {
    this.invalidateEntry(entry);
    entry.data = data;
    entry.updatedAt = Date.now();
    entry.invalidated = false;
  },

  updatePreference: function (familyId, preference) {
    const preferenceEntry = this.getCacheEntry('preference', familyId);
    if (preferenceEntry.data && preferenceEntry.data.family && !preferenceEntry.invalidated) {
      this.updateEntry(preferenceEntry, Object.assign({}, preferenceEntry.data, { preference: preference }));
    } else if (preferenceEntry.promise) {
      this.invalidateEntry(preferenceEntry);
    }
    const graphEntry = this.getCacheEntry('graph', familyId);
    if (graphEntry.data && !graphEntry.invalidated) {
      this.updateEntry(graphEntry, Object.assign({}, graphEntry.data, { preference: preference }));
    }
  },

  updatePersonDetail: function (personId, result) {
    if (result && result.person) this.updateEntry(this.getCacheEntry('personDetail', personId), result);
  },

  applyPersonUpdate: function (familyId, person) {
    if (!person || !person._id) return;
    const graphEntry = this.getCacheEntry('graph', familyId);
    if (graphEntry.data && !graphEntry.invalidated) {
      this.updateEntry(graphEntry, Object.assign({}, graphEntry.data, {
        persons: (graphEntry.data.persons || []).map(function (item) {
          return item._id === person._id ? person : item;
        })
      }));
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
        this.updateEntry(entry, Object.assign({}, entry.data, { person: isCurrent ? person : entry.data.person, relatives: relatives }));
      }
    }, this);
    this.invalidateCache({ dashboard: familyId });
  },

  applyFamilyUpdate: function (family) {
    if (!family || !family._id) return;
    ['active', 'all'].forEach(function (name) {
      const entry = this.dataCache.familyPages[name];
      if (entry.data && !entry.invalidated) {
        this.updateEntry(entry, Object.assign({}, entry.data, {
          families: (entry.data.families || []).map(function (item) { return item._id === family._id ? family : item; })
        }));
      } else if (entry.promise) this.invalidateEntry(entry);
    }, this);
    ['graph', 'dashboard'].forEach(function (type) {
      const entry = this.getCacheEntry(type, family._id);
      if (entry.data && !entry.invalidated) this.updateEntry(entry, Object.assign({}, entry.data, { family: family }));
      else if (entry.promise) this.invalidateEntry(entry);
    }, this);
    this.globalData.familyList = this.globalData.familyList.map(function (item) { return item._id === family._id ? family : item; });
    if (this.getCurrentFamily() && this.getCurrentFamily()._id === family._id) this.setCurrentFamily(family);
    this.invalidateCache({ profile: true });
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
      this.loginUpdatedAt = 0;
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

  invalidateFamilyData: function (familyId) {
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
    this._pendingBadgeVersion = (this._pendingBadgeVersion || 0) + 1;
    this._pendingBadgeRequest = null;
    this._pendingBadgeFamilyId = '';
    this._pendingBadgeCount = 0;
    if (typeof wx !== 'undefined' && wx.removeTabBarBadge) wx.removeTabBarBadge({ index: 1 });
  },

  setPendingBadgeCount: function (familyId, count) {
    const current = this.getCurrentFamily();
    if (!current || current._id !== familyId) return;
    this._pendingBadgeVersion = (this._pendingBadgeVersion || 0) + 1;
    this._pendingBadgeRequest = null;
    const value = Math.max(0, Math.floor(Number(count) || 0));
    this._pendingBadgeFamilyId = familyId;
    this._pendingBadgeCount = value;
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
    const key = actorId + '|' + familyId;
    if (!(options && options.force) && this._pendingBadgeRequest && this._pendingBadgeRequest.key === key) {
      return this._pendingBadgeRequest.promise;
    }
    const version = this._pendingBadgeVersion = (this._pendingBadgeVersion || 0) + 1;
    const self = this;
    const request = { key: key, promise: null };
    request.promise = api.call('change.pendingCount', { familyId: familyId }).then(function (data) {
      if (version !== self._pendingBadgeVersion || !self.getCurrentFamily() || self.getCurrentFamily()._id !== familyId ||
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
    const previous = this.globalData.currentFamily;
    this.globalData.currentFamily = family || null;
    if (family) {
      wx.setStorageSync('youpu_current_family', family);
    } else {
      wx.removeStorageSync('youpu_current_family');
    }
    if ((previous && previous._id || '') !== (family && family._id || '')) {
      this.clearPendingBadge();
      if (family) this.refreshPendingBadge().catch(function () {});
    }
  },

  getCurrentFamily: function () {
    if (!this.globalData.currentFamily) {
      this.globalData.currentFamily = wx.getStorageSync('youpu_current_family') || null;
    }
    return this.globalData.currentFamily;
  },

  setUser: function (user) {
    this.globalData.user = user;
    wx.setStorageSync('youpu_user', user);
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
    this.clearLocalData();
    const keys = wx.getStorageInfoSync().keys || [];
    keys.forEach(function (key) {
      if (key.indexOf('youpu_') === 0) wx.removeStorageSync(key);
    });
  },

  clearLocalData: function () {
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
  }
});
