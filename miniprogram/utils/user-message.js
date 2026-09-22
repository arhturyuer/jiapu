const MESSAGE_BY_CODE = {
  CLOUD_CALL_FAILED: '网络不稳定，请检查后重试',
  CLOUD_FUNCTION_TIMEOUT: '等待时间较长，请稍后重试',
  UNAUTHENTICATED: '登录状态已更新，请重新打开页面',
  ACCOUNT_FROZEN: '账户暂时无法使用，请联系微信客服',
  ACCOUNT_UNAVAILABLE: '账户暂时无法使用，请联系微信客服',
  TARGET_ACCOUNT_UNAVAILABLE: '这位家人的账户暂时无法调整',
  NO_PERMISSION: '你暂时没有权限完成这项操作',
  NO_FAMILY_ACCESS: '你已无法查看这份家谱',
  FAMILY_NOT_FOUND: '这份家谱已不存在或无法查看',
  PERSON_NOT_FOUND: '这位家人已不在当前家谱中',
  NOT_FOUND: '这项内容已不存在或无法查看',
  FAMILY_ARCHIVED: '这份家谱已移入回收站',
  FAMILY_FROZEN: '这份家谱暂时无法修改',
  GRAPH_CHANGED: '家谱刚有新变化，请刷新后重试',
  GRAPH_REVISION_REQUIRED: '家谱刚有新变化，请刷新后重试',
  REQUEST_IN_PROGRESS: '这项操作正在处理，请稍候',
  REQUEST_REVIEWED: '这项申请已经处理',
  RATE_LIMITED: '操作有些频繁，请稍后再试',
  MEDIA_TOO_LARGE: '图片较大，请换一张后重试',
  MEDIA_INSPECTION_FAILED: '这张图片暂时无法使用，请换一张重试',
  MEDIA_NOT_READY: '图片正在处理，请稍后再试',
  CONTENT_REJECTED: '提交的内容未通过安全检查，请修改后重试',
  INVALID_INVITATION: '这张邀请已无法使用，请让家人重新发送',
  INVITE_INVALID: '这张邀请已无法使用，请让家人重新发送',
  INVITE_ALREADY_INACTIVE: '这张邀请已失效',
  MINI_CODE_FAILED: '小程序码生成失败，请稍后重试',
  MINI_CODE_FILE_FAILED: '小程序码暂时无法保存，请重试',
  MEMBERSHIP_REQUIRED: '这项功能需要家庭会员',
  BACKUP_IN_PROGRESS: '家庭备份正在生成，请稍候',
  BACKUP_COOLDOWN: '每 7 天可生成一次家庭备份',
  BACKUP_NOT_READY: '家庭备份还在准备，请稍后再试',
  BACKUP_EXPIRED: '这份家庭备份已过期，请重新生成',
  BACKUP_URL_FAILED: '备份文件暂时无法领取，请稍后重试',
  EXPORT_NOT_READY: '个人资料文件还在准备，请稍后再试',
  EXPORT_LINK_ALREADY_ISSUED: '这份个人资料文件已领取',
  PAYMENT_LOGIN_REQUIRED: '请重新打开页面后再购买',
  PAYMENT_LOGIN_INVALID: '请重新打开页面后再购买',
  PAYMENT_MONTHLY_LIMIT: '本月购买次数已达上限',
  PAYMENT_NOT_CONFIGURED: '当前暂时无法购买，请稍后再试',
  PAYMENT_NOTIFY_UNAVAILABLE: '订单仍在确认，请稍后查看，不要重复购买',
  PAYMENT_RECONCILE_UNAVAILABLE: '订单仍在确认，请稍后查看，不要重复购买',
  SHARE_UNSUPPORTED: '当前微信版本暂不支持转发文件，请升级微信',
  SHARE_REQUIRES_TAP: '请再点击一次转发',
  SHARE_FILE_MISSING: '文件已失效，请重新下载',
  SHARE_FAILED: '文件转发失败，请稍后重试'
};

let recentProblemId = '';

function fromError(error, fallback) {
  const source = error || {};
  const code = String(source.code || '');
  const problemId = String(source.requestId || '');
  if (problemId) recentProblemId = problemId;
  return {
    message: MESSAGE_BY_CODE[code] || fallback || '暂时无法完成，请稍后重试',
    problemId: problemId
  };
}

module.exports = {
  fromError: fromError,
  message: function (error, fallback) { return fromError(error, fallback).message; },
  lastProblemId: function () { return recentProblemId; }
};
