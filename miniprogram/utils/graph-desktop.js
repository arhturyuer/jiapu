const capabilities = require('./platform-capabilities');

function blocked(page) {
  return page._deviceHidden || page._unloaded || !page.data.nodes || !page.data.nodes.length || page.data.orientationChanging
    || page._newFamilyTourTimer
    || Object.keys(page.data).some(function (key) { return /^show.*(?:Sheet|Dialog|Prompt)$/.test(key) && page.data[key]; });
}

function attach(page) {
  detach(page);
  if (!page.data.isDesktop || !capabilities.supports('onKeyDown')) return;
  page._graphKeyDown = function (event) {
    if (blocked(page) || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (key === '+' || key === '=') page.zoomGraphIn();
    else if (key === '-' || key === '_') page.zoomGraphOut();
    else if (key === '0') page.fitWholeGraph();
  };
  try { wx.onKeyDown(page._graphKeyDown); } catch (error) { page._graphKeyDown = null; }
}

function detach(page) {
  if (page._graphKeyDown && typeof wx !== 'undefined' && wx.offKeyDown) {
    try { wx.offKeyDown(page._graphKeyDown); } catch (error) {}
  }
  page._graphKeyDown = null;
}

module.exports = { attach: attach, detach: detach, blocked: blocked };
