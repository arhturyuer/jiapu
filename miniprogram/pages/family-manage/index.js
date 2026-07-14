const app = getApp();
const api = require('../../utils/api');
const format = require('../../utils/format');

function decorateInvitations(items) {
  return (items || []).map(function (item) {
    return Object.assign({}, item, {
      roleText: format.roleText(item.role),
      statusText: item.displayStatus === 'active' ? '有效' : item.displayStatus === 'revoked' ? '已撤销' : item.displayStatus === 'expired' ? '已过期' : '已用完'
    });
  });
}

Page({
  data: {
    familyId: '',
    loading: true,
    error: '',
    family: null,
    name: '',
    description: '',
    currentRole: 'viewer',
    isAdmin: false,
    collaborators: [],
    invitations: [],
    inviteCursor: '',
    hasMoreInvites: false,
    loadingMoreInvites: false,
    saving: false
  },

  onLoad: function (options) {
    const familyId = options.familyId || '';
    if (!familyId) {
      this.setData({ loading: false, error: '缺少家谱信息，请返回后重试。' });
      return;
    }
    this.setData({ familyId: familyId });
  },

  onShow: function () {
    if (this.data.familyId) this.loadPage();
  },

  loadPage: function () {
    const self = this;
    this.setData({ loading: true, error: '' });
    return app.loadFamilyPages(true).then(function (listData) {
      const family = (listData.families || []).find(function (item) { return item._id === self.data.familyId; });
      if (!family) throw new Error('你已无法访问这份家谱');
      self.setData({
        family: family,
        name: family.name || '',
        description: family.description || '',
        currentRole: family.currentRole,
        isAdmin: family.currentRole === 'admin'
      });
      if (family.status === 'archived') return { family: family, collaborators: [], invitations: [] };
      const tasks = [api.call('family.dashboard', { familyId: family._id })];
      if (family.currentRole === 'admin') tasks.push(api.call('invite.list', { familyId: family._id, pageSize: 50 }));
      return Promise.all(tasks).then(function (results) {
        return {
          family: results[0].family,
          collaborators: results[0].collaborators || [],
          invitations: results[1] ? results[1].items || [] : [],
          inviteCursor: results[1] ? results[1].nextCursor || '' : '',
          hasMoreInvites: Boolean(results[1] && results[1].hasMore)
        };
      });
    }).then(function (data) {
      self.setData({
        loading: false,
        family: data.family,
        collaborators: (data.collaborators || []).map(function (item) {
          return Object.assign({}, item, {
            initial: (item.displayName || '家').slice(0, 1),
            roleText: format.roleText(item.role)
          });
        }),
        invitations: decorateInvitations(data.invitations),
        inviteCursor: data.inviteCursor || '',
        hasMoreInvites: Boolean(data.hasMoreInvites)
      });
    }).catch(function (error) {
      self.setData({ loading: false, error: error.message || '加载失败' });
    });
  },

  inputField: function (event) {
    const field = event.currentTarget.dataset.field;
    const change = {};
    change[field] = event.detail.value;
    this.setData(change);
  },

  reportFamily: function () {
    const family = this.data.family;
    if (!family) return;
    wx.navigateTo({
      url: '/pages/report/index?familyId=' + family._id + '&targetType=family&targetId=' + family._id + '&targetName=' + encodeURIComponent(family.name + '的家谱描述')
    });
  },

  saveFamily: function () {
    const self = this;
    if (!this.data.name.trim()) {
      wx.showToast({ title: '家谱名称不能为空', icon: 'none' });
      return;
    }
    if (this.data.saving) return;
    this.setData({ saving: true });
    api.call('family.update', {
      familyId: this.data.familyId,
      name: this.data.name.trim(),
      description: this.data.description.trim()
    }).then(function (data) {
      app.setCurrentFamily(data.family);
      self.setData({ family: data.family });
      wx.showToast({ title: '家谱资料已保存', icon: 'success' });
    }).catch(function (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }).then(function () {
      self.setData({ saving: false });
    });
  },

  changeRole: function (event) {
    const self = this;
    const membershipId = event.currentTarget.dataset.id;
    const target = this.data.collaborators.find(function (item) { return item._id === membershipId; });
    if (!target || !this.data.isAdmin) return;
    wx.showActionSheet({ itemList: ['设为共同补全成员', '设为仅查看访客', '设为管理员'] }).then(function (result) {
      const roles = ['member', 'viewer', 'admin'];
      return api.call('membership.updateRole', {
        familyId: self.data.familyId,
        membershipId: membershipId,
        role: roles[result.tapIndex]
      });
    }).then(function () {
      wx.showToast({ title: '角色已更新', icon: 'success' });
      self.loadPage();
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.includes('cancel')) return;
      wx.showToast({ title: error.message || '角色更新失败', icon: 'none' });
    });
  },

  transferAdmin: function (event) {
    const self = this;
    const membershipId = event.currentTarget.dataset.id;
    const target = this.data.collaborators.find(function (item) { return item._id === membershipId; });
    if (!target || target.role === 'admin') return;
    wx.showModal({
      title: '设为管理员？',
      content: target.displayName + ' 将可以审核修改、管理邀请和家庭成员。你仍保留管理员身份。',
      confirmText: '确认设置'
    }).then(function (result) {
      if (!result.confirm) return null;
      return api.call('membership.transferAdmin', {
        familyId: self.data.familyId,
        membershipId: membershipId,
        keepAdmin: true
      });
    }).then(function (data) {
      if (!data) return;
      wx.showToast({ title: '管理员已添加', icon: 'success' });
      self.loadPage();
    }).catch(function (error) {
      wx.showToast({ title: error.message || '设置失败', icon: 'none' });
    });
  },

  transferOwnership: function (event) {
    const self = this;
    const membershipId = event.currentTarget.dataset.id;
    const target = this.data.collaborators.find(function (item) { return item._id === membershipId; });
    if (!target || target.role === 'admin') return;
    wx.showModal({
      title: '转让管理员身份？',
      content: target.displayName + ' 将成为管理员，你将变为普通家庭成员。',
      confirmText: '确认转让',
      confirmColor: '#B56B2B'
    }).then(function (result) {
      if (!result.confirm) return null;
      return api.call('membership.transferAdmin', {
        familyId: self.data.familyId,
        membershipId: membershipId,
        keepAdmin: false
      });
    }).then(function (data) {
      if (!data) return;
      wx.showToast({ title: '管理权已转让', icon: 'success' });
      self.loadPage();
    }).catch(function (error) {
      wx.showToast({ title: error.message || '转让失败', icon: 'none' });
    });
  },

  loadMoreInvites: function () {
    const self = this;
    if (!this.data.hasMoreInvites || this.data.loadingMoreInvites) return;
    this.setData({ loadingMoreInvites: true });
    api.call('invite.list', {
      familyId: this.data.familyId,
      pageSize: 50,
      cursor: this.data.inviteCursor
    }).then(function (data) {
      self.setData({
        invitations: self.data.invitations.concat(decorateInvitations(data.items)),
        inviteCursor: data.nextCursor || '',
        hasMoreInvites: Boolean(data.hasMore),
        loadingMoreInvites: false
      });
    }).catch(function (error) {
      self.setData({ loadingMoreInvites: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    });
  },

  revokeInvite: function (event) {
    const self = this;
    const invitationId = event.currentTarget.dataset.id;
    wx.showModal({ title: '撤销这个邀请？', content: '撤销后，尚未加入的家人将无法继续使用这张邀请卡。', confirmText: '撤销', confirmColor: '#B43D3D' }).then(function (result) {
      if (!result.confirm) return null;
      return api.call('invite.revoke', { invitationId: invitationId });
    }).then(function (data) {
      if (!data) return;
      wx.showToast({ title: '邀请已撤销', icon: 'success' });
      self.loadPage();
    }).catch(function (error) {
      wx.showToast({ title: error.message || '撤销失败', icon: 'none' });
    });
  },

  archiveFamily: function () {
    const self = this;
    wx.showModal({
      title: '将家谱移入回收站？',
      content: '归档后暂停访问，30 天内可以恢复，之后将永久删除。',
      confirmText: '移入回收站',
      confirmColor: '#B43D3D'
    }).then(function (result) {
      if (!result.confirm) return null;
      return api.call('family.archive', { familyId: self.data.familyId });
    }).then(function (data) {
      if (!data) return;
      self.setData({ family: Object.assign({}, self.data.family, { status: 'archived', purgeAt: data.purgeAt }) });
      app.setCurrentFamily(null);
      wx.showToast({ title: '已移入回收站', icon: 'none' });
    }).catch(function (error) {
      wx.showToast({ title: error.message || '归档失败', icon: 'none' });
    });
  },

  restoreFamily: function () {
    const self = this;
    api.call('family.restore', { familyId: this.data.familyId }).then(function () {
      wx.showToast({ title: '家谱已恢复', icon: 'success' });
      self.loadPage();
    }).catch(function (error) {
      wx.showToast({ title: error.message || '恢复失败', icon: 'none' });
    });
  },

  leaveFamily: function () {
    const self = this;
    wx.showModal({
      title: '退出这份家谱？',
      content: '退出后需要新的邀请才能再次访问。最后一名管理员不能直接退出。',
      confirmText: '确认退出',
      confirmColor: '#B43D3D'
    }).then(function (result) {
      if (!result.confirm) return null;
      return api.call('membership.leave', { familyId: self.data.familyId });
    }).then(function (data) {
      if (!data) return;
      app.setCurrentFamily(null);
      wx.showToast({ title: '已退出家谱', icon: 'none' });
      setTimeout(function () { wx.reLaunch({ url: '/pages/tree/index' }); }, 500);
    }).catch(function (error) {
      wx.showToast({ title: error.message || '退出失败', icon: 'none' });
    });
  }
});
