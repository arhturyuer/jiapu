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

function relationDefinition(anchorPersonId, relatedPersonId, relationType) {
  if (relationType === 'father' || relationType === 'mother') {
    return { type: 'parent_child', fromId: relatedPersonId, toId: anchorPersonId };
  }
  if (relationType === 'son' || relationType === 'daughter') {
    return { type: 'parent_child', fromId: anchorPersonId, toId: relatedPersonId };
  }
  if (relationType === 'spouse') {
    return { type: 'spouse', fromId: anchorPersonId, toId: relatedPersonId };
  }
  return null;
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

function hasAlternateConnection(startId, targetId, excludedRelationId, relations) {
  if (!startId || !targetId || startId === targetId) return false;
  const neighbors = {};
  (relations || []).forEach(function (relation) {
    if (!relation || relation.status !== 'active' || relation._id === excludedRelationId) return;
    if (relation.type !== 'parent_child' && relation.type !== 'spouse') return;
    const fromId = relation.fromPersonId;
    const toId = relation.toPersonId;
    if (!fromId || !toId || fromId === toId) return;
    if (!neighbors[fromId]) neighbors[fromId] = [];
    if (!neighbors[toId]) neighbors[toId] = [];
    neighbors[fromId].push(toId);
    neighbors[toId].push(fromId);
  });
  const queue = [startId];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    (neighbors[current] || []).forEach(function (id) {
      if (!visited.has(id)) queue.push(id);
    });
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
  relationDefinition: relationDefinition,
  reachesTarget: reachesTarget,
  hasAlternateConnection: hasAlternateConnection,
  invitationState: invitationState
};
