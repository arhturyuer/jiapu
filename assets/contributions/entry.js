function cancel(page) { page._contributionRevision = (page._contributionRevision || 0) + 1; }
function load(page, familyId, personId, options) {
  const revision = page._contributionRevision = (page._contributionRevision || 0) + 1;
  const app = getApp();
  const identity = app.globalData || {};
  const scope = JSON.stringify([identity.environment, identity.env, identity.user && identity.user._id, familyId, personId || '']);
  if (page._contributionScope !== scope) page.setData({ contributionText: '正在读取编写记录…', contributionError: false });
  page._contributionScope = scope;
  return app.getContributionSummary(familyId, personId || '', options).then(function (data) {
    if (revision !== page._contributionRevision) return;
    page._contributionLoadedScope = scope;
    const authors = data.authors || [];
    const names = authors.slice(0, 3).map(item => item.name).join('、');
    page.setData({ contributionError: false, contributionText: authors.length ? '资料编写：' + names + (authors.length > 3 ? '等 ' + authors.length + ' 人' : '') : '暂无编写记录' });
  }).catch(function () {
    if (revision === page._contributionRevision) page.setData({ contributionError: true, ...(page._contributionLoadedScope === scope ? {} : { contributionText: '编写记录暂未加载，点击查看' }) });
  });
}
function open(familyId, personId) {
  if (familyId) wx.navigateTo({ url: '/pages/contribution/index?familyId=' + encodeURIComponent(familyId) + (personId ? '&personId=' + encodeURIComponent(personId) : '') });
}
module.exports = { load, cancel, open };
