const api = require('../../utils/api');
const privacy = require('../../utils/privacy');
const formState = require('../../utils/form-state');

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
    entryMode: 'new',
    loadingContext: true,
    existingKeyword: '',
    existingResults: [],
    selectedExistingId: '',
    selectedExistingPerson: null,
    sharedChildren: [],
    selectedSharedChildIds: [],
    sharedParentRoleText: '另一位家长',
    name: '',
    gender: 'unknown',
    birthDate: '',
    birthPlace: '',
    avatar: '',
    selectedAvatarPath: '',
    avatarAssetId: '',
    moderationStatus: '',
    avatarState: '',
    avatarStateText: '',
    bio: '',
    uploading: false,
    submitting: false,
    submitStage: '',
    hasUnsavedChanges: false
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
      gender: gender,
      sharedParentRoleText: this.parentRoleText(gender)
    });
    if (!options.familyId || !options.anchorId || !RELATION_LABELS[relationType]) {
      wx.showModal({
        title: '无法添加成员',
        content: '缺少家谱或关系信息，请返回后重新选择。',
        showCancel: false
      }).then(function () { wx.navigateBack(); });
      return;
    }
    this.loadRelationContext();
  },

  onUnload: function () {
    formState.clearLeaveAlert(this);
  },

  markDirty: function () {
    if (!this.data.hasUnsavedChanges) this.setData({ hasUnsavedChanges: true });
    formState.syncLeaveAlert(this, true, '新增成员信息尚未保存，确定离开吗？');
  },

  clearDirty: function () {
    this.setData({ hasUnsavedChanges: false });
    formState.clearLeaveAlert(this);
  },

  parentRoleText: function (gender) {
    if (gender === 'male') return '父亲';
    if (gender === 'female') return '母亲';
    return '另一位家长';
  },

  relationGenderMatches: function (person) {
    const type = this.data.relationType;
    const expected = type === 'father' || type === 'son'
      ? 'male'
      : type === 'mother' || type === 'daughter'
        ? 'female'
        : '';
    return !expected || person.gender === 'unknown' || person.gender === expected;
  },

  loadRelationContext: function () {
    const self = this;
    return api.call('graph.get', { familyId: this.data.familyId }).then(function (data) {
      const persons = data.persons || [];
      const relations = data.relations || [];
      self._graphPersons = persons;
      self._graphRelations = relations;
      const directIds = {};
      relations.forEach(function (relation) {
        if (relation.fromPersonId === self.data.anchorId) directIds[relation.toPersonId] = true;
        if (relation.toPersonId === self.data.anchorId) directIds[relation.fromPersonId] = true;
      });
      const candidates = persons.filter(function (person) {
        return person._id !== self.data.anchorId && !directIds[person._id] && self.relationGenderMatches(person);
      }).map(function (person) {
        return Object.assign({}, person, {
          initial: (person.name || '家').slice(0, 1),
          genderText: person.gender === 'male' ? '男' : person.gender === 'female' ? '女' : '性别未填写'
        });
      });
      self._existingCandidates = candidates;
      const childIds = relations.filter(function (relation) {
        return relation.type === 'parent_child' && relation.fromPersonId === self.data.anchorId;
      }).map(function (relation) { return relation.toPersonId; });
      const sharedChildren = childIds.map(function (childId) {
        const child = persons.find(function (person) { return person._id === childId; });
        return child ? Object.assign({}, child, { initial: (child.name || '家').slice(0, 1), selected: false }) : null;
      }).filter(Boolean);
      self.setData({
        loadingContext: false,
        existingResults: candidates,
        sharedChildren: sharedChildren
      });
    }).catch(function (error) {
      self.setData({ loadingContext: false });
      wx.showToast({ title: error.message || '成员列表加载失败', icon: 'none' });
    });
  },

  chooseEntryMode: function (event) {
    const mode = event.currentTarget.dataset.mode;
    if (mode === this.data.entryMode) return;
    this.setData({
      entryMode: mode,
      existingKeyword: '',
      existingResults: this._existingCandidates || [],
      selectedExistingId: '',
      selectedExistingPerson: null,
      sharedParentRoleText: this.parentRoleText(this.data.gender)
    });
    this.markDirty();
  },

  filterExisting: function (event) {
    const keyword = event.detail.value.trim();
    const results = (this._existingCandidates || []).filter(function (person) {
      return !keyword || person.name.indexOf(keyword) >= 0;
    });
    this.setData({ existingKeyword: keyword, existingResults: results });
    this.markDirty();
  },

  selectExisting: function (event) {
    const personId = event.currentTarget.dataset.id;
    const person = (this._existingCandidates || []).find(function (item) { return item._id === personId; });
    if (!person) return;
    this.setData({
      selectedExistingId: personId,
      selectedExistingPerson: person,
      sharedParentRoleText: this.parentRoleText(person.gender)
    });
    this.markDirty();
  },

  toggleSharedChild: function (event) {
    const childId = event.currentTarget.dataset.id;
    const selected = this.data.selectedSharedChildIds.slice();
    const index = selected.indexOf(childId);
    if (index >= 0) selected.splice(index, 1);
    else selected.push(childId);
    this.setData({
      selectedSharedChildIds: selected,
      sharedChildren: this.data.sharedChildren.map(function (child) {
        return Object.assign({}, child, { selected: selected.indexOf(child._id) >= 0 });
      })
    });
    this.markDirty();
  },

  inputField: function (event) {
    const field = event.currentTarget.dataset.field;
    const data = {};
    data[field] = event.detail.value;
    this.setData(data);
    this.markDirty();
  },

  chooseGender: function (event) {
    const gender = event.currentTarget.dataset.gender;
    if (gender === this.data.gender) return;
    this.setData({ gender: gender, sharedParentRoleText: this.parentRoleText(gender) });
    this.markDirty();
  },

  chooseDate: function (event) {
    this.setData({ birthDate: event.detail.value });
    this.markDirty();
  },

  chooseAvatar: function () {
    const self = this;
    if (this.data.uploading || this.data.submitting) return Promise.resolve();
    return privacy.ensurePrivacyAuthorized().then(function () {
      return wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] });
    }).then(function (result) {
      const file = result.tempFiles[0];
      self._selectedAvatarSize = file.size || 0;
      self._pendingAvatarMedia = null;
      self.setData({
        avatar: file.tempFilePath,
        selectedAvatarPath: file.tempFilePath,
        avatarAssetId: '',
        moderationStatus: '',
        avatarState: 'selected',
        avatarStateText: '已选择，添加成员时一并上传'
      });
      self.markDirty();
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) return;
      wx.showToast({ title: error.message || error.errMsg || '照片选择失败', icon: 'none' });
    });
  },

  createNewPerson: function (avatarAssetId) {
    const sharedChildIds = this.data.relationType === 'spouse' ? this.data.selectedSharedChildIds : [];
    return api.call('person.createRelated', {
      familyId: this.data.familyId,
      anchorPersonId: this.data.anchorId,
      relationType: this.data.relationType,
      sharedChildIds: sharedChildIds,
      person: {
        name: this.data.name.trim(),
        gender: this.data.gender,
        birthDate: this.data.birthDate,
        birthPlace: this.data.birthPlace.trim(),
        avatarAssetId: avatarAssetId || '',
        bio: this.data.bio.trim()
      }
    });
  },

  submit: function () {
    const self = this;
    const name = this.data.name.trim();
    if (this.data.entryMode === 'new' && !name) {
      wx.showToast({ title: '请填写姓名', icon: 'none' });
      return;
    }
    if (this.data.entryMode === 'existing' && !this.data.selectedExistingId) {
      wx.showToast({ title: '请选择已有成员', icon: 'none' });
      return;
    }
    if (this.data.submitting || this.data.uploading) return;
    this.setData({ submitting: true, submitStage: this.data.entryMode === 'new' ? '正在添加成员…' : '正在关联…' });
    const sharedChildIds = this.data.relationType === 'spouse' ? this.data.selectedSharedChildIds : [];
    let request;
    if (this.data.entryMode === 'existing') {
      request = api.call('relation.linkExisting', {
        familyId: this.data.familyId,
        anchorPersonId: this.data.anchorId,
        relatedPersonId: this.data.selectedExistingId,
        relationType: this.data.relationType,
        sharedChildIds: sharedChildIds
      });
    } else {
      let mediaPromise = Promise.resolve(this._pendingAvatarMedia || null);
      if (this.data.selectedAvatarPath && !this._pendingAvatarMedia) {
        this.setData({ uploading: true, submitStage: '正在上传头像…', avatarState: 'uploading', avatarStateText: '正在上传头像…' });
        mediaPromise = api.uploadImage(this.data.selectedAvatarPath, 'person-avatars', {
          familyId: this.data.familyId,
          kind: 'person_avatar',
          size: this._selectedAvatarSize || 0
        }).then(function (media) {
          self._pendingAvatarMedia = media;
          self.setData({
            avatar: media.previewUrl || self.data.avatar,
            avatarAssetId: media.assetId,
            moderationStatus: media.moderationStatus,
            uploading: false,
            submitStage: '正在添加成员…',
            avatarState: 'uploaded',
            avatarStateText: media.ready ? '头像已上传，正在绑定成员…' : '头像已上传，审核通过后自动展示'
          });
          return media;
        });
      }
      request = mediaPromise.then(function (media) {
        return self.createNewPerson(media ? media.assetId : '');
      });
    }
    return request.then(function (data) {
      self.clearDirty();
      wx.showToast({
        title: data.pending ? '已提交管理员审核' : self.data.entryMode === 'existing' ? '关系已关联' : '家人已添加',
        icon: data.pending ? 'none' : 'success',
        duration: 1800
      });
      setTimeout(function () { wx.navigateBack(); }, 600);
    }).catch(function (error) {
      const avatarUploadFailed = self.data.entryMode === 'new' && self.data.selectedAvatarPath && !self._pendingAvatarMedia;
      if (avatarUploadFailed) {
        self.setData({ avatarState: 'failed', avatarStateText: '头像上传失败，请再次添加重试' });
      } else if (self.data.entryMode === 'new' && self._pendingAvatarMedia) {
        self.setData({ avatarState: 'uploaded', avatarStateText: '头像已上传，再次添加时将直接重试绑定' });
      }
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
    }).then(function () {
      self.setData({ submitting: false, uploading: false, submitStage: '' });
    });
  }
});
