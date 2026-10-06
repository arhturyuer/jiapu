const launchAd = require('../../utils/launch-ad');
const app = getApp();
const api = require('../../utils/api');
const privacy = require('../../utils/privacy');
const formState = require('../../utils/form-state');
const kinship = require('../../utils/kinship');
const personGender = require('../../utils/person-gender');
const personDate = require('../../utils/person-date');
const memberLifeStatus = require('../../utils/member-life-status');

const RELATION_OPTIONS = [
  { key: 'father', label: '父亲' }, { key: 'mother', label: '母亲' },
  { key: 'spouse', label: '伴侣' }, { key: 'son', label: '儿子' },
  { key: 'daughter', label: '女儿' }, { key: 'sibling', label: '兄弟姐妹' }
];
function fixedGender(type) {
  if (type === 'father' || type === 'son') return 'male';
  if (type === 'mother' || type === 'daughter') return 'female';
  return '';
}
function defaultGender(type, anchorGender) {
  return fixedGender(type) || (type === 'spouse' ? personGender.opposite(anchorGender) : '');
}

Page(launchAd.wrap({
  data: {
    familyId: '', anchorId: '', anchorName: '', anchorGender: 'unknown', relationType: '', relationLabel: '', relationOptions: RELATION_OPTIONS,
    entryMode: 'new', loadingContext: true, contextError: '', existingKeyword: '', existingResults: [],
    selectedExistingId: '', selectedExistingPerson: null, duplicateSuggestions: [],
    coParentCandidates: [], coParentId: '', parentPartnerCandidates: [], parentPartnerId: '',
    sharedParents: [], selectedSharedParentIds: [], sharedChildren: [], selectedSharedChildIds: [],
    name: '', gender: '', lifeStatus: 'living', birthDraft: personDate.emptyDraft(), deathDraft: personDate.emptyDraft(), birthPlace: '', avatar: '', selectedAvatarPath: '',
    avatarAssetId: '', moderationStatus: '', avatarState: '', avatarStateText: '', bio: '', showMoreFields: false,
    uploading: false, submitting: false, submitStage: '', hasUnsavedChanges: false, relationSummary: [], siblingBlocked: false
  },
  onLoad: function (options) {
    const type = RELATION_OPTIONS.some(function (item) { return item.key === options.relationType; }) ? options.relationType : 'son';
    this._drafts = { new: {}, existing: {} };
    this._genderTouched = false;
    this._lifeStatusTouched = false;
    this.setData({ familyId: options.familyId || '', anchorId: options.anchorId || '', anchorName: decodeURIComponent(options.anchorName || ''), relationType: type, relationLabel: RELATION_OPTIONS.find(function (item) { return item.key === type; }).label, gender: defaultGender(type, 'unknown') });
    if (!options.familyId || !options.anchorId) {
      wx.showModal({ title: '无法添加成员', content: '缺少家谱或成员信息，请返回后重新选择。', showCancel: false }).then(function () { wx.navigateBack(); });
      return;
    }
    this.loadRelationContext();
  },
  onUnload: function () { formState.clearLeaveAlert(this); if (this._existingTimer) clearTimeout(this._existingTimer); if (this._duplicateTimer) clearTimeout(this._duplicateTimer); },
  markDirty: function () { if (!this.data.hasUnsavedChanges) this.setData({ hasUnsavedChanges: true }); formState.syncLeaveAlert(this, true, '新增成员信息尚未保存，确定离开吗？'); },
  clearDirty: function () { this.setData({ hasUnsavedChanges: false }); formState.clearLeaveAlert(this); },
  relationExists: function (type, firstId, secondId) {
    return (this._graphRelations || []).some(function (r) {
      if (r.type !== type) return false;
      return type === 'spouse' ? (r.fromPersonId === firstId && r.toPersonId === secondId) || (r.fromPersonId === secondId && r.toPersonId === firstId) : r.fromPersonId === firstId && r.toPersonId === secondId;
    });
  },
  reachesByChildren: function (startId, targetId) {
    const relations = this._graphRelations || [], queue = [startId], visited = {};
    while (queue.length) {
      const current = queue.shift();
      if (current === targetId) return true;
      if (visited[current]) continue;
      visited[current] = true;
      relations.forEach(function (r) { if (r.type === 'parent_child' && r.fromPersonId === current) queue.push(r.toPersonId); });
    }
    return false;
  },
  personItem: function (person) {
    return personGender.decorate(Object.assign({}, person, { initial: (person.name || '家').slice(0, 1), birthDateText: personDate.display(person, 'birth') }));
  },
  loadRelationContext: function () {
    const self = this; this._contextRequested = true; this.setData({ loadingContext: true, contextError: '' });
    return app.getGraph(this.data.familyId).then(function (data) {
      self._graphPersons = data.persons || []; self._graphRelations = data.relations || [];
      const anchor = self._graphPersons.find(function (p) { return p._id === self.data.anchorId; });
      if (anchor) {
        const anchorGender = personGender.normalize(anchor.gender);
        const patch = { anchorName: anchor.name, anchorGender: anchorGender, relationLabel: kinship.relationTypeLabel(anchor, self.data.relationType) };
        if (!self._genderTouched) patch.gender = defaultGender(self.data.relationType, anchorGender);
        self.setData(patch);
      }
      self.refreshDefaultLifeStatus();
      self.setData({ loadingContext: false }); self.refreshRelationChoices(true);
    }).catch(function (error) { self.setData({ loadingContext: false, contextError: api.userMessage(error, '家谱成员加载失败') }); });
  },
  refreshRelationChoices: function (allowDefault) {
    const self = this, persons = this._graphPersons || [], relations = this._graphRelations || [], anchorId = this.data.anchorId, type = this.data.relationType;
    const parents = relations.filter(function (r) { return r.type === 'parent_child' && r.toPersonId === anchorId; }).map(function (r) { return r.fromPersonId; });
    const children = relations.filter(function (r) { return r.type === 'parent_child' && r.fromPersonId === anchorId; }).map(function (r) { return r.toPersonId; });
    const spouses = relations.filter(function (r) { return r.type === 'spouse' && (r.fromPersonId === anchorId || r.toPersonId === anchorId); }).map(function (r) { return r.fromPersonId === anchorId ? r.toPersonId : r.fromPersonId; });
    const item = function (id) { const p = persons.find(function (v) { return v._id === id; }); return p ? self.personItem(p) : null; };
    const coParents = spouses.map(item).filter(Boolean);
    let coParentId = coParents.some(function (p) { return p._id === self.data.coParentId; }) ? self.data.coParentId : '';
    if (allowDefault && (type === 'son' || type === 'daughter') && coParents.length === 1 && !self._coParentTouched) coParentId = coParents[0]._id;
    const siblingIds = {};
    parents.forEach(function (parentId) { relations.forEach(function (r) { if (r.type === 'parent_child' && r.fromPersonId === parentId && r.toPersonId !== anchorId) siblingIds[r.toPersonId] = true; }); });
    let sharedChildIds = children.slice();
    if (type === 'spouse' && self.data.selectedExistingId) relations.forEach(function (r) { if (r.type === 'parent_child' && r.fromPersonId === self.data.selectedExistingId && sharedChildIds.indexOf(r.toPersonId) < 0) sharedChildIds.push(r.toPersonId); });
    if (type === 'father' || type === 'mother') sharedChildIds = Object.keys(siblingIds);
    const selectedTargetId = self.data.entryMode === 'existing' ? self.data.selectedExistingId : '';
    const sharedChildren = sharedChildIds.map(item).filter(Boolean).map(function (p) {
      let state = '';
      if (selectedTargetId && (type === 'father' || type === 'mother')) state = self.relationExists('parent_child', selectedTargetId, p._id) ? '已关联' : '可补齐';
      if (selectedTargetId && type === 'spouse') state = self.relationExists('parent_child', anchorId, p._id) && self.relationExists('parent_child', selectedTargetId, p._id) ? '已关联' : '可补齐';
      return Object.assign({}, p, { selected: self.data.selectedSharedChildIds.indexOf(p._id) >= 0, relationStateText: state });
    });
    const expected = fixedGender(type);
    const existing = persons.filter(function (p) { return p._id !== anchorId && (!expected || p.gender === 'unknown' || p.gender === expected); }).map(function (p) {
      const primary = type === 'father' || type === 'mother' ? self.relationExists('parent_child', p._id, anchorId) : type === 'son' || type === 'daughter' ? self.relationExists('parent_child', anchorId, p._id) : type === 'spouse' ? self.relationExists('spouse', anchorId, p._id) : false;
      const cycle = (type === 'father' || type === 'mother') ? self.reachesByChildren(anchorId, p._id) : (type === 'son' || type === 'daughter') ? self.reachesByChildren(p._id, anchorId) : false;
      const parentConflict = type === 'sibling' && parents.indexOf(p._id) >= 0;
      const siblingLinked = type === 'sibling' && parents.some(function (parentId) { return self.relationExists('parent_child', parentId, p._id); });
      return Object.assign(self.personItem(p), { selectable: !cycle && !parentConflict, relationStateText: cycle ? '会形成亲子循环' : parentConflict ? '已是父母，不能设为兄弟姐妹' : primary || siblingLinked ? '已关联，可补齐关系' : '可关联' });
    });
    this._existingCandidates = existing;
    this.setData({ coParentCandidates: coParents, coParentId: type === 'son' || type === 'daughter' ? coParentId : '', parentPartnerCandidates: parents.map(item).filter(Boolean).map(function (p) { return Object.assign({}, p, { relationStateText: selectedTargetId && self.relationExists('spouse', selectedTargetId, p._id) ? '已关联' : '' }); }), parentPartnerId: (type === 'father' || type === 'mother') && parents.indexOf(this.data.parentPartnerId) >= 0 ? this.data.parentPartnerId : '', sharedParents: parents.map(item).filter(Boolean).map(function (p) { return Object.assign({}, p, { selected: self.data.selectedSharedParentIds.indexOf(p._id) >= 0, relationStateText: selectedTargetId && self.relationExists('parent_child', p._id, selectedTargetId) ? '已关联' : '' }); }), sharedChildren: sharedChildren, selectedSharedChildIds: this.data.selectedSharedChildIds.filter(function (id) { return sharedChildIds.indexOf(id) >= 0; }), selectedSharedParentIds: this.data.selectedSharedParentIds.filter(function (id) { return parents.indexOf(id) >= 0; }), siblingBlocked: type === 'sibling' && parents.length === 0, existingResults: this.filterCandidates(existing, this.data.existingKeyword) });
    this.updateSummary(); this.updateDuplicateSuggestions();
  },
  filterCandidates: function (list, keyword) { return (list || []).filter(function (p) { return !keyword || p.name.indexOf(keyword) >= 0; }); },
  refreshDefaultLifeStatus: function () {
    if (this._lifeStatusTouched || !this._graphPersons) return;
    this.setData({ lifeStatus: memberLifeStatus.defaultStatus(this._graphPersons, this._graphRelations, this.data.anchorId, this.data.relationType) });
  },
  chooseRelation: function (event) {
    const type = event.currentTarget.dataset.type; if (type === this.data.relationType) return; this._coParentTouched = false;
    this._genderTouched = false;
    this.setData({ relationType: type, relationLabel: RELATION_OPTIONS.find(function (i) { return i.key === type; }).label, gender: defaultGender(type, this.data.anchorGender), coParentId: '', parentPartnerId: '', selectedSharedParentIds: [], selectedSharedChildIds: [], selectedExistingId: '', selectedExistingPerson: null });
    this.refreshDefaultLifeStatus();
    this.refreshRelationChoices(true); this.markDirty();
  },
  saveDraft: function (mode) { this._drafts[mode] = mode === 'new' ? { name: this.data.name, gender: this.data.gender, lifeStatus: this.data.lifeStatus, birthDraft: this.data.birthDraft, deathDraft: this.data.deathDraft, birthPlace: this.data.birthPlace, bio: this.data.bio, showMoreFields: this.data.showMoreFields } : { existingKeyword: this.data.existingKeyword, selectedExistingId: this.data.selectedExistingId, selectedExistingPerson: this.data.selectedExistingPerson }; },
  chooseEntryMode: function (event) { const mode = event.currentTarget.dataset.mode; if (mode === this.data.entryMode) return; this.saveDraft(this.data.entryMode); this.setData(Object.assign({ entryMode: mode }, this._drafts[mode] || {})); this.refreshRelationChoices(false); },
  filterExisting: function (event) { const keyword = event.detail.value.trim(); this.setData({ existingKeyword: keyword }); if (this._existingTimer) clearTimeout(this._existingTimer); const self = this; this._existingTimer = setTimeout(function () { self._existingTimer = null; self.setData({ existingResults: self.filterCandidates(self._existingCandidates, keyword) }); }, 120); },
  selectExisting: function (event) { const id = event.currentTarget.dataset.id, person = (this._existingCandidates || []).find(function (p) { return p._id === id; }); if (!person) return; if (person.selectable === false) { wx.showToast({ title: person.relationStateText, icon: 'none' }); return; } this.setData({ selectedExistingId: id, selectedExistingPerson: person }); this.refreshRelationChoices(false); this.markDirty(); },
  useExistingSuggestion: function (event) { const id = event.currentTarget.dataset.id, selected = (this._existingCandidates || []).find(function (p) { return p._id === id; }); if (!selected || selected.selectable === false) { wx.showToast({ title: selected ? selected.relationStateText : '这位成员不适合当前关系', icon: 'none' }); return; } this.saveDraft('new'); this.setData({ entryMode: 'existing', selectedExistingId: id, existingKeyword: this.data.name, selectedExistingPerson: selected }); this.refreshRelationChoices(false); this.markDirty(); },
  inputField: function (event) { const patch = {}; patch[event.currentTarget.dataset.field] = event.detail.value; this.setData(patch); if (event.currentTarget.dataset.field === 'name') { if (this._duplicateTimer) clearTimeout(this._duplicateTimer); const self = this; this._duplicateTimer = setTimeout(function () { self._duplicateTimer = null; self.updateDuplicateSuggestions(); }, 120); } this.markDirty(); },
  updateDuplicateSuggestions: function () { const name = this.data.name.trim(); this.setData({ duplicateSuggestions: name ? (this._graphPersons || []).filter(function (p) { return p.name.indexOf(name) >= 0; }).slice(0, 3).map(this.personItem.bind(this)) : [] }); },
  chooseGender: function (event) { const gender = event.currentTarget.dataset.gender; if (fixedGender(this.data.relationType) || !personGender.isKnown(gender)) return; this._genderTouched = true; this.setData({ gender: gender }); this.markDirty(); },
  chooseLifeStatus: function (event) { const lifeStatus = event.currentTarget.dataset.status; this._lifeStatusTouched = true; this.setData({ lifeStatus: lifeStatus, deathDraft: lifeStatus === 'living' ? personDate.emptyDraft() : this.data.deathDraft }); this.markDirty(); },
  onBirthDateChange: function (event) { this.setData({ birthDraft: event.detail.value }); this.markDirty(); },
  onDeathDateChange: function (event) { this.setData({ deathDraft: event.detail.value }); this.markDirty(); },
  dateInputs: function () { const birth = personDate.toInfo(this.data.birthDraft), death = personDate.toInfo(this.data.deathDraft); return { birth: birth, death: death, error: birth.error ? '出生时间：' + birth.error : death.error ? '离世时间：' + death.error : '' }; },
  toggleMoreFields: function () { this.setData({ showMoreFields: !this.data.showMoreFields }); },
  chooseExclusive: function (event) { const field = event.currentTarget.dataset.field, id = event.currentTarget.dataset.id, patch = {}; patch[field] = this.data[field] === id ? '' : id; if (field === 'coParentId') this._coParentTouched = true; this.setData(patch); this.updateSummary(); this.markDirty(); },
  toggleMulti: function (event) { const field = event.currentTarget.dataset.field, id = event.currentTarget.dataset.id, selected = this.data[field].slice(), index = selected.indexOf(id); if (index >= 0) selected.splice(index, 1); else selected.push(id); const patch = {}; patch[field] = selected; this.setData(patch); if (field === 'selectedSharedChildIds') this.setData({ sharedChildren: this.data.sharedChildren.map(function (p) { return Object.assign({}, p, { selected: selected.indexOf(p._id) >= 0 }); }) }); if (field === 'selectedSharedParentIds') this.setData({ sharedParents: this.data.sharedParents.map(function (p) { return Object.assign({}, p, { selected: selected.indexOf(p._id) >= 0 }); }) }); this.updateSummary(); this.markDirty(); },
  updateSummary: function () { const summary = [this.data.anchorName + '的' + this.data.relationLabel]; if (this.data.coParentId) summary.push('同时关联另一位父母'); if (this.data.parentPartnerId) summary.push('同时确认父母伴侣关系'); if (this.data.selectedSharedParentIds.length) summary.push('共同父母 ' + this.data.selectedSharedParentIds.length + ' 位'); if (this.data.selectedSharedChildIds.length) summary.push('共同子女 ' + this.data.selectedSharedChildIds.length + ' 位'); this.setData({ relationSummary: summary }); },
  chooseAvatar: function () {
    const self = this; if (this.data.uploading || this.data.submitting) return Promise.resolve();
    return privacy.ensurePrivacyAuthorized().then(function () { return wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] }); }).then(function (result) { const file = result.tempFiles[0]; self._selectedAvatarSize = file.size || 0; self._pendingAvatarMedia = null; self.setData({ avatar: file.tempFilePath, selectedAvatarPath: file.tempFilePath, avatarAssetId: '', moderationStatus: '', avatarState: 'selected', avatarStateText: '已选择，添加成员时一并上传' }); self.markDirty(); }).catch(function (error) { if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) return; wx.showToast({ title: api.userMessage(error, '照片选择失败'), icon: 'none' }); });
  },
  requestPayload: function () { return { familyId: this.data.familyId, anchorPersonId: this.data.anchorId, relationType: this.data.relationType, coParentId: this.data.coParentId, parentPartnerId: this.data.parentPartnerId, sharedParentIds: this.data.selectedSharedParentIds, sharedChildIds: this.data.selectedSharedChildIds }; },
  createNewPerson: function (avatarAssetId) { const dates = this.dateInputs(); return api.call('person.createRelated', Object.assign(this.requestPayload(), { idempotencyKey: this._submitRequestId, person: { name: this.data.name.trim(), gender: this.data.gender, lifeStatus: this.data.lifeStatus, birthDateInfo: dates.birth.info, deathDateInfo: this.data.lifeStatus === 'deceased' ? dates.death.info : null, birthPlace: this.data.birthPlace.trim(), avatarAssetId: avatarAssetId || '', bio: this.data.bio.trim() } })); },
  canSubmit: function () { if ((this._contextRequested && this.data.loadingContext) || this.data.contextError || this.data.siblingBlocked) return false; if (this.data.relationType === 'sibling' && !this.data.selectedSharedParentIds.length) return false; return this.data.entryMode === 'new' ? Boolean(this.data.name.trim() && personGender.isKnown(this.data.gender) && ['living', 'deceased'].includes(this.data.lifeStatus)) : Boolean(this.data.selectedExistingId); },
  submit: function (event) {
    const self = this, continueAdding = Boolean(event && event.currentTarget && event.currentTarget.dataset.continue);
    if (!this.canSubmit()) { wx.showToast({ title: this.data.siblingBlocked ? '请先添加父亲或母亲' : this.data.entryMode === 'new' && !personGender.isKnown(this.data.gender) ? '请选择成员性别' : '请完整选择成员和关系', icon: 'none' }); return; }
    if (this.data.entryMode === 'new' && this.dateInputs().error) { wx.showToast({ title: this.dateInputs().error, icon: 'none' }); return; }
    if (this.data.submitting || this.data.uploading) return;
    if (!this._submitRequestId) this._submitRequestId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    this.setData({ submitting: true, submitStage: this.data.entryMode === 'new' ? '正在添加成员…' : '正在关联…' });
    let request;
    if (this.data.entryMode === 'existing') request = api.call('relation.linkExisting', Object.assign(this.requestPayload(), { relatedPersonId: this.data.selectedExistingId, idempotencyKey: this._submitRequestId }));
    else {
      let mediaPromise = Promise.resolve(this._pendingAvatarMedia || null);
      if (this.data.selectedAvatarPath && !this._pendingAvatarMedia) {
        this.setData({ uploading: true, submitStage: '正在上传头像…', avatarState: 'uploading', avatarStateText: '正在上传头像…' });
        mediaPromise = api.uploadImage(this.data.selectedAvatarPath, 'person-avatars', { familyId: this.data.familyId, kind: 'person_avatar', size: this._selectedAvatarSize || 0 }).then(function (media) { self._pendingAvatarMedia = media; self.setData({ avatar: media.previewUrl || self.data.avatar, avatarAssetId: media.assetId, moderationStatus: media.moderationStatus, uploading: false, submitStage: '正在添加成员…', avatarState: 'uploaded', avatarStateText: media.ready ? '头像已上传，正在绑定成员…' : '头像已上传，审核通过后自动展示' }); return media; });
      }
      request = mediaPromise.then(function (media) { return self.createNewPerson(media ? media.assetId : ''); });
    }
    return request.then(function (data) { self._submitRequestId = ''; if (!data.pending && app.invalidateFamilyData) app.invalidateFamilyData(self.data.familyId); if (data.pending && app.refreshPendingBadge) app.refreshPendingBadge({ force: true }).catch(function () {}); self.clearDirty(); wx.showToast({ title: data.pending ? '已提交管理员审核' : '关系已保存', icon: data.pending ? 'none' : 'success', duration: 1600 }); if (continueAdding) return self.resetForNext(); setTimeout(function () { wx.navigateBack(); }, 600); return data; }).catch(function (error) { if (error.code !== 'CLOUD_FUNCTION_TIMEOUT' && error.code !== 'CLOUD_CALL_FAILED') self._submitRequestId = ''; if (self.data.entryMode === 'new' && self._pendingAvatarMedia) self.setData({ avatarState: 'uploaded', avatarStateText: '头像已上传，再次保存时将直接重试绑定' }); wx.showToast({ title: api.userMessage(error, '添加失败'), icon: 'none' }); }).then(function (data) { self.setData({ submitting: false, uploading: false, submitStage: '' }); return data; });
  },
  resetForNext: function () { this._pendingAvatarMedia = null; this._selectedAvatarSize = 0; this._drafts = { new: {}, existing: {} }; this._genderTouched = false; this._lifeStatusTouched = false; this.setData({ entryMode: 'new', name: '', gender: defaultGender(this.data.relationType, this.data.anchorGender), lifeStatus: 'living', birthDraft: personDate.emptyDraft(), deathDraft: personDate.emptyDraft(), birthPlace: '', bio: '', avatar: '', selectedAvatarPath: '', avatarAssetId: '', avatarState: '', avatarStateText: '', selectedExistingId: '', selectedExistingPerson: null, existingKeyword: '', duplicateSuggestions: [], showMoreFields: false }); return this.loadRelationContext(); }
}));
