const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function miniapp(options) {
  const root = options.sourceRoot || path.resolve(__dirname, '../..');
  const source = name => fs.readFileSync(path.join(root, name), 'utf8');
  const storage = options.storage || new Map();
  const now = options.now || Date.now;
  class Clock extends Date { static now() { return now(); } }
  let app;
  const env = options.environment || 'fixture-staging';
  const environment = { active: 'staging', environments: { staging: { cloudEnv: env } },
    resolveRuntimeEnvironment: () => ({ active: 'staging', runtimeVersion: 'develop', environment: { cloudEnv: env, userApi: 'fixture-api' } }) };
  const wx = { getAccountInfoSync: () => ({ miniProgram: { appId: 'fixture-app', envVersion: 'develop' } }),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key), getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    setTabBarBadge() {}, removeTabBarBadge() {}, cloud: { callFunction: async input => ({ result: await options.call(input.data) }) } };
  const ledgerContext = { module: { exports: {} }, wx };
  vm.runInNewContext(source('miniprogram/utils/activity-ledger.js'), ledgerContext);
  const apiContext = { module: { exports: {} }, wx, getApp: () => app, Date: Clock, setTimeout, clearTimeout,
    require: name => name === '../config/env' ? environment : { message: () => 'fixture error', fromError: () => ({ message: 'fixture error' }) } };
  vm.runInNewContext(source('miniprogram/utils/api.js'), apiContext);
  const api = apiContext.module.exports;
  const context = { App: value => { app = value; }, wx, Date: Clock, setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {} }, require: name => {
      if (name === './utils/api') return api;
      if (name === './config/env') return environment;
      if (name === './utils/activity-ledger') return ledgerContext.module.exports;
      if (name === './utils/profile-image-cache') return { clear() {} };
      return {};
    } };
  vm.runInNewContext(source('miniprogram/app.js'), context);
  return { app, api, wx, storage, ledger: ledgerContext.module.exports,
    close: () => { if (app._badgeChangeTimer) clearTimeout(app._badgeChangeTimer); } };
}
module.exports = { miniapp };
