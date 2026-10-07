// In-memory CloudBase substitute: transactions serialize, roll back on errors,
// and query limits/cursors exercise the real worker's pagination and batches.
function createDatabase() {
  let records = new Map(); let tail = Promise.resolve();
  const database = { now: new Date('2026-10-06T10:00:00Z'), queryHook: null, writeHook: null };
  database.command = { gt: value => ({ op: 'gt', value }), inc: value => ({ op: 'inc', value }) };
  database.serverDate = () => new Date(database.now);
  function scope(state, transactional) {
    return { collection: function (name) {
      function query(where = {}, orders = [], size = 100) {
        const api = {
          where: conditions => query(conditions, orders, size),
          orderBy: (field, direction) => query(where, orders.concat([[field, direction]]), size),
          limit: limit => query(where, orders, limit),
          get: async () => {
            if (database.queryHook) await database.queryHook(name, where);
            const values = Array.from(state().entries()).filter(([key]) => key.startsWith(name + '/')).map(([, value]) => structuredClone(value));
            const filtered = values.filter(row => Object.entries(where).every(([key, value]) => value && value.op === 'gt' ? row[key] > value.value : row[key] === value));
            filtered.sort((a, b) => {
              for (const [field, direction] of orders) {
                if (a[field] < b[field]) return direction === 'desc' ? 1 : -1;
                if (a[field] > b[field]) return direction === 'desc' ? -1 : 1;
              }
              return 0;
            });
            return { data: filtered.slice(0, size) };
          }
        };
        return api;
      }
      return Object.assign(query(), { doc: function (id) {
        const key = name + '/' + id;
        async function write(data, replace) {
          if (database.writeHook) await database.writeHook(name, id, data, transactional);
          const value = replace ? { _id: id } : Object.assign({}, state().get(key));
          if (!replace && !state().has(key)) throw new Error('document with _id ' + id + ' does not exist');
          for (const [field, input] of Object.entries(data)) value[field] = input && input.op === 'inc' ? Number(value[field] || 0) + input.value : structuredClone(input);
          state().set(key, value);
        }
        return {
          get: async () => ({ data: structuredClone(state().get(key)) }),
          set: async ({ data }) => write(data, true), update: async ({ data }) => write(data, false),
          remove: async () => { state().delete(key); }
        };
      } });
    } };
  }
  database.collection = scope(() => records, false).collection;
  database.runTransaction = function (callback) {
    const previous = tail;
    let unlock; tail = new Promise(resolve => { unlock = resolve; });
    return previous.then(async function () {
      const snapshot = structuredClone(records);
      try {
        const result = await callback(scope(() => snapshot, true));
        records = snapshot;
        return result;
      } finally { unlock(); }
    });
  };
  database.put = (name, id, data) => records.set(name + '/' + id, Object.assign({ _id: id }, structuredClone(data)));
  database.get = (name, id) => structuredClone(records.get(name + '/' + id));
  database.all = name => Array.from(records.entries()).filter(([key]) => key.startsWith(name + '/')).map(([, value]) => structuredClone(value));
  return database;
}
module.exports = { createDatabase };
