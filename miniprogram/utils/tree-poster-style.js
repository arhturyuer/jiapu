const COLORS = { male: ['#E6EFF5', '#416B89'], female: ['#F5E7EB', '#985565'] };
function genderColors(node, enabled) {
  const pair = enabled && (node.gender === 'male' || node.gender === 'female') && COLORS[node.gender];
  return pair
    ? { surface: pair[0], border: pair[1], avatar: pair[0], text: pair[1], badge: pair[1] }
    : { surface: '#FFFEFA', border: '#D8DED9', avatar: '#E4EFEA', text: '#245C4A', badge: '#65706A' };
}
module.exports = { genderColors };
