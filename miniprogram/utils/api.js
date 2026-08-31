const environmentConfig = require('../config/env');
const CLOUD_CALL_TIMEOUT = 8000;

function currentEnvironment() {
  return environmentConfig.resolveRuntimeEnvironment(typeof wx === 'undefined' ? null : wx).environment;
}

function requestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function normalizeCloudError(error) {
  if (error instanceof Error) return error;
  const source = error || {};
  const message = source.message || source.errMsg || (typeof error === 'string' ? error : '') || '服务请求失败，请检查网络后重试';
  const normalized = new Error(message);
  normalized.code = source.code || 'CLOUD_CALL_FAILED';
  normalized.details = source.details || null;
  normalized.errMsg = source.errMsg || '';
  normalized.isBusinessError = Boolean(source.isBusinessError);
  return normalized;
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
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        const error = new Error('服务响应超时，请检查网络后重试');
        error.code = 'CLOUD_FUNCTION_TIMEOUT';
        reject(error);
      }, CLOUD_CALL_TIMEOUT);

      function finish(callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      }

      let cloudRequest;
      try {
        cloudRequest = wx.cloud.callFunction({
          name: currentEnvironment().userApi,
          data: payload
        });
      } catch (error) {
        finish(reject, normalizeCloudError(error));
        return;
      }
      Promise.resolve(cloudRequest).then(function (response) {
        const result = response.result || {};
        if (result.success) {
          finish(resolve, result.data || {});
          return;
        }

        const error = new Error(result.message || result.errMsg || '请求失败');
        error.code = result.code || 'UNKNOWN_ERROR';
        error.details = result.details || null;
        error.isBusinessError = true;
        finish(reject, error);
      }).catch(function (error) {
        finish(reject, normalizeCloudError(error));
      });
    }).catch(function (error) {
      if (!error.isBusinessError && retriesLeft > 0) {
        return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(function () {
          return invoke(retriesLeft - 1);
        });
      }
      throw error;
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

function getMediaStates(assetIds) {
  const ids = Array.from(new Set((assetIds || []).filter(Boolean))).slice(0, 50);
  if (!ids.length) return Promise.resolve({});
  return call('media.getStates', { assetIds: ids }).then(function (data) {
    return data.states || {};
  });
}

function getMediaPresentation(assetIds) {
  const ids = Array.from(new Set((assetIds || []).filter(Boolean))).slice(0, 50);
  if (!ids.length) return Promise.resolve({});
  return call('media.getPresentation', { assetIds: ids }).then(function (data) {
    return data.items || {};
  });
}

module.exports = {
  call: call,
  uploadImage: uploadImage,
  getMediaUrls: getMediaUrls,
  getMediaStates: getMediaStates,
  getMediaPresentation: getMediaPresentation,
  requestId: requestId
};
