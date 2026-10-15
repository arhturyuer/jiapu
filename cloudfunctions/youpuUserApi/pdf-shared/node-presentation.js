// Shared, deterministic node content for native views, canvas, SVG and PDF.
const COMPOUND_SURNAMES = new Set('欧阳 太史 端木 上官 司马 东方 独孤 南宫 万俟 闻人 夏侯 诸葛 尉迟 公羊 赫连 澹台 皇甫 宗政 濮阳 公冶 太叔 申屠 公孙 慕容 仲孙 钟离 长孙 宇文 司徒 鲜于 司空 闾丘 子车 亓官 司寇 巫马 公西 颛孙 壤驷 公良 漆雕 乐正 宰父 谷梁 拓跋 夹谷 轩辕 令狐 段干 百里 呼延 东郭 南门 羊舌 微生 梁丘 左丘 东门 西门 第五'.split(' '));
function systemAvatar(gender, enabled) {
  const variant = enabled && (gender === 'male' || gender === 'female') ? gender : 'neutral';
  return '/images/system-avatar-' + variant + '.png';
}
function characters(name) { return Array.from(String(name || '未命名')); }
function surname(name) {
  const chars = Array.from(String(name || '').trim());
  const pair = chars.slice(0, 2).join('');
  return COMPOUND_SURNAMES.has(pair) ? pair : chars[0] || '家';
}
function surnameFontSize(value) { return Array.from(value).length > 1 ? 20 : 26; }
function parts(name, capacity, count) {
  let chars = characters(name);
  if (chars.length > capacity * count) chars = chars.slice(0, capacity * count - 1).concat('…');
  const result = [];
  for (let i = 0; i < chars.length; i += capacity) result.push(chars.slice(i, i + capacity));
  return result;
}
function nameLines(name) { return parts(name, 5, 2).map(function (line) { return line.join(''); }); }
function nameColumns(name) { return parts(name, 4, 2).map(function (column) { return column.join('\n'); }); }
function avatarPreference(value, legacy) {
  const source = value || {};
  return { showAvatar: source.showAvatar !== false,
    emptyAvatarStyle: source.emptyAvatarStyle === 'default' || source.emptyAvatarStyle === 'surname'
      ? source.emptyAvatarStyle : legacy ? 'surname' : 'default' };
}
function avatarKind(photo, preference) {
  if (preference.showAvatar === false) return 'hidden';
  return photo ? 'photo' : preference.emptyAvatarStyle === 'surname' ? 'surname' : 'default';
}
function width(name, baseWidth, vertical, legacy) {
  return baseWidth + (vertical && !legacy && characters(name).length > 4 ? 32 : 0);
}
function horizontalContent(name, height, showAvatar, meta) {
  const lines = nameLines(name);
  const textHeight = lines.length * 30 + (meta ? 26 : 0);
  const nameTop = showAvatar ? 68 : (height - textHeight) / 2;
  return { lines: lines, nameTop: nameTop, metaCenter: nameTop + lines.length * 30 + 14 };
}
module.exports = { systemAvatar, surname, surnameFontSize, nameLines, nameColumns, avatarPreference, avatarKind, width, horizontalContent };
