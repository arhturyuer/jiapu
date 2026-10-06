const launchAd = require('../../utils/launch-ad');
const app = getApp();
const api = require('../../utils/api');
const legal = require('../../config/legal');
const format = require('../../utils/format');
const fileTransfer = require('../../utils/file-transfer');

const EXPORT_TASK_STORAGE_KEY = 'youpu_export_task';

function decorateReports(items) {
  const labels = { open: '待处理', processing: '处理中', resolved: '已解决', rejected: '未采纳' };
  const targetLabels = { person: '人物资料', media: '人物头像', family: '家谱资料', invitation: '邀请内容', invite: '邀请内容' };
  return (items || []).map(function (item) {
    return Object.assign({}, item, {
      statusText: labels[item.status] || '处理中',
      targetTypeText: targetLabels[item.targetType] || '相关资料'
    });
  });
}

function decorateExportTask(task) {
  return Object.assign({}, task, { expiresText: task && task.expiresAt ? format.dateText(task.expiresAt) : '' });
}

function deletionExecuteText(deletion) {
  return deletion && deletion.executeAt ? format.dateText(deletion.executeAt) : '';
}

Page(launchAd.wrap({
  data: {
    loading: true, error: '', legal: legal, accountState: 'active', deletion: null,
    reports: [], reportCursor: '', hasMoreReports: false, exporting: false, exportTask: null, exportFileReady: false,
    deleting: false, cancelling: false, deletionExecuteText: '', supportProblemId: ''
  },

  onShow: function () {
    this._pageVisible = true;
    this.setData({ supportProblemId: api.lastProblemId() });
    this.loadAccount();
  },
  onHide: function () {
    this._pageVisible = false;
    this.clearExportTimer();
  },
  onUnload: function () {
    this._pageVisible = false;
    this.clearExportTimer();
    if (this._readyExport) fileTransfer.removeTempFile(this._readyExport.filePath);
    this._readyExport = null;
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
      self.setData({ loading: false, error: api.userMessage(error, '账户状态加载失败，请检查网络后重试') });
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
      wx.showToast({ title: api.userMessage(error, '暂时无法准备个人资料文件'), icon: 'none' });
    }).then(function () { self.setData({ exporting: false }); });
  },

  shareExport: function () {
    const self = this;
    const task = this.data.exportTask;
    if (!task || task.status !== 'completed' || this.data.exporting) return;
    if (!fileTransfer.canShareFile(wx)) {
      wx.showModal({ title: '当前微信版本暂不支持安全导出', content: '请升级微信后再下载导出文件，或通过微信客服申请导出。为保护隐私，文件不会复制到剪贴板。', showCancel: false });
      return;
    }
    if (this.data.exportFileReady && this._readyExport) {
      this.shareReadyExport();
      return;
    }
    this.setData({ exporting: true });
    let filePath = '';
    api.call('account.exportUrl', { taskId: task.taskId }).then(function (data) {
      return fileTransfer.downloadToTempFile(data.url, { fileName: '有谱个人信息导出.json' });
    }).then(function (result) {
      filePath = result.filePath;
      self._readyExport = { filePath: filePath, fileName: '有谱个人信息导出.json' };
      self.setData({ exporting: false, exportFileReady: true });
      wx.showToast({ title: '下载完成，请再次点击转发', icon: 'none', duration: 2600 });
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '个人资料文件下载失败'), icon: 'none' });
    }).then(function () {
      if (!self._readyExport) return fileTransfer.removeTempFile(filePath).then(function () { self.setData({ exporting: false, exportFileReady: false }); });
      return null;
    });
  },

  shareReadyExport: function () {
    const self = this;
    const task = this.data.exportTask;
    const ready = this._readyExport;
    if (!ready || !task) { this.setData({ exportFileReady: false }); return; }
    this.setData({ exporting: true });
    fileTransfer.shareFile(ready.filePath, ready.fileName).then(function () {
      self._readyExport = null;
      wx.removeStorageSync(EXPORT_TASK_STORAGE_KEY);
      self.setData({ exporting: false, exportFileReady: false, exportTask: Object.assign({}, task, { status: 'download_issued' }) });
      return fileTransfer.removeTempFile(ready.filePath);
    }).catch(function (error) {
      self.setData({ exporting: false });
      if (fileTransfer.isCancelled(error)) {
        wx.showToast({ title: '已取消，可再次点击转发', icon: 'none' });
        return;
      }
      console.error('个人信息导出文件转发失败', { code: error.code, errMsg: error.errMsg });
      wx.showModal({ title: '导出文件转发失败', content: fileTransfer.shareFailureText(error), showCancel: false });
    });
  },

  requestDeletion: function () {
    const self = this;
    if (this.data.deleting) return;
    wx.showModal({ title: '申请注销账户？', content: '申请后进入 7 天冷静期并暂停使用。届时会清除你的账户资料，并去除其他必要记录与你身份的关联；共享家谱仍由家庭管理员维护。', confirmText: '申请注销', confirmColor: '#B43D3D' }).then(function (result) {
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
      wx.showToast({ title: api.userMessage(error, '注销申请失败'), icon: 'none' });
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
      wx.showToast({ title: api.userMessage(modalError, '注销申请失败'), icon: 'none' });
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
    }).catch(function (error) { wx.showToast({ title: api.userMessage(error, '撤销失败'), icon: 'none' }); }).then(function () { self.setData({ cancelling: false }); });
  },

  clearCache: function () {
    wx.showModal({ title: '清理本机临时文件？', content: '只会清理这台设备上为提高速度保留的临时文件，不会退出微信登录，也不会删除已保存的家谱资料。' }).then(function (result) {
      if (!result.confirm) return;
      app.clearLocalData();
      wx.showToast({ title: '本机临时文件已清理', icon: 'success' });
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
    }).catch(function (error) { wx.showToast({ title: api.userMessage(error, '举报记录加载失败'), icon: 'none' }); });
  }
}));
