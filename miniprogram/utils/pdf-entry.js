function open(page, source) {
  const family = source === 'example' ? page.data.example : page.data.currentFamily;
  if (!family) return;
  const key = source === 'example' ? '&slug=' + encodeURIComponent(page.data.slug) : '&familyId=' + encodeURIComponent(family._id);
  const display = {};
  ['nameLayout', 'showGenderColors', 'showGenderBadge', 'showChildRankBadge'].forEach(function (field) { display[field] = page.data[field]; });
  wx.navigateTo({ url: '/pages/pdf-export/index?source=' + source + key + '&display=' + encodeURIComponent(JSON.stringify(display)) });
}
module.exports = { open };
