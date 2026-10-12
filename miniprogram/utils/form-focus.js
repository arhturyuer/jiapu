function hideKeyboard() {
  if (typeof wx === 'undefined' || typeof wx.hideKeyboard !== 'function') return;
  try {
    const result = wx.hideKeyboard({ fail: function () {} });
    if (result && typeof result.catch === 'function') result.catch(function () {});
  } catch (error) {}
}

function datePickerVisibility(event) {
  this.setData({ datePickerOpen: Boolean(event.detail && event.detail.shown), readingNameFocus: false }, hideKeyboard);
}

module.exports = { hideKeyboard: hideKeyboard, datePickerVisibility: datePickerVisibility };
