const api = require('../../utils/api');
const privacy = require('../../utils/privacy');
const formState = require('../../utils/form-state');

const FORM_FIELDS = ['name', 'gender', 'birthDate', 'birthPlace', 'bio', 'lifeStatus'];

function normalizedForm(data) {
  return {
    name: String(data.name || '').trim(),
    gender: data.gender || 'unknown',
    birthDate: data.birthDate || '',
    birthPlace: String(data.birthPlace || '').trim(),
    bio: String(data.bio || '').trim(),
    lifeStatus: data.lifeStatus || 'unknown'
  };
}

function savedAvatarState(status) {
  if (status === 'approved') return { state: 'approved', text: '头像已保存并通过审核' };
  if (status === 'rejected' || status === 'deleted') return { state: 'rejected', text: '头像未通过，请重新选择' };
  if (status === 'pending' || status === 'review') return { state: 'pending', text: '头像已保存，审核通过后自动展示' };
  return { state: '', text: '' };
}

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
    avatarState: '',
    avatarStateText: '',
    avatarError: '',
    bio: '',
    lifeStatus: 'unknown',
    currentRole: 'viewer',
    uploading: false,
    savingAvatar: false,
    submitting: false,
    hasFormChanges: false
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

  onUnload: function () {
    formState.clearLeaveAlert(this);
  },

  loadPerson: function () {
    const self = this;
    formState.clearLeaveAlert(this);
    this.setData({ loading: true, error: '' });
    return api.call('person.get', { personId: this.data.personId }).then(function (data) {
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
        moderationStatus: '',
        avatarState: '',
        avatarStateText: '',
        avatarError: '',
        bio: person.bio || '',
        lifeStatus: person.lifeStatus || 'unknown',
        currentRole: data.currentRole,
        uploading: false,
        savingAvatar: false,
        hasFormChanges: false
      });
      self._initialForm = normalizedForm(self.data);
      return Promise.all([
        api.getMediaUrls([avatarAssetId]),
        api.getMediaStates([avatarAssetId])
      ]).then(function (results) {
        const urls = results[0];
        const states = results[1];
        const moderationStatus = states[avatarAssetId] || '';
        const presentation = savedAvatarState(moderationStatus);
        self.setData({
          avatar: urls[avatarAssetId] || '',
          moderationStatus: moderationStatus,
          avatarState: presentation.state,
          avatarStateText: presentation.text
        });
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: error.message || '资料加载失败' });
    });
  },

  refreshFormState: function () {
    if (!this._initialForm) return;
    const hasFormChanges = formState.changed(normalizedForm(this.data), this._initialForm, FORM_FIELDS);
    const hasUnsavedAvatar = this.data.uploading || this.data.savingAvatar || this.data.avatarState === 'failed';
    if (this.data.hasFormChanges !== hasFormChanges) this.setData({ hasFormChanges: hasFormChanges });
    formState.syncLeaveAlert(this, hasFormChanges || hasUnsavedAvatar, '当前资料或头像尚未保存，确定离开吗？');
  },

  setFormData: function (patch) {
    const self = this;
    this.setData(patch, function () { self.refreshFormState(); });
  },

  inputField: function (event) {
    const field = event.currentTarget.dataset.field;
    const data = {};
    data[field] = event.detail.value;
    this.setFormData(data);
  },

  chooseGender: function (event) {
    this.setFormData({ gender: event.currentTarget.dataset.gender });
  },

  chooseLifeStatus: function (event) {
    this.setFormData({ lifeStatus: event.currentTarget.dataset.status });
  },

  chooseDate: function (event) {
    this.setFormData({ birthDate: event.detail.value });
  },

  chooseAvatar: function () {
    const self = this;
    if (this.data.uploading || this.data.savingAvatar || this.data.submitting) return Promise.resolve();
    let selectedPath = '';
    return privacy.ensurePrivacyAuthorized().then(function () {
      return wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] });
    }).then(function (result) {
      const file = result.tempFiles[0];
      selectedPath = file.tempFilePath;
      self.setData({
        avatar: selectedPath,
        uploading: true,
        avatarState: 'uploading',
        avatarStateText: '正在上传头像…',
        avatarError: ''
      }, function () { self.refreshFormState(); });
      return api.uploadImage(selectedPath, 'person-avatars', {
        familyId: self.data.familyId,
        kind: 'person_avatar',
        size: file.size || 0
      });
    }).then(function (media) {
      self._pendingAvatarMedia = media;
      return self.saveUploadedAvatar(media);
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) return;
      self.setData({
        avatar: selectedPath || self.data.avatar,
        uploading: false,
        savingAvatar: false,
        avatarState: 'failed',
        avatarStateText: '头像保存失败，点击重试',
        avatarError: error.message || error.errMsg || '头像保存失败'
      }, function () { self.refreshFormState(); });
      wx.showToast({ title: error.message || error.errMsg || '头像保存失败', icon: 'none' });
    });
  },

  saveUploadedAvatar: function (media) {
    const self = this;
    this.setData({
      avatar: media.previewUrl || this.data.avatar,
      avatarAssetId: media.assetId,
      moderationStatus: media.moderationStatus,
      uploading: false,
      savingAvatar: true,
      avatarState: 'saving',
      avatarStateText: '正在保存头像…',
      avatarError: ''
    }, function () { self.refreshFormState(); });
    return api.call('person.update', {
      personId: this.data.personId,
      data: { avatarAssetId: media.assetId }
    }).then(function (data) {
      self._pendingAvatarMedia = null;
      let presentation;
      if (data.pending) {
        presentation = {
          state: 'family-review',
          text: media.ready ? '头像已提交管理员确认' : '已提交管理员确认，内容审核中'
        };
      } else {
        presentation = savedAvatarState(media.moderationStatus);
      }
      self.setData({
        savingAvatar: false,
        avatarState: presentation.state,
        avatarStateText: presentation.text
      }, function () { self.refreshFormState(); });
      wx.showToast({
        title: data.pending ? '头像修改已提交管理员确认' : media.ready ? '头像已更新' : '头像已保存，等待审核',
        icon: data.pending || !media.ready ? 'none' : 'success'
      });
      return data;
    });
  },

  retryAvatarSave: function () {
    if (this.data.uploading || this.data.savingAvatar || this.data.submitting) return;
    if (this._pendingAvatarMedia) {
      const self = this;
      this.saveUploadedAvatar(this._pendingAvatarMedia).catch(function (error) {
        self.setData({
          savingAvatar: false,
          avatarState: 'failed',
          avatarStateText: '头像保存失败，点击重试',
          avatarError: error.message || '头像保存失败'
        }, function () { self.refreshFormState(); });
      });
      return;
    }
    this.chooseAvatar();
  },

  submit: function () {
    const self = this;
    const current = normalizedForm(this.data);
    if (!current.name) {
      wx.showToast({ title: '姓名不能为空', icon: 'none' });
      return Promise.resolve();
    }
    if (!this.data.hasFormChanges || this.data.submitting || this.data.uploading || this.data.savingAvatar) return Promise.resolve();
    const changes = {};
    FORM_FIELDS.forEach(function (field) {
      if (current[field] !== self._initialForm[field]) changes[field] = current[field];
    });
    this.setData({ submitting: true });
    return api.call('person.update', {
      personId: this.data.personId,
      data: changes
    }).then(function (data) {
      self._initialForm = current;
      self.setData({ submitting: false, hasFormChanges: false }, function () { self.refreshFormState(); });
      wx.showToast({
        title: self.data.avatarState === 'failed'
          ? '资料已保存，头像仍需重试'
          : data.pending ? '修改已提交管理员审核' : '资料已保存',
        icon: data.pending ? 'none' : 'success',
        duration: 2200
      });
      if (self.data.avatarState !== 'failed') {
        formState.clearLeaveAlert(self);
        setTimeout(function () { wx.navigateBack(); }, 700);
      }
      return data;
    }).catch(function (error) {
      self.setData({ submitting: false });
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    });
  }
});
