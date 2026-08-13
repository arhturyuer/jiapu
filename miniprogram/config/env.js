const production = {
  cloudEnv: 'cloud1-d5gs5yj4l283d9c6d',
  userApi: 'youpuUserApi',
  moderationMode: 'strict'
};

// env.local.js supplies the staging ID and is intentionally ignored. Both
// environment definitions are bundled; the active one is selected at runtime
// from WeChat's official miniProgram.envVersion.
let local = {};
try {
  local = require('./env.local');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const stagingCloudEnv = typeof local.stagingCloudEnv === 'string'
  ? local.stagingCloudEnv
  : 'REPLACE_WITH_STAGING_ENV_ID';
const hasStagingEnvironment = stagingCloudEnv &&
  stagingCloudEnv !== production.cloudEnv &&
  !/REPLACE_WITH|\s/.test(stagingCloudEnv);

if (!hasStagingEnvironment) {
  throw new Error('缺少 staging 环境配置：请运行 deployment/configure-staging.mjs 后再打开开发者工具或上传小程序。');
}

const environments = {
  production: production,
  staging: {
    cloudEnv: stagingCloudEnv,
    userApi: 'youpuUserApi',
    moderationMode: 'strict'
  }
};

function getRuntimeVersion(wxApi) {
  try {
    const account = wxApi && wxApi.getAccountInfoSync && wxApi.getAccountInfoSync();
    return account && account.miniProgram && account.miniProgram.envVersion || '';
  } catch (error) {
    return '';
  }
}

function resolveRuntimeEnvironment(wxApi) {
  const runtimeVersion = getRuntimeVersion(wxApi);
  // Official values: develop (开发版), trial (体验版), release (正式版).
  // Unknown values deliberately stay on staging so a platform/API anomaly can
  // never redirect a test package to production.
  const active = runtimeVersion === 'release' ? 'production' : 'staging';
  return {
    active: active,
    runtimeVersion: runtimeVersion || 'unknown',
    environment: environments[active]
  };
}

const resolved = resolveRuntimeEnvironment(typeof wx === 'undefined' ? null : wx);

module.exports = {
  active: resolved.active,
  runtimeVersion: resolved.runtimeVersion,
  environments: environments,
  resolveRuntimeEnvironment: resolveRuntimeEnvironment
};
