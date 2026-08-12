export const PRODUCTION_ENV_ID = 'cloud1-d5gs5yj4l283d9c6d';

function fail(message) {
  throw new Error(message);
}

function invalidEnvironmentId(envId) {
  return !envId || /REPLACE_WITH|YOUR_|<|>|\s/.test(envId);
}

/**
 * Guard every CloudBase CLI mutation behind an explicit deployment role.
 * A staging command may never target production, even if its local env file
 * was copied incorrectly.
 */
export function assertDeploymentTarget(envId, operation) {
  const target = process.env.DEPLOYMENT_TARGET || '';
  if (!['staging', 'production'].includes(target)) {
    fail(`${operation} 必须显式设置 DEPLOYMENT_TARGET=staging 或 DEPLOYMENT_TARGET=production。`);
  }
  if (invalidEnvironmentId(envId)) {
    fail(`${operation} 缺少有效的 CloudBase 环境 ID。`);
  }

  if (target === 'staging') {
    if (envId === PRODUCTION_ENV_ID) {
      fail(`${operation} 已阻止：staging 命令绝不能指向 production 环境。`);
    }
    const configuredStagingId = process.env.STAGING_ENV_ID || '';
    if (invalidEnvironmentId(configuredStagingId)) {
      fail(`${operation} 的 staging 目标必须由 STAGING_ENV_ID 显式提供。`);
    }
    if (envId !== configuredStagingId) {
      fail(`${operation} 目标与 STAGING_ENV_ID 不一致，已阻止执行。`);
    }
    return;
  }

  if (envId !== PRODUCTION_ENV_ID || process.env.ALLOW_PRODUCTION_CHANGE !== '1') {
    fail(`${operation} 已阻止生产写入：仅允许 TARGET=production、正式环境 ID 且 ALLOW_PRODUCTION_CHANGE=1。`);
  }
}
