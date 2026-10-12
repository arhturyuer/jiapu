function error(page, message, field) {
  if (!page.data.elderMode) return;
  const patch = { readingResult: message, readingResultError: true, readingSaved: false };
  if (field === 'name') patch.readingNameFocus = true;
  page.setData(patch);
  if (field === 'name' && typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({ selector: '#reading-name', duration: 0 });
}

function saved(page, message, complete) {
  page.setData({ readingResult: message, readingResultError: false, readingSaved: complete === true });
}

function clearReturn(page) { clearTimeout(page._readingReturnTimer); page._readingReturnTimer = null; }

function returnAfter(page, delay) {
  clearReturn(page);
  page._readingReturnTimer = setTimeout(function () {
    page._readingReturnTimer = null;
    if (!page._deviceHidden && !page.data.elderMode) wx.navigateBack();
  }, delay);
}

function back() { wx.navigateBack(); }
module.exports = { error: error, saved: saved, back: back, returnAfter: returnAfter, clearReturn: clearReturn };
