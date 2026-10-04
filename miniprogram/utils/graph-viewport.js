const MIN_SCALE = 0.32;
const MAX_SCALE = 1.6;
const REFERENCE_RPX_TO_PX = 0.5;
const MIN_SCALE_FLOOR = 0.12;
// The cards use 28rpx names. Keep their initial on-screen size at 16px,
// independent of graph dimensions and the device's rpx conversion.
const INITIAL_NAME_SIZE = 16;
const NODE_NAME_RPX = 28;

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

function minimumScaleForViewport(viewport) {
  const rpxToPx = viewport && Number(viewport.rpxToPx);
  if (!rpxToPx || rpxToPx <= 0) return MIN_SCALE;
  return clamp(MIN_SCALE * REFERENCE_RPX_TO_PX / rpxToPx, MIN_SCALE_FLOOR, MIN_SCALE);
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
    const nodeWidth = layout.nodeWidth || 168;
    const nodeHeight = layout.nodeHeight || 164;
    x = viewport.width / 2 - (focusNode.x + nodeWidth / 2) * viewport.rpxToPx * scale;
    y = viewport.height * 0.38 - (focusNode.y + nodeHeight * 58 / 164) * viewport.rpxToPx * scale;
  }
  return { x: x, y: y, scale: scale };
}

function initialTransform(layout, viewport, options) {
  const optionsValue = options || {};
  const rpxToPx = Number(viewport.rpxToPx) || REFERENCE_RPX_TO_PX;
  const scale = clamp(INITIAL_NAME_SIZE / NODE_NAME_RPX / rpxToPx,
    optionsValue.minimumScale || minimumScaleForViewport(viewport),
    optionsValue.maximumScale || MAX_SCALE);
  const focusNode = findNode(layout, optionsValue.focusPersonId);
  if (focusNode) {
    return fitTransform(layout, viewport, {
      focusPersonId: focusNode._id,
      currentScale: scale,
      minimumScale: scale,
      maximumScale: scale
    });
  }
  const pixelsPerRpx = rpxToPx * scale;
  let x = (viewport.width - layout.width * pixelsPerRpx) / 2;
  let y = (viewport.height - layout.height * pixelsPerRpx) / 2;
  const nodeWidth = layout.nodeWidth || 168;
  const nodeHeight = layout.nodeHeight || 164;
  const start = initialClusterNode(layout, viewport, pixelsPerRpx, optionsValue.relations);
  if (start) {
    if (layout.width * pixelsPerRpx > viewport.width - 48) {
      x = viewport.width / 2 - (start.x + nodeWidth / 2) * pixelsPerRpx;
    }
    if (layout.height * pixelsPerRpx > viewport.height - 48) {
      y = viewport.height / 2 - (start.y + nodeHeight / 2) * pixelsPerRpx;
    }
  }
  return { x: x, y: y, scale: scale };
}

function initialClusterNode(layout, viewport, pixelsPerRpx, relations) {
  const nodes = layout.nodes || [];
  if (!nodes.length) return null;
  const ids = new Set(nodes.map(function (node) { return node._id; }));
  const seenEdges = new Set();
  const edges = (relations || []).filter(function (relation) {
    if (relation.status === 'deleted' || !['spouse', 'parent_child'].includes(relation.type)) return false;
    const from = relation.fromPersonId, to = relation.toPersonId;
    if (!ids.has(from) || !ids.has(to) || from === to) return false;
    const key = JSON.stringify([relation.type, [from, to].sort()]);
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  nodes.forEach(function (node) {
    minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
  });
  // Count nearby members and their visible relationships at the readable
  // scale. Ties favor the middle/newer generations, then horizontal center.
  const halfWidth = Math.max(layout.nodeWidth || 168, (viewport.width - 48) / pixelsPerRpx) / 2;
  const halfHeight = Math.max(layout.nodeHeight || 164, (viewport.height - 96) / pixelsPerRpx) / 2;
  const targetY = minY + (maxY - minY) * 0.65;
  const targetX = (minX + maxX) / 2;
  let best = null, bestScore = -1, bestDistance = Infinity;
  nodes.forEach(function (candidate) {
    const nearby = new Set();
    nodes.forEach(function (node) {
      if (Math.abs(node.x - candidate.x) <= halfWidth && Math.abs(node.y - candidate.y) <= halfHeight) nearby.add(node._id);
    });
    const connections = edges.reduce(function (count, edge) {
      return count + (nearby.has(edge.fromPersonId) && nearby.has(edge.toPersonId) ? 1 : 0);
    }, 0);
    const score = nearby.size + connections * 0.5;
    const distance = Math.abs(candidate.y - targetY) / Math.max(1, maxY - minY)
      + Math.abs(candidate.x - targetX) / Math.max(1, maxX - minX) * 0.25;
    if (score > bestScore || (score === bestScore && (distance < bestDistance
      || (distance === bestDistance && String(candidate._id) < String(best._id))))) {
      best = candidate; bestScore = score; bestDistance = distance;
    }
  });
  return best;
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

function resizeTransform(transform, previousViewport, nextViewport, options) {
  const optionsValue = options || {};
  const minimum = optionsValue.minimumScale || minimumScaleForViewport(nextViewport);
  const maximum = optionsValue.maximumScale || MAX_SCALE;
  const previousRpxToPx = previousViewport && Number(previousViewport.rpxToPx);
  const nextRpxToPx = nextViewport && Number(nextViewport.rpxToPx);
  const previousWidth = previousViewport && Number(previousViewport.width);
  const previousHeight = previousViewport && Number(previousViewport.height);
  const nextWidth = nextViewport && Number(nextViewport.width);
  const nextHeight = nextViewport && Number(nextViewport.height);
  const currentScale = transform && Number(transform.scale);
  if (!previousRpxToPx || !nextRpxToPx || !previousWidth || !previousHeight || !nextWidth || !nextHeight || !currentScale) {
    return {
      x: transform && Number(transform.x) || 0,
      y: transform && Number(transform.y) || 0,
      scale: clamp(currentScale || 1, minimum, maximum)
    };
  }
  const currentX = Number(transform.x) || 0;
  const currentY = Number(transform.y) || 0;
  const logicalCenterX = (previousWidth / 2 - currentX) / currentScale / previousRpxToPx;
  const logicalCenterY = (previousHeight / 2 - currentY) / currentScale / previousRpxToPx;
  const nextScale = clamp(currentScale * previousRpxToPx / nextRpxToPx, minimum, maximum);
  return {
    x: nextWidth / 2 - logicalCenterX * nextRpxToPx * nextScale,
    y: nextHeight / 2 - logicalCenterY * nextRpxToPx * nextScale,
    scale: nextScale
  };
}

module.exports = {
  MIN_SCALE: MIN_SCALE,
  MAX_SCALE: MAX_SCALE,
  fitTransform: fitTransform,
  initialTransform: initialTransform,
  minimumScaleForViewport: minimumScaleForViewport,
  resizeTransform: resizeTransform,
  zoomAroundCenter: zoomAroundCenter,
  zoomClassForScale: zoomClassForScale
};
