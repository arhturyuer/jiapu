function changed(event) {
  if (this._deviceHidden || this._unloaded) return;
  const height = Number(event && event.detail && event.detail.height);
  if (!Number.isFinite(height) || height <= 0 || height === this.data.navigationHeight) return;
  this.setData({ navigationHeight: height }, () => {
    if (this._deviceHidden || this._unloaded || this._launchGate || !this.applyPageResize) return;
    // Use the existing resize/gesture queue to preserve the current graph position.
    this.onResize({ size: event.detail.size || this.getWindowSize() });
  });
}

module.exports = { changed: changed };
