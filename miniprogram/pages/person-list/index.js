const app = getApp();
const api = require('../../utils/api');
const graphLayout = require('../../utils/graph-layout');

const MISSING_FIELD_LABELS = {
  gender: '性别',
  birthDate: '出生日期',
  avatar: '头像',
  story: '简介或籍贯'
};

function personMeta(person) {
  const parts = [];
  if (person.gender === 'male') parts.push('男');
  if (person.gender === 'female') parts.push('女');
  if (person.lifeStatus === 'deceased') parts.push('已故');
  if (person.birthDate) parts.push(person.birthDate.slice(0, 4) + ' 年出生');
  return parts.join(' · ') || '资料待补充';
}

function decoratePersons(persons) {
  return (persons || []).map(function (person) {
    const missingFields = Array.isArray(person.profileMissingFields)
      ? person.profileMissingFields
      : [
        (!person.gender || person.gender === 'unknown') ? 'gender' : '',
        person.birthDate ? '' : 'birthDate',
        person.avatarAssetId ? '' : 'avatar'
      ].filter(Boolean);
    return Object.assign({}, person, {
      avatar: '',
      initial: (person.name || '家').slice(0, 1),
      metaText: personMeta(person),
      profileMissingFields: missingFields,
      missingText: '待补：' + missingFields.map(function (field) {
        return MISSING_FIELD_LABELS[field] || field;
      }).join('、')
    });
  });
}

Page({
  data: {
    familyId: '',
    family: null,
    loading: true,
    error: '',
    keyword: '',
    viewMode: 'generation',
    viewOptions: [
      { key: 'generation', label: '按辈分' },
      { key: 'name', label: '按姓名' },
      { key: 'missing', label: '资料待补' }
    ],
    persons: [],
    relations: [],
    generationSections: [],
    displayedPersons: [],
    searching: false,
    showEmpty: false
  },

  onLoad: function (options) {
    const familyId = options.familyId || '';
    this.setData({ familyId: familyId });
    if (!familyId) this.setData({ loading: false, error: '缺少家谱信息，请返回后重试。' });
  },

  onShow: function () {
    if (this.data.familyId) this.loadPage();
  },

  onPullDownRefresh: function () {
    this.loadPage().then(function () { wx.stopPullDownRefresh(); });
  },

  loadPage: function () {
    const self = this;
    this.setData({ loading: true, error: '' });
    return api.call('graph.get', { familyId: this.data.familyId }).then(function (data) {
      const persons = decoratePersons(data.persons);
      const relations = data.relations || [];
      app.setCurrentFamily(data.family);
      self.setData({
        loading: false,
        family: data.family,
        relations: relations
      });
      self.buildViews(persons, relations);
      return api.getMediaUrls(persons.map(function (person) { return person.avatarAssetId; })).then(function (urls) {
        const resolved = persons.map(function (person) {
          return Object.assign({}, person, { avatar: urls[person.avatarAssetId] || '' });
        });
        self.buildViews(resolved, relations);
      }).catch(function () {});
    }).catch(function (error) {
      self.setData({ loading: false, error: error.message || '成员列表加载失败' });
    });
  },

  inputKeyword: function (event) {
    this.setData({ keyword: event.detail.value });
    this.applyFilter();
  },

  clearKeyword: function () {
    this.setData({ keyword: '' });
    this.applyFilter();
  },

  switchView: function (event) {
    const mode = event.currentTarget.dataset.mode;
    if (!this.data.viewOptions.some(function (item) { return item.key === mode; })) return;
    this.setData({ viewMode: mode });
    this.applyFilter();
  },

  buildViews: function (persons, relations) {
    const structure = graphLayout.groupPersonsByGeneration(persons, relations);
    const generationLabelByPerson = {};
    structure.groups.forEach(function (group) {
      group.persons.forEach(function (person) { generationLabelByPerson[person._id] = group.label; });
    });
    const enriched = persons.map(function (person) {
      const generationText = generationLabelByPerson[person._id] || '辈分待确认';
      return Object.assign({}, person, {
        generationText: generationText,
        nameMetaText: generationText + ' · ' + person.metaText
      });
    });
    const peopleById = {};
    enriched.forEach(function (person) { peopleById[person._id] = person; });
    const generationSections = structure.groups.map(function (group) {
      return {
        key: group.key,
        label: group.label,
        persons: group.persons.map(function (person) { return peopleById[person._id]; })
      };
    });
    const generationSorted = structure.orderedPersons.map(function (person) { return peopleById[person._id]; });
    const nameSorted = graphLayout.sortPersonsByName(enriched);
    const nameOrder = {};
    nameSorted.forEach(function (person, index) { nameOrder[person._id] = index; });
    const generationByPerson = structure.generationByPerson;
    const missingSorted = enriched.filter(function (person) {
      return person.profileMissingFields.length > 0;
    }).sort(function (first, second) {
      const missingOrder = second.profileMissingFields.length - first.profileMissingFields.length;
      if (missingOrder) return missingOrder;
      const firstGeneration = generationByPerson[first._id] === null ? Number.MAX_SAFE_INTEGER : generationByPerson[first._id];
      const secondGeneration = generationByPerson[second._id] === null ? Number.MAX_SAFE_INTEGER : generationByPerson[second._id];
      if (firstGeneration !== secondGeneration) return firstGeneration - secondGeneration;
      return nameOrder[first._id] - nameOrder[second._id];
    });
    this._viewPersons = {
      generation: generationSorted,
      name: nameSorted,
      missing: missingSorted
    };
    this.setData({ persons: enriched, generationSections: generationSections });
    this.applyFilter();
  },

  applyFilter: function () {
    const keyword = (this.data.keyword || '').trim().toLowerCase();
    const source = this._viewPersons && this._viewPersons[this.data.viewMode]
      ? this._viewPersons[this.data.viewMode]
      : [];
    const filtered = keyword
      ? source.filter(function (person) {
        return (person.name || '').toLowerCase().indexOf(keyword) >= 0;
      })
      : source;
    this.setData({
      displayedPersons: filtered,
      searching: Boolean(keyword),
      showEmpty: filtered.length === 0
    });
  },

  openMember: function (event) {
    wx.navigateTo({ url: '/pages/member-detail/index?id=' + event.currentTarget.dataset.id });
  },

  openGraph: function () {
    app.openFullGraph(this.data.family);
    wx.switchTab({ url: '/pages/tree/index' });
  }
});
