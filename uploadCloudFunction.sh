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

if [[ ! -x "${WECHAT_CLI}" ]]; then
  echo "未找到微信开发者工具 CLI: ${WECHAT_CLI}"
  exit 3
fi

"${WECHAT_CLI}" cloud functions deploy \
  --env "${ENV_ID}" \
  --names youpuUserApi youpuOpsApi youpuJobs \
  --remote-npm-install \
  --project "${PROJECT_PATH}"

echo "云函数代码已部署到 ${ENV_ID}。请继续按 deployment/cloudbaserc.example.json 校验运行时、超时、内存、密钥、OpenAPI 权限与触发器。"
