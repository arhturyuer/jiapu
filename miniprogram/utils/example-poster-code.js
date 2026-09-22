const api = require('./api');
const posterCodeFile = require('./poster-code-file');

function get(options) {
  const value = options || {};
  return api.call('examples.getMiniCode', {
    slug: value.slug,
    viewMode: value.viewMode,
    viewPersonId: value.viewPersonId,
    envVersion: posterCodeFile.environmentVersion()
  }).then(function (data) {
    const key = ['example', value.slug, value.viewMode || 'full', value.viewPersonId || 'all'].join('-');
    return posterCodeFile.write(key, data.base64).then(function (miniCodePath) {
      return { miniCodePath: miniCodePath };
    });
  });
}

module.exports = { get: get };
