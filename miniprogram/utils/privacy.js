function privacyError(message) {
  const error = new Error(message || '未获得隐私授权');
  error.code = 'PRIVACY_DENIED';
  return error;
}

function ensurePrivacyAuthorized() {
  if (!wx.getPrivacySetting || !wx.requirePrivacyAuthorize) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    wx.getPrivacySetting({
      success: function (setting) {
        if (!setting.needAuthorization) {
          resolve();
          return;
        }
        wx.requirePrivacyAuthorize({
          success: resolve,
          fail: function () { reject(privacyError('你已拒绝隐私授权，仍可继续使用文字家谱功能')); }
        });
      },
      fail: function () { reject(privacyError('隐私设置读取失败，请稍后重试')); }
    });
  });
}

module.exports = {
  ensurePrivacyAuthorized: ensurePrivacyAuthorized
};
