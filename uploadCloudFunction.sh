#!/usr/bin/env bash
set -euo pipefail

ENV_ID="${1:-}"
PRODUCTION_ENV_ID="cloud1-d5gs5yj4l283d9c6d"
if [[ -z "${ENV_ID}" ]]; then
  echo "用法: ./uploadCloudFunction.sh <预发布环境ID>"
  exit 2
fi

if [[ "${ENV_ID}" == "${PRODUCTION_ENV_ID}" && "${ALLOW_PRODUCTION_DEPLOY:-0}" != "1" ]]; then
  echo "已阻止直接部署生产。完成生产备份和预发布验收后设置 ALLOW_PRODUCTION_DEPLOY=1。"
  exit 2
fi

PROJECT_PATH="$(cd "$(dirname "$0")" && pwd)"
WECHAT_CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"

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
