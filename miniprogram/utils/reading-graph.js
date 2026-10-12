function anchor(page) {
  const layout = page._lastLayout;
  if (!layout || !layout.nodes.length) return null;
  const viewport = page.getGraphViewport();
  const transform = page.getGraphTransform();
  const pixels = viewport.rpxToPx * transform.scale;
  function position(node) { return { x: transform.x + (node.x + layout.nodeWidth / 2) * pixels,
    y: transform.y + (node.y + layout.nodeHeight / 2) * pixels }; }
  const selected = layout.nodes.find(function (node) { return node._id === page.data.selectedPersonId; });
  const node = selected || layout.nodes.reduce(function (nearest, candidate) {
    const p = position(candidate), n = position(nearest);
    return Math.pow(p.x - viewport.width / 2, 2) + Math.pow(p.y - viewport.height / 2, 2)
      < Math.pow(n.x - viewport.width / 2, 2) + Math.pow(n.y - viewport.height / 2, 2) ? candidate : nearest;
  });
  return Object.assign({ id: node._id, scale: transform.scale }, position(node));
}

function changed(previous, next) {
  if (!previous || (previous.contentScale === next.contentScale && previous.elderMode === next.elderMode) || !this._lastLayout || !this.data.rawPersons) return;
  const point = anchor(this);
  if (previous.contentScale !== next.contentScale) this.renderGraph(this.data.viewMode, this.data.viewpointId, { preserveViewport: true });
  const page = this;
  const layout = this._lastLayout;
  const version = this._readingGraphVersion = (this._readingGraphVersion || 0) + 1;
  function restore(viewport) {
    if (page._deviceHidden || page._lastLayout !== layout || page._readingGraphVersion !== version || !point) return;
    const node = page._lastLayout.nodes.find(function (item) { return item._id === point.id; });
    if (!node) return;
    const pixels = viewport.rpxToPx * point.scale;
    page._graphViewport = viewport;
    page.commitGraphTransform({ scale: point.scale, x: point.x - (node.x + page._lastLayout.nodeWidth / 2) * pixels,
      y: point.y - (node.y + page._lastLayout.nodeHeight / 2) * pixels });
  }
  if (this.measureGraphViewport && (this.createSelectorQuery || typeof wx !== 'undefined' && wx.createSelectorQuery)) {
    this.measureGraphViewport(this.getWindowSize(), restore);
  } else restore(this.getGraphViewport());
}

function lookClearly() {
  this.setData({ showReadingMore: false });
  this.fitGraph(this.data.selectedPersonId || this.data.viewpointId || '', false, { initialView: true });
}

function openPeople() {
  if (this.data.currentFamily) wx.navigateTo({ url: '/pages/person-list/index?familyId=' + encodeURIComponent(this.data.currentFamily._id) });
  else this.openPerspectiveSheet();
}

module.exports = { changed: changed, anchor: anchor, lookClearly: lookClearly, openPeople: openPeople };
