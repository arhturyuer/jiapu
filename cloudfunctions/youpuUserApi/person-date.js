const { Lunar, LunarYear } = require('lunar-javascript');

const CONVERTIBLE_LUNAR_START = 1800;
const CONVERTIBLE_LUNAR_END = 2100;

function pad(value) { return String(value).padStart(2, '0'); }
function iso(year, month, day) { return String(year).padStart(4, '0') + '-' + pad(month) + '-' + pad(day); }
function solarDayCount(year, month) { const date = new Date(0); date.setUTCFullYear(year, month, 0); return date.getUTCDate(); }

function parseLegacy(value) {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(value || ''));
  if (!match) return null;
  return {
    calendar: 'solar',
    precision: match[3] ? 'day' : match[2] ? 'month' : 'year',
    year: Number(match[1]),
    month: match[2] ? Number(match[2]) : null,
    day: match[3] ? Number(match[3]) : null,
    isLeapMonth: false
  };
}

function normalizeInfo(value) {
  if (value === null || value === '') return { info: null, range: null, legacy: '', error: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: '日期格式不正确' };
  const calendar = value.calendar;
  const precision = value.precision;
  const year = value.year;
  const month = precision === 'year' ? null : value.month;
  const day = precision === 'day' ? value.day : null;
  const isLeapMonth = calendar === 'lunar' && precision !== 'year' && value.isLeapMonth === true;
  if (!['solar', 'lunar'].includes(calendar) || !['year', 'month', 'day'].includes(precision)
    || !Number.isInteger(year) || year < 1 || year > 9999
    || (month !== null && (!Number.isInteger(month) || month < 1 || month > 12))
    || (day !== null && (!Number.isInteger(day) || day < 1 || day > (calendar === 'lunar' ? 30 : solarDayCount(year, month))))
    || (calendar === 'solar' && value.isLeapMonth === true)
    || (value.isLeapMonth !== undefined && typeof value.isLeapMonth !== 'boolean')
    || (precision === 'year' && (value.month !== null && value.month !== undefined || value.day !== null && value.day !== undefined))
    || (precision === 'month' && value.day !== null && value.day !== undefined)) return { error: '日期或精度不正确' };
  const info = { calendar: calendar, precision: precision, year: year, month: month, day: day, isLeapMonth: isLeapMonth };
  if (calendar === 'solar') {
    const start = iso(year, month || 1, day || 1);
    const end = iso(year, month || 12, day || solarDayCount(year, month || 12));
    return { info: info, range: { start: start, end: end }, legacy: precision === 'year' ? String(year).padStart(4, '0') : precision === 'month' ? iso(year, month, 1).slice(0, 7) : start, error: '' };
  }
  if (year < CONVERTIBLE_LUNAR_START || year > CONVERTIBLE_LUNAR_END) return { info: info, range: null, legacy: '', error: '' };
  try {
    const lunarYear = LunarYear.fromYear(year);
    const signedMonth = isLeapMonth ? -month : month;
    const lunarMonth = month === null ? null : lunarYear.getMonth(signedMonth);
    if (month !== null && (!lunarMonth || lunarMonth.getYear() !== year || (day !== null && day > lunarMonth.getDayCount()))) return { error: '农历月份或日期不正确' };
    const first = Lunar.fromYmd(year, month === null ? 1 : signedMonth, day || 1);
    const lastMonth = month === null ? lunarYear.getMonth(12) : lunarMonth;
    const last = precision === 'day' ? first : Lunar.fromYmd(year, month === null ? 12 : signedMonth, lastMonth.getDayCount());
    if (first.getYear() !== year || (month !== null && first.getMonth() !== signedMonth)) return { error: '农历日期不正确' };
    return { info: info, range: { start: first.getSolar().toYmd(), end: last.getSolar().toYmd() }, legacy: '', error: '' };
  } catch (error) {
    return { error: '农历日期不正确' };
  }
}

function legacyRange(value) {
  const parsed = parseLegacy(value);
  if (!parsed) return null;
  const normalized = normalizeInfo(parsed);
  return normalized.error ? null : normalized.range;
}

function effectiveRange(person, prefix) {
  const range = person && person[prefix + 'DateRange'];
  if (range && range.start && range.end) return range;
  if (person && person[prefix + 'DateInfo']) return normalizeInfo(person[prefix + 'DateInfo']).range || null;
  return legacyRange(person && person[prefix + 'Date']);
}

function definitelyDeathBeforeBirth(person) {
  const birth = effectiveRange(person, 'birth');
  const death = effectiveRange(person, 'death');
  return Boolean(birth && death && death.end < birth.start);
}

module.exports = { normalizeInfo, parseLegacy, legacyRange, effectiveRange, definitelyDeathBeforeBirth };
