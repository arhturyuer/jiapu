const launchAd = require('../../utils/launch-ad');
const api = require('../../utils/api');
const format = require('../../utils/format');

const ACTION_OPTIONS = [
  { key: '', label: '全部变化' },
  { key: 'family.update', label: '更新家谱资料' },
  { key: 'person.createRelated', label: '添加家庭成员' },
  { key: 'person.update', label: '更新人物资料' },
  { key: 'person.delete', label: '删除家庭成员' },
  { key: 'relation.linkExisting', label: '添加家庭关系' },
  { key: 'relation.remove', label: '移除家庭关系' },
  { key: 'relation.reorderChildren', label: '调整子女排行' },
  { key: 'invite.create', label: '创建家庭邀请' },
  { key: 'invite.revoke', label: '撤销家庭邀请' },
  { key: 'membership.updateRole', label: '调整家人权限' },
  { key: 'membership.transferAdmin', label: '转让管理员' },
  { key: 'change.review', label: '处理修改申请' }
];

Page(launchAd.wrap({
  data: {
    familyId: '', items: [], loading: true, loadingMore: false, hasMore: false, cursor: '', membershipRequired: false,
    action: '', actionIndex: 0, actionLabel: '全部变化', actionOptions: ACTION_OPTIONS,
    actorName: '', from: '', to: '', toDate: ''
  },
  onLoad: function (options) { this.setData({ familyId: options.familyId || '' }); this.load(true); },
  onPullDownRefresh: function () { this.load(true).then(function () { wx.stopPullDownRefresh(); }); },
  load: function (reset) {
    const self = this;
    if (!this.data.familyId || (!reset && (!this.data.hasMore || this.data.loadingMore))) return Promise.resolve();
    this.setData(reset ? { loading: true, cursor: '' } : { loadingMore: true });
    return api.call('family.activity.list', { familyId: this.data.familyId, cursor: reset ? '' : this.data.cursor, pageSize: 30, action: this.data.action.trim(), actorName: this.data.actorName.trim(), from: this.data.from, to: this.data.to }).then(function (data) {
      const mapped = (data.items || []).map(function (item) {
        const option = ACTION_OPTIONS.find(function (candidate) { return candidate.key && candidate.key === item.action; });
        return Object.assign({}, item, {
          summaryText: option ? (item.summary || option.label) : '其他家谱变化',
          timeText: format.dateTimeText ? format.dateTimeText(item.createdAt) : new Date(item.createdAt).toLocaleString()
        });
      });
      self.setData({ items: reset ? mapped : self.data.items.concat(mapped), loading: false, loadingMore: false, hasMore: data.hasMore, cursor: data.nextCursor || '', membershipRequired: data.membershipRequired });
    }).catch(function (error) { self.setData({ loading: false, loadingMore: false }); wx.showToast({ title: api.userMessage(error, '变更记录加载失败'), icon: 'none' }); });
  },
  changeAction: function (event) {
    const index = Number(event.detail.value) || 0;
    const option = ACTION_OPTIONS[index] || ACTION_OPTIONS[0];
    this.setData({ actionIndex: index, action: option.key, actionLabel: option.label });
  },
  inputActor: function (event) { this.setData({ actorName: event.detail.value || '' }); },
  changeFrom: function (event) { this.setData({ from: event.detail.value || '' }); },
  changeTo: function (event) { this.setData({ toDate: event.detail.value || '', to: event.detail.value ? event.detail.value + 'T23:59:59+08:00' : '' }); },
  clearFilters: function () { this.setData({ action: '', actionIndex: 0, actionLabel: '全部变化', actorName: '', from: '', to: '', toDate: '' }); this.load(true); },
  applyFilters: function () { this.load(true); },
  loadMore: function () { this.load(false); },
  openMembership: function () { wx.navigateTo({ url: '/pages/membership/index?familyId=' + this.data.familyId }); }
}));
