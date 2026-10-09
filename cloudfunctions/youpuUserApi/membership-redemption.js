const records = require('./membership-records');

function createService(deps) {
  const { db, assert, commerce, getOpenid, requireActiveUser, requireMembership, ACTIVE_ROLES, mutate, maybeGet } = deps;
  async function list(event) {
    const openid = getOpenid(); const user = await requireActiveUser(openid);
    assert(typeof event.familyId === 'string' && event.familyId.length <= 80, 'INVALID_INPUT', '请选择家谱');
    await requireMembership(event.familyId, ACTIVE_ROLES, db, openid, { allowArchived: true });
    return records.listRecords(db, assert, event, { actorId: user._id, paidOnly: true });
  }
  async function redeem(event) {
    const openid = getOpenid(); const user = await requireActiveUser(openid);
    const normalized = records.normalizeCode(event.code);
    assert(typeof event.code === 'string' && event.code.length <= 100 && records.validCode(normalized), 'REDEMPTION_CODE_INVALID', '兑换码无效，请检查后重试');
    assert(typeof event.familyId === 'string' && event.familyId && event.familyId.length <= 80, 'INVALID_INPUT', '请选择家谱');
    await requireMembership(event.familyId, ACTIVE_ROLES, db, openid);
    const id = records.codeId(normalized); const fingerprint = records.digest(event.familyId + ':' + id);
    const result = await mutate('membership.redeem', event, openid, async function (transaction) {
      const access = await requireMembership(event.familyId, ACTIVE_ROLES, transaction, openid);
      const code = await maybeGet(transaction, 'membership_codes', id);
      assert(code, 'REDEMPTION_CODE_INVALID', '兑换码无效，请检查后重试');
      const recordId = 'redeem_' + id;
      if (code.status === 'redeemed' && code.redeemedBy === user._id && code.redeemedFamilyId === event.familyId) {
        const prior = await maybeGet(transaction, 'membership_redemptions', recordId);
        assert(prior, 'REDEMPTION_RECORD_UNAVAILABLE', '兑换记录暂不可读取，请联系客服');
        return { record: records.publicRecord(prior, 'redemption'), fingerprint, alreadyRedeemed: true };
      }
      const now = new Date(); const state = records.codeStatus(code, now);
      assert(state !== 'redeemed', 'REDEMPTION_CODE_USED', '兑换码已被使用');
      assert(state !== 'revoked', 'REDEMPTION_CODE_REVOKED', '兑换码已作废');
      assert(state !== 'expired', 'REDEMPTION_CODE_EXPIRED', '兑换码已过期');
      assert(state === 'unused', 'REDEMPTION_CODE_INVALID', '兑换码不可使用');
      assert(!commerce.entitlementFromFamily(access.family, now).active, 'REDEMPTION_MEMBERSHIP_ACTIVE', '仅免费或会员已到期的家谱可以兑换');
      const endsAt = code.lifetime ? null : new Date(now.getTime() + code.durationDays * 86400000);
      const row = {
        familyId: event.familyId, familyName: access.family.name || '', redeemedBy: user._id,
        codeId: id, batchId: code.batchId, maskedCode: '****-****-****-' + code.codeSuffix,
        productId: code.productId, productName: code.productName, durationDays: code.durationDays,
        lifetime: code.lifetime, redeemedAt: now, createdAt: now, startsAt: now, endsAt
      };
      await transaction.collection('membership_codes').doc(id).update({ data: {
        status: 'redeemed', redeemedBy: user._id, redeemedFamilyId: event.familyId, redeemedAt: now, updatedAt: db.serverDate()
      } });
      await transaction.collection('membership_redemptions').doc(recordId).set({ data: row });
      await transaction.collection('membership_grants').doc('grant_' + recordId).set({ data: {
        familyId: event.familyId, orderId: recordId, recordType: 'redemption', redemptionId: recordId,
        productId: code.productId, durationDays: code.durationDays, lifetime: code.lifetime,
        startsAt: now, endsAt, paidAt: now, status: 'active', createdAt: now, updatedAt: now
      } });
      await transaction.collection('families').doc(event.familyId).update({ data: {
        proLifetime: code.lifetime, proExpiresAt: endsAt || db.command.remove(), proRevision: db.command.inc(1),
        proUpdatedAt: db.serverDate(), updatedAt: db.serverDate()
      } });
      return { record: records.publicRecord(Object.assign({ _id: recordId }, row), 'redemption'), fingerprint, alreadyRedeemed: false };
    });
    assert(result.fingerprint === fingerprint, 'REQUEST_MISMATCH', '原兑换请求与当前输入不一致，请重新提交');
    return { record: result.record, alreadyRedeemed: result.alreadyRedeemed };
  }
  return { redeem, list };
}
module.exports = { createService };
