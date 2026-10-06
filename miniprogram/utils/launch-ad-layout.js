function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function fromWindow(info, capsule, ratio) {
  const windowInfo = info || {};
  const width = positive(windowInfo.windowWidth, 375);
  const height = positive(windowInfo.windowHeight, 667);
  const statusHeight = Math.max(0, Number(windowInfo.statusBarHeight) || 0);
  const top = capsule && positive(capsule.bottom, 0) ? capsule.bottom + 8 : statusHeight + 44;
  const safeTop = Math.min(top, height / 3);
  const screenHeight = positive(windowInfo.screenHeight, height);
  const bottom = windowInfo.safeArea && Number(windowInfo.safeArea.bottom);
  const safeBottom = Number.isFinite(bottom) ? Math.max(0, Math.min(screenHeight - bottom, height / 4)) : 0;
  // Two 88rpx buttons, a 16rpx gap and 20rpx padding on each side.
  const actionsHeight = 232 * width / 750 + safeBottom;
  const contentHeight = Math.max(1, height - safeTop - actionsHeight);
  return { windowWidth: width, windowHeight: height, safeTop: safeTop, safeBottom: safeBottom,
    contentHeight: contentHeight, templateWidth: fitWidth(width, contentHeight, ratio) };
}

function fitWidth(width, height, ratio) {
  return Math.max(1, Math.floor(ratio > 0 && Number.isFinite(ratio) ? Math.min(width, height / ratio) : width));
}

module.exports = { fromWindow: fromWindow, fitWidth: fitWidth };
