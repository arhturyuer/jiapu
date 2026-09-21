const api = require('../../utils/api');
const kinship = require('../../utils/kinship');
const personGender = require('../../utils/person-gender');

function labelForRelation(person, relation, related) {
  const role = relation.type === 'spouse' ? 'spouse' : relation.toPersonId === person._id ? 'parent' : 'child';
  return kinship.directRelationshipLabel(person, related, role);
}

function createFamilyUrl(slug) {
  return '/pages/create-family/index?source=example&example=' + encodeURIComponent(slug);
}

Page({
  data: { slug: '', personId: '', loading: true, error: '', person: null, relatives: [], openRelationId: '' },
  onLoad: function (options) {
    this.setData({ slug: options.slug || '', personId: options.id || '' });
    if (!options.slug || !options.id) this.setData({ loading: false, error: '缺少示例人物信息，请返回家谱重新选择。' });
  },
  onShow: function () { if (this.data.slug && this.data.personId) this.loadPerson(); },
  loadPerson: function () {
    const self = this;
    this.setData({ loading: true, error: '', openRelationId: '' });
    return api.call('examples.get', { slug: this.data.slug }).then(function (data) {
      const example = data.example || {};
      const person = (example.persons || []).find(function (item) { return item._id === self.data.personId; });
      if (!person) throw new Error('该示例人物已不存在');
      const people = example.persons || [];
      const relatives = (example.relations || []).filter(function (relation) { return relation.fromPersonId === person._id || relation.toPersonId === person._id; }).map(function (relation) {
        const relatedId = relation.fromPersonId === person._id ? relation.toPersonId : relation.fromPersonId;
        const related = people.find(function (item) { return item._id === relatedId; }) || {};
        return { relationId: relation._id, person: personGender.decorate(Object.assign({}, related, { initial: (related.name || '家').slice(0, 1) })), label: labelForRelation(person, relation, related) };
      });
      self.setData({ loading: false, person: personGender.decorate(Object.assign({}, person, { initial: (person.name || '家').slice(0, 1), lifeText: person.lifeStatus === 'living' ? '健在' : person.lifeStatus === 'deceased' ? '已故' : '未填写' })), relatives: relatives });
    }).catch(function (error) { self.setData({ loading: false, error: api.userMessage(error, '资料加载失败') }); });
  },
  openRelative: function (event) {
    if (this._suppressRelationTapUntil && Date.now() < this._suppressRelationTapUntil) return;
    if (this.data.openRelationId) return this.setData({ openRelationId: '' });
    wx.navigateTo({ url: '/pages/example-person-detail/index?slug=' + encodeURIComponent(this.data.slug) + '&id=' + encodeURIComponent(event.currentTarget.dataset.id) });
  },
  onRelationTouchStart: function (event) {
    const touch = event.touches && event.touches[0]; if (!touch) return;
    this._relationTouch = { id: event.currentTarget.dataset.relationId, startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, horizontal: null, wasOpen: this.data.openRelationId === event.currentTarget.dataset.relationId };
  },
  onRelationTouchMove: function (event) {
    const gesture = this._relationTouch; const touch = event.touches && event.touches[0];
    if (!gesture || !touch || event.currentTarget.dataset.relationId !== gesture.id) return;
    gesture.lastX = touch.clientX; const dx = touch.clientX - gesture.startX; const dy = touch.clientY - gesture.startY;
    if (gesture.horizontal === null) { if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return; gesture.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2; }
    if (!gesture.horizontal) return; this._suppressRelationTapUntil = Date.now() + 400;
    if (dx <= -24) this.setData({ openRelationId: gesture.id }); else if (dx >= 24 && this.data.openRelationId === gesture.id) this.setData({ openRelationId: '' });
  },
  onRelationTouchEnd: function (event) {
    const gesture = this._relationTouch; if (!gesture || event.currentTarget.dataset.relationId !== gesture.id) return;
    const touch = event.changedTouches && event.changedTouches[0]; const dx = (touch ? touch.clientX : gesture.lastX) - gesture.startX;
    if (gesture.horizontal) { this._suppressRelationTapUntil = Date.now() + 400; this.setData({ openRelationId: dx <= -24 ? gesture.id : dx >= 24 ? '' : (gesture.wasOpen ? gesture.id : '') }); }
    this._relationTouch = null;
  },
  onRelationTouchCancel: function (event) { this.onRelationTouchEnd(event); },
  explainCreate: function () { wx.navigateTo({ url: createFamilyUrl(this.data.slug) }); },
  viewFromPerson: function () { wx.redirectTo({ url: '/pages/example/index?slug=' + encodeURIComponent(this.data.slug) + '&personId=' + encodeURIComponent(this.data.personId) }); }
});
