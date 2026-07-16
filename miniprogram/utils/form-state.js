function value(value) {
  return value === undefined || value === null ? '' : value;
}

function capture(data, fields) {
  return (fields || []).reduce(function (snapshot, field) {
    snapshot[field] = value(data[field]);
    return snapshot;
  }, {});
}

function changed(data, snapshot, fields) {
  return (fields || []).some(function (field) {
    return value(data[field]) !== value(snapshot && snapshot[field]);
  });
}

function syncLeaveAlert(page, dirty, message) {
  page._hasUnsavedChanges = Boolean(dirty);
  if (typeof wx === 'undefined') return;
  if (dirty && !page._leaveAlertEnabled && wx.enableAlertBeforeUnload) {
    wx.enableAlertBeforeUnload({ message: message || '当前修改尚未保存，确定离开吗？' });
    page._leaveAlertEnabled = true;
    return;
  }
  if (!dirty && page._leaveAlertEnabled) clearLeaveAlert(page);
}

function clearLeaveAlert(page) {
  page._hasUnsavedChanges = false;
  if (typeof wx !== 'undefined' && page._leaveAlertEnabled && wx.disableAlertBeforeUnload) {
    wx.disableAlertBeforeUnload();
  }
  page._leaveAlertEnabled = false;
}

module.exports = {
  capture: capture,
  changed: changed,
  syncLeaveAlert: syncLeaveAlert,
  clearLeaveAlert: clearLeaveAlert
};
