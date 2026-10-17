function positive(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function layout(viewport, options) {
  const settings = options || {};
  const count = settings.largeDevice ? 5 : 6;
  const target = settings.elderMode ? 60 : 44;
  const font = positive(settings.bodySize, settings.elderMode ? 20 : 16) * (settings.elderMode ? 0.9 : 0.875);
  const labels = settings.labels || [];
  const width = Math.ceil(Math.max(target, font * 2 + 16, ...labels.map(item => positive(item.width, 0) + 16)));
  const height = Math.ceil(Math.max(target, font * 1.5 + 16, ...labels.map(item => positive(item.height, 0) + 16)));
  const left = 12 + Math.max(0, Number(settings.safeLeft) || 0);
  const right = 12 + Math.max(0, Number(settings.safeRight) || 0);
  const availableWidth = Math.max(1, positive(viewport.width, 375) - left - right);
  const availableHeight = Math.max(1, positive(viewport.height, 500) - 24);
  const horizontal = settings.landscape && !settings.largeDevice;
  const limit = Math.max(1, Math.min(horizontal ? count : 3, Math.floor((availableWidth + 6) / (width + 6))));
  let columns = horizontal ? limit : 1;
  function rowsHeight() { return Math.ceil(count / columns) * (height + 6) - 6; }
  while (!horizontal && columns < limit && rowsHeight() > availableHeight) columns++;
  const groupWidth = columns * (width + 6) - 6;
  const groupHeight = Math.min(rowsHeight(), availableHeight);
  const helpWidth = Math.max(0, availableWidth - groupWidth - 8);
  return { columns: columns, width: groupWidth, height: groupHeight, scroll: rowsHeight() > availableHeight,
    style: '--graph-tools-columns:' + columns + ';--graph-tool-width:' + width + 'px;--graph-tool-height:' + height
      + 'px;--graph-tools-width:' + groupWidth + 'px;--graph-tools-height:' + groupHeight + 'px;--graph-tools-right:' + right + 'px;',
    helpStyle: 'left:' + left + 'px;max-width:' + helpWidth + 'px;' + (helpWidth < 100 ? 'display:none;' : '') };
}

module.exports = { layout: layout };
