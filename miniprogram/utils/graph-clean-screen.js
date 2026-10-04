function toggle() {
  if (this.data.orientationChanging || !this.data.nodes.length) return;
  // Preserve the latest gesture position while the available canvas grows.
  this._orientationViewport = this.getGraphViewport();
  this._orientationTransform = this.getGraphTransform();
  const size = Object.assign({}, this.getWindowSize());
  // page-meta can rotate the canvas before getWindowInfo catches up.
  if ((size.windowWidth > size.windowHeight) !== Boolean(this.data.isLandscape)) {
    size.windowWidth = this._orientationViewport.windowWidth || this._orientationViewport.width;
    size.windowHeight = this._orientationViewport.height;
  }
  const page = this;
  this.setData({ isCleanScreen: !this.data.isCleanScreen }, function () {
    if (page._pageHidden || page._hidden || page._unloaded) return;
    page.applyPageResize(size);
  });
}

module.exports = { toggle: toggle };
