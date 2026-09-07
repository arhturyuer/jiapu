const test = require('node:test');
const assert = require('node:assert/strict');
const fileTransfer = require('../miniprogram/utils/file-transfer');

function rejectedCode(code) {
  return function (error) { return error && error.code === code; };
}

test('downloadToTempFile 用回调解析成功结果而不是依赖 DownloadTask Promise', async function () {
  let returnedTask = null;
  let progressValue = 0;
  let requestedFilePath = '';
  const wxApi = {
    env: { USER_DATA_PATH: '/wx-user-data' },
    downloadFile: function (options) {
      requestedFilePath = options.filePath;
      options.success({ statusCode: 200, filePath: options.filePath });
      returnedTask = { abort: function () {}, onProgressUpdate: function (callback) { callback({ progress: 42 }); } };
      return returnedTask;
    }
  };
  const result = await fileTransfer.downloadToTempFile('https://example.test/family.zip', { wxApi: wxApi, fileName: '张家-备份.zip', onProgress: function (progress) { progressValue = progress; } });
  assert.equal(result.filePath, requestedFilePath);
  assert.match(requestedFilePath, /^\/wx-user-data\/\d+-张家-备份\.zip$/);
  assert.ok(returnedTask);
  assert.equal(progressValue, 42);
});

test('downloadToTempFile 区分网络失败、HTTP 错误和临时路径缺失', async function () {
  await assert.rejects(fileTransfer.downloadToTempFile('https://example.test/a', { wxApi: {
    downloadFile: function (options) { options.fail({ errMsg: 'downloadFile:fail timeout' }); }
  } }), rejectedCode('DOWNLOAD_FAILED'));
  await assert.rejects(fileTransfer.downloadToTempFile('https://example.test/b', { wxApi: {
    downloadFile: function (options) { options.success({ statusCode: 403, tempFilePath: '/tmp/error' }); }
  } }), rejectedCode('DOWNLOAD_HTTP_ERROR'));
  await assert.rejects(fileTransfer.downloadToTempFile('https://example.test/c', { wxApi: {
    downloadFile: function (options) { options.success({ statusCode: 200 }); }
  } }), rejectedCode('DOWNLOAD_PATH_MISSING'));
});

test('shareFile 支持成功、取消、失败和旧版本拦截', async function () {
  const success = await fileTransfer.shareFile('/tmp/a.zip', '家庭备份.zip', { wxApi: {
    shareFileMessage: function (options) {
      assert.equal(options.fileName, '家庭备份.zip');
      options.success({});
    }
  } });
  assert.deepEqual(success, {});
  await assert.rejects(fileTransfer.shareFile('/tmp/a.zip', '家庭备份.zip', { wxApi: {
    shareFileMessage: function (options) { options.fail({ errMsg: 'shareFileMessage:fail cancel' }); }
  } }), rejectedCode('SHARE_CANCELLED'));
  await assert.rejects(fileTransfer.shareFile('/tmp/a.zip', '家庭备份.zip', { wxApi: {
    shareFileMessage: function (options) { options.fail({ errMsg: 'shareFileMessage:fail system error' }); }
  } }), rejectedCode('SHARE_FAILED'));
  await assert.rejects(fileTransfer.shareFile('/tmp/a.zip', '家庭备份.zip', { wxApi: {} }), rejectedCode('SHARE_UNSUPPORTED'));
});

test('removeTempFile 在成功或清理接口异常时都安全完成', async function () {
  let removed = '';
  await fileTransfer.removeTempFile('/tmp/a.zip', { wxApi: {
    getFileSystemManager: function () {
      return { unlink: function (options) { removed = options.filePath; options.complete(); } };
    }
  } });
  assert.equal(removed, '/tmp/a.zip');
  await fileTransfer.removeTempFile('/tmp/b.zip', { wxApi: {
    getFileSystemManager: function () { throw new Error('unavailable'); }
  } });
});

test('isCancelled 只识别用户取消转发', function () {
  assert.equal(fileTransfer.isCancelled({ code: 'SHARE_CANCELLED' }), true);
  assert.equal(fileTransfer.isCancelled({ errMsg: 'shareFileMessage:fail cancel' }), true);
  assert.equal(fileTransfer.isCancelled({ code: 'SHARE_FAILED', errMsg: 'system error' }), false);
});

test('shareFailureText 为用户手势、文件失效和未知微信错误提供可操作提示', function () {
  assert.match(fileTransfer.shareFailureText({ errMsg: 'shareFileMessage:fail can only be invoked by user TAP gesture' }), /再次点击/);
  assert.match(fileTransfer.shareFailureText({ errMsg: 'shareFileMessage:fail file not exists' }), /重新下载/);
  assert.match(fileTransfer.shareFailureText({ errMsg: 'shareFileMessage:fail internal error 12' }), /internal error 12/);
});
