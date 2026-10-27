const launchAd = require('../../utils/launch-ad');
const app = getApp();
const api = require('../../utils/api');
const format = require('../../utils/format');
const shareInvite = require('../../utils/share-invite');

function decorateInvitations(items) {
  return (items || []).map(function (item) {
    const poster = item.purpose === 'poster';
    const noExpiry = item.expiresAt === null;
    const noUseLimit = item.maxUses === null;
    return Object.assign({}, item, {
      roleText: format.roleText(item.role),
      inviteTitle: poster
        ? '高清图片 · 仅查看'
        : format.roleText(item.role) + ' · ' + (item.viewMode === 'perspective' ? item.viewPersonName + '视角' : '完整家谱'),
      statusText: item.displayStatus === 'active'
        ? (noExpiry ? '长期有效' : '有效')
        : item.displayStatus === 'revoked' ? '已撤销' : item.displayStatus === 'expired' ? '已过期' : '已用完',
      usageText: noUseLimit ? '已加入 ' + Number(item.useCount || 0) + ' 人' : '已使用 ' + Number(item.useCount || 0) + '/' + Number(item.maxUses || 0)
    });
  });
}

Page(launchAd.wrap({
  data: {
    familyId: '',
    focusSection: '',
    loading: true,
    error: '',
    family: null,
    currentRole: 'viewer',
    isAdmin: false,
    collaborators: [],
    invitations: [],
    inviteCursor: '',
    hasMoreInvites: false,
    loadingMoreInvites: false,
    invitesExpanded: false,
    invitesLoaded: false,
    invitesLoading: false,
    invitesError: '',
    archiving: false
  },

  onLoad: function (options) {
    const familyId = options.familyId || '';
    if (!familyId) {
      this.setData({ loading: false, error: '缺少家谱信息，请返回后重试。' });
      return;
    }
    this.setData({ familyId: familyId, focusSection: options.section || '' });
  },

  onShow: function () {
    this._visible = true;
    if (this.data.familyId) return this.loadPage();
  },

  onHide: function () { this._visible = false; this._revision = (this._revision || 0) + 1; this._inviteRevision = (this._inviteRevision || 0) + 1; },
  onUnload: function () { this.onHide(); },

  loadPage: function () {
    const self = this;
    const revision = this._revision = (this._revision || 0) + 1;
    this._inviteRevision = (this._inviteRevision || 0) + 1;
    this.setData({ invitesExpanded: false, invitesLoaded: false, invitesLoading: false, invitations: [], invitesError: '', loadingMoreInvites: false });
    this.setData({ loading: true, error: '' });
    return app.loadFamilyPages(true).then(function (listData) {
      const family = (listData.families || []).find(function (item) { return item._id === self.data.familyId; });
      if (revision !== self._revision || !self._visible) return null;
      if (!family) throw new Error('你已无法访问这份家谱');
      self.setData({
        family: family,
        currentRole: family.currentRole,
        isAdmin: family.currentRole === 'admin'
      });
      if (family.status === 'archived') return { family: family, collaborators: [], invitations: [] };
      return app.getDashboard(family._id).then(function (data) {
        return { family: data.family, collaborators: data.collaborators || [] };
      });
    }).then(function (data) {
      if (!data || revision !== self._revision || !self._visible) return;
      self.setData({
        loading: false,
        family: data.family,
        currentRole: data.family.currentRole,
        isAdmin: data.family.currentRole === 'admin',
        collaborators: (data.collaborators || []).map(function (item) {
          return Object.assign({}, item, {
            initial: (item.displayName || '家').slice(0, 1),
            roleText: item.role === 'viewer' ? '仅查看' : format.roleText(item.role),
            roleDescription: item.role === 'admin' ? '可管理资料、审核申请和家人权限' : item.role === 'member' ? '可提交新增或修改申请，管理员审核后生效' : '可浏览家谱，不能修改资料'
          });
        }),
        invitations: decorateInvitations(data.invitations),
        inviteCursor: data.inviteCursor || '',
        hasMoreInvites: Boolean(data.hasMoreInvites)
      }, function () {
        if (self.data.focusSection === 'collaborators') {
          wx.pageScrollTo({ selector: '#collaborator-section', duration: 260 });
          self.setData({ focusSection: '' });
        }
      });
    }).catch(function (error) {
      if (revision === self._revision && self._visible) self.setData({ loading: false, error: api.userMessage(error, '加载失败') });
    });
  },

  openFamilyProfile: function () { wx.navigateTo({ url: '/pages/family-profile/index?familyId=' + encodeURIComponent(this.data.familyId) }); },

  managePermissions: function (event) {
    if (!this.data.isAdmin) return;
    const target = this.data.collaborators.find(item => item._id === event.currentTarget.dataset.id);
    if (!target) return;
    const actions = target.role === 'admin' ? ['调整角色'] : ['调整角色', '增设为管理员', '转让我的管理员身份'];
    return wx.showActionSheet({ itemList: actions }).then(result => {
      const handlers = ['changeRole', 'transferAdmin', 'transferOwnership'];
      return this[handlers[result.tapIndex]](event);
    }).catch(error => { if (!(error.errMsg || '').includes('cancel')) wx.showToast({ title: api.userMessage(error, '操作失败'), icon: 'none' }); });
  },

  copyFamily: function () {
    wx.navigateTo({ url: '/pages/family-copy/index?familyId=' + encodeURIComponent(this.data.familyId) });
  },

  reportFamily: function () {
    const family = this.data.family;
    if (!family) return;
    wx.navigateTo({
      url: '/pages/report/index?familyId=' + family._id + '&targetType=family&targetId=' + family._id + '&targetName=' + encodeURIComponent(family.name + '的家谱描述')
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
      app.invalidateFamilyData(self.data.familyId);
      wx.showToast({ title: '角色已更新', icon: 'success' });
      self.loadPage();
    }).catch(function (error) {
      if (error && error.errMsg && error.errMsg.includes('cancel')) return;
      wx.showToast({ title: api.userMessage(error, '角色更新失败'), icon: 'none' });
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
      app.invalidateFamilyData(self.data.familyId);
      wx.showToast({ title: '管理员已添加', icon: 'success' });
      self.loadPage();
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '设置失败'), icon: 'none' });
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
      app.invalidateFamilyData(self.data.familyId);
      wx.showToast({ title: '管理权已转让', icon: 'success' });
      self.loadPage();
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '转让失败'), icon: 'none' });
    });
  },

  toggleInvites: function () {
    if (!this.data.isAdmin) return Promise.resolve();
    this.setData({ invitesExpanded: !this.data.invitesExpanded });
    if (this.data.invitesExpanded && !this.data.invitesLoaded) return this.loadInvites(false);
    return Promise.resolve();
  },

  loadMoreInvites: function () { return this.loadInvites(true); },
  retryInvites: function () { return this.loadInvites(this.data.invitesLoaded); },
  loadInvites: function (more) {
    if (!this.data.isAdmin || this.data.invitesLoading || (more && !this.data.hasMoreInvites)) return Promise.resolve();
    const revision = this._inviteRevision = (this._inviteRevision || 0) + 1;
    const familyId = this.data.familyId;
    this.setData({ invitesLoading: true, loadingMoreInvites: Boolean(more), invitesError: '' });
    return app.getInvites(familyId, more ? this.data.inviteCursor : '').then(data => {
      if (!this._visible || revision !== this._inviteRevision || familyId !== this.data.familyId || !this.data.isAdmin) return;
      this.setData({ invitations: (more ? this.data.invitations : []).concat(decorateInvitations(data.items)), inviteCursor: data.nextCursor || '', hasMoreInvites: Boolean(data.hasMore), invitesLoaded: true });
    }).catch(error => {
      if (revision === this._inviteRevision && this._visible) {
        this.setData({ invitesError: api.userMessage(error, '邀请加载失败，请重试') });
        if (['NO_PERMISSION', 'NO_FAMILY_ACCESS', 'FAMILY_ARCHIVED'].includes(error.code)) this.setData({ isAdmin: false, invitesExpanded: false, invitations: [] });
      }
    }).then(() => { if (revision === this._inviteRevision) this.setData({ invitesLoading: false, loadingMoreInvites: false }); });
  },

  revokeInvite: function (event) {
    const self = this;
    const invitationId = event.currentTarget.dataset.id;
    return wx.showModal({ title: '撤销这个邀请？', content: '撤销后，尚未加入的家人将无法继续使用这张邀请卡。已加入的家人不受影响。', confirmText: '撤销', confirmColor: '#B43D3D' }).then(function (result) {
      if (!result.confirm) return null;
      return api.call('invite.revoke', { invitationId: invitationId });
    }).then(function (data) {
      if (!data) return;
      shareInvite.removeInvitation(invitationId);
      app.invalidateCache({ dashboard: self.data.familyId });
      app.invalidateInvites(self.data.familyId);
      wx.showToast({ title: '邀请已撤销', icon: 'success' });
      return self.loadInvites(false);
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '撤销失败'), icon: 'none' });
    });
  },

  archiveFamily: function () {
    const self = this;
    if (this.data.archiving) return;
    wx.showModal({
      title: '将家谱移入回收站？',
      content: '归档后暂停访问，30 天内可以恢复，之后将永久删除。',
      confirmText: '确认移入',
      confirmColor: '#B43D3D'
    }).then(function (result) {
      if (!result.confirm) return null;
      if (self.data.archiving) return null;
      self.setData({ archiving: true });
      return api.call('family.archive', { familyId: self.data.familyId });
    }).then(function (data) {
      if (!data) return;
      app.invalidateFamilyData(self.data.familyId);
      self.setData({ family: Object.assign({}, self.data.family, { status: 'archived', purgeAt: data.purgeAt }) });
      app.setCurrentFamily(null);
      wx.showToast({ title: '已移入回收站', icon: 'none' });
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '移入回收站失败'), icon: 'none' });
    }).then(function () {
      self.setData({ archiving: false });
    });
  },

  restoreFamily: function () {
    const self = this;
    api.call('family.restore', { familyId: this.data.familyId }).then(function () {
      app.invalidateFamilyData(self.data.familyId);
      wx.showToast({ title: '家谱已恢复', icon: 'success' });
      self.loadPage();
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '恢复失败'), icon: 'none' });
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
      app.invalidateFamilyData(self.data.familyId);
      app.setCurrentFamily(null);
      wx.showToast({ title: '已退出家谱', icon: 'none' });
      setTimeout(function () { wx.reLaunch({ url: '/pages/tree/index' }); }, 500);
    }).catch(function (error) {
      wx.showToast({ title: api.userMessage(error, '退出失败'), icon: 'none' });
    });
  }
}));
