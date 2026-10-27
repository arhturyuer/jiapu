const GROUPS = ['基本信息', '家族概况', '字辈与家训', '家族历史'];
const FIELDS = [
  { key: 'name', label: '家谱名称', max: 40, group: 0 },
  { key: 'description', label: '简介', max: 200, group: 0, multiline: true },
  { key: 'surname', label: '姓氏', max: 40, group: 1 },
  { key: 'ancestralHome', label: '祖籍', max: 100, group: 1 },
  { key: 'hallName', label: '堂号', max: 100, group: 1 },
  { key: 'generationPoem', label: '字辈', max: 1000, group: 2, multiline: true, help: '按原顺序记录，保留换行；没有字辈可以留空。' },
  { key: 'familyMotto', label: '家训', max: 2000, group: 2, multiline: true },
  { key: 'history', label: '家族历史', max: 3000, group: 3, multiline: true, help: '可以记录家族起源、迁徙和重要往事；尚未核实的内容可注明来源。' }
];
const FEATURED = [{ key: 'none', label: '仅展示家族概况' }, { key: 'generationPoem', label: '字辈' }, { key: 'history', label: '家族历史' }, { key: 'familyMotto', label: '家训' }];
function form(data) {
  const source = Object.assign({}, data.family, data.profile);
  const result = {};
  FIELDS.forEach(field => { result[field.key] = source[field.key] || ''; });
  result.featuredSection = source.featuredSection || 'none';
  return result;
}
function normalize(value) {
  const result = {};
  FIELDS.forEach(field => { result[field.key] = String(value[field.key] || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim(); });
  result.featuredSection = value.featuredSection || 'none';
  return result;
}
function validate(value) {
  const data = normalize(value);
  for (const field of FIELDS) {
    if (field.key === 'name' && !data.name) return { key: 'name', group: 0, message: '请填写家谱名称' };
    if (data[field.key].length > field.max) return { key: field.key, group: field.group, message: field.label + '最多' + field.max + '字' };
  }
  if (!FEATURED.some(item => item.key === data.featuredSection)) return { key: 'featuredSection', group: 0, message: '请选择有效的重点展示内容' };
  if (data.featuredSection !== 'none' && !data[data.featuredSection]) {
    return { key: data.featuredSection, group: FIELDS.find(field => field.key === data.featuredSection).group, message: '请先填写重点内容，或改为仅展示家族概况' };
  }
  return null;
}
function scope(app) {
  const data = app.globalData || {};
  return JSON.stringify([app._sessionVersion || 0, data.environment, data.env, data.user && data.user._id, data.currentFamily && data.currentFamily._id]);
}
module.exports = { GROUPS, FIELDS, FEATURED, form, normalize, validate, scope };
