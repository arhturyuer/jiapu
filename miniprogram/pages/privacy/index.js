const app = getApp();
const api = require('../../utils/api');
const legal = require('../../config/legal');
const format = require('../../utils/format');

const EXPORT_TASK_STORAGE_KEY = 'youpu_export_task';

function decorateReports(items) {
  const labels = { open: '待处理', processing: '处理中', resolved: '已解决', rejected: '未采纳' };
  return (items || []).map(function (item) { return Object.assign({}, item, { statusText: labels[item.status] || item.status }); });
}

function decorateExportTask(task) {
  return Object.assign({}, task, { expiresText: task && task.expiresAt ? format.dateText(task.expiresAt) : '' });
}

function deletionExecuteText(deletion) {
  return deletion && deletion.executeAt ? format.dateText(deletion.executeAt) : '';
}

Page({
  data: {
    loading: true, error: '', legal: legal, accountState: 'active', deletion: null,
    reports: [], reportCursor: '', hasMoreReports: false, exporting: false, exportTask: null,
    deleting: false, cancelling: false, deletionExecuteText: ''
  },

  onShow: function () {
    this._pageVisible = true;
    this.loadAccount();
  },
  onHide: function () {
    this._pageVisible = false;
    this.clearExportTimer();
  },
  onUnload: function () {
    this._pageVisible = false;
    this.clearExportTimer();
  },

  clearExportTimer: function () {
    if (this._exportTimer) clearTimeout(this._exportTimer);
    this._exportTimer = null;
  },

  loadAccount: function () {
    const self = this;
    this.setData({ loading: true, error: '' });
    return api.call('auth.login').then(function (data) {
      app.globalData.accountState = data.accountState;
      app.globalData.deletion = data.deletion || null;
      self.setData({
        loading: false,
        accountState: data.accountState || 'active',
        deletion: data.deletion || null,
        deletionExecuteText: deletionExecuteText(data.deletion)
      });
      const taskId = wx.getStorageSync(EXPORT_TASK_STORAGE_KEY);
      const accountTasks = taskId ? self.refreshExportTask(taskId, false) : Promise.resolve();
      if (data.accountState !== 'active') return accountTasks;
      return Promise.all([accountTasks, api.call('report.listMine', { pageSize: 20 }).then(function (result) {
        self.setData({ reports: decorateReports(result.items), reportCursor: result.nextCursor || '', hasMoreReports: Boolean(result.hasMore) });
      }).catch(function () {
        self.setData({ reports: [], reportCursor: '', hasMoreReports: false });
      })]);
    }).catch(function (error) {
      self.setData({ loading: false, error: error.message || '账户状态加载失败，请检查网络后重试' });
    });
  },

  refreshExportTask: function (taskId, scheduleRetry) {
    const self = this;
    if (!taskId) return Promise.resolve();
    return api.call('account.exportStatus', { taskId: taskId }).then(function (task) {
      self.setData({ exportTask: decorateExportTask(task) });
      if ((task.status === 'pending' || task.status === 'processing') && scheduleRetry !== false && self._pageVisible !== false) {
        self.clearExportTimer();
        self._exportTimer = setTimeout(function () { self.refreshExportTask(taskId, true); }, 30000);
      } else if (task.status !== 'pending' && task.status !== 'processing') {
        self.clearExportTimer();
      }
      return task;
    }).catch(function () {
      wx.removeStorageSync(EXPORT_TASK_STORAGE_KEY);
      self.setData({ exportTask: null });
    });
  },

  exportData: function () {
    const self = this;
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    api.call('account.export').then(function (task) {
      wx.setStorageSync(EXPORT_TASK_STORAGE_KEY, task.taskId);
      self.setData({ exportTask: decorateExportTask(task) });
      wx.showToast({ title: '已开始准备导出文件', icon: 'none' });
      return self.refreshExportTask(task.taskId, true);
    }).catch(function (error) {
      wx.showToast({ title: error.message || '导出申请失败', icon: 'none' });
    }).then(function () { self.setData({ exporting: false }); });
  },

  shareExport: function () {
    const self = this;
    const task = this.data.exportTask;
    if (!task || task.status !== 'completed' || this.data.exporting) return;
    if (!wx.shareFileMessage) {
      wx.showModal({ title: '当前微信版本暂不支持安全导出', content: '请升级微信后再下载导出文件，或通过微信客服申请导出。为保护隐私，文件不会复制到剪贴板。', showCancel: false });
      return;
    }
    this.setData({ exporting: true });
    let filePath = '';
    api.call('account.exportUrl', { taskId: task.taskId }).then(function (data) {
      return wx.downloadFile({ url: data.url });
    }).then(function (result) {
      if (result.statusCode !== 200) throw new Error('导出文件下载失败');
      filePath = result.tempFilePath;
      return wx.shareFileMessage({ filePath: filePath, fileName: '有谱个人信息导出.json' });
    }).then(function () {
      wx.removeStorageSync(EXPORT_TASK_STORAGE_KEY);
      self.setData({ exportTask: Object.assign({}, task, { status: 'download_issued' }) });
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) wx.showToast({ title: '已取消分享；如需导出请重新申请', icon: 'none' });
      else wx.showToast({ title: error.message || '导出文件分享失败', icon: 'none' });
    }).then(function () {
      if (filePath) wx.getFileSystemManager().unlink({ filePath: filePath, fail: function () {} });
      self.setData({ exporting: false });
    });
  },

  requestDeletion: function () {
    const self = this;
    if (this.data.deleting) return;
    wx.showModal({ title: '申请注销账户？', content: '申请后进入 7 天冷静期并暂停使用。你的账户资料将被匿名化，共享家谱仍由家庭管理员维护。', confirmText: '申请注销', confirmColor: '#B43D3D' }).then(function (result) {
      if (!result.confirm) return null;
      if (self.data.deleting) return null;
      self.setData({ deleting: true });
      return api.call('account.requestDeletion');
    }).then(function (data) {
      if (!data) return;
      app.globalData.accountState = 'pending_delete'; app.globalData.loggedIn = false;
      self.setData({ accountState: 'pending_delete', deletion: data, deletionExecuteText: deletionExecuteText(data) });
      wx.showToast({ title: '已进入注销冷静期', icon: 'none' });
    }).catch(function (error) {
      if (error.code === 'LAST_ADMIN' && error.details && error.details.familyId) return self.showLastAdminGuidance(error);
      wx.showToast({ title: error.message || '注销申请失败', icon: 'none' });
    }).then(function () { self.setData({ deleting: false }); });
  },

  showLastAdminGuidance: function (error) {
    const details = error.details || {};
    const familyName = details.familyName ? '“' + details.familyName + '”' : '这份家谱';
    return wx.showModal({
      title: '请先处理家谱',
      content: '你是' + familyName + '的最后一名管理员。请先转让管理员，或将家谱移入回收站后再申请注销。',
      confirmText: '去处理'
    }).then(function (result) {
      if (!result.confirm) return;
      return wx.navigateTo({ url: '/pages/family-manage/index?familyId=' + details.familyId + '&section=collaborators' });
    }).catch(function (modalError) {
      wx.showToast({ title: modalError.message || modalError.errMsg || error.message || '注销申请失败', icon: 'none' });
    });
  },

  cancelDeletion: function () {
    const self = this;
    if (this.data.cancelling) return;
    this.setData({ cancelling: true });
    api.call('account.cancelDeletion').then(function () {
      app.globalData.accountState = 'active'; app.globalData.loggedIn = true;
      self.setData({ accountState: 'active', deletion: null, deletionExecuteText: '' });
      wx.showToast({ title: '注销已撤销', icon: 'success' });
    }).catch(function (error) { wx.showToast({ title: error.message || '撤销失败', icon: 'none' }); }).then(function () { self.setData({ cancelling: false }); });
  },

  clearCache: function () {
    wx.showModal({ title: '清除本机缓存？', content: '只会清除这台设备上的临时资料，不会退出微信登录，也不会删除云端家谱。' }).then(function (result) {
      if (!result.confirm) return;
      app.clearLocalData();
      wx.showToast({ title: '本机缓存已清除', icon: 'success' });
      setTimeout(function () { wx.reLaunch({ url: '/pages/tree/index' }); }, 500);
    });
  },

  showFeedbackGroup: function () { wx.navigateTo({ url: '/pages/feedback-group/index' }); },
  openPermissionSettings: function () { wx.openSetting().catch(function () { wx.showToast({ title: '请在微信设置中管理小程序权限', icon: 'none' }); }); },
  openLegal: function (event) { wx.navigateTo({ url: '/pages/legal/index?type=' + event.currentTarget.dataset.type }); },
  openReportTarget: function (event) {
    const report = this.data.reports.find(function (item) { return item._id === event.currentTarget.dataset.id; });
    if (!report) return;
    wx.showModal({ title: report.statusText, content: report.resolution || (report.status === 'processing' ? '运营人员正在处理这项举报。' : '处理完成后，结果会显示在这里。'), showCancel: false });
  },
  loadMoreReports: function () {
    const self = this;
    if (!this.data.hasMoreReports) return;
    api.call('report.listMine', { pageSize: 20, cursor: this.data.reportCursor }).then(function (result) {
      self.setData({ reports: self.data.reports.concat(decorateReports(result.items)), reportCursor: result.nextCursor || '', hasMoreReports: Boolean(result.hasMore) });
    }).catch(function (error) { wx.showToast({ title: error.message || '加载失败', icon: 'none' }); });
  }
});
