const graphViewport = require('./graph-viewport');

function visible(page) {
  return !page._pageHidden && !page._hidden && !page._unloaded;
}

function config(page, transform, disabled) {
  const viewport = page.getGraphViewport();
  const version = page._gestureVersion = (page._gestureVersion || 0) + 1;
  page._gestureSequence = 0;
  page._graphGestureActive = false;
  return {
    version: version, x: transform.x, y: transform.y, scale: transform.scale,
    left: viewport.left || 0, top: viewport.top || 0,
    minimum: page.data.graphScaleMin, maximum: graphViewport.MAX_SCALE,
    disabled: Boolean(disabled)
  };
}

function record(page, state) {
  page._currentGraphX = state.x;
  page._currentGraphY = state.y;
  page._currentGraphScale = state.scale;
}

function invalidate(page) {
  page._gestureJob = (page._gestureJob || 0) + 1;
  page._gesturePending = null;
  page.setData({ graphGestureConfig: config(page, page.getGraphTransform(), true) });
}

function wrap(definition) {
  definition.data.graphGestureConfig = null;
  definition.data.graphGestureRequest = null;
  definition.onGraphGestureState = function (state) {
    if (!visible(this) || state.version !== this._gestureVersion
      || state.sequence <= (this._gestureSequence || 0)
      || !Number.isFinite(state.x) || !Number.isFinite(state.y)
      || !Number.isFinite(state.scale) || state.scale <= 0) return;
    if (state.requestId && (!this._gesturePending || state.requestId !== this._gesturePending.id)) return;
    this._gestureSequence = state.sequence;
    record(this, state);
    this._graphGestureActive = state.active;
    if (state.active) return;
    const pending = this._gesturePending;
    if (state.requestId) {
      if (!pending || state.requestId !== pending.id) return;
      this._gesturePending = null;
      pending.run();
    } else if (!pending) {
      this.commitGraphTransform(this.getGraphTransform());
    }
  };
  // Existing synchronous page operations stay synchronous outside a gesture.
  // During a gesture, request the exact render-layer transform before computing.
  ['renderGraph', 'fitGraph', 'changeGraphScale', 'togglePageOrientation', 'toggleCleanScreen', 'resetPageOrientation', 'applyPageResize', 'switchExample', 'switchFamily'].forEach(function (name) {
    const original = definition[name];
    if (!original) return;
    definition[name] = function () {
      const page = this;
      const args = arguments;
      if (!this._graphGestureActive && !this._gesturePending) return original.apply(this, args);
      const id = this._gestureJob = (this._gestureJob || 0) + 1;
      this._gesturePending = { id: id, run: function () {
        if (visible(page) && id === page._gestureJob) original.apply(page, args);
      } };
      this.setData({ graphGestureRequest: { id: id, version: this._gestureVersion } });
    };
  });
  const onShow = definition.onShow;
  definition.onShow = function () {
    this.setData({ graphGestureConfig: config(this, this.getGraphTransform()) });
    return onShow && onShow.apply(this, arguments);
  };
  ['onHide', 'onUnload'].forEach(function (name) {
    const original = definition[name];
    definition[name] = function () {
      invalidate(this);
      return original && original.apply(this, arguments);
    };
  });
  return definition;
}

module.exports = { wrap: wrap, config: config, invalidate: invalidate };
