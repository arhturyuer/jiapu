require('./helpers/test-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const formFocus = require('../miniprogram/utils/form-focus');
const personDate = require('../miniprogram/utils/person-date');

function setup(t, pageName, elderMode) {
  const previous = { wx: global.wx, getApp: global.getApp, Page: global.Page, Component: global.Component };
  const native = { keyboard: true, calls: 0 };
  global.wx = { hideKeyboard: function () { native.keyboard = false; native.calls++; }, showToast: function () {} };
  global.getApp = () => ({});
  let pageDefinition, pickerDefinition;
  global.Page = value => { pageDefinition = value; };
  global.Component = value => { pickerDefinition = value; };
  for (const file of ['../miniprogram/pages/' + pageName + '/index', '../miniprogram/components/person-date-picker/index']) {
    const resolved = require.resolve(file); delete require.cache[resolved]; require(resolved);
  }
  const queue = [];
  const events = [];
  const page = Object.assign({}, pageDefinition, { data: Object.assign(structuredClone(pageDefinition.data), {
    elderMode, readingNameFocus: true, birthPlace: '虚构籍贯', bio: '尚未保存的简介'
  }) });
  page.setData = function (patch, callback) {
    Object.assign(this.data, patch);
    // Model a native keyboard being restored when inputs are re-enabled.
    if (patch.datePickerOpen === false) native.keyboard = true;
    if (callback) queue.push(callback);
  };
  const picker = Object.assign({}, pickerDefinition.methods, { data: Object.assign(structuredClone(pickerDefinition.data), {
    value: { calendar: 'solar', precision: 'day', year: '2004', month: '1', day: '6', isLeapMonth: false }
  }) });
  picker.setData = function (patch, callback) {
    for (const [field, value] of Object.entries(patch)) {
      if (field.includes('.')) this.data[field.split('.')[0]][field.split('.')[1]] = value;
      else this.data[field] = value;
    }
    if (callback) queue.push(callback);
  };
  picker.triggerEvent = function (name, detail) {
    events.push({ name, detail });
    if (name === 'visibilitychange') page.onDatePickerVisibilityChange({ detail });
    if (name === 'change') page.onBirthDateChange({ detail });
  };
  function flush() { while (queue.length) queue.shift()(); }
  t.after(() => { page.onUnload(); Object.assign(global, previous); });
  return { page, picker, native, events, flush };
}

for (const pageName of ['edit-member', 'add-member']) {
  for (const elderMode of [false, true]) {
    test(pageName + ' 日期确认不恢复原焦点或键盘，长辈模式=' + elderMode, function (t) {
      const { page, picker, native, events, flush } = setup(t, pageName, elderMode);
      picker.open();
      assert.equal(page.data.datePickerOpen, true);
      assert.equal(page.data.readingNameFocus, false);
      assert.equal(native.keyboard, false);
      flush();
      picker.data.working.day = '7';
      picker.confirm();
      // Inputs remain disabled until the overlay's removal is committed.
      assert.equal(page.data.datePickerOpen, true);
      assert.equal(page.data.birthDraft.day, '7');
      flush();
      assert.equal(page.data.datePickerOpen, false);
      assert.equal(page.data.readingNameFocus, false);
      assert.equal(native.keyboard, false);
      assert.equal(page.data.birthPlace, '虚构籍贯');
      assert.equal(page.data.bio, '尚未保存的简介');
      assert.equal(events.filter(event => event.name === 'change').length, 1);
      // The guard is released: subsequent deliberate text editing is allowed.
      assert.equal(page.data.datePickerOpen, false);
      page.inputField({ currentTarget: { dataset: { field: 'birthPlace' } }, detail: { value: '主动重新输入' } });
      assert.equal(page.data.birthPlace, '主动重新输入');
    });
  }
}

test('取消不修改日期，清空确认释放输入限制且不恢复键盘', function (t) {
  const { page, picker, native, events, flush } = setup(t, 'edit-member', false);
  const original = structuredClone(page.data.birthDraft);
  picker.open(); flush();
  picker.data.working.year = '2005';
  picker.close(); flush();
  assert.deepEqual(page.data.birthDraft, original);
  assert.equal(events.filter(event => event.name === 'change').length, 0);
  assert.equal(native.keyboard, false);
  picker.open(); flush(); picker.clear(); picker.confirm(); flush();
  assert.equal(personDate.toInfo(page.data.birthDraft).info, null);
  assert.equal(page.data.datePickerOpen, false);
  assert.equal(native.keyboard, false);
});

test('校验失败保持弹层和输入限制，不提交日期或调起键盘', function (t) {
  const { page, picker, native, events, flush } = setup(t, 'edit-member', false);
  picker.open(); flush();
  picker.data.working = { calendar: 'solar', precision: 'day', year: '1900', month: '2', day: '29', isLeapMonth: false };
  picker.confirm();
  assert.equal(picker.data.shown, true);
  assert.equal(page.data.datePickerOpen, true);
  assert.equal(native.keyboard, false);
  assert.equal(events.filter(event => event.name === 'change').length, 0);
});

test('收键盘接口缺失或失败不阻塞日期交互', async function (t) {
  const previous = global.wx;
  t.after(() => { global.wx = previous; });
  global.wx = {};
  assert.doesNotThrow(() => formFocus.hideKeyboard());
  global.wx.hideKeyboard = () => { throw new Error('unsupported'); };
  assert.doesNotThrow(() => formFocus.hideKeyboard());
  global.wx.hideKeyboard = () => Promise.reject(new Error('keyboard already hidden'));
  formFocus.hideKeyboard();
  await Promise.resolve();
});

test('日期确认和取消捕获点击，两页文本控件在弹层内禁用', function () {
  const root = path.resolve(__dirname, '../miniprogram');
  const picker = fs.readFileSync(path.join(root, 'components/person-date-picker/index.wxml'), 'utf8');
  assert.match(picker, /<button catchtap="confirm">确定<\/button>/);
  assert.doesNotMatch(picker, /bindtap="(?:confirm|close)"/);
  for (const page of ['edit-member', 'add-member']) {
    const template = fs.readFileSync(path.join(root, 'pages', page, 'index.wxml'), 'utf8');
    for (const control of template.match(/<(?:input|textarea)\b[^>]*>/g)) assert.match(control, /disabled="\{\{datePickerOpen\}\}"/);
    for (const control of template.match(/<person-date-picker\b[^>]*>/g)) assert.match(control, /bindvisibilitychange="onDatePickerVisibilityChange"/);
  }
});
