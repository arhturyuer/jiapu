const api = require('./utils/api');
const environmentConfig = require('./config/env');
const activeEnvironment = environmentConfig.environments[environmentConfig.active];

App({
  loginPromise: null,

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

  ensureLogin: function () {
    const self = this;
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = api.call('auth.login').then(function (data) {
      self.globalData.user = data.user;
      self.globalData.loggedIn = data.accountState === 'active';
      self.globalData.accountState = data.accountState || 'active';
      self.globalData.deletion = data.deletion || null;
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

  loadFamilies: function () {
    const self = this;
    return this.ensureLogin().then(function () {
      if (self.globalData.accountState === 'pending_delete') {
        self.globalData.familyList = [];
        self.setCurrentFamily(null);
        return { families: [] };
      }
      return self.loadFamilyPages(false);
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

  loadFamilyPages: function (includeArchived) {
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
  },

  openPerspective: function (family, personId) {
    this.setCurrentFamily(family);
    wx.setStorageSync('youpu_pending_view', {
      mode: 'perspective',
      personId: personId
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
    this.globalData.user = null;
    this.globalData.familyList = [];
    this.globalData.currentFamily = null;
    this.globalData.loggedIn = false;
  }
});
