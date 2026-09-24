const EXAMPLE_NAME_LAYOUT_KEY_PREFIX = 'youpu_example_name_layout_';
const EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX = 'youpu_example_display_preference_';
const DEFAULT_PREFERENCE = Object.freeze({
  nameLayout: 'horizontal',
  showChildRankBadge: false,
  showGenderBadge: false,
  showGenderColors: true,
  autoCollapseEnabled: true
});

function publishedDefaults(value) {
  const preference = value || {};
  return {
    nameLayout: preference.nameLayout === 'vertical' ? 'vertical' : 'horizontal',
    showChildRankBadge: preference.showChildRankBadge === true,
    showGenderBadge: preference.showGenderBadge === true,
    showGenderColors: preference.showGenderColors !== false,
    autoCollapseEnabled: preference.autoCollapseEnabled !== false
  };
}

function normalize(value, fallbackNameLayout) {
  const preference = value || {};
  const hasSavedPreference = Boolean(value);
  return {
    nameLayout: preference.nameLayout === 'vertical'
      ? 'vertical'
      : fallbackNameLayout === 'vertical' ? 'vertical' : 'horizontal',
    showChildRankBadge: hasSavedPreference ? preference.showChildRankBadge !== false : false,
    showGenderBadge: hasSavedPreference ? preference.showGenderBadge !== false : false,
    showGenderColors: preference.showGenderColors !== false,
    autoCollapseEnabled: preference.autoCollapseEnabled !== false
  };
}

function legacyNameLayout(slug) {
  try {
    const value = wx.getStorageSync(EXAMPLE_NAME_LAYOUT_KEY_PREFIX + slug);
    return value === 'vertical' || value === 'horizontal' ? value : null;
  } catch (error) {
    return null;
  }
}

function get(slug, exampleDefaults) {
  const fallbackNameLayout = legacyNameLayout(slug);
  try {
    const saved = wx.getStorageSync(EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX + slug);
    if (saved) return normalize(saved, fallbackNameLayout);
  } catch (error) {
    // A storage read failure is equivalent to having no local preference.
  }
  const defaults = publishedDefaults(exampleDefaults);
  if (fallbackNameLayout) defaults.nameLayout = fallbackNameLayout;
  return defaults;
}

function save(slug, preference) {
  const normalized = normalize(preference);
  try {
    wx.setStorageSync(EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX + slug, normalized);
  } catch (error) {}
  return normalized;
}

function saveField(slug, field, value, exampleDefaults) {
  const preference = get(slug, exampleDefaults);
  preference[field] = value;
  return save(slug, preference);
}

module.exports = {
  get: get,
  save: save,
  saveField: saveField,
  normalize: normalize,
  publishedDefaults: publishedDefaults,
  DEFAULT_PREFERENCE: DEFAULT_PREFERENCE,
  EXAMPLE_NAME_LAYOUT_KEY_PREFIX: EXAMPLE_NAME_LAYOUT_KEY_PREFIX,
  EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX: EXAMPLE_DISPLAY_PREFERENCE_KEY_PREFIX
};
