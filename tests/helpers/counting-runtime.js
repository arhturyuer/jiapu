const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');

function countedDatabase(database, counts, segment = () => 'business') {
  function wrap(target, name) {
    return new Proxy(target, { get(object, key) {
      const value = object[key];
      if (key === 'collection') return collection => wrap(value.call(object, collection), collection);
      if (key === 'runTransaction') return async callback => {
        counts.transactions++;
        let attempts = 0;
        try {
          const result = await value.call(object, transaction => { attempts++; return callback(wrap(transaction)); });
          counts.commits++; return result;
        } finally { counts.retries += Math.max(0, attempts - 1); }
      };
      if (['doc', 'where', 'limit', 'skip', 'orderBy', 'field', 'aggregate', 'match', 'group', 'project'].includes(key)) {
        return (...args) => wrap(value.apply(object, args), name);
      }
      if (['get', 'count', 'end', 'set', 'update', 'remove', 'add'].includes(key)) return (...args) => {
        const kind = ['get', 'count', 'end'].includes(key) ? 'reads' : 'writes';
        counts[kind]++;
        counts.operations.push({ collection: name, method: key, segment: segment() });
        return value.apply(object, args);
      };
      return typeof value === 'function' ? value.bind(object) : value;
    } });
  }
  return wrap(database);
}

function runtime(directory, database, options = {}) {
  const counts = { reads: 0, writes: 0, transactions: 0, commits: 0, retries: 0, functions: 0, operations: [] };
  const segments = new AsyncLocalStorage();
  const db = countedDatabase(database, counts, () => segments.getStore() || 'business');
  const file = path.resolve(directory, 'index.js');
  const localRequire = createRequire(file);
  const actor = options.actor || 'fixture-actor';
  const cloud = { init() {}, database: () => db, DYNAMIC_CURRENT_ENV: Symbol('fixture'),
    getWXContext: () => ({ OPENID: actor, ENV: options.environment || 'fixture-staging' }),
    openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } };
  const context = { module: { exports: {} }, exports: {}, __dirname: path.dirname(file), __filename: file,
    require: name => {
      if (name === 'wx-server-sdk') return cloud;
      if (name === './analytics') {
        const analytics = localRequire(name);
        if (analytics.createTracker) return Object.assign({}, analytics, { createTracker: database => {
          const tracker = options.now ? analytics.createTracker(database, () => new Date(options.now())) : analytics.createTracker(database);
          return Object.assign({}, tracker, { record: (...args) => segments.run('analytics', () => tracker.record(...args)) });
        } });
        return analytics;
      }
      return localRequire(name);
    },
    console: options.console || { log() {}, warn() {}, error() {} }, process: { env: {} },
    Buffer, URL, Date: options.Date || Date, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { counts, call: async (input, platform) => { counts.functions++; return segments.run('business', () => context.exports.main(input, platform)); } };
}
module.exports = { countedDatabase, runtime };
