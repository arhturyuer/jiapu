const app = getApp();
const api = require('../../utils/api');
const exampleDisplayPreference = require('../../utils/example-display-preference');

function normalizedPreference(value) {
  const preference = value || {};
  return {
    nameLayout: preference.nameLayout === 'vertical' ? 'vertical' : 'horizontal',
    showChildRankBadge: preference.showChildRankBadge === true,
    showGenderBadge: preference.showGenderBadge === true,
    showGenderColors: preference.showGenderColors !== false
  };
}

Page({
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

  loadPreference: function () {
    const self = this;
    if (this.data.isExample) {
      const preference = exampleDisplayPreference.get(this.data.exampleSlug);
      this.setData(Object.assign({
        loading: false,
        error: '',
        family: { name: '示例家谱' }
      }, preference));
      return Promise.resolve(preference);
    }
    if (!this.data.familyId) {
      this.setData({ loading: false, error: '请先选择一份家谱' });
      return Promise.resolve();
    }
    this.setData({ loading: true, error: '' });
    return api.call('family.getPreference', { familyId: this.data.familyId }).then(function (data) {
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
    if (this.data.saving || (value !== 'horizontal' && value !== 'vertical') || value === this.data.nameLayout) return;
    this.savePreference('nameLayout', value);
  },

  togglePreference: function (event) {
    const field = event.currentTarget.dataset.field;
    if (this.data.saving || ['showChildRankBadge', 'showGenderBadge', 'showGenderColors'].indexOf(field) < 0) return;
    this.savePreference(field, Boolean(event.detail.value));
  },

  savePreference: function (field, value) {
    const self = this;
    const previous = this.data[field];
    if (this.data.isExample) {
      const examplePreference = exampleDisplayPreference.saveField(this.data.exampleSlug, field, value);
      this.setData(Object.assign({ saving: false, savingField: '' }, examplePreference));
      this.refreshExamplePreview(examplePreference);
      return Promise.resolve(examplePreference);
    }
    const patch = { saving: true, savingField: field };
    patch[field] = value;
    this.setData(patch);
    const payload = { familyId: this.data.familyId };
    payload[field] = value;
    return api.call('family.setPreference', payload).then(function (data) {
      const saved = normalizedPreference(data.preference);
      self.setData(Object.assign({ saving: false, savingField: '' }, saved));
      app.invalidateCache({ graph: self.data.familyId });
      return data;
    }).catch(function (error) {
      const rollback = { saving: false, savingField: '' };
      rollback[field] = previous;
      self.setData(rollback);
      wx.showToast({ title: api.userMessage(error, '设置保存失败，请重试'), icon: 'none' });
    });
  },

  refreshExamplePreview: function (preference) {
    if (typeof getCurrentPages !== 'function') return;
    const pages = getCurrentPages();
    const previousPage = pages[pages.length - 2];
    if (previousPage && typeof previousPage.applyDisplayPreference === 'function') {
      previousPage.applyDisplayPreference(preference);
    }
  }
});
