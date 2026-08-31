const releaseNotes = require('../config/release-notes');

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(left, right) {
  const leftParts = String(left).match(VERSION_PATTERN);
  const rightParts = String(right).match(VERSION_PATTERN);
  if (!leftParts || !rightParts) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftParts[index]) - Number(rightParts[index]);
    if (difference) return difference;
  }
  return 0;
}

function validateReleaseNotes(notes) {
  const items = Array.isArray(notes) ? notes : [];
  const seen = new Set();
  let previous = '';
  items.forEach(function (item, index) {
    const version = String(item && item.version || '').trim();
    const summary = String(item && item.summary || '').trim();
    if (!VERSION_PATTERN.test(version)) throw new Error('版本记录 #' + (index + 1) + ' 的版本号必须为 X.Y.Z');
    if (!summary) throw new Error('版本记录 #' + (index + 1) + ' 缺少更新摘要');
    if (seen.has(version)) throw new Error('版本记录包含重复版本号：' + version);
    if (previous && compareVersions(previous, version) <= 0) throw new Error('版本记录必须按最新版本在前排列');
    seen.add(version);
    previous = version;
  });
  return items.map(function (item) {
    return { version: String(item.version).trim(), summary: String(item.summary).trim() };
  });
}

function getCurrentReleaseVersion(wxApi) {
  try {
    const account = wxApi && wxApi.getAccountInfoSync && wxApi.getAccountInfoSync();
    const miniProgram = account && account.miniProgram || {};
    if (miniProgram.envVersion !== 'release') return '';
    return String(miniProgram.version || '').trim();
  } catch (error) {
    return '';
  }
}

function getAboutReleaseInfo(wxApi) {
  const currentVersion = getCurrentReleaseVersion(wxApi);
  return {
    currentVersion: currentVersion,
    releaseNotes: validateReleaseNotes(releaseNotes).map(function (item) {
      return Object.assign({}, item, { isCurrent: Boolean(currentVersion && item.version === currentVersion) });
    })
  };
}

module.exports = {
  compareVersions: compareVersions,
  validateReleaseNotes: validateReleaseNotes,
  getCurrentReleaseVersion: getCurrentReleaseVersion,
  getAboutReleaseInfo: getAboutReleaseInfo
};
