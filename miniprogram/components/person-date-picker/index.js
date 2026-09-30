const personDate = require('../../utils/person-date');

const MONTHS = [{ value: '', label: '无' }].concat(Array.from({ length: 12 }, function (_, index) {
  return { value: String(index + 1), label: String(index + 1) + '月' };
}));

function yearsFor() {
  const years = [{ value: '', label: '无' }];
  for (let year = new Date().getFullYear(); year >= 1; year -= 1) years.push({ value: String(year), label: year + '年' });
  return years;
}

function daysFor(calendar, year, month) {
  let count = calendar === 'lunar' ? 30 : 31;
  if (calendar === 'solar' && Number(year) > 0 && Number(month) > 0) {
    const last = new Date(0);
    last.setUTCFullYear(Number(year), Number(month), 0);
    count = last.getUTCDate();
  }
  return [{ value: '', label: '无' }].concat(Array.from({ length: count }, function (_, index) {
    return { value: String(index + 1), label: String(index + 1) + '日' };
  }));
}

function selectedIndex(options, value) {
  const index = options.findIndex(function (item) { return item.value === String(value || ''); });
  return index < 0 ? 0 : index;
}

function workingDraft(source) {
  const value = Object.assign(personDate.emptyDraft(), source || {});
  value.year = String(value.year || '');
  value.month = value.year ? String(value.month || '') : '';
  value.day = value.month ? String(value.day || '') : '';
  value.precision = value.day ? 'day' : value.month ? 'month' : 'year';
  value.isLeapMonth = value.calendar === 'lunar' && Boolean(value.month) && Boolean(value.isLeapMonth);
  return value;
}

Component({
  properties: {
    label: { type: String, value: '出生时间' },
    value: {
      type: Object,
      value: personDate.emptyDraft(),
      observer: function (value) { this.setData({ summary: personDate.displayDraft(workingDraft(value)) }); }
    }
  },
  data: {
    shown: false,
    summary: '',
    working: personDate.emptyDraft(),
    yearOptions: [],
    monthOptions: MONTHS,
    dayOptions: daysFor('solar', '', ''),
    pickerValue: [0, 0, 0]
  },
  lifetimes: {
    attached: function () { this.setData({ summary: personDate.displayDraft(workingDraft(this.data.value)) }); }
  },
  methods: {
    open: function () {
      const working = workingDraft(this.data.value);
      const yearOptions = yearsFor();
      const dayOptions = daysFor(working.calendar, working.year, working.month);
      this.setData({ shown: true, working: working, yearOptions: yearOptions, dayOptions: dayOptions,
        pickerValue: [selectedIndex(yearOptions, working.year), selectedIndex(MONTHS, working.month), selectedIndex(dayOptions, working.day)] });
    },
    close: function () { this.setData({ shown: false }); },
    noop: function () {},
    chooseCalendar: function (event) {
      const calendar = event.currentTarget.dataset.calendar;
      if (calendar === this.data.working.calendar) return;
      const working = workingDraft(Object.assign({}, this.data.working, { calendar: calendar, isLeapMonth: false }));
      const dayOptions = daysFor(calendar, working.year, working.month);
      if (!dayOptions.some(function (item) { return item.value === working.day; })) working.day = '';
      working.precision = working.day ? 'day' : working.month ? 'month' : 'year';
      this.setData({ working: working, dayOptions: dayOptions,
        pickerValue: [this.data.pickerValue[0], this.data.pickerValue[1], selectedIndex(dayOptions, working.day)] });
    },
    chooseDate: function (event) {
      const indexes = event.detail.value || [0, 0, 0];
      const year = (this.data.yearOptions[indexes[0]] || {}).value || '';
      const month = year ? (MONTHS[indexes[1]] || {}).value || '' : '';
      const oldDay = month ? (this.data.dayOptions[indexes[2]] || {}).value || '' : '';
      const dayOptions = daysFor(this.data.working.calendar, year, month);
      const day = dayOptions.some(function (item) { return item.value === oldDay; }) ? oldDay : '';
      const working = workingDraft(Object.assign({}, this.data.working, { year: year, month: month, day: day }));
      this.setData({ working: working, dayOptions: dayOptions,
        pickerValue: [selectedIndex(this.data.yearOptions, year), selectedIndex(MONTHS, month), selectedIndex(dayOptions, day)] });
    },
    toggleLeapMonth: function () {
      if (this.data.working.calendar !== 'lunar' || !this.data.working.month) return;
      this.setData({ 'working.isLeapMonth': !this.data.working.isLeapMonth });
    },
    clear: function () {
      const working = workingDraft({ calendar: this.data.working.calendar });
      this.setData({ working: working, dayOptions: daysFor(working.calendar, '', ''), pickerValue: [0, 0, 0] });
    },
    confirm: function () {
      const working = workingDraft(this.data.working);
      const result = personDate.toInfo(working);
      if (result.error) { wx.showToast({ title: result.error, icon: 'none' }); return; }
      this.triggerEvent('change', { value: working });
      this.setData({ shown: false });
    }
  }
});

module.exports = { workingDraft, yearsFor, daysFor };
