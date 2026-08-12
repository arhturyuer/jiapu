const production = {
  cloudEnv: 'cloud1-d5gs5yj4l283d9c6d',
  userApi: 'youpuUserApi',
  moderationMode: 'strict'
};

// env.local.js is generated from the ignored staging.local.env. It may only
// select staging and provide its ID; production is intentionally immutable.
let local = {};
try {
  local = require('./env.local');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const stagingCloudEnv = typeof local.stagingCloudEnv === 'string'
  ? local.stagingCloudEnv
  : 'REPLACE_WITH_STAGING_ENV_ID';

module.exports = {
  active: local.active === 'staging' ? 'staging' : 'production',
  environments: {
    production: production,
    staging: {
      cloudEnv: stagingCloudEnv,
      userApi: 'youpuUserApi',
      moderationMode: 'strict'
    }
  }
};
