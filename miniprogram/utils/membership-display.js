const format = require('./format');

function fromFamily(family) {
  const membership = family && family.membership ? family.membership : {};
  if (!membership.active) {
    return {
      active: false,
      tierText: '免费版',
      detailText: '升级后全体家人共享会员权益'
    };
  }
  if (membership.lifetime) {
    return {
      active: true,
      tierText: '会员版',
      detailText: '永久有效 · 全体家人共享'
    };
  }
  const expiresText = format.dateText(membership.expiresAt);
  return {
    active: true,
    tierText: '会员版',
    detailText: expiresText ? ('有效至 ' + expiresText + ' · 全体家人共享') : '全体家人共享会员权益'
  };
}

module.exports = { fromFamily: fromFamily };
