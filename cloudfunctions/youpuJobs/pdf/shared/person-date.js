function emptyDraft() {
  return { calendar: 'solar', precision: 'year', year: '', month: '', day: '', isLeapMonth: false };
}

function fromPerson(person, prefix) {
  const source = person || {};
  const info = source[prefix + 'DateInfo'];
  if (info && info.year) return {
    calendar: info.calendar === 'lunar' ? 'lunar' : 'solar',
    precision: info.precision || 'year',
    year: String(info.year), month: info.month ? String(info.month) : '', day: info.day ? String(info.day) : '',
    isLeapMonth: Boolean(info.isLeapMonth)
  };
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(source[prefix + 'Date'] || '');
  if (!match) return emptyDraft();
  return { calendar: 'solar', precision: match[3] ? 'day' : match[2] ? 'month' : 'year', year: match[1], month: match[2] || '', day: match[3] || '', isLeapMonth: false };
}

function toInfo(draft) {
  if (!draft || (!String(draft.year || '').trim() && !String(draft.month || '').trim() && !String(draft.day || '').trim())) return { info: null, error: '' };
  const year = Number(draft.year), month = Number(draft.month), day = Number(draft.day);
  if (!Number.isInteger(year) || year < 1 || year > 9999) return { error: '请输入有效的四位年份' };
  if (draft.precision !== 'year' && (!Number.isInteger(month) || month < 1 || month > 12)) return { error: '请输入 1 到 12 月' };
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month, 0);
  const maxDay = draft.calendar === 'lunar' ? 30 : lastDay.getUTCDate();
  if (draft.precision === 'day' && (!Number.isInteger(day) || day < 1 || day > maxDay)) return { error: '请输入有效日期' };
  return { info: { calendar: draft.calendar, precision: draft.precision, year: year,
    month: draft.precision === 'year' ? null : month, day: draft.precision === 'day' ? day : null,
    isLeapMonth: draft.calendar === 'lunar' && draft.precision !== 'year' && Boolean(draft.isLeapMonth) }, error: '' };
}

function displayDraft(draft) {
  if (!draft.year) return '';
  return (draft.calendar === 'lunar' ? '农历 ' : '公历 ') + draft.year + '年'
    + (draft.precision === 'year' ? '' : (draft.isLeapMonth ? '闰' : '') + Number(draft.month) + '月')
    + (draft.precision === 'day' ? Number(draft.day) + '日' : '');
}

function display(person, prefix) {
  return displayDraft(fromPerson(person, prefix));
}

function range(person, prefix) {
  const source = person || {};
  const stored = source[prefix + 'DateRange'];
  if (stored && stored.start && stored.end) return stored;
  const draft = fromPerson(source, prefix);
  if (!draft.year || draft.calendar !== 'solar') return null;
  const year = Number(draft.year), month = Number(draft.month);
  if (!Number.isInteger(year) || year < 1 || year > 9999 || (draft.precision !== 'year' && (month < 1 || month > 12))) return null;
  function pad(value) { return String(value).padStart(2, '0'); }
  const startMonth = draft.precision === 'year' ? 1 : month;
  const endMonth = draft.precision === 'year' ? 12 : month;
  const startDay = draft.precision === 'day' ? Number(draft.day) : 1;
  const last = new Date(0);
  last.setFullYear(year, endMonth, 0);
  const endDay = draft.precision === 'day' ? Number(draft.day) : last.getDate();
  if (draft.precision === 'day' && (!Number.isInteger(endDay) || endDay < 1 || endDay > last.getDate())) return null;
  return { start: draft.year + '-' + pad(startMonth) + '-' + pad(startDay), end: draft.year + '-' + pad(endMonth) + '-' + pad(endDay) };
}

function comparableOrder(first, second) {
  const a = range(first, 'birth'), b = range(second, 'birth');
  if (!a || !b) return 0;
  return a.end < b.start ? -1 : b.end < a.start ? 1 : 0;
}

function definitelyAtLeast(person, years, today) {
  const birth = range(person, 'birth');
  if (!birth) return false;
  const date = today || new Date();
  const cutoff = String(date.getFullYear() - years).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  return birth.end <= cutoff;
}

module.exports = { emptyDraft, fromPerson, toInfo, displayDraft, display, range, comparableOrder, definitelyAtLeast };
