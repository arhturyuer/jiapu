const environmentConfig = require('../config/env');
const activeEnvironment = environmentConfig.environments[environmentConfig.active];

function requestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function call(type, data) {
  const payload = Object.assign({}, data || {});
  if (type === 'change.review' && payload.requestId && !payload.changeRequestId) {
    payload.changeRequestId = payload.requestId;
  }
  payload.requestId = payload.idempotencyKey || requestId();
  delete payload.idempotencyKey;
  payload.type = type;

  function invoke(retriesLeft) {
    return new Promise(function (resolve, reject) {
    wx.cloud.callFunction({
      name: activeEnvironment.userApi,
      data: payload
    }).then(function (response) {
      const result = response.result || {};
      if (result.success) {
        resolve(result.data || {});
        return;
      }

      const error = new Error(result.message || result.errMsg || '请求失败');
      error.code = result.code || 'UNKNOWN_ERROR';
      error.details = result.details || null;
      error.isBusinessError = true;
      reject(error);
    }).catch(function (error) {
      if (!error.isBusinessError && retriesLeft > 0) {
        setTimeout(function () {
          invoke(retriesLeft - 1).then(resolve).catch(reject);
        }, 250);
        return;
      }
      reject(error);
    });
    });
  }

  return invoke(1);
}

function uploadImage(tempFilePath, folder, options) {
  const config = options || {};
  let prepared;
  let uploadPath = tempFilePath;
  let uploadSize = Number(config.size) || 0;
  const compress = wx.compressImage
    ? wx.compressImage({ src: tempFilePath, quality: 78 }).then(function (result) {
      uploadPath = result.tempFilePath || tempFilePath;
    }).catch(function () {})
    : Promise.resolve();
  return compress.then(function () {
    if (!wx.getFileInfo) return null;
    return wx.getFileInfo({ filePath: uploadPath }).then(function (info) {
      uploadSize = Number(info.size) || uploadSize;
    }).catch(function () {});
  }).then(function () {
    const extensionMatch = uploadPath.match(/\.([a-zA-Z0-9]+)$/);
    const extension = extensionMatch ? extensionMatch[1] : 'jpg';
    return call('media.prepare', {
      extension: extension,
      kind: config.kind || (folder === 'user-avatars' ? 'user_avatar' : 'person_avatar'),
      familyId: config.familyId || ''
    });
  }).then(function (result) {
    prepared = result;
    return wx.cloud.uploadFile({
      cloudPath: result.cloudPath,
      filePath: uploadPath
    });
  }).then(function (result) {
    return call('media.complete', {
      assetId: prepared.assetId,
      fileId: result.fileID,
      size: uploadSize
    });
  }).then(function (result) {
    return {
      assetId: result.assetId,
      moderationStatus: result.moderationStatus,
      ready: result.ready,
      previewUrl: tempFilePath
    };
  });
}

function getMediaUrls(assetIds) {
  const ids = Array.from(new Set((assetIds || []).filter(Boolean)));
  if (!ids.length) return Promise.resolve({});
  const batches = [];
  for (let index = 0; index < ids.length; index += 50) batches.push(ids.slice(index, index + 50));
  return Promise.all(batches.map(function (batch) {
    return call('media.getUrls', { assetIds: batch });
  })).then(function (results) {
    return results.reduce(function (urls, data) {
      return Object.assign(urls, data.urls || {});
    }, {});
  });
}

module.exports = {
  call: call,
  uploadImage: uploadImage,
  getMediaUrls: getMediaUrls,
  requestId: requestId
};
