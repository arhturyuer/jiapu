const api = require('./api');
let entry = { scene: 0 };
let epoch = 0;
let seen = {};
function enter(options) {
  const value = options || {};
  // App.onShow is the source of scenes, never a URL's source/scene parameter.
  if (Number(value.scene) === 1038) return;
  entry = { scene: Number(value.scene) || 0 };
  epoch += 1;
  seen = {};
}
function record(event, page, slug, entryType) {
  if ([1129, 1030, 1203].indexOf(entry.scene) >= 0) return Promise.resolve();
  const app = typeof getApp === 'function' && getApp();
  if (app) app._growthTouched = true;
  const scope = app && app.globalData ? app.globalData.environment + '|' + app.globalData.env : '';
  const key = scope + '|' + epoch + '|' + event + '|' + page + '|' + (slug || '') + '|' + (entryType || '');
  if (seen[key]) return seen[key];
  const scene = entry.scene;
  const request = Promise.resolve().then(function () { return api.call('growth.record', Object.assign({ event: event, page: page, slug: slug || '', scene: scene }, entryType ? { entryType: entryType } : {})); }).catch(function () { delete seen[key]; });
  seen[key] = request;
  return request;
}
function create(page, slug, url, entryType) {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const owner = pages[pages.length - 1];
  if (owner && owner._growthCreating) return Promise.resolve();
  if (owner) owner._growthCreating = true;
  // Serialize with the landing receipt so registration cannot precede first touch.
  const receipt = (entryType ? record('landing', page, '', entryType) : record('view', page, slug))
    .then(function () { return record('create_click', page, entryType ? '' : slug, entryType); });
  let timer;
  const deadline = new Promise(function (resolve) { timer = setTimeout(resolve, 1000); });
  return Promise.race([receipt, deadline]).then(function () {
    clearTimeout(timer);
    if (owner) owner._growthCreating = false;
    if (!owner || !owner._growthHidden) wx.navigateTo({ url: url || '/pages/create-family/index' });
  });
}
function shareOpen(kind, slug) {
  if ([1129, 1030, 1203].indexOf(entry.scene) >= 0) return Promise.resolve();
  return Promise.resolve().then(function () {
    return api.call('public.share.record', { kind: kind, slug: slug || '', stage: 'opened', scene: entry.scene });
  }).catch(function () {});
}
module.exports = { enter: enter, record: record, create: create, shareOpen: shareOpen };
