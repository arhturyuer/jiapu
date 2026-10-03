const api = require('./api');
let cachedTemplates = null;
let cachedAt = 0;
let pendingRequest = null;

function loadTemplates() {
  if (cachedTemplates && Date.now() - cachedAt < 10 * 60 * 1000) return Promise.resolve(cachedTemplates);
  if (pendingRequest) return pendingRequest;
  pendingRequest = api.call('notification.templates').then(function (result) {
    cachedTemplates = { joinTemplateId: result.joinTemplateId || '', reviewTemplateId: result.reviewTemplateId || '' };
    cachedAt = Date.now();
    return cachedTemplates;
  }).then(function (templates) {
    pendingRequest = null;
    return templates;
  }, function (error) {
    pendingRequest = null;
    throw error;
  });
  return pendingRequest;
}

function request(templates, isAdmin) {
  const ids = [templates && templates.joinTemplateId];
  if (isAdmin) ids.push(templates && templates.reviewTemplateId);
  const tmplIds = ids.filter(Boolean);
  if (!tmplIds.length) return Promise.resolve({ unavailable: true, accepted: 0 });
  if (typeof wx.requestSubscribeMessage !== 'function') return Promise.resolve({ unavailable: true, accepted: 0 });
  return new Promise(function (resolve) {
    wx.requestSubscribeMessage({
      tmplIds: tmplIds,
      success: function (result) {
        resolve({ accepted: tmplIds.filter(function (id) { return result[id] === 'accept'; }).length, requested: tmplIds.length });
      },
      fail: function (error) { resolve({ accepted: 0, requested: tmplIds.length, error: error }); }
    });
  });
}

function showResult(result) {
  const title = result.unavailable ? '提醒暂未开通' : result.accepted
    ? '已订阅 ' + result.accepted + ' 类提醒，每类可接收一次' : '未开启提醒，可稍后重试';
  wx.showToast({ title: title, icon: 'none', duration: 2500 });
}

module.exports = { loadTemplates: loadTemplates, request: request, showResult: showResult };
