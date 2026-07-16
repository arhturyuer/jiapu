const app = getApp();
const api = require('../../utils/api');
const legal = require('../../config/legal');

Page({
  data: {
    loading: true,
    legal: legal,
    accountState: 'active',
    deletion: null,
    reports: [],
    reportCursor: '',
    hasMoreReports: false,
    exporting: false,
    deleting: false,
    cancelling: false
  },

  onShow: function () {
    this.loadAccount();
  },

  loadAccount: function () {
    const self = this;
    this.setData({ loading: true });
    return api.call('auth.login').then(function (data) {
      app.globalData.accountState = data.accountState;
      app.globalData.deletion = data.deletion || null;
      self.setData({
        loading: false,
        accountState: data.accountState || 'active',
        deletion: data.deletion || null
      });
      if (data.accountState !== 'active') return null;
      return api.call('report.listMine', { pageSize: 20 }).then(function (result) {
        const labels = { open: '待处理', processing: '处理中', resolved: '已解决', rejected: '未采纳' };
        self.setData({
          reports: (result.items || []).map(function (item) {
            return Object.assign({}, item, { statusText: labels[item.status] || item.status });
          }),
          reportCursor: result.nextCursor || '',
          hasMoreReports: Boolean(result.hasMore)
        });
      });
    }).catch(function (error) {
      self.setData({ loading: false });
      wx.showToast({ title: error.message || '账户状态加载失败', icon: 'none' });
    });
  },

  exportData: function () {
    const self = this;
    let exportPath = '';
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    api.call('account.export').then(function (data) {
      const content = JSON.stringify(data, null, 2);
      const filePath = wx.env.USER_DATA_PATH + '/youpu-personal-data-' + new Date().toISOString().slice(0, 10) + '.json';
      exportPath = filePath;
      return new Promise(function (resolve, reject) {
        wx.getFileSystemManager().writeFile({
          filePath: filePath,
          data: content,
          encoding: 'utf8',
          success: function () { resolve(filePath); },
          fail: reject
        });
      }).then(function (path) {
        if (wx.shareFileMessage) {
          return wx.shareFileMessage({ filePath: path, fileName: '有谱个人信息导出.json' });
        }
        return wx.setClipboardData({ data: content }).then(function () {
          return wx.showModal({
            title: '个人信息已导出',
            content: '当前微信版本不支持分享文件，导出内容已复制到剪贴板。',
            showCancel: false
          });
        });
      });
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) {
        wx.showToast({ title: '已取消分享', icon: 'none' });
        return;
      }
      wx.showToast({ title: error.message || '导出失败', icon: 'none' });
    }).then(function () {
      if (exportPath) {
        wx.getFileSystemManager().unlink({ filePath: exportPath, fail: function () {} });
      }
      self.setData({ exporting: false });
    });
  },

  requestDeletion: function () {
    const self = this;
    wx.showModal({
      title: '申请注销账户？',
      content: '申请后进入 7 天冷静期并暂停使用。你的账户资料将被匿名化，共享家谱仍由家庭管理员维护。',
      confirmText: '申请注销',
      confirmColor: '#B43D3D'
    }).then(function (result) {
      if (!result.confirm) return null;
      self.setData({ deleting: true });
      return api.call('account.requestDeletion');
    }).then(function (data) {
      if (!data) return;
      app.globalData.accountState = 'pending_delete';
      app.globalData.loggedIn = false;
      self.setData({ accountState: 'pending_delete', deletion: data });
      wx.showToast({ title: '已进入注销冷静期', icon: 'none' });
    }).catch(function (error) {
      wx.showToast({ title: error.message || '注销申请失败', icon: 'none' });
    }).then(function () {
      self.setData({ deleting: false });
    });
  },

  cancelDeletion: function () {
    const self = this;
    if (this.data.cancelling) return;
    this.setData({ cancelling: true });
    api.call('account.cancelDeletion').then(function () {
      app.globalData.accountState = 'active';
      app.globalData.loggedIn = true;
      self.setData({ accountState: 'active', deletion: null });
      wx.showToast({ title: '注销已撤销', icon: 'success' });
    }).catch(function (error) {
      wx.showToast({ title: error.message || '撤销失败', icon: 'none' });
    }).then(function () {
      self.setData({ cancelling: false });
    });
  },

  openPermissionSettings: function () {
    wx.openSetting().catch(function () {
      wx.showToast({ title: '请在微信设置中管理小程序权限', icon: 'none' });
    });
  },

  openLegal: function (event) {
    wx.navigateTo({ url: '/pages/legal/index?type=' + event.currentTarget.dataset.type });
  },

  openReportTarget: function (event) {
    const report = this.data.reports.find(function (item) { return item._id === event.currentTarget.dataset.id; });
    if (!report) return;
    wx.showModal({
      title: report.statusText,
      content: report.resolution || (report.status === 'processing' ? '运营人员正在处理这项举报。' : '处理完成后，结果会显示在这里。'),
      showCancel: false
    });
  },

  loadMoreReports: function () {
    const self = this;
    if (!this.data.hasMoreReports) return;
    api.call('report.listMine', { pageSize: 20, cursor: this.data.reportCursor }).then(function (result) {
      const labels = { open: '待处理', processing: '处理中', resolved: '已解决', rejected: '未采纳' };
      self.setData({
        reports: self.data.reports.concat((result.items || []).map(function (item) {
          return Object.assign({}, item, { statusText: labels[item.status] || item.status });
        })),
        reportCursor: result.nextCursor || '',
        hasMoreReports: Boolean(result.hasMore)
      });
    }).catch(function (error) {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    });
  }
});
