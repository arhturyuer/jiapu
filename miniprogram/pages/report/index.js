const api = require('../../utils/api');

Page({
  data: {
    familyId: '',
    targetType: '',
    targetId: '',
    inviteToken: '',
    targetName: '',
    invalid: false,
    reason: '',
    detail: '',
    reasons: ['关系或资料错误', '冒用他人信息', '不当文字内容', '不当图片内容', '其他问题'],
    submitting: false
  },

  onLoad: function (options) {
    if (!options.familyId || !options.targetType || !options.targetId) {
      this.setData({ invalid: true });
      wx.showModal({ title: '无法举报', content: '举报对象信息不完整，请返回后重试。', showCancel: false });
      return;
    }
    this.setData({
      familyId: options.familyId,
      targetType: options.targetType,
      targetId: options.targetId,
      inviteToken: options.inviteToken ? decodeURIComponent(options.inviteToken) : '',
      targetName: decodeURIComponent(options.targetName || '这项资料')
    });
  },

  chooseReason: function (event) {
    this.setData({ reason: event.currentTarget.dataset.reason });
  },

  inputDetail: function (event) {
    this.setData({ detail: event.detail.value });
  },

  submit: function () {
    const self = this;
    if (!this.data.reason) {
      wx.showToast({ title: '请选择问题类型', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    api.call('report.create', {
      familyId: this.data.familyId,
      targetType: this.data.targetType,
      targetId: this.data.targetId,
      inviteToken: this.data.inviteToken,
      reason: this.data.reason,
      detail: this.data.detail.trim()
    }).then(function () {
      wx.showToast({ title: '举报已提交', icon: 'success' });
      setTimeout(function () { wx.navigateBack(); }, 600);
    }).catch(function (error) {
      wx.showToast({ title: error.message || '提交失败', icon: 'none' });
    }).then(function () {
      self.setData({ submitting: false });
    });
  }
});
