const app = getApp();
const api = require('../../utils/api');
const personGender = require('../../utils/person-gender');

Page({
  data: {
    step: 1,
    startName: '',
    startGender: '',
    fatherName: '',
    motherName: '',
    spouseName: '',
    spouseGender: '',
    familyName: '',
    description: '',
    source: '',
    submitting: false
  },

  onLoad: function (options) {
    this._spouseGenderTouched = false;
    const source = options.source === 'share_menu' ? 'share_menu' : (options.source || '');
    this.setData({ source: source });
    if (source === 'share_menu') api.call('share.record', { stage: 'opened', kind: 'discovery' }).catch(function () {});
  },

  inputField: function (event) {
    const field = event.currentTarget.dataset.field;
    const data = {};
    data[field] = event.detail.value;
    if (field === 'spouseName' && event.detail.value.trim() && !this._spouseGenderTouched && !this.data.spouseGender) {
      data.spouseGender = personGender.opposite(this.data.startGender);
    }
    this.setData(data);
  },

  chooseGender: function (event) {
    const gender = event.currentTarget.dataset.gender;
    if (!personGender.isKnown(gender)) return;
    const patch = { startGender: gender };
    if (!this._spouseGenderTouched) patch.spouseGender = personGender.opposite(gender);
    this.setData(patch);
  },

  chooseSpouseGender: function (event) {
    const gender = event.currentTarget.dataset.gender;
    if (!personGender.isKnown(gender)) return;
    this._spouseGenderTouched = true;
    this.setData({ spouseGender: gender });
  },

  nextStep: function () {
    if (this.data.step === 1 && !this.data.startName.trim()) {
      wx.showToast({ title: '先填写第一位成员的姓名', icon: 'none' });
      return;
    }
    if (this.data.step === 1 && !personGender.isKnown(this.data.startGender)) {
      wx.showToast({ title: '请选择第一位成员的性别', icon: 'none' });
      return;
    }
    if (this.data.step === 2 && this.data.spouseName.trim() && !personGender.isKnown(this.data.spouseGender)) {
      wx.showToast({ title: '请选择伴侣性别', icon: 'none' });
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
    if (!personGender.isKnown(this.data.startGender) || (this.data.spouseName.trim() && !personGender.isKnown(this.data.spouseGender))) {
      wx.showToast({ title: '请完整选择成员性别', icon: 'none' });
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
        spouseName: this.data.spouseName.trim(),
        spouseGender: this.data.spouseName.trim() ? this.data.spouseGender : ''
      },
      source: this.data.source === 'share_menu' ? 'share_menu' : ''
    }).then(function (data) {
      app.setCurrentFamily(data.family);
      app.invalidateCache({ families: true, profile: true, graph: data.family._id, dashboard: data.family._id });
      if (self.data.source !== 'example') {
        wx.setStorageSync('youpu_new_family_tour_' + data.family._id, true);
      }
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
