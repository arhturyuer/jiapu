const { AsyncLocalStorage } = require('node:async_hooks');

// Verified objects belong to one invocation only, including concurrent calls
// on the same warm instance. Transactional reads never use these objects.
const requests = new AsyncLocalStorage();
const transactions = new WeakMap();

function run(callback) {
  return requests.run({ users: new Map(), access: new Map(), receipts: [] }, callback);
}

function rememberUser(user) {
  const request = requests.getStore();
  if (request && user && user._id) request.users.set(user._id, user);
}

function rememberAccess(access) {
  const request = requests.getStore();
  if (request && access && access.family) request.access.set(access.family._id, access);
}

function user(id) {
  const request = requests.getStore();
  return request && request.users.get(id);
}

function access(familyId, userId) {
  const request = requests.getStore();
  const value = request && request.access.get(familyId);
  return value && value.membership.userId === userId && value.family.status === 'active' ? value : null;
}

function invalidate() {
  const request = requests.getStore();
  if (request) { request.users.clear(); request.access.clear(); }
}

function rememberActivity(receipt) {
  const request = requests.getStore();
  if (request && receipt) request.receipts.push(receipt);
}
function activityReceipts() { const request = requests.getStore(); return request ? request.receipts.slice() : []; }

function transactionState(scope) {
  if (!transactions.has(scope)) transactions.set(scope, { actor: null, revisedFamilies: new Set() });
  return transactions.get(scope);
}

function rememberTransactionActor(scope, actor) { transactionState(scope).actor = actor; }
function transactionActor(scope, id) {
  const actor = transactionState(scope).actor;
  return actor && actor._id === id ? actor : null;
}
function markFamilyRevision(scope, familyId) { transactionState(scope).revisedFamilies.add(familyId); }
function hasFamilyRevision(scope, familyId) { return transactionState(scope).revisedFamilies.has(familyId); }

module.exports = { run, rememberUser, rememberAccess, user, access, invalidate,
  rememberTransactionActor, transactionActor, markFamilyRevision, hasFamilyRevision, rememberActivity, activityReceipts };
