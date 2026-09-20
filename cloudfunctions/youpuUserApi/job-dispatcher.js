const crypto = require('crypto');

function clean(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function runtimeValue(name, fallback) {
  return clean(process.env[name] || fallback || '', 160);
}

function dispatchConfig(options) {
  const source = options || {};
  const secret = clean(source.secret || process.env.JOB_DISPATCH_SECRET, 200);
  const region = clean(source.region || process.env.TENCENTCLOUD_REGION, 80);
  const namespace = clean(source.namespace || process.env.JOB_FUNCTION_NAMESPACE || process.env.SCF_NAMESPACE || process.env.TCB_ENV, 160);
  if (!secret || /REPLACE_WITH|CHANGE_BEFORE_DEPLOY/.test(secret) || secret.length < 32) {
    throw Object.assign(new Error('后台任务派发密钥未配置'), { code: 'JOB_DISPATCH_NOT_CONFIGURED' });
  }
  if (!region || !namespace) {
    throw Object.assign(new Error('后台任务运行环境信息不完整'), { code: 'JOB_DISPATCH_NOT_CONFIGURED' });
  }
  return {
    secret: secret,
    region: region,
    namespace: namespace,
    functionName: clean(source.functionName || runtimeValue('JOB_FUNCTION_NAME', 'youpuJobs'), 80)
  };
}

function createClient(config, Client) {
  const ClientConstructor = Client || require('tencentcloud-sdk-nodejs-scf').scf.v20180416.Client;
  return new ClientConstructor({
    credential: {
      secretId: process.env.TENCENTCLOUD_SECRETID,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY,
      token: process.env.TENCENTCLOUD_SESSIONTOKEN
    },
    region: config.region,
    profile: { httpProfile: { endpoint: 'scf.tencentcloudapi.com' } }
  });
}

async function dispatchJob(action, taskId, options) {
  const safeAction = clean(action, 80);
  const safeTaskId = clean(taskId, 80);
  if (!['task.account-export', 'task.family-backup'].includes(safeAction) || !safeTaskId) {
    throw Object.assign(new Error('后台任务派发参数不合法'), { code: 'JOB_DISPATCH_INVALID' });
  }
  const config = dispatchConfig(options);
  const client = (options && options.client) || createClient(config, options && options.Client);
  const requestId = clean(options && options.requestId, 80) || crypto.randomBytes(8).toString('hex');
  const response = await client.Invoke({
    FunctionName: config.functionName,
    Namespace: config.namespace,
    InvocationType: 'Event',
    ClientContext: JSON.stringify({
      action: safeAction,
      taskId: safeTaskId,
      internalSecret: config.secret,
      requestId: requestId
    })
  });
  return {
    requestId: clean(response && response.RequestId, 120) || requestId
  };
}

module.exports = {
  dispatchConfig: dispatchConfig,
  dispatchJob: dispatchJob
};
