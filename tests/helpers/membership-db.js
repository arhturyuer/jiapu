// Transaction writes are isolated and rolled back. Queries intentionally live
// outside transactions, matching CloudBase's document-only transaction API.
function createDatabase() {
  let state = new Map(); let queue = Promise.resolve();
  const db = { queryHook: null, writeHook: null, now: new Date() };
  db.command = {};
  for (const op of ['lt', 'lte', 'gt', 'gte', 'neq', 'in', 'and', 'or', 'inc']) db.command[op] = value => ({ op, value });
  db.command.aggregate = {};
  for (const op of ['sum', 'cond', 'ifNull', 'neq', 'eq', 'and', 'or', 'add']) db.command.aggregate[op] = value => ({ aggregate: op, value });
  function expression(value, row) {
    if (typeof value === 'string' && value.startsWith('$')) return row[value.slice(1)];
    if (Array.isArray(value)) return value.map(item => expression(item, row));
    if (!value || !value.aggregate) return value;
    const args = expression(value.value, row);
    switch (value.aggregate) {
      case 'ifNull': return args[0] == null ? args[1] : args[0];
      case 'neq': return args[0] !== args[1];
      case 'eq': return args[0] === args[1];
      case 'and': return args.every(Boolean);
      case 'or': return args.some(Boolean);
      case 'cond': return args[0] ? args[1] : args[2];
      case 'add': return args.reduce((total, item) => total + item, 0);
      default: throw new Error('unsupported aggregate ' + value.aggregate);
    }
  }
  db.command.remove = () => ({ op: 'remove' }); db.serverDate = () => new Date(db.now);
  db.command.set = value => ({ op: 'set', value });
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
          async update({ data }) {
            if (transactional) throw new Error('transaction queries unsupported');
            const ids = Array.from(current().entries()).filter(([key, row]) => key.startsWith(name + '/') && match(row, where)).map(([, row]) => row._id);
            for (const id of ids) await scope(current, false).collection(name).doc(id).update({ data });
            return { stats: { updated: ids.length } };
          },
          async remove() {
            if (transactional) throw new Error('transaction queries unsupported');
            const ids = Array.from(current().entries()).filter(([key, row]) => key.startsWith(name + '/') && match(row, where)).map(([, row]) => row._id);
            for (const id of ids) await scope(current, false).collection(name).doc(id).remove();
            return { stats: { removed: ids.length } };
          },
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
      function aggregate(stages = []) {
        const pipeline = {};
        for (const op of ['match', 'group', 'project', 'limit']) pipeline[op] = value => aggregate([...stages, [op, value]]);
        pipeline.end = async () => {
          if (transactional) throw new Error('transaction aggregates unsupported');
          let rows = Array.from(current().entries()).filter(([key]) => key.startsWith(name + '/')).map(([, row]) => structuredClone(row));
          for (const [op, data] of stages) {
            if (op === 'match') rows = rows.filter(row => match(row, data));
            if (op === 'limit') rows = rows.slice(0, data);
            if (op === 'project') rows = rows.map(row => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value === 1 ? row[key] : expression(value, row)])));
            if (op === 'group') {
              const groups = new Map();
              for (const row of rows) {
                const id = expression(data._id, row);
                if (!groups.has(id)) groups.set(id, { _id: id });
                for (const [key, value] of Object.entries(data)) {
                  if (key === '_id') continue;
                  if (value.aggregate !== 'sum') throw new Error('unsupported accumulator');
                  groups.get(id)[key] = (groups.get(id)[key] || 0) + Number(expression(value.value, row));
                }
              }
              rows = [...groups.values()];
            }
          }
          return { list: rows };
        };
        return pipeline;
      }
      return Object.assign(query(), { aggregate,
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
              else if (value && value.op === 'set') row[field] = structuredClone(value.value);
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
