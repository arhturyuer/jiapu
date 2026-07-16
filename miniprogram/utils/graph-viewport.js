const MIN_SCALE = 0.32;
const MAX_SCALE = 1.6;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function zoomClassForScale(scale, currentClass) {
  const current = currentClass || 'zoom-detail';
  if (current === 'zoom-detail') {
    if (scale < 0.44) return 'zoom-overview';
    return scale < 0.72 ? 'zoom-compact' : 'zoom-detail';
  }
  if (current === 'zoom-overview') {
    if (scale >= 0.82) return 'zoom-detail';
    return scale >= 0.56 ? 'zoom-compact' : 'zoom-overview';
  }
  if (scale >= 0.82) return 'zoom-detail';
  if (scale < 0.44) return 'zoom-overview';
  return 'zoom-compact';
}

function findNode(layout, personId) {
  if (!personId || !layout || !layout.nodes) return null;
  return layout.nodes.find(function (node) { return node._id === personId; }) || null;
}

function fitTransform(layout, viewport, options) {
  const optionsValue = options || {};
  const minimum = optionsValue.minimumScale || MIN_SCALE;
  const maximum = optionsValue.maximumScale || MAX_SCALE;
  const canvasWidth = layout.width * viewport.rpxToPx;
  const canvasHeight = layout.height * viewport.rpxToPx;
  const fitScale = clamp(Math.min(
    (viewport.width - 24) / canvasWidth,
    (viewport.height - 24) / canvasHeight,
    1
  ), minimum, maximum);
  const focusNode = findNode(layout, optionsValue.focusPersonId);
  const scale = optionsValue.fitAll
    ? fitScale
    : clamp(Math.max(optionsValue.currentScale || fitScale, optionsValue.minimumFocusScale || 0), minimum, maximum);
  let x = (viewport.width - canvasWidth * scale) / 2;
  let y = (viewport.height - canvasHeight * scale) / 2;
  if (focusNode) {
    x = viewport.width / 2 - (focusNode.x + 84) * viewport.rpxToPx * scale;
    y = viewport.height * 0.38 - (focusNode.y + 58) * viewport.rpxToPx * scale;
  }
  return { x: x, y: y, scale: scale };
}

function zoomAroundCenter(transform, nextScaleValue, viewport, options) {
  const optionsValue = options || {};
  const minimum = optionsValue.minimumScale || MIN_SCALE;
  const maximum = optionsValue.maximumScale || MAX_SCALE;
  const currentScale = transform.scale || 1;
  const nextScale = clamp(nextScaleValue, minimum, maximum);
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const contentX = (centerX - transform.x) / currentScale;
  const contentY = (centerY - transform.y) / currentScale;
  return {
    x: centerX - contentX * nextScale,
    y: centerY - contentY * nextScale,
    scale: nextScale
  };
}

module.exports = {
  MIN_SCALE: MIN_SCALE,
  MAX_SCALE: MAX_SCALE,
  fitTransform: fitTransform,
  zoomAroundCenter: zoomAroundCenter,
  zoomClassForScale: zoomClassForScale
};
