const ACTIVE_ROLES = Object.freeze(['admin', 'member', 'viewer']);

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLength || 200);
}

function cleanDate(value) {
  const text = cleanText(value, 10);
  return /^\d{4}(-\d{2})?(-\d{2})?$/.test(text) ? text : '';
}

function roleAllows(role, allowedRoles) {
  return ACTIVE_ROLES.includes(role) && (!allowedRoles || !allowedRoles.length || allowedRoles.includes(role));
}

function canonicalPair(type, firstId, secondId) {
  if (type === 'spouse' && firstId > secondId) return [secondId, firstId];
  return [firstId, secondId];
}

function reachesTarget(startId, targetId, relations) {
  const children = {};
  (relations || []).forEach(function (relation) {
    if (relation.type !== 'parent_child' || relation.status !== 'active') return;
    if (!children[relation.fromPersonId]) children[relation.fromPersonId] = [];
    children[relation.fromPersonId].push(relation.toPersonId);
  });
  const queue = [startId];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    (children[current] || []).forEach(function (id) { queue.push(id); });
  }
  return false;
}

function invitationState(invitation, now) {
  if (invitation.status !== 'active') return invitation.status;
  if (new Date(invitation.expiresAt).getTime() <= Number(now || Date.now())) return 'expired';
  if ((invitation.useCount || 0) >= invitation.maxUses) return 'exhausted';
  return 'active';
}

module.exports = {
  ACTIVE_ROLES: ACTIVE_ROLES,
  cleanText: cleanText,
  cleanDate: cleanDate,
  roleAllows: roleAllows,
  canonicalPair: canonicalPair,
  reachesTarget: reachesTarget,
  invitationState: invitationState
};
