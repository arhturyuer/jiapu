const app = getApp();
const api = require('../../utils/api');

Page({
  data: {
    step: 1,
    startName: '',
    startGender: 'unknown',
    fatherName: '',
    motherName: '',
    spouseName: '',
    familyName: '',
    description: '',
    submitting: false
  },

  inputField: function (event) {
    const field = event.currentTarget.dataset.field;
    const data = {};
    data[field] = event.detail.value;
    this.setData(data);
  },

  chooseGender: function (event) {
    this.setData({ startGender: event.currentTarget.dataset.gender });
  },

  nextStep: function () {
    if (this.data.step === 1 && !this.data.startName.trim()) {
      wx.showToast({ title: '先填写第一位成员的姓名', icon: 'none' });
      return;
    }
    if (this.data.step === 1 && !this.data.familyName) {
      const surname = this.data.startName.trim().slice(0, 1);
      this.setData({ familyName: surname ? surname + '氏家谱' : '我的家谱' });
    }
    this.setData({ step: Math.min(3, this.data.step + 1) });
  },

  previousStep: function () {
    this.setData({ step: Math.max(1, this.data.step - 1) });
  },

  createFamily: function () {
    const self = this;
    if (this.data.submitting) return;
    const familyName = this.data.familyName.trim();
    if (!familyName) {
      wx.showToast({ title: '请填写家谱名称', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    api.call('family.create', {
      name: familyName,
      description: this.data.description.trim(),
      startPerson: {
        name: this.data.startName.trim(),
        gender: this.data.startGender
      },
      relatives: {
        fatherName: this.data.fatherName.trim(),
        motherName: this.data.motherName.trim(),
        spouseName: this.data.spouseName.trim()
      }
    }).then(function (data) {
      app.setCurrentFamily(data.family);
      wx.setStorageSync('youpu_pending_view', { mode: 'full', personId: '' });
      wx.showToast({ title: '家谱创建好了', icon: 'success' });
      setTimeout(function () {
        wx.switchTab({ url: '/pages/tree/index' });
      }, 500);
    }).catch(function (error) {
      wx.showToast({ title: error.message || '创建失败，请重试', icon: 'none' });
    }).then(function () {
      self.setData({ submitting: false });
    });
  }
});
