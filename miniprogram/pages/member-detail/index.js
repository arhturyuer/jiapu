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
    isAdmin: false,
    openRelationId: '',
    removingRelationId: ''
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
    this.setData({ loading: true, error: '', openRelationId: '' });
    return api.call('person.get', { personId: this.data.personId }).then(function (data) {
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
    if (this._suppressRelationTapUntil && Date.now() < this._suppressRelationTapUntil) return;
    if (this.data.openRelationId) {
      this.setData({ openRelationId: '' });
      return;
    }
    wx.navigateTo({ url: '/pages/member-detail/index?id=' + event.currentTarget.dataset.id });
  },

  onRelationTouchStart: function (event) {
    if (!this.data.isAdmin || this.data.removingRelationId) return;
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    const relationId = event.currentTarget.dataset.relationId;
    this._relationTouch = {
      relationId: relationId,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      horizontal: null,
      wasOpen: this.data.openRelationId === relationId
    };
  },

  onRelationTouchMove: function (event) {
    const gesture = this._relationTouch;
    const touch = event.touches && event.touches[0];
    if (!gesture || !touch || event.currentTarget.dataset.relationId !== gesture.relationId) return;
    gesture.lastX = touch.clientX;
    gesture.lastY = touch.clientY;
    const deltaX = touch.clientX - gesture.startX;
    const deltaY = touch.clientY - gesture.startY;
    if (gesture.horizontal === null) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 8) return;
      gesture.horizontal = Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
    }
    if (!gesture.horizontal) return;
    this._suppressRelationTapUntil = Date.now() + 400;
    if (deltaX <= -24 && this.data.openRelationId !== gesture.relationId) {
      this.setData({ openRelationId: gesture.relationId });
    } else if (deltaX >= 24 && this.data.openRelationId === gesture.relationId) {
      this.setData({ openRelationId: '' });
    }
  },

  onRelationTouchEnd: function (event) {
    const gesture = this._relationTouch;
    if (!gesture || event.currentTarget.dataset.relationId !== gesture.relationId) return;
    const touch = event.changedTouches && event.changedTouches[0];
    const finalX = touch ? touch.clientX : gesture.lastX;
    const deltaX = finalX - gesture.startX;
    if (gesture.horizontal) {
      this._suppressRelationTapUntil = Date.now() + 400;
      if (deltaX <= -24) this.setData({ openRelationId: gesture.relationId });
      else if (deltaX >= 24) this.setData({ openRelationId: '' });
      else this.setData({ openRelationId: gesture.wasOpen ? gesture.relationId : '' });
    }
    this._relationTouch = null;
  },

  onRelationTouchCancel: function (event) {
    this.onRelationTouchEnd(event);
  },

  removeRelation: function (event) {
    if (!this.data.isAdmin || this.data.removingRelationId) return Promise.resolve(null);
    const self = this;
    const relationId = event.currentTarget.dataset.relationId;
    const relative = this.data.relatives.find(function (item) { return item.relationId === relationId; });
    if (!relative) return Promise.resolve(null);
    return wx.showModal({
      title: '移除这条关系？',
      content: '将移除“' + relative.person.name + '”与“' + this.data.person.name + '”之间的' + relative.label + '关系。只移除关系，不删除两位成员。',
      confirmText: '移除',
      confirmColor: '#B43D3D'
    }).then(function (result) {
      if (!result.confirm) return null;
      self.setData({ removingRelationId: relationId });
      return api.call('relation.remove', { relationId: relationId }).then(function (data) {
        self.setData({ removingRelationId: '', openRelationId: '' });
        wx.showToast({ title: '关系已移除', icon: 'success' });
        return self.loadPerson().then(function () { return data; });
      }).catch(function (error) {
        self.setData({ removingRelationId: '' });
        if (error.code === 'RELATION_DISCONNECTS_GRAPH') {
          return wx.showModal({
            title: '无法移除关系',
            content: '移除后会使家谱关系断开，请先建立正确关系，再移除当前关系。',
            showCancel: false
          });
        }
        wx.showToast({ title: error.message || '关系移除失败', icon: 'none' });
        return null;
      });
    });
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
