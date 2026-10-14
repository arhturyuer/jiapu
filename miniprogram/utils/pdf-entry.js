const snapshot = require('./pdf-layout-snapshot');
const session = require('./pdf-export-session');
function open(page, source) {
  const family = source === 'example' ? page.data.example : page.data.currentFamily;
  if (!family) return;
  const key = source === 'example' ? '&slug=' + encodeURIComponent(page.data.slug) : '&familyId=' + encodeURIComponent(family._id);
  const display = {};
  ['nameLayout', 'showGenderColors', 'showGenderBadge', 'showChildRankBadge'].forEach(function (field) { display[field] = page.data[field]; });
  try {
    const revision = source === 'example' ? Number(family.publishedVersion || 0) : page.data.contentRevision;
    const layout = snapshot.create(page.data.rawPersons || [], page.data.rawRelations || [], display.nameLayout, revision);
    const token = session.set({ source: source, key: source === 'example' ? page.data.slug : family._id, layoutSnapshot: layout });
    wx.navigateTo({ url: '/pages/pdf-export/index?source=' + source + key + '&display=' + encodeURIComponent(JSON.stringify(display)) + '&session=' + token,
      fail: function () { session.clear(token); wx.showToast({ title: '导出页面暂时没有打开，请重试', icon: 'none' }); } });
  } catch (error) {
    wx.showToast({ title: '请刷新家谱后重新生成', icon: 'none' });
  }
}
module.exports = { open };
