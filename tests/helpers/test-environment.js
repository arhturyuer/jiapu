const fs = require('node:fs');
const vm = require('node:vm');

const environmentPath = require.resolve('../../miniprogram/config/env');
const fixture = { stagingCloudEnv: 'cloud1-unit-test-staging' };

// Execute the real routing code with a synthetic local config. Never read or
// write env.local.js, and never add a test fallback to application code.
function loadEnvironment(local = fixture) {
  const context = {
    module: { exports: {} },
    require: function (name) {
      if (name !== './env.local') throw new Error('Unexpected environment dependency: ' + name);
      if (local === null) {
        const error = new Error('No local config');
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return local;
    }
  };
  vm.runInNewContext(fs.readFileSync(environmentPath, 'utf8'), context, { filename: environmentPath });
  return context.module.exports;
}

require.cache[environmentPath] = {
  id: environmentPath, filename: environmentPath, loaded: true, exports: loadEnvironment()
};

module.exports = { loadEnvironment };
