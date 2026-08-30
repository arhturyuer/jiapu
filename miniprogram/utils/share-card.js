const FALLBACK_IMAGE = '/images/share/brand-fallback.jpg';
const CANVAS_WIDTH = 750;
const CANVAS_HEIGHT = 600;
const CARD_RENDER_VERSION = 'share-card-v3';
const CARD_BUTTON = { x: 76, y: 430, width: 440, height: 90, radius: 24 };

function text(value, limit) {
  const valueText = String(value || '').replace(/[\r\n\t]/g, ' ').trim();
  if (!limit || valueText.length <= limit) return valueText;
  return valueText.slice(0, Math.max(1, limit - 1)) + '…';
}

function titleFor(options) {
  const kind = options.kind || 'discovery';
  const familyName = text(options.familyName || '我的家谱', 18);
  const personName = text(options.personName, 12);
  const count = Math.max(0, Number(options.personCount) || 0);
  const member = options.role === 'member';
  if (kind === 'family_perspective') {
    return '从' + (personName || '一位家人') + '看' + familyName + '｜' + (member ? '一起完善家谱' : '查看家人关系');
  }
  if (kind === 'family_full') return familyName + '｜已有' + count + '位家人，' + (member ? '邀你一起完善' : '邀你查看');
  if (kind === 'example') return text(options.customTitle, 36) || text(options.exampleName || '有谱示例', 18) + '｜看看一份家谱如何串起家人';
  return '有谱｜从一个人开始，把一家人连起来';
}

function detailsFor(options) {
  const kind = options.kind || 'discovery';
  const count = Math.max(0, Number(options.personCount) || 0);
  if (kind === 'family_perspective') {
    return {
      eyebrow: '有谱 · 成员视角邀请',
      heading: '从' + text(options.personName || '一位家人', 12) + '认识这一家人',
      meta: text(options.inviterName || '一位家人', 16) + ' 邀请你 · ' + count + ' 位家人',
      cta: options.role === 'member' ? '打开家谱，一起完善' : '打开家谱，查看关系'
    };
  }
  if (kind === 'family_full') {
    return {
      eyebrow: '有谱 · 家庭邀请',
      heading: text(options.familyName || '我的家谱', 30),
      meta: text(options.inviterName || '一位家人', 16) + ' 邀请你 · 已有 ' + count + ' 位家人',
      cta: options.role === 'member' ? '打开家谱，一起完善' : '打开家谱，查看关系'
    };
  }
  if (kind === 'example') {
    return {
      eyebrow: '有谱 · 官方虚构示例',
      heading: text(options.exampleName || '示例家谱', 24),
      meta: '从一张关系图，看见一家人的故事',
      cta: '打开示例，体验家谱'
    };
  }
  return {
    eyebrow: '有谱 · 家庭图谱',
    heading: '从一个人开始',
    meta: '把一家人连起来，慢慢补成一份家谱',
    cta: '创建我的家谱'
  };
}

function create(options) {
  const input = Object.assign({ kind: 'discovery' }, options || {});
  const card = {
    kind: input.kind,
    title: titleFor(input),
    path: input.path || '/pages/create-family/index?source=share_menu',
    imageUrl: FALLBACK_IMAGE,
    visual: detailsFor(input)
  };
  return card;
}

function fingerprint(options) {
  const input = options || {};
  return [
    CARD_RENDER_VERSION, input.kind || '', input.familyName || '', input.personCount || 0,
    input.role || '', input.personName || '', input.inviterName || ''
  ].map(function (value) { return String(value); }).join('|');
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

function drawNetwork(ctx, kind) {
  const nodes = kind === 'family_perspective'
    ? [[540, 238, 32, true], [438, 148, 25], [646, 160, 25], [434, 342, 23], [632, 354, 23], [700, 262, 18]]
    : [[570, 192, 30, true], [458, 278, 24], [662, 280, 24], [514, 388, 22], [626, 392, 22], [718, 396, 16]];
  const links = kind === 'family_perspective'
    ? [[0, 1], [0, 2], [0, 3], [0, 4], [2, 5]]
    : [[0, 1], [0, 2], [1, 3], [2, 4], [2, 5]];
  ctx.strokeStyle = kind === 'family_perspective' ? '#6C9677' : '#9DB59E';
  ctx.lineWidth = kind === 'family_perspective' ? 8 : 6;
  links.forEach(function (link) {
    const start = nodes[link[0]];
    const end = nodes[link[1]];
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.quadraticCurveTo((start[0] + end[0]) / 2, start[1] + 18, end[0], end[1]);
    ctx.stroke();
  });
  nodes.forEach(function (node) {
    if (node[3] && kind === 'family_perspective') {
      ctx.beginPath();
      ctx.fillStyle = '#E7C9A9';
      ctx.arc(node[0], node[1], node[2] + 15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.fillStyle = node[3] ? '#245C4A' : '#E4EFEA';
    ctx.arc(node[0], node[1], node[2], 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = node[3] ? 10 : 6;
    ctx.strokeStyle = '#FFFEFA';
    ctx.stroke();
  });
}

function truncateToWidth(ctx, value, maxWidth) {
  const suffix = '…';
  let output = value;
  while (output && ctx.measureText(output + suffix).width > maxWidth) output = output.slice(0, -1);
  return output ? output + suffix : suffix;
}

function drawText(ctx, value, x, y, maxWidth, font, color, options) {
  const settings = options || {};
  const maxLines = settings.maxLines || Infinity;
  const lineHeight = settings.lineHeight || parseInt(font, 10) + 12;
  ctx.font = font;
  ctx.fillStyle = color;
  const chars = String(value || '').split('');
  const lines = [];
  let line = '';
  chars.forEach(function (character) {
    const next = line + character;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = character;
    } else line = next;
  });
  if (line) lines.push(line);
  const visibleLines = lines.slice(0, maxLines);
  if (lines.length > maxLines && visibleLines.length) {
    visibleLines[visibleLines.length - 1] = truncateToWidth(ctx, visibleLines[visibleLines.length - 1], maxWidth);
  }
  visibleLines.forEach(function (item, index) { ctx.fillText(item, x, y + index * lineHeight); });
  return { lines: visibleLines.length, bottom: y + Math.max(0, visibleLines.length - 1) * lineHeight };
}

function drawButtonText(ctx, value, centerX, centerY, maxWidth) {
  const sizes = [27, 25, 23, 21];
  let label = text(value, 20);
  const previousAlign = ctx.textAlign;
  const previousBaseline = ctx.textBaseline;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let index = 0; index < sizes.length; index += 1) {
    ctx.font = '500 ' + sizes[index] + 'px sans-serif';
    if (ctx.measureText(label).width <= maxWidth) {
      ctx.fillText(label, centerX, centerY);
      ctx.textAlign = previousAlign || 'start';
      ctx.textBaseline = previousBaseline || 'alphabetic';
      return;
    }
  }
  ctx.font = '500 19px sans-serif';
  label = truncateToWidth(ctx, label, maxWidth);
  ctx.fillText(label, centerX, centerY);
  ctx.textAlign = previousAlign || 'start';
  ctx.textBaseline = previousBaseline || 'alphabetic';
}

function draw(ctx, card) {
  const visual = card.visual;
  ctx.fillStyle = '#F7F4EC';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = '#E4EFEA';
  ctx.beginPath();
  ctx.arc(738, 82, 176, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#B95338';
  ctx.beginPath();
  ctx.arc(691, 95, 10, 0, Math.PI * 2);
  ctx.fill();
  roundedRect(ctx, 42, 42, 666, 516, 30);
  ctx.fillStyle = '#FFFEFA';
  ctx.fill();
  ctx.strokeStyle = '#D8DED9';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#245C4A';
  roundedRect(ctx, 74, 76, 72, 72, 20);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '600 34px sans-serif';
  ctx.fillText('谱', 94, 123);
  drawText(ctx, visual.eyebrow, 168, 112, 250, '500 22px sans-serif', '#65706A', { maxLines: 1 });
  const heading = drawText(ctx, visual.heading, 76, 205, 350, '600 44px sans-serif', '#202824', { maxLines: 2, lineHeight: 56 });
  drawText(ctx, visual.meta, 76, heading.bottom + 48, 344, '400 24px sans-serif', '#65706A', { maxLines: 2, lineHeight: 34 });
  drawNetwork(ctx, card.kind);
  ctx.fillStyle = '#245C4A';
  roundedRect(ctx, CARD_BUTTON.x, CARD_BUTTON.y, CARD_BUTTON.width, CARD_BUTTON.height, CARD_BUTTON.radius);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  drawButtonText(ctx, visual.cta,
    CARD_BUTTON.x + CARD_BUTTON.width / 2,
    CARD_BUTTON.y + CARD_BUTTON.height / 2,
    CARD_BUTTON.width - 56);
}

function render(page, canvasId, card) {
  if (!page || typeof wx === 'undefined' || !wx.createSelectorQuery) return Promise.resolve(FALLBACK_IMAGE);
  return new Promise(function (resolve) {
    const finish = function (imageUrl) { resolve(imageUrl || FALLBACK_IMAGE); };
    const run = function () {
      wx.createSelectorQuery().in(page).select('#' + canvasId).fields({ node: true, size: true }).exec(function (result) {
        const entry = result && result[0];
        const canvas = entry && entry.node;
        if (!canvas) return finish();
        try {
          canvas.width = CANVAS_WIDTH;
          canvas.height = CANVAS_HEIGHT;
          const context = canvas.getContext('2d');
          draw(context, card);
          wx.canvasToTempFilePath({
            canvas: canvas,
            fileType: 'png',
            quality: 1,
            destWidth: CANVAS_WIDTH,
            destHeight: CANVAS_HEIGHT,
            success: function (output) { finish(output.tempFilePath); },
            fail: function () { finish(); }
          }, page);
        } catch (error) {
          finish();
        }
      });
    };
    if (wx.nextTick) wx.nextTick(run); else setTimeout(run, 0);
  });
}

function createAndRender(page, canvasId, options) {
  const card = create(options);
  return render(page, canvasId, card).then(function (imageUrl) {
    card.imageUrl = imageUrl;
    return card;
  });
}

module.exports = {
  FALLBACK_IMAGE: FALLBACK_IMAGE,
  CARD_RENDER_VERSION: CARD_RENDER_VERSION,
  CARD_BUTTON: CARD_BUTTON,
  create: create,
  createAndRender: createAndRender,
  fingerprint: fingerprint,
  titleFor: titleFor,
  detailsFor: detailsFor,
  draw: draw
};
