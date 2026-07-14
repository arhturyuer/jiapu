const api = require('../../utils/api');
const privacy = require('../../utils/privacy');

const RELATION_LABELS = {
  father: '父亲',
  mother: '母亲',
  spouse: '伴侣',
  son: '儿子',
  daughter: '女儿'
};

Page({
  data: {
    familyId: '',
    anchorId: '',
    anchorName: '',
    relationType: '',
    relationLabel: '',
    name: '',
    gender: 'unknown',
    birthDate: '',
    birthPlace: '',
    avatar: '',
    avatarAssetId: '',
    moderationStatus: '',
    bio: '',
    uploading: false,
    submitting: false
  },

  onLoad: function (options) {
    const relationType = options.relationType || '';
    let gender = 'unknown';
    if (relationType === 'father' || relationType === 'son') gender = 'male';
    if (relationType === 'mother' || relationType === 'daughter') gender = 'female';
    this.setData({
      familyId: options.familyId || '',
      anchorId: options.anchorId || '',
      anchorName: decodeURIComponent(options.anchorName || ''),
      relationType: relationType,
      relationLabel: RELATION_LABELS[relationType] || '亲属',
      gender: gender
    });
    if (!options.familyId || !options.anchorId || !RELATION_LABELS[relationType]) {
      wx.showModal({
        title: '无法添加成员',
        content: '缺少家谱或关系信息，请返回后重新选择。',
        showCancel: false
      }).then(function () { wx.navigateBack(); });
    }
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
      wx.showToast({ title: '请填写姓名', icon: 'none' });
      return;
    }
    if (this.data.submitting || this.data.uploading) return;
    this.setData({ submitting: true });
    api.call('person.createRelated', {
      familyId: this.data.familyId,
      anchorPersonId: this.data.anchorId,
      relationType: this.data.relationType,
      person: {
        name: name,
        gender: this.data.gender,
        birthDate: this.data.birthDate,
        birthPlace: this.data.birthPlace.trim(),
        avatarAssetId: this.data.avatarAssetId,
        bio: this.data.bio.trim()
      }
    }).then(function (data) {
      wx.showToast({
        title: data.pending ? '已提交管理员审核' : '家人已添加',
        icon: data.pending ? 'none' : 'success',
        duration: 1800
      });
      setTimeout(function () { wx.navigateBack(); }, 600);
    }).catch(function (error) {
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
    }).then(function () {
      self.setData({ submitting: false });
    });
  }
});
