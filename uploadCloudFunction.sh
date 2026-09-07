#!/usr/bin/env bash
set -euo pipefail

ENV_ID="${1:-}"
if [[ -z "${ENV_ID}" ]]; then
  echo "用法: DEPLOYMENT_TARGET=staging STAGING_ENV_ID=<测试环境ID> ./uploadCloudFunction.sh <环境ID>"
  exit 2
fi

PROJECT_PATH="$(cd "$(dirname "$0")" && pwd)"
cd "${PROJECT_PATH}"
WECHAT_CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"

node -e "import('./deployment/target-guard.mjs').then(m => m.assertDeploymentTarget(process.argv[1], '云函数部署'))" "${ENV_ID}"

if [[ "${DEPLOYMENT_TARGET:-}" == "staging" ]]; then
  echo "staging 会员支付必须使用 deployment/deploy-staging.sh functions，以注入沙箱变量；随后在云开发控制台人工绑定两条虚拟支付消息推送。"
  exec "${PROJECT_PATH}/deployment/deploy-staging.sh" functions
fi

if [[ ! -x "${WECHAT_CLI}" ]]; then
  echo "未找到微信开发者工具 CLI: ${WECHAT_CLI}"
  exit 3
fi

"${WECHAT_CLI}" cloud functions deploy \
  --env "${ENV_ID}" \
  --names youpuUserApi youpuOpsApi youpuJobs youpuPaymentNotify \
  --remote-npm-install \
  --project "${PROJECT_PATH}"

# The original production notifier was created on an immutable Node.js 16
# runtime.  Production delivery now targets V2 (Node.js 20); update its code
# explicitly without touching its runtime, environment variables, or message
# push binding.  Staging continues to use the original notifier above.
tcb -e "${ENV_ID}" fn deploy youpuPaymentNotifyV2 \
  --dir "${PROJECT_PATH}/cloudfunctions/youpuPaymentNotify" \
  --force

echo "云函数代码已部署到 ${ENV_ID}。production 的支付通知函数为 youpuPaymentNotifyV2；请继续校验运行时、超时、内存、密钥、OpenAPI 权限与触发器。"
