const api = require('./utils/api');
const environmentConfig = require('./config/env');
const activeEnvironment = environmentConfig.environments[environmentConfig.active];
const CACHE_TTL = 60 * 1000;

function cacheEntry() {
  return { data: null, updatedAt: 0, invalidated: false, promise: null };
}

function isFresh(entry) {
  return Boolean(entry && entry.data && !entry.invalidated && Date.now() - entry.updatedAt < CACHE_TTL);
}

App({
  loginPromise: null,
  loginUpdatedAt: 0,
  dataCache: {
    familyPages: { active: cacheEntry(), all: cacheEntry() },
    graph: {},
    dashboard: {},
    profile: cacheEntry()
  },

  globalData: {
    environment: environmentConfig.active,
    env: activeEnvironment.cloudEnv,
    user: null,
    familyList: [],
    currentFamily: null,
    loggedIn: false
  },

  onLaunch: function () {
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

  restoreLocalState: function () {
    this.globalData.user = wx.getStorageSync('youpu_user') || null;
    wx.removeStorageSync('youpu_openid');
    this.globalData.currentFamily = wx.getStorageSync('youpu_current_family') || null;
  },

  ensureLogin: function (options) {
    const self = this;
    const force = Boolean(options && options.force);
    if (this.loginPromise) return this.loginPromise;
    if (!force && this.globalData.user && Date.now() - this.loginUpdatedAt < CACHE_TTL) {
      return Promise.resolve({
        user: this.globalData.user,
        accountState: this.globalData.accountState || 'active',
        deletion: this.globalData.deletion || null
      });
    }

    this.loginPromise = api.call('auth.login').then(function (data) {
      self.globalData.user = data.user;
      self.globalData.loggedIn = data.accountState === 'active';
      self.globalData.accountState = data.accountState || 'active';
      self.globalData.deletion = data.deletion || null;
      self.loginUpdatedAt = Date.now();
      wx.setStorageSync('youpu_user', data.user);
      return data;
    }).catch(function (error) {
      console.error('有谱登录失败', error);
      throw error;
    }).then(function (data) {
      self.loginPromise = null;
      return data;
    }, function (error) {
      self.loginPromise = null;
      throw error;
    });

    return this.loginPromise;
  },

  loadFamilies: function (options) {
    const self = this;
    return this.ensureLogin(options).then(function () {
      if (self.globalData.accountState === 'pending_delete') {
        self.globalData.familyList = [];
        self.setCurrentFamily(null);
        return { families: [] };
      }
      return self.loadFamilyPages(false, options);
    }).then(function (data) {
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
    const force = Boolean(options && options.force);
    if (!force && isFresh(entry)) return Promise.resolve(entry.data);
    if (entry.promise) return entry.promise;
    entry.promise = Promise.resolve().then(loader).then(function (data) {
      entry.data = data;
      entry.updatedAt = Date.now();
      entry.invalidated = false;
      entry.promise = null;
      return data;
    }, function (error) {
      entry.promise = null;
      throw error;
    });
    return entry.promise;
  },

  getCacheEntry: function (type, key) {
    if (type === 'familyPages') return this.dataCache.familyPages[key ? 'all' : 'active'];
    if (!this.dataCache[type][key]) this.dataCache[type][key] = cacheEntry();
    return this.dataCache[type][key];
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
    }, options);
  },

  getDashboard: function (familyId, options) {
    const entry = this.getCacheEntry('dashboard', familyId);
    return this.loadCached(entry, function () {
      return api.call('family.dashboard', { familyId: familyId });
    }, options);
  },

  getProfileData: function (loader, options) {
    return this.loadCached(this.dataCache.profile, loader, options);
  },

  invalidateCache: function (options) {
    const config = options || {};
    if (config.families) {
      this.dataCache.familyPages.active.invalidated = true;
      this.dataCache.familyPages.all.invalidated = true;
    }
    if (config.profile) this.dataCache.profile.invalidated = true;
    if (config.graph) this.getCacheEntry('graph', config.graph).invalidated = true;
    if (config.dashboard) this.getCacheEntry('dashboard', config.dashboard).invalidated = true;
  },

  invalidateFamilyData: function (familyId) {
    this.invalidateCache({
      families: true,
      profile: true,
      graph: familyId,
      dashboard: familyId
    });
  },

  setCurrentFamily: function (family) {
    this.globalData.currentFamily = family || null;
    if (family) {
      wx.setStorageSync('youpu_current_family', family);
    } else {
      wx.removeStorageSync('youpu_current_family');
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

  clearLocalData: function () {
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
    this.dataCache = {
      familyPages: { active: cacheEntry(), all: cacheEntry() },
      graph: {},
      dashboard: {},
      profile: cacheEntry()
    };
  }
});
