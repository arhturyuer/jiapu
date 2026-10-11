const deviceLayout = require('./device-layout');

function apiFrom(api) { return api || (typeof wx !== 'undefined' ? wx : {}); }

function supports(name, api) {
  const platform = apiFrom(api);
  if (typeof platform[name] !== 'function') return false;
  try { return !platform.canIUse || platform.canIUse(name); } catch (error) { return false; }
}

function canSaveToDisk(api) {
  return deviceLayout.read(api).desktop && supports('saveFileToDisk', api);
}

function canGuide(api) {
  const platform = apiFrom(api);
  if (deviceLayout.read(platform).largeDevice || !platform.getMenuButtonBoundingClientRect) return false;
  try {
    const menu = platform.getMenuButtonBoundingClientRect();
    return Boolean(menu && menu.width > 0 && menu.height > 0 && menu.right > menu.left);
  } catch (error) { return false; }
}

function chooseImage(api) {
  const platform = apiFrom(api);
  const desktop = deviceLayout.read(platform).desktop;
  const media = function () { return platform.chooseMedia({ count: 1, mediaType: ['image'], sourceType: desktop ? ['album'] : ['album', 'camera'] }); };
  const image = function () { return platform.chooseImage({ count: 1, sourceType: desktop ? ['album'] : ['album', 'camera'] }).then(function (result) {
    const files = result.tempFiles || [];
    return { tempFiles: files.map(function (file) { return { tempFilePath: file.path || file.tempFilePath, size: file.size || 0 }; }) };
  }); };
  if (desktop && supports('chooseImage', platform)) return image();
  if (supports('chooseMedia', platform)) return media();
  if (supports('chooseImage', platform)) return image();
  return Promise.reject(new Error('当前微信不支持选择照片，请在手机微信继续'));
}

module.exports = { supports: supports, canSaveToDisk: canSaveToDisk, canGuide: canGuide, chooseImage: chooseImage };
