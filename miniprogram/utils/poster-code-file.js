function environmentVersion() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    const value = info && info.miniProgram && info.miniProgram.envVersion;
    return ['develop', 'trial', 'release'].includes(value) ? value : 'develop';
  } catch (error) {
    return 'develop';
  }
}

function filePath(key) {
  const root = wx.env && wx.env.USER_DATA_PATH;
  const safeKey = String(key || 'poster').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 96);
  return root ? root + '/youpu-poster-code-' + safeKey + '.png' : '';
}

function write(key, base64) {
  const target = filePath(key);
  if (!target || !base64 || !wx.getFileSystemManager) {
    const error = new Error('小程序码暂时无法保存');
    error.code = 'MINI_CODE_FILE_FAILED';
    return Promise.reject(error);
  }
  return new Promise(function (resolve, reject) {
    wx.getFileSystemManager().writeFile({
      filePath: target,
      data: base64,
      encoding: 'base64',
      success: function () { resolve(target); },
      fail: function (source) {
        const error = new Error('小程序码暂时无法保存');
        error.code = 'MINI_CODE_FILE_FAILED';
        error.errMsg = source && source.errMsg || '';
        reject(error);
      }
    });
  });
}

module.exports = {
  environmentVersion: environmentVersion,
  filePath: filePath,
  write: write
};
