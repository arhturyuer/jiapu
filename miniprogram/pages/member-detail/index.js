const app = getApp();
const api = require('../../utils/api');

function relationLabel(item) {
  const person = item.person || {};
  if (item.role === 'spouse') return '伴侣';
  if (item.role === 'parent') {
    if (person.gender === 'male') return '父亲';
    if (person.gender === 'female') return '母亲';
    return '父母';
  }
  if (person.gender === 'male') return '儿子';
  if (person.gender === 'female') return '女儿';
  return '子女';
}

Page({
  data: {
    personId: '',
    loading: true,
    error: '',
    person: null,
    relatives: [],
    currentRole: 'viewer',
    canEdit: false,
    isAdmin: false
  },

  onLoad: function (options) {
    const personId = options.id || '';
    this.setData({ personId: personId });
    if (!personId) {
      this.setData({ loading: false, error: '缺少成员信息，请返回家谱重新选择。' });
      wx.showModal({ title: '无法打开资料', content: '缺少成员信息，请返回家谱重新选择。', showCancel: false });
    }
  },

  onShow: function () {
    if (this.data.personId) this.loadPerson();
  },

  loadPerson: function () {
    const self = this;
    this.setData({ loading: true, error: '' });
    api.call('person.get', { personId: this.data.personId }).then(function (data) {
      const person = Object.assign({}, data.person, {
        initial: (data.person.name || '家').slice(0, 1),
        genderText: data.person.gender === 'male' ? '男' : data.person.gender === 'female' ? '女' : '未填写',
        lifeText: data.person.lifeStatus === 'living' ? '健在' : data.person.lifeStatus === 'deceased' ? '已故' : '未填写'
      });
      const relatives = (data.relatives || []).map(function (item) {
        return Object.assign({}, item, {
          label: relationLabel(item),
          initial: (item.person.name || '家').slice(0, 1)
        });
      });
      self.setData({
        loading: false,
        person: person,
        relatives: relatives,
        currentRole: data.currentRole,
        canEdit: data.currentRole === 'admin' || data.currentRole === 'member',
        isAdmin: data.currentRole === 'admin'
      });
      const assetIds = [person.avatarAssetId].concat(relatives.map(function (item) { return item.person.avatarAssetId; }));
      return api.getMediaUrls(assetIds).then(function (urls) {
        person.avatar = urls[person.avatarAssetId] || '';
        relatives.forEach(function (item) {
          item.person.avatar = urls[item.person.avatarAssetId] || '';
        });
        self.setData({ person: person, relatives: relatives });
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: error.message || '资料加载失败' });
    });
  },

  openRelative: function (event) {
    wx.navigateTo({ url: '/pages/member-detail/index?id=' + event.currentTarget.dataset.id });
  },

  editPerson: function () {
    wx.navigateTo({ url: '/pages/edit-member/index?id=' + this.data.personId });
  },

  reportPerson: function () {
    const person = this.data.person;
    if (!person) return;
    wx.navigateTo({
      url: '/pages/report/index?familyId=' + person.familyId + '&targetType=person&targetId=' + person._id + '&targetName=' + encodeURIComponent(person.name)
    });
  },

  reportAvatar: function () {
    const person = this.data.person;
    if (!person || !person.avatarAssetId) return;
    wx.navigateTo({
      url: '/pages/report/index?familyId=' + person.familyId + '&targetType=media&targetId=' + person.avatarAssetId + '&targetName=' + encodeURIComponent(person.name + '的头像')
    });
  },

  viewFromPerson: function () {
    const person = this.data.person;
    const family = (app.globalData.familyList || []).find(function (item) {
      return person && item._id === person.familyId;
    }) || app.getCurrentFamily();
    if (!family) return;
    app.openPerspective(family, this.data.personId);
    wx.switchTab({ url: '/pages/tree/index' });
  },

  deletePerson: function () {
    const self = this;
    wx.showModal({
      title: '删除这位成员？',
      content: '相关关系会一起从家谱中移除。此操作会被记录，当前不能在小程序内恢复。',
      confirmText: '删除',
      confirmColor: '#B43D3D'
    }).then(function (result) {
      if (!result.confirm) return null;
      return api.call('person.delete', { personId: self.data.personId });
    }).then(function (data) {
      if (!data) return;
      wx.showToast({ title: '成员已删除', icon: 'success' });
      setTimeout(function () { wx.navigateBack(); }, 600);
    }).catch(function (error) {
      wx.showToast({ title: error.message || '删除失败', icon: 'none' });
    });
  }
});
