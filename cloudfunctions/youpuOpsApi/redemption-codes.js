const crypto = require('crypto');
const commerce = require('./commerce');
const records = require('./membership-records');

function createService(deps) {
  const { db, assert, requireOperator, opsMutate, writeOpsAudit, maybeGet } = deps;
  async function generate(event, context) {
    const operator = await requireOperator(context, ['super_admin']);
    const product = commerce.product(event.productId); const quantity = event.quantity === undefined ? 1 : Number(event.quantity);
    assert(product, 'INVALID_INPUT', '请选择有效会员套餐');
    assert(Number.isInteger(quantity) && quantity >= 1 && quantity <= 50, 'INVALID_INPUT', '每批可生成 1 至 50 个兑换码');
    assert(event.note === undefined || (typeof event.note === 'string' && event.note.length <= 100), 'INVALID_INPUT', '批次备注最多 100 字');
    let expiresAt = null;
    assert(event.expiresAt === undefined || event.expiresAt === null || typeof event.expiresAt === 'string', 'INVALID_INPUT', '兑换截止时间无效');
    if (event.expiresAt) {
      assert(typeof event.expiresAt === 'string', 'INVALID_INPUT', '兑换截止时间无效');
      expiresAt = new Date(event.expiresAt);
      assert(Number.isFinite(expiresAt.getTime()), 'INVALID_INPUT', '兑换截止时间无效');
    }
    const note = (event.note || '').trim();
    const fingerprint = records.digest(JSON.stringify([product.productId, quantity, expiresAt && expiresAt.toISOString(), note]));
    const result = await opsMutate(operator, 'commerce.codes.generate', event, async function (transaction) {
      const currentOperator = await maybeGet('operators', operator._id, transaction);
      assert(currentOperator && currentOperator.status === 'active' && currentOperator.role === 'super_admin', 'NO_PERMISSION', '当前运营角色没有此权限');
      assert(!expiresAt || expiresAt.getTime() > Date.now(), 'INVALID_INPUT', '兑换截止时间必须晚于当前时间');
      const batchId = 'batch_' + crypto.randomBytes(12).toString('hex'); const now = new Date();
      for (let index = 0; index < quantity; index += 1) {
        const code = records.generateCode(); const id = records.codeId(code);
        // add with a unique ID refuses collisions without a read per code.
        // A 50-code batch stays below the platform's 100-operation limit.
        await transaction.collection('membership_codes').add({ data: {
          _id: id, batchId, fullCode: records.formatCode(code), codeSuffix: code.slice(-4),
          productId: product.productId, productName: product.name, durationDays: product.durationDays, lifetime: product.lifetime,
          status: 'unused', expiresAt, note, createdBy: operator._id, createdAt: now, updatedAt: now
        } });
      }
      await writeOpsAudit(transaction, operator, 'ops.commerce.codes.generate', 'membership_code_batch', batchId,
        note || '生成会员兑换码', '生成 ' + quantity + ' 个兑换码', event.requestId);
      return { batchId, quantity, productId: product.productId, fingerprint };
    });
    assert(result.fingerprint === fingerprint, 'REQUEST_MISMATCH', '原生成请求与当前参数不一致，请重新提交');
    return { batchId: result.batchId, quantity: result.quantity, productId: result.productId };
  }
  async function list(event, context) {
    await requireOperator(context, ['super_admin', 'operator']);
    const now = new Date(); const command = db.command; const where = {};
    for (const field of ['batchId', 'productId']) {
      assert(!event[field] || (typeof event[field] === 'string' && event[field].length <= 80), 'INVALID_INPUT', '筛选参数无效');
      if (event[field]) where[field] = event[field];
    }
    if (event.status) {
      assert(['unused', 'redeemed', 'revoked', 'expired'].includes(event.status), 'INVALID_INPUT', '兑换码状态无效');
      where.status = event.status === 'expired' ? 'unused' : event.status;
    }
    const filters = [where];
    if (event.status === 'expired') filters.push({ expiresAt: command.neq(null) }, { expiresAt: command.lte(now) });
    if (event.status === 'unused') filters.push(command.or([{ expiresAt: null }, { expiresAt: command.gt(now) }]));
    let cursor;
    if (event.cursor) {
      try { cursor = JSON.parse(Buffer.from(String(event.cursor), 'base64url').toString()); } catch (error) { /* validate below */ }
      assert(String(event.cursor).length <= 512 && cursor && typeof cursor.id === 'string' && cursor.id.length <= 100 && Number.isFinite(new Date(cursor.t).getTime()), 'INVALID_CURSOR', '分页标识无效');
      filters.push(command.or([{ createdAt: command.lt(new Date(cursor.t)) }, { createdAt: new Date(cursor.t), _id: command.lt(cursor.id) }]));
    }
    const size = Math.max(1, Math.min(Math.floor(Number(event.pageSize) || 25), 50));
    const result = await db.collection('membership_codes').where(command.and(filters)).orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(size + 1).get();
    const rows = result.data || []; const items = rows.slice(0, size).map(row => records.publicCode(row, now)); const last = items[items.length - 1];
    return { items, hasMore: rows.length > size, nextCursor: rows.length > size ? Buffer.from(JSON.stringify({ t: new Date(last.createdAt).toISOString(), id: last._id })).toString('base64url') : '' };
  }
  async function reveal(event, context) {
    const operator = await requireOperator(context, ['super_admin']);
    assert(Boolean(event.codeId) !== Boolean(event.batchId), 'INVALID_INPUT', '请选择单个兑换码或一批兑换码');
    assert(typeof (event.codeId || event.batchId) === 'string' && (event.codeId || event.batchId).length <= 100, 'INVALID_INPUT', '兑换码标识无效');
    let rows;
    if (event.codeId) {
      const row = await maybeGet('membership_codes', event.codeId); assert(row, 'CODE_NOT_FOUND', '兑换码不存在'); rows = [row];
    } else {
      const result = await db.collection('membership_codes').where({ batchId: event.batchId }).limit(51).get(); rows = result.data || [];
      assert(rows.length > 0 && rows.length <= 50, 'CODE_BATCH_INVALID', '兑换码批次不存在或数量异常');
    }
    await writeOpsAudit(db, operator, 'ops.commerce.codes.reveal', 'membership_code', event.codeId || event.batchId, '查看完整兑换码', '查看 ' + rows.length + ' 个完整兑换码', event.requestId);
    return { items: rows.map(row => Object.assign(records.publicCode(row), { code: row.fullCode })) };
  }
  async function revoke(event, context) {
    const operator = await requireOperator(context, ['super_admin']);
    assert(typeof event.codeId === 'string' && event.codeId.length <= 100, 'INVALID_INPUT', '兑换码标识无效');
    const result = await opsMutate(operator, 'commerce.codes.revoke', event, async function (transaction) {
      const currentOperator = await maybeGet('operators', operator._id, transaction);
      assert(currentOperator && currentOperator.status === 'active' && currentOperator.role === 'super_admin', 'NO_PERMISSION', '当前运营角色没有此权限');
      const code = await maybeGet('membership_codes', event.codeId, transaction); assert(code, 'CODE_NOT_FOUND', '兑换码不存在');
      assert(code.status === 'unused' || code.status === 'revoked', 'CODE_ALREADY_REDEEMED', '已兑换的码不能作废');
      if (code.status !== 'revoked') {
        await transaction.collection('membership_codes').doc(code._id).update({ data: { status: 'revoked', revokedBy: operator._id, revokedAt: db.serverDate(), updatedAt: db.serverDate() } });
        await writeOpsAudit(transaction, operator, 'ops.commerce.codes.revoke', 'membership_code', code._id, '作废未使用兑换码', '作废兑换码', event.requestId);
      }
      return { codeId: code._id };
    });
    assert(result.codeId === event.codeId, 'REQUEST_MISMATCH', '原作废请求与当前参数不一致，请重新提交');
    return result;
  }
  async function listRecords(event, context) {
    await requireOperator(context, ['super_admin', 'operator']);
    assert(!event.familyId || (typeof event.familyId === 'string' && event.familyId.length <= 80), 'INVALID_INPUT', '家谱标识无效');
    return records.listRecords(db, assert, event, {});
  }
  async function detail(event, context) {
    const operator = await requireOperator(context, ['super_admin', 'operator']);
    assert(['payment', 'redemption'].includes(event.recordType) && typeof event.recordId === 'string' && event.recordId.length <= 100, 'INVALID_INPUT', '会员记录标识无效');
    const row = await maybeGet(event.recordType === 'payment' ? 'payment_orders' : 'membership_redemptions', event.recordId);
    assert(row, 'RECORD_NOT_FOUND', '会员记录不存在');
    await writeOpsAudit(db, operator, 'ops.commerce.record.view', 'membership_record', event.recordId, '查看会员记录', '查看会员记录', event.requestId, row.familyId);
    return records.publicRecord(row, event.recordType);
  }
  return { generate, list, reveal, revoke, listRecords, detail };
}
module.exports = { createService };
