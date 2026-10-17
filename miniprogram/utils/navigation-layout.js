function positive(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function layout(info, capsule, options) {
  const window = info || {};
  const settings = options || {};
  const width = positive(window.windowWidth, 375);
  const safe = window.safeArea || {};
  const status = Number.isFinite(window.statusBarHeight) && window.statusBarHeight >= 0
    ? window.statusBarHeight : Math.max(0, Number(safe.top) || 20);
  const valid = capsule && [capsule.left, capsule.right, capsule.top, capsule.bottom, capsule.width, capsule.height].every(Number.isFinite)
    && capsule.left > 0 && capsule.right <= width && capsule.right > capsule.left
    && capsule.width > 0 && capsule.height >= 20 && capsule.height <= 64
    && capsule.top >= status && capsule.top < status + 100 && capsule.bottom > capsule.top;
  const fontSize = positive(settings.bodySize, 16) * 17 / 16;
  const target = settings.elderMode ? 60 : 44;
  const rowHeight = Math.ceil(Math.max(target, fontSize * 1.4 + 16,
    valid ? capsule.bottom - status + Math.max(4, capsule.top - status) : 44));
  const gutter = settings.pageGutter ? (width >= 600 ? 16 : width * 32 / 750) : 12;
  const left = Math.max(gutter, Number(safe.left) + gutter || gutter);
  const safeRight = Number.isFinite(safe.right) && safe.right <= width ? Math.max(gutter, width - safe.right + gutter) : gutter;
  const right = valid ? Math.max(safeRight, width - capsule.left + 8) : Math.max(safeRight, 108);
  const titleLeft = left + (settings.back ? target + 4 : 0);
  return { height: status + rowHeight, status: status, rowHeight: rowHeight, fontSize: fontSize,
    left: left, right: right, titleLeft: titleLeft, titleWidth: Math.max(0, width - titleLeft - right), target: target };
}

module.exports = { layout: layout };
