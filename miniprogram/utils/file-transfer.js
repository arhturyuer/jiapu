function apiFrom(options) {
  if (options && options.wxApi) return options.wxApi;
  return wx;
}

function transferError(code, message, source) {
  const error = new Error(message);
  error.code = code;
  if (source && source.errMsg) error.errMsg = source.errMsg;
  if (source && source.statusCode) error.statusCode = source.statusCode;
  return error;
}

function canShareFile(wxApi) {
  const api = wxApi || wx;
  return Boolean(api && typeof api.shareFileMessage === 'function');
}

function safeFileName(value) {
  const cleaned = String(value || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-100);
  return cleaned || 'file';
}

function localFilePath(fileName, api) {
  const root = api && api.env && api.env.USER_DATA_PATH;
  if (!root || !fileName) return '';
  return root + '/' + Date.now() + '-' + safeFileName(fileName);
}

function downloadToTempFile(url, options) {
  const api = apiFrom(options);
  if (!url) return Promise.reject(transferError('DOWNLOAD_URL_MISSING', '文件下载地址无效，请重新领取'));
  return new Promise(function (resolve, reject) {
    try {
      const request = {
        url: url,
        timeout: options && options.timeout ? options.timeout : 60000,
        success: function (result) {
          if (!result || result.statusCode !== 200) {
            reject(transferError('DOWNLOAD_HTTP_ERROR', '文件暂不可用，请稍后重试', result));
            return;
          }
          const filePath = result.tempFilePath || result.filePath || '';
          if (!filePath) {
            reject(transferError('DOWNLOAD_PATH_MISSING', '文件已下载，但没有生成可转发的临时文件'));
            return;
          }
          resolve({ filePath: filePath, statusCode: result.statusCode, profile: result.profile || null });
        },
        fail: function (error) {
          reject(transferError('DOWNLOAD_FAILED', '文件下载失败，请检查网络后重试', error));
        }
      };
      const requestedFilePath = localFilePath(options && options.fileName, api);
      if (requestedFilePath) request.filePath = requestedFilePath;
      const task = api.downloadFile(request);
      if (options && typeof options.onProgress === 'function' && task && typeof task.onProgressUpdate === 'function') {
        task.onProgressUpdate(function (progress) {
          options.onProgress(Math.max(0, Math.min(100, Number(progress && progress.progress) || 0)), progress || {});
        });
      }
    } catch (error) {
      reject(transferError('DOWNLOAD_FAILED', '文件下载失败，请检查网络后重试', error));
    }
  });
}

function shareFile(filePath, fileName, options) {
  const api = apiFrom(options);
  if (!canShareFile(api)) return Promise.reject(transferError('SHARE_UNSUPPORTED', '当前微信版本不支持文件转发，请升级微信'));
  if (!filePath) return Promise.reject(transferError('SHARE_PATH_MISSING', '没有可转发的文件，请重新下载'));
  return new Promise(function (resolve, reject) {
    const request = {
      filePath: filePath,
      success: function (result) { resolve(result || {}); },
      fail: function (error) {
        const cancelled = String(error && error.errMsg || '').toLowerCase().indexOf('cancel') >= 0;
        reject(transferError(cancelled ? 'SHARE_CANCELLED' : 'SHARE_FAILED', cancelled ? '已取消文件转发' : '文件转发失败，请重试', error));
      }
    };
    if (fileName) request.fileName = fileName;
    try {
      api.shareFileMessage(request);
    } catch (error) {
      reject(transferError('SHARE_FAILED', '文件转发失败，请重试', error));
    }
  });
}

function removeTempFile(filePath, options) {
  const api = apiFrom(options);
  if (!filePath || !api || typeof api.getFileSystemManager !== 'function') return Promise.resolve();
  return new Promise(function (resolve) {
    try {
      const manager = api.getFileSystemManager();
      if (!manager || typeof manager.unlink !== 'function') {
        resolve();
        return;
      }
      manager.unlink({ filePath: filePath, complete: function () { resolve(); } });
    } catch (error) {
      resolve();
    }
  });
}

function isCancelled(error) {
  return Boolean(error && (error.code === 'SHARE_CANCELLED' || String(error.errMsg || '').toLowerCase().indexOf('cancel') >= 0));
}

function shareFailureText(error) {
  const raw = String(error && error.errMsg || '');
  const normalized = raw.toLowerCase();
  if (normalized.indexOf('user tap gesture') >= 0) return '请再次点击“转发到聊天”后重试';
  if (normalized.indexOf('not exist') >= 0 || normalized.indexOf('no such file') >= 0) return '下载文件已失效，请重新下载';
  if (normalized.indexOf('size') >= 0 && (normalized.indexOf('exceed') >= 0 || normalized.indexOf('limit') >= 0)) return '文件超过微信可转发大小，请联系微信客服';
  return '文件转发失败，请稍后重试';
}

module.exports = {
  canShareFile: canShareFile,
  downloadToTempFile: downloadToTempFile,
  shareFile: shareFile,
  removeTempFile: removeTempFile,
  isCancelled: isCancelled,
  shareFailureText: shareFailureText
};
