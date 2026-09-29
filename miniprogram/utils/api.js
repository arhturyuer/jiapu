const environmentConfig = require('../config/env');
const userMessage = require('./user-message');
const CLOUD_CALL_TIMEOUT = 8000;
const MEDIA_URL_TTL = 10 * 60 * 1000;
let mediaUrlCache = {};
let mediaUrlRequests = {};
let mediaCacheVersion = 0;

function mediaActorKey() {
  if (typeof getApp !== 'function') return '';
  const app = getApp();
  return app && app.globalData && app.globalData.user ? app.globalData.user._id || '' : '';
}

function clearMediaUrlCache() {
  mediaCacheVersion += 1;
  mediaUrlCache = {};
  mediaUrlRequests = {};
}

function currentEnvironment() {
  return environmentConfig.resolveRuntimeEnvironment(typeof wx === 'undefined' ? null : wx).environment;
}

function requestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function normalizeCloudError(error) {
  if (error instanceof Error) {
    if (!error.code) error.code = 'CLOUD_CALL_FAILED';
    return error;
  }
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
        error.requestId = payload.requestId;
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
        const normalized = normalizeCloudError(error);
        normalized.requestId = normalized.requestId || payload.requestId;
        finish(reject, normalized);
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
        error.requestId = result.requestId || payload.requestId;
        error.isBusinessError = true;
        finish(reject, error);
      }).catch(function (error) {
        const normalized = normalizeCloudError(error);
        normalized.requestId = normalized.requestId || payload.requestId;
        finish(reject, normalized);
      });
    }).catch(function (error) {
      if (!error.isBusinessError && retriesLeft > 0) {
        return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(function () {
          return invoke(retriesLeft - 1);
        });
      }
      if (['NO_FAMILY_ACCESS', 'NO_PERMISSION', 'UNAUTHENTICATED', 'ACCOUNT_FROZEN', 'ACCOUNT_UNAVAILABLE'].indexOf(error.code) >= 0 && typeof getApp === 'function') {
        const app = getApp();
        if (app && typeof app.clearCachedAccess === 'function') {
          if (error.code === 'NO_FAMILY_ACCESS') app.clearCachedAccess(payload.familyId || '');
          else if (error.code === 'NO_PERMISSION' && typeof app.invalidateFamilyData === 'function') {
            clearMediaUrlCache();
            const family = app.globalData && app.globalData.currentFamily;
            if (payload.personId && typeof app.invalidateCache === 'function') app.invalidateCache({ personDetail: payload.personId });
            if (payload.familyId || family) app.invalidateFamilyData(payload.familyId || family._id);
          }
          else if (error.code !== 'NO_PERMISSION') app.clearCachedAccess('');
        }
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
  const actor = mediaActorKey();
  const requestVersion = mediaCacheVersion;
  const urls = {};
  const missing = [];
  const waiting = [];
  ids.forEach(function (id) {
    const key = actor + ':' + id;
    const cached = mediaUrlCache[key];
    if (cached && Date.now() - cached.updatedAt < MEDIA_URL_TTL) urls[id] = cached.url;
    else if (mediaUrlRequests[key]) waiting.push(mediaUrlRequests[key]);
    else missing.push(id);
  });
  const batches = [];
  for (let index = 0; index < missing.length; index += 50) batches.push(missing.slice(index, index + 50));
  batches.forEach(function (batch) {
    const version = mediaCacheVersion;
    const request = call('media.getUrls', { assetIds: batch }).then(function (data) {
      if (version === mediaCacheVersion) {
        Object.keys(data.urls || {}).forEach(function (id) {
          mediaUrlCache[actor + ':' + id] = { url: data.urls[id], updatedAt: Date.now() };
        });
      }
      return data.urls || {};
    });
    batch.forEach(function (id) {
      const key = actor + ':' + id;
      mediaUrlRequests[key] = request;
    });
    waiting.push(request.then(function (result) {
      batch.forEach(function (id) { if (mediaUrlRequests[actor + ':' + id] === request) delete mediaUrlRequests[actor + ':' + id]; });
      return result;
    }, function (error) {
      batch.forEach(function (id) { if (mediaUrlRequests[actor + ':' + id] === request) delete mediaUrlRequests[actor + ':' + id]; });
      throw error;
    }));
  });
  return Promise.all(waiting).then(function (results) {
    if (requestVersion !== mediaCacheVersion) return {};
    results.forEach(function (result) { Object.assign(urls, result); });
    return urls;
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
  clearMediaUrlCache: clearMediaUrlCache,
  requestId: requestId,
  userError: userMessage.fromError,
  userMessage: userMessage.message,
  lastProblemId: userMessage.lastProblemId
};
