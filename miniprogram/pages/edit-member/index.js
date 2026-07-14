const api = require('../../utils/api');
const privacy = require('../../utils/privacy');

Page({
  data: {
    personId: '',
    familyId: '',
    loading: true,
    error: '',
    name: '',
    gender: 'unknown',
    birthDate: '',
    birthPlace: '',
    avatar: '',
    avatarAssetId: '',
    moderationStatus: '',
    bio: '',
    lifeStatus: 'unknown',
    currentRole: 'viewer',
    uploading: false,
    submitting: false
  },

  onLoad: function (options) {
    const personId = options.id || '';
    this.setData({ personId: personId });
    if (!personId) {
      this.setData({ loading: false, error: '缺少成员信息，请返回后重试。' });
      wx.showModal({ title: '无法编辑', content: '缺少成员信息，请返回后重试。', showCancel: false }).then(function () { wx.navigateBack(); });
      return;
    }
    this.loadPerson();
  },

  loadPerson: function () {
    const self = this;
    this.setData({ loading: true, error: '' });
    api.call('person.get', { personId: this.data.personId }).then(function (data) {
      const person = data.person;
      const avatarAssetId = person.avatarAssetId || '';
      self.setData({
        loading: false,
        familyId: person.familyId || '',
        name: person.name || '',
        gender: person.gender || 'unknown',
        birthDate: person.birthDate || '',
        birthPlace: person.birthPlace || '',
        avatar: '',
        avatarAssetId: avatarAssetId,
        bio: person.bio || '',
        lifeStatus: person.lifeStatus || 'unknown',
        currentRole: data.currentRole
      });
      return api.getMediaUrls([avatarAssetId]).then(function (urls) {
        if (urls[avatarAssetId]) self.setData({ avatar: urls[avatarAssetId] });
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: error.message || '资料加载失败' });
    });
  },

  inputField: function (event) {
    const field = event.currentTarget.dataset.field;
    const data = {};
    data[field] = event.detail.value;
    this.setData(data);
  },

  chooseGender: function (event) {
    this.setData({ gender: event.currentTarget.dataset.gender });
  },

  chooseLifeStatus: function (event) {
    this.setData({ lifeStatus: event.currentTarget.dataset.status });
  },

  chooseDate: function (event) {
    this.setData({ birthDate: event.detail.value });
  },

  chooseAvatar: function () {
    const self = this;
    privacy.ensurePrivacyAuthorized().then(function () {
      return wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] });
    }).then(function (result) {
      self.setData({ uploading: true });
      const file = result.tempFiles[0];
      return api.uploadImage(file.tempFilePath, 'person-avatars', {
        familyId: self.data.familyId,
        kind: 'person_avatar',
        size: file.size || 0
      });
    }).then(function (media) {
      self.setData({
        avatar: media.previewUrl,
        avatarAssetId: media.assetId,
        moderationStatus: media.moderationStatus,
        uploading: false
      });
      if (!media.ready) wx.showToast({ title: '照片将在审核通过后展示', icon: 'none' });
    }).catch(function (error) {
      self.setData({ uploading: false });
      if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) return;
      wx.showToast({ title: error.message || '照片上传失败', icon: 'none' });
    });
  },

  submit: function () {
    const self = this;
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '姓名不能为空', icon: 'none' });
      return;
    }
    if (this.data.submitting || this.data.uploading) return;
    this.setData({ submitting: true });
    api.call('person.update', {
      personId: this.data.personId,
      data: {
        name: name,
        gender: this.data.gender,
        birthDate: this.data.birthDate,
        birthPlace: this.data.birthPlace.trim(),
        avatarAssetId: this.data.avatarAssetId,
        bio: this.data.bio.trim(),
        lifeStatus: this.data.lifeStatus
      }
    }).then(function (data) {
      wx.showToast({
        title: data.pending ? '修改已提交管理员审核' : '资料已保存',
        icon: data.pending ? 'none' : 'success',
        duration: 2200
      });
      setTimeout(function () { wx.navigateBack(); }, 700);
    }).catch(function (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }).then(function () {
      self.setData({ submitting: false });
    });
  }
});
