const launchAd = require('../../utils/launch-ad');
const api = require('../../utils/api');
const profile = require('../../utils/family-profile');
const formState = require('../../utils/form-state');
const app = getApp();
Page(launchAd.wrap({
  data: { familyId: '', family: null, profile: {}, facts: [], loading: true, error: '', isAdmin: false, editing: false, form: {}, fields: profile.FIELDS, featuredOptions: profile.FEATURED, featuredIndex: 0, hasChanges: false, saving: false, saveError: '', fieldError: '', canEdit: false },
  onLoad: function (options) { this._alive = true; this._startEditing = options.edit === '1'; this.setData({ familyId: options.familyId || '' }); },
  onShow: function () {
    this._visible = true;
    if (this._savedData) { const data = this._savedData; this._savedData = null; if (this._scope === profile.scope(app)) { this.finishSave(data); return; } }
    if (this.data.saving) return;
    if (this.data.editing) return this.checkAccess();
    return this.load();
  },
  onHide: function () { this._visible = false; this._revision = (this._revision || 0) + 1; },
  onUnload: function () { this._alive = false; this.onHide(); formState.clearLeaveAlert(this); },
  onPullDownRefresh: function () { return (this.data.editing || this.data.saving ? Promise.resolve() : this.load({ force: true })).then(() => wx.stopPullDownRefresh()); },
  load: function (options) {
    if (this.data.editing || this.data.saving) return Promise.resolve();
    const revision = this._revision = (this._revision || 0) + 1;
    const familyId = this.data.familyId;
    if (!familyId) { this.setData({ loading: false, error: '缺少家谱信息，请返回后重试。' }); return Promise.resolve(); }
    this.setData({ loading: true, error: '' });
    const scope = profile.scope(app);
    return app.getFamilyProfile(familyId, options).then(data => {
      if (revision !== this._revision || !this._visible) return;
      if (scope !== profile.scope(app)) { this.setData({ loading: false, error: '账户或家谱已变化，请重新进入' }); return; }
      this.renderProfile(data);
      if (this._startEditing) { this._startEditing = false; return this.edit(); }
    }).catch(error => {
      if (revision === this._revision && this._visible) this.setData({ loading: false, error: api.userMessage(error, '资料加载失败，请重试') });
    });
  },
  renderProfile: function (data) {
    const info = data.profile;
    const facts = [['surname', '姓氏'], ['ancestralHome', '祖籍'], ['hallName', '堂号']].map(item => ({ key: item[0], label: item[1], value: info[item[0]] || '' }));
    this.setData({ loading: false, family: data.family, profile: info, facts, isAdmin: data.family.currentRole === 'admin' });
  },
  retry: function () { return this.load({ force: true }); },
  edit: function () {
    if (!this.data.isAdmin || this.data.editing || this.data.loading || !this._visible) return Promise.resolve();
    const form = profile.form({ family: this.data.family, profile: this.data.profile });
    this._initial = profile.normalize(form); this._scope = profile.scope(app);
    this.setData({ editing: true, form, hasChanges: false, saveError: '', fieldError: '', featuredIndex: Math.max(0, profile.FEATURED.findIndex(item => item.key === form.featuredSection)) });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    return this.checkAccess();
  },
  checkAccess: function () {
    const revision = this._revision = (this._revision || 0) + 1;
    this.setData({ canEdit: false });
    if (this._scope !== profile.scope(app)) { this.setData({ saveError: '账户或家谱已变化，请返回后重新进入' }); return Promise.resolve(); }
    return app.getFamilyProfile(this.data.familyId, { force: true }).then(data => {
      if (revision !== this._revision || !this._visible) return;
      this.setData({ canEdit: data.family.currentRole === 'admin' && this._scope === profile.scope(app), saveError: this._scope !== profile.scope(app) ? '账户或家谱已变化，请返回后重新进入' : data.family.currentRole === 'admin' ? '' : '管理权限已变化，当前无法保存' });
    }).catch(error => { if (revision === this._revision && this._visible) this.setData({ canEdit: false, saveError: api.userMessage(error, '无法确认管理权限，请返回后重试') }); });
  },
  inputField: function (event) {
    if (!this.data.canEdit || this.data.saving) return;
    const key = event.currentTarget.dataset.field;
    if (!profile.FIELDS.some(field => field.key === key)) return;
    this.updateForm(Object.assign({}, this.data.form, { [key]: event.detail.value }));
  },
  changeFeatured: function (event) {
    if (!this.data.canEdit || this.data.saving) return;
    const index = Number(event.detail.value);
    if (!profile.FEATURED[index]) return;
    this.setData({ featuredIndex: index });
    this.updateForm(Object.assign({}, this.data.form, { featuredSection: profile.FEATURED[index].key }));
  },
  updateForm: function (form) {
    const hasChanges = JSON.stringify(profile.normalize(form)) !== JSON.stringify(this._initial);
    this.setData({ form, hasChanges, saveError: '', fieldError: '' });
    formState.syncLeaveAlert(this, hasChanges);
  },
  cancel: function () {
    if (this.data.saving) return;
    const leave = () => { formState.clearLeaveAlert(this); this.setData({ editing: false, form: {}, hasChanges: false, saveError: '', fieldError: '', canEdit: false }); return this.load({ force: true }); };
    if (!this.data.hasChanges) return leave();
    return wx.showModal({ title: '放弃本次修改？', content: '尚未保存的资料将不会保留。', confirmText: '放弃修改' }).then(result => { if (result.confirm) return leave(); });
  },
  save: function () {
    if (!this.data.editing || !this._visible || this.data.saving || !this.data.hasChanges || !this.data.canEdit) return Promise.resolve();
    if (this._scope !== profile.scope(app)) { this.setData({ canEdit: false, saveError: '账户或家谱已变化，请返回后重新进入' }); return Promise.resolve(); }
    const issue = profile.validate(this.data.form);
    if (issue) { this.setData({ fieldError: issue.key, saveError: issue.message }); wx.pageScrollTo({ selector: '#field-' + issue.key, duration: 240 }); return Promise.resolve(); }
    const form = profile.normalize(this.data.form);
    const payload = { familyId: this.data.familyId, name: form.name, description: form.description };
    Object.keys(form).forEach(key => { if (form[key] !== this._initial[key]) payload[key] = form[key]; });
    const serialized = JSON.stringify(payload);
    if (serialized !== this._pendingPayload) { this._pendingPayload = serialized; this._idempotencyKey = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
    payload.idempotencyKey = this._idempotencyKey;
    this.setData({ saving: true, saveError: '' });
    formState.syncLeaveAlert(this, true, '资料正在保存，请稍候再离开。');
    return api.call('family.update', payload).then(data => {
      if (this._scope !== profile.scope(app) || !this._alive) return;
      app.applyFamilyUpdate(data.family, data.profile);
      if (!this._visible) { this._savedData = data; return; }
      this.finishSave(data);
    }).catch(error => {
      if (this._alive && this._scope === profile.scope(app)) this.setData({ saveError: api.userMessage(error, '保存失败，请重试'), canEdit: !['NO_PERMISSION', 'NO_FAMILY_ACCESS', 'FAMILY_ARCHIVED', 'ACCOUNT_SESSION_CHANGED'].includes(error.code) });
      if (error.isBusinessError) this._pendingPayload = '';
    }).then(() => { if (this._alive) { this.setData({ saving: false }); formState.syncLeaveAlert(this, this.data.editing && this.data.hasChanges); } });
  },
  finishSave: function (data) {
    this.renderProfile(data);
    this.setData({ editing: false, form: {}, hasChanges: false, saveError: '', fieldError: '', canEdit: false });
    this._pendingPayload = ''; formState.clearLeaveAlert(this);
    wx.showToast({ title: '家谱资料已保存', icon: 'success' });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  openContributions: function () { wx.navigateTo({ url: '/pages/contribution/index?familyId=' + encodeURIComponent(this.data.familyId) }); }
}));
