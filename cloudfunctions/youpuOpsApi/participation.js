function classify(createdFamilyCount, joinedFamilyCount) {
  const created = Math.max(0, Number(createdFamilyCount) || 0);
  const joined = Math.max(0, Number(joinedFamilyCount) || 0);
  if (created > 0 && joined > 0) return 'creator_member';
  if (created > 0) return 'creator';
  if (joined > 0) return 'member';
  return 'visitor';
}

function summarize(createdFamilyCount, joinedFamilyCount) {
  const created = Math.max(0, Number(createdFamilyCount) || 0);
  const joined = Math.max(0, Number(joinedFamilyCount) || 0);
  return {
    createdFamilyCount: created,
    joinedFamilyCount: joined,
    activeFamilyCount: created + joined,
    participationType: classify(created, joined)
  };
}

module.exports = { classify: classify, summarize: summarize };
