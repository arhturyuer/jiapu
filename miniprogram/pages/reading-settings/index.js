const launchAd = require('../../utils/launch-ad');
const reading = require('../../utils/reading-preference');

Page(launchAd.wrap({
  data: { fontOptions: [{ value: 'system', label: '跟随微信' }, { value: 1, label: '标准' },
    { value: 1.25, label: '125%' }, { value: 1.5, label: '150%' }, { value: 2, label: '200%' }], fontScale: 'system', persistenceMessage: '' },
  onShow: function () { this.setData(reading.get()); },
  onReadingChange: function () { this.setData(reading.get()); },
  save: function (patch) {
    const result = reading.save(patch);
    this.setData(Object.assign({}, result.preference, { persistenceMessage: result.persisted ? '设置已保存，仅影响本机显示' : '当前设置已生效，但本机保存失败；重新打开后可能恢复默认' }));
  },
  chooseScale: function (event) {
    const value = event.currentTarget.dataset.scale;
    this.save({ fontScale: value === 'system' ? 'system' : Number(value) });
  },
  toggleElder: function (event) { this.save({ elderMode: Boolean(event.detail.value) }); },
  restoreDefault: function () { this.save({ elderMode: false, fontScale: 'system' }); }
}));
