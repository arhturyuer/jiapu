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
      fail: function (error) {
        // 开发者工具和部分旧客户端可能无法读取隐私状态。此处不能阻断用户
        // 主动发起的选图操作，后续 chooseMedia 仍会执行微信原生隐私校验。
        console.warn('隐私设置读取失败，交由选图接口继续校验', error && error.errMsg);
        resolve();
      }
    });
  });
}

module.exports = {
  ensurePrivacyAuthorized: ensurePrivacyAuthorized
};
