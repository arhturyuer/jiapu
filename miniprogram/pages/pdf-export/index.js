const launchAd = require('../../utils/launch-ad');
const api = require('../../utils/api');
const transfer = require('../../utils/file-transfer');
Page(launchAd.wrap({
  data: {
    source: 'family', familyId: '', slug: '', format: 'poster', name: '',
    loading: true, error: '', membershipRequired: false, task: null,
    running: false, submitting: false, opening: false, taskError: '', uncertain: false
  },
  onLoad: function (options) {
    this._display = {};
    try { this._display = JSON.parse(decodeURIComponent(options.display || '%7B%7D')); } catch (error) {}
    this.setData({ source: options.source === 'example' ? 'example' : 'family', familyId: options.familyId || '', slug: options.slug || '' });
  },
  onShow: function () { this._visible = true; this.load(); },
  onHide: function () { this._visible = false; clearTimeout(this._timer); },
  onUnload: function () { this._unloaded = true; this._visible = false; clearTimeout(this._timer); if (this._file) transfer.removeTempFile(this._file.filePath); },
  load: function () {
    const self = this;
    this.setData({ error: '' });
    const source = this.data.source === 'example' ? api.call('examples.get', { slug: this.data.slug }) : api.call('membership.status', { familyId: this.data.familyId });
    source.then(function (result) {
      if (!self._visible) return;
      self.setData({ loading: false, name: self.data.source === 'example' ? result.title || result.example && result.example.title || '示例家谱' : result.family.name, membershipRequired: self.data.source === 'family' && !result.membership.active });
      if (!self.data.membershipRequired) self.refreshTask();
    }).catch(function (error) { if (self._visible) self.setData({ loading: false, error: api.userMessage(error, '家谱暂不可用，请重试') }); });
  },
  chooseFormat: function (event) {
    if (this.data.running || this.data.submitting || this.data.uncertain) return;
    this.setData({ format: event.currentTarget.dataset.format });
  },
  openMembership: function () { wx.navigateTo({ url: '/pages/membership/index?familyId=' + encodeURIComponent(this.data.familyId) }); },
  receiveTask: function (task) {
    if (!this._visible) return;
    const previous = this.data.task;
    if (task && (!previous || previous.taskId !== task.taskId || previous.status !== task.status)) {
      if (this._file) { transfer.removeTempFile(this._file.filePath); this._file = null; }
    }
    this.setData({ task: task, running: Boolean(task && ['pending', 'processing'].includes(task.status)), taskError: '' });
    if (this.data.running) {
      const self = this;
      this._delay = Math.min((this._delay || 3000) * 1.5, 30000);
      clearTimeout(this._timer);
      this._timer = setTimeout(function () { self.refreshTask(); }, this._delay);
    }
  },
  refreshTask: function () {
    const self = this; clearTimeout(this._timer);
    const query = this.data.task ? { taskId: this.data.task.taskId } : { familyId: this.data.familyId, slug: this.data.slug };
    api.call('pdf.status', query).then(function (result) { self.receiveTask(result.task); }).catch(function (error) {
      if (!self._visible) return;
      self.setData({ taskError: api.userMessage(error, '状态读取失败，请重试') });
    });
  },
  generate: function () {
    if (this.data.submitting || this.data.running || this.data.membershipRequired) return;
    const self = this;
    if (!this._request) {
      this._request = { source: this.data.source, familyId: this.data.familyId, slug: this.data.slug, format: this.data.format, display: this._display, requestId: api.requestId() };
      if (this.data.task && this.data.task.status === 'failed' && this.data.task.format === this.data.format) this._request.retryTaskId = this.data.task.taskId;
    }
    this.setData({ submitting: true, taskError: '' });
    api.call('pdf.create', this._request).then(function (task) {
      self._request = null; self._delay = 3000;
      if (!self._unloaded) self.setData({ uncertain: false });
      self.receiveTask(task);
    }).catch(function (error) {
      if (self._unloaded) return;
      const uncertain = !error.isBusinessError;
      if (!uncertain) self._request = null;
      self.setData({ uncertain: uncertain, taskError: api.userMessage(error, '请求结果未确认，请点击继续确认') });
      if (error.code === 'MEMBERSHIP_REQUIRED') self.setData({ membershipRequired: true });
    }).then(function () { if (!self._unloaded) self.setData({ submitting: false }); });
  },
  file: function () {
    const self = this;
    return api.call('pdf.downloadUrl', { taskId: this.data.task.taskId }).then(function (result) {
      if (self._file) return self._file;
      return transfer.downloadToTempFile(result.url, { fileName: result.fileName }).then(function (download) {
        if (self._unloaded) { transfer.removeTempFile(download.filePath); throw new Error('页面已关闭'); }
        self._file = { filePath: download.filePath, fileName: result.fileName };
        return self._file;
      });
    });
  },
  openFile: function (event) {
    if (this.data.opening || !this.data.task || this.data.task.status !== 'completed') return;
    const action = event.currentTarget.dataset.action; const self = this;
    if (action === 'share' && !transfer.canShareFile()) return wx.showToast({ title: '请升级微信后转发文件', icon: 'none' });
    this.setData({ opening: true });
    if (action === 'share' && !this._file) {
      this.file().then(function () { if (!self._unloaded) wx.showToast({ title: '文件已准备好，请再次点击转发', icon: 'none' }); }).catch(function (error) { if (!self._unloaded) wx.showToast({ title: api.userMessage(error, '文件下载失败，请重试'), icon: 'none' }); }).then(function () { if (!self._unloaded) self.setData({ opening: false }); });
      return;
    }
    const operation = action === 'save'
      ? this.file().then(function (file) { if (self._unloaded) return; return transfer.saveToDisk(file.filePath); })
      : action === 'share'
      ? transfer.shareFile(this._file.filePath, this._file.fileName)
      : this.file().then(function (file) { return new Promise(function (resolve, reject) { wx.openDocument({ filePath: file.filePath, fileType: 'pdf', showMenu: true, success: resolve, fail: reject }); }); });
    operation.catch(function (error) { if (!self._unloaded && !transfer.isCancelled(error)) wx.showToast({ title: api.userMessage(error, '文件操作失败，请重试'), icon: 'none' }); }).then(function () { if (!self._unloaded) self.setData({ opening: false }); });
  }
}));
