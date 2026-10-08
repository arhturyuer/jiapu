function createImageProcessor(load = require) {
  let sharp;
  try { sharp = load('sharp'); }
  catch (error) {
    throw Object.assign(new Error('照片处理服务暂不可用，请稍后重试'), { code: 'PDF_AVATAR_RUNTIME_UNAVAILABLE' });
  }
  return async bytes => sharp(bytes, { limitInputPixels: 40000000 }).rotate()
    .resize(360, 360, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#FFFFFF' }).jpeg({ quality: 88 }).toBuffer();
}
module.exports = { createImageProcessor };
