const launchAd = require('../../utils/launch-ad');
const app = getApp();
const api = require('../../utils/api');
const exampleDisplayPreference = require('../../utils/example-display-preference');

function normalizedPreference(value) {
  const preference = value || {};
  return {
    nameLayout: preference.nameLayout === 'vertical' ? 'vertical' : 'horizontal',
    showChildRankBadge: preference.showChildRankBadge === true,
    showGenderBadge: preference.showGenderBadge === true,
    showGenderColors: preference.showGenderColors !== false,
    autoCollapseEnabled: preference.autoCollapseEnabled !== false
  };
}

Page(launchAd.wrap({
  data: {
    loading: true,
    error: '',
    familyId: '',
    family: null,
    exampleSlug: '',
    isExample: false,
    nameLayout: 'horizontal',
    showChildRankBadge: false,
    showGenderBadge: false,
    showGenderColors: true,
    autoCollapseEnabled: true,
    saving: false,
    savingField: ''
  },

  onLoad: function (options) {
    options = options || {};
    const exampleSlug = options.exampleSlug || '';
    if (exampleSlug) {
      this.setData({ exampleSlug: exampleSlug, isExample: true });
      this.loadPreference();
      return;
    }
    const currentFamily = app.getCurrentFamily();
    const familyId = options.familyId || (currentFamily && currentFamily._id) || '';
    this.setData({ familyId: familyId });
    this.loadPreference();
  },

  onHide: function () { this.flushPreference(); },
  onUnload: function () { this._unloaded = true; this.flushPreference(); },

  loadPreference: function () {
    const self = this;
    if (this.data.isExample) {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const previousPage = pages[pages.length - 2];
      const example = previousPage && previousPage.data && previousPage.data.example;
      const matchingExample = example && example.slug === this.data.exampleSlug ? example : null;
      this._exampleDefaults = matchingExample && matchingExample.defaultDisplayPreference;
      this._exampleVersion = matchingExample && matchingExample.publishedVersion;
      const preference = exampleDisplayPreference.get(this.data.exampleSlug, this._exampleDefaults, this._exampleVersion);
      this.setData(Object.assign({
        loading: false,
        error: '',
        family: { name: matchingExample ? matchingExample.title : '示例家谱' }
      }, preference));
      return Promise.resolve(preference);
    }
    if (!this.data.familyId) {
      this.setData({ loading: false, error: '请先选择一份家谱' });
      return Promise.resolve();
    }
    this.setData({ loading: true, error: '' });
    return app.getPreference(this.data.familyId).then(function (data) {
      self._confirmedPreference = normalizedPreference(data.preference);
      self.setData(Object.assign({
        loading: false,
        family: data.family || null
      }, normalizedPreference(data.preference)));
    }).catch(function (error) {
      self.setData({ loading: false, error: api.userMessage(error, '显示设置加载失败') });
    });
  },

  chooseNameLayout: function (event) {
    const value = event.currentTarget.dataset.layout;
    if ((value !== 'horizontal' && value !== 'vertical') || value === this.data.nameLayout) return;
    this.savePreference('nameLayout', value);
  },

  togglePreference: function (event) {
    const field = event.currentTarget.dataset.field;
    if (['showChildRankBadge', 'showGenderBadge', 'showGenderColors', 'autoCollapseEnabled'].indexOf(field) < 0) return;
    this.savePreference(field, Boolean(event.detail.value));
  },

  savePreference: function (field, value) {
    if (this.data.isExample) {
      const examplePreference = exampleDisplayPreference.saveField(this.data.exampleSlug, field, value, this._exampleDefaults, this._exampleVersion);
      this.setData(Object.assign({ saving: false, savingField: '' }, examplePreference));
      this.refreshExamplePreview(examplePreference);
      return Promise.resolve(examplePreference);
    }
    if (!this._confirmedPreference) this._confirmedPreference = normalizedPreference(this.data);
    const patch = { saving: true, savingField: field };
    patch[field] = value;
    this.setData(patch);
    this._pendingPreferenceVersion = app._sessionVersion || 0;
    this._pendingPreference = Object.assign(this._pendingPreference || {}, { [field]: value });
    if (this._preferenceTimer) clearTimeout(this._preferenceTimer);
    const self = this;
    this._preferenceTimer = setTimeout(function () {
      self._preferenceTimer = null;
      self.flushPreference();
    }, 1500);
    return Promise.resolve();
  },

  flushPreference: function () {
    if (this._preferenceTimer) clearTimeout(this._preferenceTimer);
    this._preferenceTimer = null;
    if (this._preferenceInFlight || (!this._pendingPreference && !this._retryPreference)) return this._preferenceInFlight || Promise.resolve();
    const retryVersion = this._retryPreferenceVersion;
    if (this._pendingPreference && this._pendingPreferenceVersion !== (app._sessionVersion || 0)) this._pendingPreference = null;
    if (this._retryPreference && retryVersion !== (app._sessionVersion || 0)) this._retryPreference = null;
    const retry = this._retryPreference;
    const changes = Object.assign({}, this._pendingPreference || {});
    if (!retry) this._pendingPreference = null;
    Object.keys(changes).forEach(key => { if (this._confirmedPreference && changes[key] === this._confirmedPreference[key]) delete changes[key]; });
    if (!retry && !Object.keys(changes).length) { if (!this._unloaded) this.setData({ saving: false, savingField: '' }); return Promise.resolve(); }
    const payload = retry || Object.assign({ familyId: this.data.familyId, idempotencyKey: api.requestId() }, changes);
    this._retryPreference = null;
    const self = this;
    const operationVersion = app._sessionVersion || 0;
    this._preferenceInFlight = api.call('family.setPreference', payload).then(function (data) {
      const saved = normalizedPreference(data.preference);
      self._confirmedPreference = saved;
      app.updatePreference(self.data.familyId, data.preference);
      if (!self._unloaded && !self._pendingPreference) self.setData(Object.assign({ saving: false, savingField: '' }, saved));
    }).catch(function (error) {
      self._retryPreference = !error.isBusinessError && operationVersion === (app._sessionVersion || 0) ? payload : null;
      self._retryPreferenceVersion = operationVersion;
      if (error.isBusinessError || operationVersion !== (app._sessionVersion || 0)) self._pendingPreference = null;
      if (!self._unloaded && !self._pendingPreference) self.setData(Object.assign({ saving: false, savingField: '' }, self._confirmedPreference || {}));
      if (!self._unloaded) wx.showToast({ title: api.userMessage(error, '设置保存失败，请重试'), icon: 'none' });
    }).then(function () {
      self._preferenceInFlight = null;
      if (self._pendingPreference && !self._retryPreference) return self.flushPreference();
    });
    return this._preferenceInFlight;
  },

  refreshExamplePreview: function (preference) {
    if (typeof getCurrentPages !== 'function') return;
    const pages = getCurrentPages();
    const previousPage = pages[pages.length - 2];
    if (previousPage && typeof previousPage.applyDisplayPreference === 'function') {
      previousPage.applyDisplayPreference(preference);
    }
  }
}));
