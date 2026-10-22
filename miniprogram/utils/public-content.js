const PATHS = ['pages/share-intro/index', 'pages/about/index', 'pages/legal/index', 'pages/guides/index', 'pages/guide/index', 'pages/examples/index', 'pages/example/index', 'pages/example-person-detail/index', 'pages/example-reading/index'];
function isPublic(path) { return PATHS.indexOf(String(path || '').replace(/^\//, '')) >= 0; }
function defaultPath(options, hasLocalFamily) {
  const entry = options || {};
  if (entry.path && entry.path !== 'pages/launch-ad/index') return entry.path;
  return hasLocalFamily ? 'pages/tree/index' : 'pages/example/index';
}
function defaultTarget(options, hasLocalFamily) {
  const entry = options || {};
  return { path: defaultPath(entry, hasLocalFamily), query: !hasLocalFamily && (!entry.path || entry.path === 'pages/launch-ad/index')
    ? { entry: 'default' } : Object.assign({}, entry.query || {}) };
}
module.exports = { isPublic: isPublic, defaultPath: defaultPath, defaultTarget: defaultTarget };
