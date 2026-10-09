// Transaction writes are isolated and rolled back. Queries intentionally live
// outside transactions, matching CloudBase's document-only transaction API.
function createDatabase() {
  let state = new Map(); let queue = Promise.resolve();
  const db = { queryHook: null, writeHook: null, now: new Date() };
  db.command = {};
  for (const op of ['lt', 'lte', 'gt', 'gte', 'neq', 'in', 'and', 'or', 'inc']) db.command[op] = value => ({ op, value });
  db.command.remove = () => ({ op: 'remove' }); db.serverDate = () => new Date(db.now);
  function equal(a, b) { return a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : a === b; }
  function match(row, where) {
    if (where && where.op === 'and') return where.value.every(condition => match(row, condition));
    if (where && where.op === 'or') return where.value.some(condition => match(row, condition));
    return Object.entries(where || {}).every(([key, value]) => {
      const current = row[key];
      if (!value || !value.op) return equal(current, value);
      if (value.op === 'in') return value.value.some(item => equal(current, item));
      if (value.op === 'neq') return !equal(current, value.value);
      if (current === null || current === undefined) return false;
      return ({ lt: () => current < value.value, lte: () => current <= value.value, gt: () => current > value.value, gte: () => current >= value.value })[value.op]();
    });
  }
  function scope(current, transactional) {
    return { collection(name) {
      function query(where = {}, orders = [], offset = 0, size = 100) {
        return {
          where: value => query(value, orders, offset, size), orderBy: (field, order) => query(where, [...orders, [field, order]], offset, size),
          skip: value => query(where, orders, value, size), limit: value => query(where, orders, offset, value),
          count: async () => ({ total: Array.from(current().entries()).filter(([key, row]) => key.startsWith(name + '/') && match(row, where)).length }),
          async get() {
            if (transactional) throw new Error('transaction queries unsupported');
            const values = Array.from(current().entries()).filter(([key, row]) => key.startsWith(name + '/') && match(row, where)).map(([, row]) => structuredClone(row));
            values.sort((a, b) => {
              for (const [field, order] of orders) {
                if (a[field] < b[field]) return order === 'desc' ? 1 : -1;
                if (a[field] > b[field]) return order === 'desc' ? -1 : 1;
              }
              return 0;
            });
            if (db.queryHook) await db.queryHook(name, where);
            return { data: values.slice(offset, offset + size) };
          }
        };
      }
      return Object.assign(query(), {
        async add({ data }) {
          const id = data._id || 'audit_' + current().size;
          if (current().has(name + '/' + id)) throw new Error('duplicate key');
          await this.doc(id).set({ data }); return { _id: id };
        },
        doc(id) {
          const key = name + '/' + id;
          async function write(data, replace) {
            if (db.writeHook) await db.writeHook(name, id, data, transactional);
            if (!replace && !current().has(key)) throw new Error('missing document');
            const row = replace ? { _id: id } : structuredClone(current().get(key));
            for (const [field, value] of Object.entries(data)) {
              if (value && value.op === 'inc') row[field] = Number(row[field] || 0) + value.value;
              else if (value && value.op === 'remove') delete row[field];
              else row[field] = structuredClone(value);
            }
            current().set(key, row);
          }
          return { get: async () => ({ data: structuredClone(current().get(key)) }), set: async ({ data }) => write(data, true), update: async ({ data }) => write(data, false), remove: async () => current().delete(key) };
        }
      });
    } };
  }
  db.collection = scope(() => state, false).collection;
  db.runTransaction = callback => {
    const previous = queue; let unlock; queue = new Promise(resolve => { unlock = resolve; });
    return previous.then(async () => {
      const next = structuredClone(state);
      try { const result = await callback(scope(() => next, true)); state = next; return result; }
      finally { unlock(); }
    });
  };
  db.put = (name, id, row) => state.set(name + '/' + id, { ...structuredClone(row), _id: id });
  db.get = (name, id) => structuredClone(state.get(name + '/' + id));
  db.all = name => Array.from(state.entries()).filter(([key]) => key.startsWith(name + '/')).map(([, value]) => structuredClone(value));
  return db;
}
module.exports = { createDatabase };
