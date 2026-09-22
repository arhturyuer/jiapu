const TARGET_SCALE = 1.25;
const MIN_SCALE = 0.75;
const MAX_SIDE = 8192;
const MAX_PIXELS = 32000000;
const PAGE_PADDING = 64;
const TITLE_FONT_SIZE = 88;
const PERSON_NAME_FONT_SIZE = 28;
const HEADER_HEIGHT = 260;
const FOOTER_HEIGHT = 0;

function posterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function calculateSize(layout, options) {
  const config = options || {};
  const graphWidth = Math.max(750, Number(layout && layout.width) || 0);
  const graphHeight = Math.max(900, Number(layout && layout.height) || 0);
  const logicalWidth = graphWidth + PAGE_PADDING * 2;
  const logicalHeight = HEADER_HEIGHT + graphHeight + FOOTER_HEIGHT + PAGE_PADDING;
  const target = Math.max(MIN_SCALE, Number(config.targetScale) || TARGET_SCALE);
  const scale = Math.min(
    target,
    MAX_SIDE / logicalWidth,
    MAX_SIDE / logicalHeight,
    Math.sqrt(MAX_PIXELS / (logicalWidth * logicalHeight))
  );
  if (!Number.isFinite(scale) || scale < MIN_SCALE) {
    throw posterError('POSTER_TOO_LARGE', '当前展开内容过多，请先收起部分分支');
  }
  return {
    graphWidth: graphWidth,
    graphHeight: graphHeight,
    logicalWidth: logicalWidth,
    logicalHeight: logicalHeight,
    width: Math.max(1, Math.floor(logicalWidth * scale)),
    height: Math.max(1, Math.floor(logicalHeight * scale)),
    scale: scale,
    graphX: PAGE_PADDING,
    graphY: HEADER_HEIGHT
  };
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function truncate(ctx, value, maxWidth) {
  const text = String(value || '');
  if (!maxWidth || ctx.measureText(text).width <= maxWidth) return text;
  let output = text;
  while (output && ctx.measureText(output + '…').width > maxWidth) output = output.slice(0, -1);
  return output + '…';
}

function centerText(ctx, value, x, y, maxWidth) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncate(ctx, value, maxWidth), x, y);
}

function genderColors(node, showGenderColors) {
  if (!showGenderColors) return { surface: '#FFFEFA', border: '#D8DED9', avatar: '#E4EFEA', text: '#245C4A', badge: '#65706A' };
  if (node.gender === 'male') return { surface: '#E6EFF5', border: '#416B89', avatar: '#E6EFF5', text: '#416B89', badge: '#416B89' };
  if (node.gender === 'female') return { surface: '#F5E7EB', border: '#985565', avatar: '#F5E7EB', text: '#985565', badge: '#985565' };
  return { surface: '#FFFEFA', border: '#D8DED9', avatar: '#E4EFEA', text: '#245C4A', badge: '#65706A' };
}

function drawLines(ctx, layout, sizing) {
  ctx.lineCap = 'round';
  (layout.lines || []).filter(function (line) { return !line.isFlow; }).forEach(function (line) {
    ctx.beginPath();
    ctx.moveTo(sizing.graphX + line.x1, sizing.graphY + line.y1);
    ctx.lineTo(sizing.graphX + line.x2, sizing.graphY + line.y2);
    ctx.strokeStyle = line.lineRole === 'spouse' ? '#829D91' : line.lineRole === 'rail' ? '#BEC9C3' : '#A6B7AE';
    ctx.lineWidth = line.lineRole === 'spouse' ? 5 : line.lineRole === 'rail' ? 3 : 4;
    ctx.stroke();
  });
  (layout.junctions || []).forEach(function (junction) {
    ctx.beginPath();
    ctx.arc(sizing.graphX + junction.x, sizing.graphY + junction.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#829D91';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#F7F4EC';
    ctx.stroke();
  });
}

function drawAvatar(ctx, image, x, y, size, colors, initial) {
  roundedRect(ctx, x, y, size, size, 18);
  ctx.fillStyle = colors.avatar;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = colors.border;
  ctx.stroke();
  if (image) {
    ctx.save();
    roundedRect(ctx, x, y, size, size, 18);
    ctx.clip();
    const naturalWidth = Number(image.width) || size;
    const naturalHeight = Number(image.height) || size;
    const ratio = Math.max(size / naturalWidth, size / naturalHeight);
    const width = naturalWidth * ratio;
    const height = naturalHeight * ratio;
    ctx.drawImage(image, x + (size - width) / 2, y + (size - height) / 2, width, height);
    ctx.restore();
    return;
  }
  ctx.fillStyle = colors.text;
  ctx.font = '600 26px sans-serif';
  centerText(ctx, initial || '家', x + size / 2, y + size / 2 + 1, size - 8);
}

function drawBadge(ctx, value, x, y, background, foreground, options) {
  const config = options || {};
  ctx.font = (config.font || 'bold 20px sans-serif');
  const width = Math.max(config.minimumWidth || 38, ctx.measureText(value).width + (config.padding || 18));
  const height = config.height || 34;
  roundedRect(ctx, x, y, width, height, height / 2);
  ctx.fillStyle = background;
  ctx.fill();
  if (config.border) {
    ctx.lineWidth = config.borderWidth || 3;
    ctx.strokeStyle = config.border;
    ctx.stroke();
  }
  ctx.fillStyle = foreground;
  centerText(ctx, value, x + width / 2, y + height / 2 + 1, width - 8);
  return width;
}

function drawNode(ctx, layout, node, sizing, images, options) {
  const width = layout.nodeWidth || 168;
  const height = layout.nodeHeight || 164;
  const x = sizing.graphX + node.x;
  const y = sizing.graphY + node.y;
  const colors = genderColors(node, options.showGenderColors);
  roundedRect(ctx, x, y, width, height, 24);
  ctx.fillStyle = colors.surface;
  ctx.fill();
  ctx.lineWidth = node.isViewpoint ? 5 : 2;
  ctx.strokeStyle = node.isViewpoint ? '#245C4A' : colors.border;
  ctx.stroke();

  if (options.showGenderBadge) {
    drawBadge(ctx, node.genderText || '未填', x - 12, y - 15, colors.badge, '#FFFFFF', {
      minimumWidth: 44, height: 34, padding: 20, border: '#F7F4EC'
    });
  }
  if (node.lifeStatus === 'deceased') {
    const textWidth = 38;
    drawBadge(ctx, '故', x + width - textWidth + 12, y - 15, '#EEF0ED', '#53655C', {
      minimumWidth: textWidth, height: 34, padding: 18, border: '#F7F4EC'
    });
  }

  if (layout.nameLayout === 'vertical') {
    const lines = String(node.verticalName || node.name || '未命名').split('\n').slice(0, 5);
    ctx.font = '600 27px sans-serif';
    ctx.fillStyle = '#202824';
    const lineHeight = 31;
    const total = lines.length * lineHeight;
    lines.forEach(function (line, index) {
      centerText(ctx, line, x + width / 2, y + Math.max(26, (height - total) / 2) + index * lineHeight + lineHeight / 2, width - 22);
    });
    if (options.viewMode === 'perspective' && node.relationLabel) {
      ctx.font = '400 18px sans-serif';
      ctx.fillStyle = '#65706A';
      centerText(ctx, node.relationLabel, x + width / 2, y + height - 17, width - 12);
    }
  } else {
    const avatarSize = 52;
    const avatarX = x + (width - avatarSize) / 2;
    drawAvatar(ctx, images[node._id], avatarX, y + 14, avatarSize, colors, node.initial || String(node.name || '家').slice(0, 1));
    ctx.fillStyle = '#202824';
    ctx.font = '600 ' + PERSON_NAME_FONT_SIZE + 'px sans-serif';
    centerText(ctx, node.name || '未命名', x + width / 2, y + 89, width - 24);
    const meta = options.viewMode === 'perspective' && node.relationLabel ? node.relationLabel : node.metaText || '';
    if (meta) {
      ctx.fillStyle = '#65706A';
      ctx.font = '400 22px sans-serif';
      centerText(ctx, meta, x + width / 2, y + 121, width - 24);
    }
    if (options.viewMode === 'perspective' && node.hasMultipleKinships) {
      ctx.fillStyle = '#765E3A';
      ctx.font = '500 18px sans-serif';
      centerText(ctx, '多重关系', x + width / 2, y + height - 13, width - 24);
    }
  }

  if (options.showChildRankBadge && node.childRankLabel) {
    drawBadge(ctx, node.childRankLabel, x - 12, y + height - 16, '#FFF0CA', '#704A16', {
      minimumWidth: 66, height: 36, padding: 24, border: '#F7F4EC'
    });
  }
  if (Number(node.hiddenDescendantCount || 0) > 0) {
    const label = '+' + node.hiddenDescendantCount + ' 人';
    ctx.font = '600 20px sans-serif';
    const badgeWidth = Math.max(72, ctx.measureText(label).width + 24);
    drawBadge(ctx, label, x + width - badgeWidth + 18, y + height - 16, '#245C4A', '#FFFEFA', {
      minimumWidth: badgeWidth, height: 38, padding: 24, border: '#F7F4EC', borderWidth: 4
    });
  }
}

function drawHeader(ctx, sizing, miniCodeImage, options) {
  const qrSize = 150;
  const qrX = sizing.logicalWidth - PAGE_PADDING - qrSize;
  const qrY = 34;
  const copyRight = qrX - 24;
  const copyWidth = 220;
  const titleMaxWidth = Math.max(240, copyRight - copyWidth - PAGE_PADDING - 28);

  ctx.fillStyle = '#202824';
  ctx.font = 'bold ' + TITLE_FONT_SIZE + 'px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(truncate(ctx, options.familyName || '我的家谱', titleMaxWidth), PAGE_PADDING, 120);
  ctx.fillStyle = '#65706A';
  ctx.font = '400 32px sans-serif';
  ctx.fillText(truncate(ctx, options.viewLabel || '当前视图：完整家谱', titleMaxWidth), PAGE_PADDING, 184);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#245C4A';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText('由有谱家谱生成', copyRight, 96);
  ctx.fillStyle = '#202824';
  ctx.font = '500 23px sans-serif';
  ctx.fillText('扫码查看详情', copyRight, 138);
  if (miniCodeImage) ctx.drawImage(miniCodeImage, qrX, qrY, qrSize, qrSize);

  ctx.strokeStyle = '#D8DED9';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAGE_PADDING, 222);
  ctx.lineTo(sizing.logicalWidth - PAGE_PADDING, 222);
  ctx.stroke();
}

function draw(ctx, layout, sizing, images, miniCodeImage, options) {
  ctx.fillStyle = '#F7F4EC';
  ctx.fillRect(0, 0, sizing.logicalWidth, sizing.logicalHeight);
  drawHeader(ctx, sizing, miniCodeImage, options);
  drawLines(ctx, layout, sizing);
  (layout.nodes || []).forEach(function (node) {
    drawNode(ctx, layout, node, sizing, images, options);
  });
}

function loadImage(canvas, source) {
  if (!canvas || !source || typeof canvas.createImage !== 'function') return Promise.resolve(null);
  return new Promise(function (resolve) {
    const image = canvas.createImage();
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 5000);
    image.onload = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    };
    image.src = source;
  });
}

function loadNodeImages(canvas, nodes) {
  const pending = (nodes || []).filter(function (node) { return Boolean(node.avatar); });
  const images = {};
  let cursor = 0;
  function worker() {
    const node = pending[cursor];
    cursor += 1;
    if (!node) return Promise.resolve();
    return loadImage(canvas, node.avatar).then(function (image) {
      if (image) images[node._id] = image;
      return worker();
    });
  }
  const workers = [];
  for (let index = 0; index < Math.min(6, pending.length); index += 1) workers.push(worker());
  return Promise.all(workers).then(function () { return images; });
}

function canvasNode(page, canvasId) {
  return new Promise(function (resolve, reject) {
    wx.createSelectorQuery().in(page).select('#' + canvasId).fields({ node: true, size: true }).exec(function (result) {
      const canvas = result && result[0] && result[0].node;
      if (!canvas) reject(posterError('POSTER_CANVAS_UNAVAILABLE', '图片暂时无法生成，请重试'));
      else resolve(canvas);
    });
  });
}

function exportCanvas(page, canvas, sizing) {
  return new Promise(function (resolve, reject) {
    wx.canvasToTempFilePath({
      canvas: canvas,
      fileType: 'png',
      quality: 1,
      destWidth: sizing.width,
      destHeight: sizing.height,
      success: function (result) { resolve(result.tempFilePath); },
      fail: function (source) {
        const error = posterError('POSTER_EXPORT_FAILED', '图片生成失败，请稍后重试');
        error.errMsg = source && source.errMsg || '';
        reject(error);
      }
    }, page);
  });
}

function renderOnce(page, canvasId, layout, options, targetScale) {
  const sizing = calculateSize(layout, { targetScale: targetScale });
  return canvasNode(page, canvasId).then(function (canvas) {
    canvas.width = sizing.width;
    canvas.height = sizing.height;
    const context = canvas.getContext('2d');
    if (!context) throw posterError('POSTER_CANVAS_UNAVAILABLE', '图片暂时无法生成，请重试');
    return Promise.all([
      loadNodeImages(canvas, layout.nodes),
      loadImage(canvas, options.miniCodePath)
    ]).then(function (assets) {
      context.save();
      context.scale(sizing.scale, sizing.scale);
      draw(context, layout, sizing, assets[0], assets[1], options);
      context.restore();
      return exportCanvas(page, canvas, sizing).then(function (filePath) {
        return { filePath: filePath, width: sizing.width, height: sizing.height, scale: sizing.scale };
      });
    });
  });
}

function render(page, canvasId, layout, options) {
  let initial;
  try {
    initial = calculateSize(layout);
  } catch (error) {
    return Promise.reject(error);
  }
  return renderOnce(page, canvasId, layout, options || {}, initial.scale).catch(function (error) {
    if (error.code === 'POSTER_TOO_LARGE' || initial.scale <= MIN_SCALE) throw error;
    const retryScale = Math.max(MIN_SCALE, Math.min(initial.scale * 0.78, 1));
    return renderOnce(page, canvasId, layout, options || {}, retryScale);
  });
}

module.exports = {
  TARGET_SCALE: TARGET_SCALE,
  MIN_SCALE: MIN_SCALE,
  MAX_SIDE: MAX_SIDE,
  MAX_PIXELS: MAX_PIXELS,
  TITLE_FONT_SIZE: TITLE_FONT_SIZE,
  PERSON_NAME_FONT_SIZE: PERSON_NAME_FONT_SIZE,
  calculateSize: calculateSize,
  draw: draw,
  render: render
};
