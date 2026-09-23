const api = require('../../utils/api');
const posterSession = require('../../utils/poster-session');
const privacy = require('../../utils/privacy');

function cancelled(error) {
  return String(error && error.errMsg || '').toLowerCase().includes('cancel');
}

function privacyAuthorizationFailure(error) {
  const message = String(error && error.errMsg || error && error.message || '').toLowerCase();
  return message.includes('privacy') && message.includes('not authorized');
}

function appAlbumPermission() {
  if (typeof wx.getAppAuthorizeSetting !== 'function') return 'unknown';
  try {
    const setting = wx.getAppAuthorizeSetting() || {};
    const state = setting.albumAuthorized;
    if (state === 'authorized') return 'authorized';
    if (state === 'denied') return 'denied';
    return 'not determined';
  } catch (error) {
    return 'unknown';
  }
}

function miniProgramAlbumPermission() {
  if (typeof wx.getSetting !== 'function') return Promise.resolve(undefined);
  return new Promise(function (resolve) {
    wx.getSetting({
      success: function (setting) {
        resolve(setting.authSetting && setting.authSetting['scope.writePhotosAlbum']);
      },
      fail: function () { resolve(undefined); }
    });
  });
}

function requestMiniProgramAlbumPermission() {
  return miniProgramAlbumPermission().then(function (state) {
    if (state === true) return true;
    if (typeof wx.authorize !== 'function') return true;
    return new Promise(function (resolve, reject) {
      wx.authorize({
        scope: 'scope.writePhotosAlbum',
        success: function () { resolve(true); },
        fail: function (cause) {
          const error = new Error(String(cause && cause.errMsg || '保存到相册授权失败'));
          error.code = 'MINIPROGRAM_ALBUM_DENIED';
          error.cause = cause;
          reject(error);
        }
      });
    });
  });
}

Page({
  data: {
    filePath: '',
    familyName: '',
    sharePayload: null,
    entrancePath: '/pages/tree/index',
    error: '',
    saving: false,
    sharing: false,
    permissionGuide: ''
  },

  onLoad: function () {
    const session = posterSession.take();
    if (!session || !session.filePath) {
      this.setData({ error: '图片已经失效，请返回家谱重新生成。' });
      return;
    }
    this.setData({
      filePath: session.filePath,
      familyName: session.familyName || '家谱',
      sharePayload: session.sharePayload || (session.invitationId ? { invitationId: session.invitationId } : null),
      entrancePath: session.entrancePath || '/pages/tree/index'
    });
  },

  onShow: function () {
    if (!this._resumeAlbumSave) return;
    this._resumeAlbumSave = false;
    if (appAlbumPermission() === 'denied') {
      this.setData({ permissionGuide: 'system' });
      wx.showToast({ title: '还未开启微信的相册权限', icon: 'none' });
      return;
    }
    this.saveImage();
  },

  shareImage: function () {
    if (!this.data.filePath || this.data.sharing) return;
    if (typeof wx.showShareImageMenu !== 'function') {
      wx.showToast({ title: '当前微信版本暂不支持，请先保存图片', icon: 'none' });
      return;
    }
    const self = this;
    this.setData({ sharing: true });
    wx.showShareImageMenu({
      path: this.data.filePath,
      needShowEntrance: true,
      entrancePath: this.data.entrancePath,
      success: function () {
        if (self.data.sharePayload) {
          api.call('share.record', Object.assign({ stage: 'sent' }, self.data.sharePayload)).catch(function () {});
        }
      },
      fail: function (error) {
        if (!cancelled(error)) wx.showToast({ title: '图片发送失败，请重试', icon: 'none' });
      },
      complete: function () { self.setData({ sharing: false }); }
    });
  },

  closePermissionGuide: function () {
    this._resumeAlbumSave = false;
    this.setData({ permissionGuide: '' });
  },

  onMiniProgramSetting: function (event) {
    const authSetting = event && event.detail && event.detail.authSetting || {};
    this.setData({ permissionGuide: '' });
    if (authSetting['scope.writePhotosAlbum']) {
      this.saveImage();
      return;
    }
    wx.showToast({ title: '还未开启保存到相册权限', icon: 'none' });
  },

  openSystemAlbumSetting: function () {
    if (typeof wx.openAppAuthorizeSetting !== 'function') {
      this.setData({ permissionGuide: '' });
      wx.showToast({ title: '请在手机系统设置中为微信开启照片权限', icon: 'none', duration: 3000 });
      return;
    }
    const self = this;
    this._resumeAlbumSave = true;
    this.setData({ permissionGuide: '' });
    wx.openAppAuthorizeSetting({
      fail: function () {
        self._resumeAlbumSave = false;
        wx.showToast({ title: '系统权限设置打开失败', icon: 'none' });
      }
    });
  },

  saveToAlbum: function () {
    const filePath = this.data.filePath;
    return new Promise(function (resolve, reject) {
      wx.saveImageToPhotosAlbum({ filePath: filePath, success: resolve, fail: reject });
    });
  },

  saveImage: function () {
    if (!this.data.filePath || this.data.saving) return;
    const self = this;
    this.setData({ saving: true });
    privacy.ensurePrivacyAuthorized().then(function () {
      return requestMiniProgramAlbumPermission();
    }).then(function () {
      return self.saveToAlbum();
    }).then(function () {
      wx.showToast({ title: '图片已保存', icon: 'success' });
    }).catch(function (error) {
      if (cancelled(error)) return null;
      if (error && error.code === 'PRIVACY_DENIED' || privacyAuthorizationFailure(error)) {
        wx.showToast({ title: '同意隐私保护指引后才能保存', icon: 'none' });
        return null;
      }
      if (error && error.code === 'MINIPROGRAM_ALBUM_DENIED') {
        self.setData({ permissionGuide: 'miniprogram' });
        return null;
      }
      if (appAlbumPermission() === 'denied') {
        self.setData({ permissionGuide: 'system' });
        return null;
      }
      wx.showToast({ title: '图片保存失败，请重试', icon: 'none' });
      return null;
    }).then(function () {
      self.setData({ saving: false });
    });
  },

  goBack: function () {
    if (typeof getCurrentPages === 'function' && getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    wx.switchTab({ url: '/pages/tree/index' });
  }
});
