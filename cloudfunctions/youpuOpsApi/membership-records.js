const crypto = require('crypto');

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function normalizeCode(value) { return String(value || '').toUpperCase().replace(/[\s-]/g, ''); }
function validCode(value) { return value.length === 16 && Array.from(value).every(character => CODE_ALPHABET.includes(character)); }
function generateCode() {
  return Array.from(crypto.randomBytes(16), byte => CODE_ALPHABET[byte & 31]).join('');
}
function formatCode(value) { return value.match(/.{1,4}/g).join('-'); }
function codeId(value) { return 'code_' + digest(value); }
function codeStatus(row, now) {
  return row.status === 'unused' && row.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime() ? 'expired' : row.status;
}
function publicCode(row, now) {
  return {
    _id: row._id, batchId: row.batchId, maskedCode: '****-****-****-' + row.codeSuffix,
    productId: row.productId, productName: row.productName, durationDays: row.durationDays,
    lifetime: row.lifetime, note: row.note || '', status: codeStatus(row, now || new Date()),
    expiresAt: row.expiresAt || null, createdAt: row.createdAt, redeemedAt: row.redeemedAt || null,
    redeemedFamilyId: row.redeemedFamilyId || '', revokedAt: row.revokedAt || null
  };
}
function publicRecord(row, type) {
  const redemption = type === 'redemption';
  return {
    _id: row._id, recordId: type + ':' + row._id, recordType: type,
    orderId: redemption ? '' : row._id, familyId: row.familyId, familyName: row.familyName || '',
    productId: row.productId, productName: row.productName || '',
    priceCents: redemption ? null : Number(row.priceCents) || 0,
    status: redemption ? 'fulfilled' : row.status, createdAt: row.createdAt,
    redeemedAt: redemption ? row.redeemedAt : null, paidAt: row.paidAt || null,
    refundedAt: row.refundedAt || null, fulfilledAt: row.fulfilledAt || null,
    updatedAt: row.updatedAt || null, startsAt: row.startsAt || null, endsAt: row.endsAt || null,
    lifetime: Boolean(row.lifetime), maskedCode: redemption ? row.maskedCode : '',
    paymentMode: redemption ? '' : row.paymentMode || 'mock',
    closeReason: row.closeReason || '', reconcileStatus: row.reconcileStatus || '',
    reconcileMessage: row.reconcileMessage || ''
  };
}
function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: new Date(row.createdAt).toISOString(), id: row._id, type: row.recordType })).toString('base64url');
}
function decodeCursor(value, assert) {
  if (!value) return null;
  let cursor;
  try { cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString()); } catch (error) { /* validation below */ }
  assert(String(value).length <= 512 && cursor && typeof cursor.id === 'string' && cursor.id.length <= 100 &&
    ['payment', 'redemption'].includes(cursor.type) && typeof cursor.t === 'string' && Number.isFinite(new Date(cursor.t).getTime()), 'INVALID_CURSOR', '记录分页标识无效，请重新加载');
  return cursor;
}
function compareRecords(left, right) {
  const time = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  if (time) return time;
  if (left._id !== right._id) return left._id > right._id ? -1 : 1;
  return left.recordType > right.recordType ? -1 : left.recordType === right.recordType ? 0 : 1;
}
async function listRecords(db, assert, event, options) {
  const source = event.recordType || 'all';
  assert(['all', 'payment', 'redemption'].includes(source), 'INVALID_INPUT', '会员记录类型无效');
  const size = Math.max(1, Math.min(Math.floor(Number(event.pageSize) || 10), 50));
  const cursor = decodeCursor(event.cursor, assert); const command = db.command;
  const types = source === 'all' ? ['payment', 'redemption'] : [source];
  const pages = await Promise.all(types.map(async function (type) {
    const where = {};
    if (options.actorId) where[type === 'payment' ? 'payerUserId' : 'redeemedBy'] = options.actorId;
    if (event.familyId) where.familyId = event.familyId;
    if (type === 'payment' && options.paidOnly) where.status = command.in(['fulfilled', 'refunded']);
    let conditions = where;
    if (cursor) {
      const at = new Date(cursor.t);
      const before = [{ createdAt: command.lt(at) }, { createdAt: at, _id: command.lt(cursor.id) }];
      if (type < cursor.type) before.push({ createdAt: at, _id: cursor.id });
      conditions = command.and([where, command.or(before)]);
    }
    const result = await db.collection(type === 'payment' ? 'payment_orders' : 'membership_redemptions')
      .where(conditions).orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(size + 1).get();
    return (result.data || []).map(row => publicRecord(row, type));
  }));
  const merged = pages.flat().sort(compareRecords); const items = merged.slice(0, size);
  return { items, hasMore: merged.length > size, nextCursor: merged.length > size ? encodeCursor(items[items.length - 1]) : '' };
}

module.exports = { digest, normalizeCode, validCode, generateCode, formatCode, codeId, codeStatus, publicCode, publicRecord, listRecords };
