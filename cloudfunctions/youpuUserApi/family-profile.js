const LIMITS = Object.freeze({ surname: 40, ancestralHome: 100, hallName: 100, generationPoem: 1000, history: 3000, familyMotto: 2000 });
const LABELS = Object.freeze({ name: '家谱名称', description: '家谱介绍', surname: '姓氏', ancestralHome: '祖籍', hallName: '堂号', generationPoem: '字辈', history: '家族历史', familyMotto: '家训', featuredSection: '家庭页重点展示' });
const FEATURED = Object.freeze({ none: '仅展示家族概况', generationPoem: '字辈', history: '家族历史', familyMotto: '家训' });
function clean(value) { return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim(); }
function patch(event, assert) {
  const result = {};
  for (const [field, limit] of Object.entries(LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(event, field)) continue;
    assert(typeof event[field] === 'string', 'INVALID_FAMILY_PROFILE', LABELS[field] + '格式不正确');
    const value = clean(event[field]);
    assert(value.length <= limit, 'INVALID_FAMILY_PROFILE', LABELS[field] + '最多' + limit + '字');
    result[field] = value;
  }
  if (Object.prototype.hasOwnProperty.call(event, 'featuredSection')) {
    assert(typeof event.featuredSection === 'string' && Object.prototype.hasOwnProperty.call(FEATURED, event.featuredSection), 'INVALID_FAMILY_PROFILE', '请选择有效的重点展示内容');
    result.featuredSection = event.featuredSection;
  }
  return result;
}
function full(family) {
  const profile = {};
  for (const field of Object.keys(LIMITS)) profile[field] = family[field] || '';
  profile.featuredSection = Object.prototype.hasOwnProperty.call(FEATURED, family.featuredSection) ? family.featuredSection : 'none';
  return profile;
}
function summary(family) {
  const profile = full(family);
  return { surname: profile.surname, ancestralHome: profile.ancestralHome, hallName: profile.hallName,
    featuredSection: profile.featuredSection, featuredLabel: FEATURED[profile.featuredSection],
    featuredExcerpt: profile.featuredSection === 'none' ? '' : Array.from(profile[profile.featuredSection] || '').slice(0, 100).join('') };
}
function validateFeatured(family, assert) {
  const profile = full(family);
  assert(profile.featuredSection === 'none' || Boolean(profile[profile.featuredSection].trim()), 'INVALID_FAMILY_PROFILE', '请先填写重点内容，或改为仅展示家族概况');
}
module.exports = { LIMITS, LABELS, FEATURED, patch, full, summary, validateFeatured };
