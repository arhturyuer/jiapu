const EXAMPLE_NAME_LAYOUT_KEY_PREFIX = 'youpu_example_name_layout_';
const EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX = 'youpu_example_display_preference_';

function normalize(value, fallbackNameLayout) {
  const preference = value || {};
  return {
    nameLayout: preference.nameLayout === 'vertical'
      ? 'vertical'
      : fallbackNameLayout === 'vertical' ? 'vertical' : 'horizontal',
    showChildRankBadge: preference.showChildRankBadge !== false,
    showGenderBadge: preference.showGenderBadge !== false,
    showGenderColors: preference.showGenderColors !== false
  };
}

function legacyNameLayout(slug) {
  try {
    return wx.getStorageSync(EXAMPLE_NAME_LAYOUT_KEY_PREFIX + slug) === 'vertical' ? 'vertical' : 'horizontal';
  } catch (error) {
    return 'horizontal';
  }
}

function get(slug) {
  const fallbackNameLayout = legacyNameLayout(slug);
  try {
    return normalize(wx.getStorageSync(EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX + slug), fallbackNameLayout);
  } catch (error) {
    return normalize(null, fallbackNameLayout);
  }
}

function save(slug, preference) {
  const normalized = normalize(preference);
  try {
    wx.setStorageSync(EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX + slug, normalized);
  } catch (error) {}
  return normalized;
}

function saveField(slug, field, value) {
  const preference = get(slug);
  preference[field] = value;
  return save(slug, preference);
}

module.exports = {
  get: get,
  save: save,
  saveField: saveField,
  normalize: normalize,
  EXAMPLE_NAME_LAYOUT_KEY_PREFIX: EXAMPLE_NAME_LAYOUT_KEY_PREFIX,
  EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX: EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX
};
