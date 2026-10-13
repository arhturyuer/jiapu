const api = require('./api');
const STORAGE_KEY = 'youpu_profile_images_v1';
const QR_TTL = 12 * 60 * 60 * 1000;

function createCache(wxApi, client) {
  const requests = new Map();
  const versions = new Map();
  let epoch = 0;
  let serial = 0;
  function context(app) {
    return JSON.stringify([app.globalData.env || '', app.globalData.user && app.globalData.user._id || '', app._sessionVersion || 0]);
  }
  function key(app, kind, assetId) {
    return JSON.stringify([app.globalData.env || '', app.globalData.user && app.globalData.user._id || '', kind, assetId || '']);
  }
  function read() {
    try {
      const value = wxApi.getStorageSync(STORAGE_KEY);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) { return {}; }
  }
  function write(entries) {
    wxApi.setStorageSync(STORAGE_KEY, entries);
  }
  function owned(path) {
    const root = wxApi.env && wxApi.env.USER_DATA_PATH;
    return Boolean(root && path && path.indexOf(root + '/youpu-profile-image-') === 0 && path.indexOf('..') < 0);
  }
  function removeFile(path) {
    if (!owned(path)) return;
    try { wxApi.getFileSystemManager().unlinkSync(path); } catch (error) { /* already removed */ }
  }
  function discard(cacheKey) {
    versions.set(cacheKey, (versions.get(cacheKey) || 0) + 1);
    requests.delete(cacheKey);
    const entries = read();
    if (entries[cacheKey]) removeFile(entries[cacheKey].path);
    delete entries[cacheKey];
    try { write(entries); } catch (error) { /* storage unavailable */ }
  }
  function peek(app, kind, assetId) {
    const cacheKey = key(app, kind, assetId);
    const item = read()[cacheKey];
    if (!item) return null;
    const age = Date.now() - item.fetchedAt;
    if (!owned(item.path) || (kind === 'qr' && (!Number.isFinite(age) || age < 0 || age >= QR_TTL))) {
      discard(cacheKey);
      return null;
    }
    try { wxApi.getFileSystemManager().accessSync(item.path); }
    catch (error) { discard(cacheKey); return null; }
    return { url: item.path, status: 'approved', available: true, qrCodeUrl: item.path };
  }
  function persist(url) {
    return new Promise(function (resolve, reject) {
      const root = wxApi.env && wxApi.env.USER_DATA_PATH;
      if (!root || !wxApi.downloadFile) { reject(new Error('本地图片缓存不可用')); return; }
      const path = root + '/youpu-profile-image-' + Date.now() + '-' + (++serial) + '-' + Math.random().toString(36).slice(2, 10) + '.jpg';
      try {
        wxApi.downloadFile({ url: url, filePath: path, timeout: 30000,
          success: function (result) {
            if (result.statusCode !== 200) { removeFile(path); reject(new Error('图片下载失败')); return; }
            try { wxApi.getFileSystemManager().accessSync(path); resolve(path); }
            catch (error) { removeFile(path); reject(error); }
          },
          fail: function (error) { removeFile(path); reject(error); }
        });
      } catch (error) { removeFile(path); reject(error); }
    });
  }
  function get(app, kind, assetId, options) {
    const cacheKey = key(app, kind, assetId);
    if (options && options.force) discard(cacheKey);
    const hit = peek(app, kind, assetId);
    if (hit) return Promise.resolve(hit);
    if (requests.has(cacheKey)) return requests.get(cacheKey);
    const token = context(app), startedEpoch = epoch, version = versions.get(cacheKey) || 0;
    function current() {
      return token === context(app) && epoch === startedEpoch && version === (versions.get(cacheKey) || 0) &&
        (kind !== 'avatar' || (app.globalData.user && app.globalData.user.avatarAssetId || '') === assetId);
    }
    function assertCurrent() {
      if (!current()) throw Object.assign(new Error('账户或图片已变化，请重新加载'), { code: 'IMAGE_CACHE_CHANGED' });
    }
    const request = Promise.resolve().then(function () {
      return kind === 'qr' ? client.call('feedbackGroup.get') : client.getMediaPresentation([assetId]).then(function (items) {
        return items[assetId] || { status: 'pending', url: '' };
      });
    }).then(function (data) {
      assertCurrent();
      const url = kind === 'qr' ? (data.available && data.qrCodeUrl || '') : (data.status === 'approved' && data.url || '');
      if (!url) return data;
      const fetchedAt = Date.now();
      return persist(url).then(function (path) {
        if (!current()) { removeFile(path); assertCurrent(); }
        const entries = read();
        const old = entries[cacheKey];
        entries[cacheKey] = { path: path, fetchedAt: fetchedAt };
        try { write(entries); }
        catch (error) { removeFile(path); return data; }
        if (old && old.path !== path) removeFile(old.path);
        return kind === 'qr' ? { available: true, qrCodeUrl: path } : { status: 'approved', url: path };
      }, function () { assertCurrent(); return data; });
    }).finally(function () {
      if (requests.get(cacheKey) === request) requests.delete(cacheKey);
    });
    requests.set(cacheKey, request);
    return request;
  }
  return {
    peekAvatar: function (app, assetId) { return assetId ? peek(app, 'avatar', assetId) : null; },
    getAvatar: function (app, assetId, options) { return assetId ? get(app, 'avatar', assetId, options) : Promise.resolve({ url: '', status: 'empty' }); },
    peekFeedback: function (app) { return peek(app, 'qr'); },
    getFeedback: function (app, options) { return get(app, 'qr', '', options); },
    discardAvatar: function (app, assetId) { discard(key(app, 'avatar', assetId)); },
    discardFeedback: function (app) { discard(key(app, 'qr')); },
    replaceAvatar: function (app, assetId) {
      const prefix = [app.globalData.env || '', app.globalData.user && app.globalData.user._id || ''];
      const keys = new Set(Object.keys(read()).concat(Array.from(requests.keys())));
      keys.forEach(function (cacheKey) {
        let parts;
        try { parts = JSON.parse(cacheKey); } catch (error) { return; }
        if (parts[0] === prefix[0] && parts[1] === prefix[1] && parts[2] === 'avatar' && parts[3] !== assetId) discard(cacheKey);
      });
    },
    clear: function () {
      epoch += 1;
      requests.clear();
      const entries = read();
      Object.keys(entries).forEach(function (cacheKey) { removeFile(entries[cacheKey].path); });
      try { wxApi.removeStorageSync(STORAGE_KEY); } catch (error) { /* storage unavailable */ }
    }
  };
}

let instance;
function shared() { if (!instance) instance = createCache(wx, api); return instance; }
const exported = { createCache: createCache, QR_TTL: QR_TTL };
['peekAvatar', 'getAvatar', 'peekFeedback', 'getFeedback', 'discardAvatar', 'discardFeedback', 'replaceAvatar', 'clear'].forEach(function (name) {
  exported[name] = function () { return shared()[name].apply(null, arguments); };
});
module.exports = exported;
