const api = require('./api');
const posterCodeFile = require('./poster-code-file');

const STORAGE_KEY = 'youpu_poster_invites';
const MAX_CACHE_ENTRIES = 40;

function cacheKey(options) {
  const value = options || {};
  return [value.ownerId || '', value.familyId || '', value.viewMode || 'full', value.viewPersonId || ''].join('|');
}

function readCache() {
  try {
    const stored = wx.getStorageSync(STORAGE_KEY);
    return stored && typeof stored === 'object' ? stored : {};
  } catch (error) {
    return {};
  }
}

function writeCache(cache) {
  try { wx.setStorageSync(STORAGE_KEY, cache); } catch (error) { /* cache is optional */ }
}

function prune(cache) {
  return Object.keys(cache || {}).filter(function (key) {
    const item = cache[key];
    return item && item.invitationId && item.token;
  }).sort(function (left, right) {
    return Number(cache[right].savedAt || 0) - Number(cache[left].savedAt || 0);
  }).slice(0, MAX_CACHE_ENTRIES).reduce(function (result, key) {
    result[key] = cache[key];
    return result;
  }, {});
}

function staleInvitation(error) {
  return ['INVITE_INVALID', 'INVITE_NOT_FOUND', 'INVITE_REVOKED', 'INVITE_EXPIRED', 'INVALID_INVITATION'].includes(error && error.code);
}

function requestCode(invitation) {
  return api.call('invite.getMiniCode', {
    invitationId: invitation.invitationId,
    token: invitation.token,
    envVersion: posterCodeFile.environmentVersion()
  }).then(function (data) {
    return posterCodeFile.write(invitation.invitationId, data.base64).then(function (filePath) {
      return Object.assign({}, invitation, { miniCodePath: filePath });
    });
  });
}

function create(options, key, cache) {
  return api.call('invite.createPoster', {
    familyId: options.familyId,
    viewMode: options.viewMode,
    viewPersonId: options.viewPersonId
  }).then(function (invitation) {
    cache[key] = {
      invitationId: invitation.invitationId,
      token: invitation.token,
      savedAt: Date.now()
    };
    writeCache(prune(cache));
    return requestCode(cache[key]);
  });
}

function get(options) {
  const cache = prune(readCache());
  const key = cacheKey(options);
  const cached = cache[key];
  if (!cached) return create(options, key, cache);
  return requestCode(cached).catch(function (error) {
    if (!staleInvitation(error)) throw error;
    delete cache[key];
    writeCache(cache);
    return create(options, key, cache);
  });
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  cacheKey: cacheKey,
  environmentVersion: posterCodeFile.environmentVersion,
  get: get
};
