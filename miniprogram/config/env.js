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
  // WeChat's module loader omits Node's MODULE_NOT_FOUND code. Only translate
  // this exact missing local module; errors inside a present config still fail.
  const missingLocal = error && (error.code === 'MODULE_NOT_FOUND' ||
    error.message === "module 'config/env.local.js' is not defined, require args is './env.local'");
  if (!missingLocal) throw error;
}

const stagingCloudEnv = typeof local.stagingCloudEnv === 'string'
  ? local.stagingCloudEnv
  : 'REPLACE_WITH_STAGING_ENV_ID';
const hasStagingEnvironment = stagingCloudEnv &&
  stagingCloudEnv !== production.cloudEnv &&
  !/REPLACE_WITH|\s/.test(stagingCloudEnv);

if (!hasStagingEnvironment) {
  throw new Error('缺少 staging 环境配置：本地开发请显式设置 DEPLOYMENT_TARGET=staging 和 STAGING_ENV_ID，运行 node deployment/configure-miniprogram.mjs 后重新编译；完整部署仍使用 deployment/configure-staging.mjs。');
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
  // never redirect an unrecognized package to production.
  const active = (runtimeVersion === 'trial' || runtimeVersion === 'release')
    ? 'production'
    : 'staging';
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
