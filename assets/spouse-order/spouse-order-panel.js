const api = require('./api');
const graph = require('./graph-layout');
const order = require('./spouse-order');
const gender = require('./person-gender');
const adAccess = require('./ad-access');
module.exports = function (app) {
  return {
    spouseRows: function () {
      const owner = this.data.spousePerson; const ids = this._spouseIds || [];
      return ids.map((id, i) => {
        const p = this.data.rawPersons.find(row => row._id === id);
        return Object.assign({}, gender.decorate(p), { initial: (p.name || '家').slice(0, 1), isSelf: id === owner._id, canMoveUp: i > 0, canMoveDown: i < ids.length - 1 });
      });
    },
    openSpouseOrderSheet: function () {
      const person = this.data.selectedPerson;
      if (!person || !this.data.canEdit) return;
      const membership = order.neighbors(this.data.rawPersons, this.data.rawRelations).get(person._id);
      if (!membership || membership.size < 2) return;
      // Use the complete layout so perspective/collapse does not omit a spouse.
      const ids = graph.groupPersonsByGeneration(this.data.rawPersons, this.data.rawRelations).orderedPersons.filter(p => membership.has(p._id)).map(p => p._id);
      this._spouseIds = ids.slice(); this._spouseOriginal = ids.slice();
      this._spouseRevision = this.data.relationRevision;
      this._spouseFamily = this.data.currentFamily._id;
      adAccess.closeMember(this);
      this.setData({ showMemberSheet: false, showSpouseOrder: true, spousePerson: person, spouseDirty: false });
      this.setData({ spouseItems: this.spouseRows() });
    },
    closeSpouseOrderSheet: function () {
      if (this.data.spouseSaving) return;
      this._spouseIds = []; this._spouseOriginal = [];
      this.setData({ showSpouseOrder: false, spousePerson: null, spouseItems: [], spouseDirty: false });
    },
    moveSpouseOrder: function (event) {
      if (this.data.spouseSaving) return;
      const ids = (this._spouseIds || []).slice();
      const index = ids.indexOf(event.currentTarget.dataset.id);
      const direction = event.currentTarget.dataset.direction;
      if (direction !== 'up' && direction !== 'down') return;
      const next = index + (direction === 'up' ? -1 : 1);
      if (index < 0 || next < 0 || next >= ids.length) return;
      [ids[index], ids[next]] = [ids[next], ids[index]];
      this._spouseIds = ids;
      this.setData({ spouseItems: this.spouseRows(), spouseDirty: ids.join('|') !== this._spouseOriginal.join('|') });
    },
    saveSpouseOrder: function () {
      const person = this.data.spousePerson;
      if (!person || !this.data.canEdit || !this.data.spouseDirty || this.data.spouseSaving) return;
      const familyId = this._spouseFamily;
      if (!this.data.currentFamily || this.data.currentFamily._id !== familyId) return;
      this.setData({ spouseSaving: true });
      return api.call('relation.reorderSpouses', { familyId, personId: person._id, orderedPersonIds: this._spouseIds.slice(), relationRevision: this._spouseRevision }).then(data => {
        if (this._spouseDisposed || !this.data.currentFamily || this.data.currentFamily._id !== familyId) return;
        wx.showToast({ title: data.pending ? '已提交管理员审核' : '夫妻顺序已更新', icon: data.pending ? 'none' : 'success' });
        if (data.pending && app.refreshPendingBadge) app.refreshPendingBadge({ force: true }).catch(function () {});
        this.setData({ spouseSaving: false }); this.closeSpouseOrderSheet();
        if (!data.pending) {
          if (!app.handleFamilyMutation) app.invalidateFamilyData(familyId);
          return this.loadPage(null, { refreshGraph: true });
        }
        return data;
      }).catch(error => {
        if (this._spouseDisposed || !this.data.currentFamily || this.data.currentFamily._id !== familyId) return;
        this.setData({ spouseSaving: false });
        if (error.code === 'SPOUSE_ORDER_CONFLICT') wx.showModal({ title: '夫妻顺序冲突', content: error.message || '请先调整相关人物的夫妻顺序', showCancel: false });
        else wx.showToast({ title: api.userMessage(error, '夫妻顺序保存失败'), icon: 'none' });
      });
    }
  };
};
