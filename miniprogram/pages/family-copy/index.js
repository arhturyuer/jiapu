const launchAd = require('../../utils/launch-ad');
const api = require('../../utils/api');
const app = getApp();
const STAGES = { snapshot: '准备资料', persons: '复制人物', avatars: '复制头像', relations: '复制关系', verify: '核对资料', completed: '复制完成' };
const DEFINITE_REJECTIONS = ['UNKNOWN_ACTION', 'REQUEST_ID_REQUIRED', 'UNAUTHENTICATED', 'ACCOUNT_FROZEN', 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_PENDING_DELETE', 'ACCOUNT_SESSION_CHANGED', 'TEST_IDENTITY_INVALID', 'NO_PERMISSION', 'NO_FAMILY_ACCESS', 'FAMILY_NOT_FOUND', 'FAMILY_ARCHIVED', 'FAMILY_FROZEN', 'COPY_SOURCE_INVALID', 'COPY_NAME_INVALID', 'COPY_REQUEST_CHANGED', 'COPY_IN_PROGRESS', 'COPY_DAILY_LIMIT', 'CONTENT_REJECTED', 'CONTENT_REVIEW_UNAVAILABLE', 'RATE_LIMITED'];
const FAILURES = {
  COPY_SOURCE_UNAVAILABLE: '原家谱或你的访问权限已变化，请返回确认',
  COPY_ACCOUNT_UNAVAILABLE: '账户当前不能复制家谱，请返回确认',
  GRAPH_CHANGED: '家谱正在修改，请稍后重试',
  COPY_INVALID_GRAPH: '家谱关系资料异常，请联系管理员检查',
  COPY_LIMIT_EXCEEDED: '家谱超过 500 人或 2000 条关系，暂时无法复制',
  COPY_TIMEOUT: '复制等待时间过长，请重新发起',
  COPY_FAILED: '复制未完成，请稍后重试'
};
function settle(promise) {
  return Promise.resolve(promise).then(function (value) { return { status: 'fulfilled', value: value }; }, function (reason) { return { status: 'rejected', reason: reason }; });
}
function decorate(task) {
  if (!task) return null;
  return Object.assign({}, task, {
    stageText: STAGES[task.stage] || '准备资料',
    failureText: FAILURES[task.failureCode] || FAILURES.COPY_FAILED,
    missingAvatars: (task.missingAvatars || []).map(function (item) {
      return Object.assign({}, item, { reasonText: item.reason === 'transfer_failed' ? '头像复制失败' : '原头像暂时不可用' });
    })
  });
}
Page(launchAd.wrap({
  data: { familyId: '', family: null, name: '', loading: true, error: '', taskError: '', task: null, submitting: false, running: false, uncertain: false, opening: false },
  onLoad: function (options) { this.setData({ familyId: options.familyId || '' }); },
  onShow: function () { this._visible = true; this._version = (this._version || 0) + 1; this.setData({ opening: false }); this.loadPage(); },
  onHide: function () { this.stopPolling(); },
  onUnload: function () { this.stopPolling(); },
  stopPolling: function () {
    this._visible = false; this._version = (this._version || 0) + 1;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  },
  storageKey: function () {
    const user = app.globalData.user;
    return 'youpu_copy_request_' + (user ? user._id : '') + '_' + this.data.familyId;
  },
  valid: function (version) { return this._visible && this._version === version && (!this._actorId || app.globalData.user && app.globalData.user._id === this._actorId); },
  loadPage: function () {
    const self = this; const version = this._version;
    if (!this.data.familyId) { this.setData({ loading: false, error: '缺少家谱信息，请返回重试' }); return Promise.resolve(); }
    this.setData({ loading: true, error: '' });
    return app.ensureLogin().then(function () {
      if (!self._visible || self._version !== version) return;
      self._actorId = app.globalData.user ? app.globalData.user._id : '';
      self._pendingRequest = wx.getStorageSync(self.storageKey()) || null;
      if (self._pendingRequest) self.setData({ name: self._pendingRequest.name, uncertain: true });
      return Promise.all([
        api.call('family.dashboard', { familyId: self.data.familyId }),
        api.call('family.copy.status', { familyId: self.data.familyId })
      ].map(settle)).then(function (results) {
        if (!self.valid(version)) return;
        const familyResult = results[0]; const taskResult = results[1];
        const family = familyResult.status === 'fulfilled' ? familyResult.value.family : null;
        self.setData({ family: family, loading: false });
        if (family && !self.data.name) self.setData({ name: (family.name || '').slice(0, 36).replace(/[\uD800-\uDBFF]$/, '') + '（副本）' });
        if (taskResult.status === 'fulfilled') self.applyTask(taskResult.value.task);
        else self.setData({ taskError: api.userMessage(taskResult.reason, '复制状态读取失败，请重试') });
        if (!family && !(taskResult.status === 'fulfilled' && taskResult.value.task)) self.setData({ error: api.userMessage(familyResult.reason, '家谱读取失败，请重试') });
      });
    }).catch(function (error) { if (self.valid(version)) self.setData({ loading: false, error: api.userMessage(error, '请重新打开页面') }); });
  },
  applyTask: function (task) {
    const running = Boolean(task && ['pending', 'processing'].includes(task.status));
    this.setData({ task: decorate(task), running: running, submitting: false, taskError: '' });
    if (task && this._pendingRequest && (task.taskId === this._pendingRequest.taskId || task.requestId === this._pendingRequest.idempotencyKey)) {
      wx.removeStorageSync(this.storageKey()); this._pendingRequest = null; this.setData({ uncertain: false });
    }
    if (running) this.schedulePoll();
  },
  schedulePoll: function () {
    if (this._timer) clearTimeout(this._timer);
    if (!this._visible) return;
    const self = this; const attempt = this._pollAttempt || 0;
    this._pollAttempt = attempt + 1;
    this._timer = setTimeout(function () { self.refreshTask(); }, Math.min(30000, 4000 * Math.pow(2, Math.min(attempt, 3))));
  },
  refreshTask: function () {
    const self = this; const version = this._version;
    const payload = this.data.task ? { taskId: this.data.task.taskId } : { familyId: this.data.familyId };
    return api.call('family.copy.status', payload).then(function (result) {
      if (!self.valid(version)) return;
      self.applyTask(result.task);
    }).catch(function (error) {
      if (!self.valid(version)) return;
      self.setData({ taskError: api.userMessage(error, '复制状态读取失败，请重试') });
      if (self.data.running && !error.isBusinessError) self.schedulePoll();
    });
  },
  inputName: function (event) { this.setData({ name: event.detail.value }); },
  createCopy: function () {
    if (this.data.submitting || this.data.running || this.data.taskError) return Promise.resolve();
    const self = this; const version = this._version;
    const name = this.data.name.trim();
    if (!name || name.length > 40) { wx.showToast({ title: '请填写 40 字以内的家谱名称', icon: 'none' }); return Promise.resolve(); }
    const request = this._pendingRequest || { idempotencyKey: api.requestId(), name: name };
    const storageKey = this.storageKey();
    this._pendingRequest = request;
    wx.setStorageSync(storageKey, request);
    this.setData({ submitting: true, uncertain: true });
    return api.call('family.copy.create', { familyId: this.data.familyId, name: request.name, idempotencyKey: request.idempotencyKey }).then(function (task) {
      request.taskId = task.taskId;
      wx.removeStorageSync(storageKey); if (self._pendingRequest === request) self._pendingRequest = null;
      if (!self.valid(version)) return;
      self._pollAttempt = 0;
      self.setData({ uncertain: false }); self.applyTask(task);
    }).catch(function (error) {
      const rejected = error.isBusinessError && DEFINITE_REJECTIONS.indexOf(error.code) >= 0;
      if (rejected) { wx.removeStorageSync(storageKey); if (self._pendingRequest === request) self._pendingRequest = null; }
      if (!self.valid(version)) return;
      self.setData({ submitting: false, uncertain: !rejected });
      wx.showToast({ title: api.userMessage(error, rejected ? '复制未开始，请稍后重试' : '提交结果尚未确认，点击继续确认'), icon: 'none' });
    });
  },
  openCopy: function (event) {
    const task = this.data.task;
    if (!task || !task.family || this.data.opening) return Promise.resolve();
    const self = this; const version = this._version;
    const personId = event && event.currentTarget.dataset.personId;
    this.setData({ opening: true });
    app.invalidateCache({ families: true, profile: true });
    return app.loadFamilyPages(true).then(function (result) {
      if (!self.valid(version)) return;
      const family = (result.families || []).find(f => f._id === task.family._id && f.status === 'active');
      if (!family) throw Object.assign(new Error('copy unavailable'), { code: 'NO_FAMILY_ACCESS' });
      app.setCurrentFamily(family);
      wx.setStorageSync('youpu_pending_view', { mode: 'full', personId: '' });
      if (personId) wx.navigateTo({ url: '/pages/edit-member/index?id=' + encodeURIComponent(personId) });
      else wx.switchTab({ url: '/pages/tree/index' });
    }).catch(function (error) { if (self.valid(version)) wx.showToast({ title: api.userMessage(error, '新家谱打开失败，请重试'), icon: 'none' }); }).then(function () { if (self.valid(version)) self.setData({ opening: false }); });
  }
}));
