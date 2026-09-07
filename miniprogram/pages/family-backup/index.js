const app = getApp();
const api = require('../../utils/api');
const fileTransfer = require('../../utils/file-transfer');

function sizeText(bytes) { const size = Number(bytes) || 0; return size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.ceil(size / 1024)) + ' KB'; }
Page({
  data: { familyId: '', family: null, isAdmin: false, membershipActive: false, loading: true, creating: false, task: null, parts: [], downloadingPartIndex: -1, sharingPartIndex: -1, readyPartIndex: -1, downloadProgress: 0 },
  onLoad: function (options) { this.setData({ familyId: options.familyId || '' }); },
  onShow: function () { this.loadPage(); },
  onUnload: function () {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._readyPart) fileTransfer.removeTempFile(this._readyPart.filePath);
    this._readyPart = null;
  },
  loadPage: function () {
    const self = this; this._stopped = false;
    return api.call('membership.status', { familyId: this.data.familyId }).then(function (data) {
      self.setData({ family: data.family, isAdmin: data.family.currentRole === 'admin', membershipActive: data.membership.active, loading: false });
      const taskId = wx.getStorageSync('youpu_family_backup_' + self.data.familyId);
      if (taskId) return self.loadTask(taskId);
      return null;
    }).catch(function (error) { self.setData({ loading: false }); wx.showToast({ title: error.message || '备份状态加载失败', icon: 'none' }); });
  },
  loadTask: function (taskId) {
    const self = this;
    return api.call('family.backup.status', { taskId: taskId }).then(function (task) {
      const parts = (task.parts || []).map(function (item) { return Object.assign({}, item, { sizeText: sizeText(item.size) }); });
      self.setData({ task: task, parts: parts, creating: ['pending', 'processing'].includes(task.status) });
      if (['pending', 'processing'].includes(task.status) && !self._stopped) self._timer = setTimeout(function () { self.loadTask(taskId); }, 3500);
    }).catch(function () { wx.removeStorageSync('youpu_family_backup_' + self.data.familyId); });
  },
  createBackup: function () {
    const self = this;
    if (!this.data.isAdmin) { wx.showToast({ title: '仅家谱管理员可生成备份', icon: 'none' }); return; }
    if (!this.data.membershipActive) { this.openMembership(); return; }
    this.setData({ creating: true });
    api.call('family.backup.create', { familyId: this.data.familyId }).then(function (task) {
      wx.setStorageSync('youpu_family_backup_' + self.data.familyId, task.taskId);
      self.setData({ task: task }); self.loadTask(task.taskId);
    }).catch(function (error) { self.setData({ creating: false }); wx.showToast({ title: error.message || '备份创建失败', icon: 'none' }); });
  },
  downloadPart: function (event) {
    if (this.data.downloadingPartIndex >= 0 || this.data.sharingPartIndex >= 0) return;
    if (!fileTransfer.canShareFile(wx)) {
      wx.showModal({ title: '当前微信版本暂不支持文件转发', content: '请升级微信后再领取家庭备份。', showCancel: false });
      return;
    }
    const index = Number(event.currentTarget.dataset.index) || 0;
    if (this.data.readyPartIndex === index && this._readyPart) {
      this.shareReadyPart();
      return;
    }
    this.downloadBackupPart(index);
  },
  downloadBackupPart: function (index) {
    const self = this;
    const previous = this._readyPart;
    let filePath = '';
    let loadingVisible = true;
    this._readyPart = null;
    this.setData({ downloadingPartIndex: index, readyPartIndex: -1, downloadProgress: 0 });
    wx.showLoading({ title: '正在下载分卷' });
    fileTransfer.removeTempFile(previous && previous.filePath).then(function () {
      return api.call('family.backup.partUrl', { taskId: self.data.task.taskId, partIndex: index });
    }).then(function (data) {
      return fileTransfer.downloadToTempFile(data.url, {
        fileName: data.fileName,
        onProgress: function (progress) { self.setData({ downloadProgress: progress }); }
      }).then(function (result) {
        filePath = result.filePath;
        wx.hideLoading();
        loadingVisible = false;
        self._readyPart = { index: index, filePath: filePath, fileName: data.fileName };
        self.setData({ downloadingPartIndex: -1, readyPartIndex: index, downloadProgress: 100 });
        wx.showToast({ title: '下载完成，请点击转发到聊天', icon: 'none', duration: 2600 });
      });
    }).catch(function (error) {
      wx.showToast({ title: error.message || error.errMsg || '分卷下载失败', icon: 'none' });
    }).then(function () {
      if (loadingVisible) wx.hideLoading();
      if (!self._readyPart) return fileTransfer.removeTempFile(filePath);
      return null;
    }).then(function () {
      if (!self._readyPart) self.setData({ downloadingPartIndex: -1, readyPartIndex: -1, downloadProgress: 0 });
    });
  },
  shareReadyPart: function () {
    const self = this;
    const ready = this._readyPart;
    if (!ready) { this.setData({ readyPartIndex: -1 }); return; }
    this.setData({ sharingPartIndex: ready.index });
    fileTransfer.shareFile(ready.filePath, ready.fileName).then(function () {
      self._readyPart = null;
      self.setData({ sharingPartIndex: -1, readyPartIndex: -1, downloadProgress: 0 });
      wx.showToast({ title: '已转发备份分卷', icon: 'success' });
      return fileTransfer.removeTempFile(ready.filePath);
    }).catch(function (error) {
      self.setData({ sharingPartIndex: -1 });
      if (fileTransfer.isCancelled(error)) {
        wx.showToast({ title: '已取消，可再次点击转发', icon: 'none' });
        return;
      }
      console.error('家庭备份文件转发失败', { code: error.code, errMsg: error.errMsg });
      wx.showModal({ title: '文件转发失败', content: fileTransfer.shareFailureText(error), showCancel: false });
    });
  },
  openMembership: function () { wx.navigateTo({ url: '/pages/membership/index?familyId=' + this.data.familyId }); },
  openHistory: function () { wx.navigateTo({ url: '/pages/activity/index?familyId=' + this.data.familyId }); }
});
