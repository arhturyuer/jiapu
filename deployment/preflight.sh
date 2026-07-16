#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${PREFLIGHT_MODE:-release}"
TARGET_ENV_ID="${TARGET_ENV_ID:-}"
PRODUCTION_ENV_ID="cloud1-d5gs5yj4l283d9c6d"
WECHAT_CLI="${WECHAT_CLI:-/Applications/wechatwebdevtools.app/Contents/MacOS/cli}"

if [[ -n "${NODE_BIN:-}" ]]; then
  NODE="${NODE_BIN}"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "缺少 Node.js 20.19+；可通过 NODE_BIN=/absolute/path/to/node 指定。"
  exit 2
fi

if [[ -n "${PNPM_BIN:-}" ]]; then
  PNPM="${PNPM_BIN}"
elif command -v pnpm >/dev/null 2>&1; then
  PNPM="$(command -v pnpm)"
else
  echo "缺少 pnpm；可通过 PNPM_BIN=/absolute/path/to/pnpm 指定。"
  exit 2
fi

if [[ ! -x "${WECHAT_CLI}" ]]; then
  echo "未找到微信开发者工具 CLI：${WECHAT_CLI}"
  exit 2
fi

export PATH="$(dirname "${NODE}"):$(dirname "${PNPM}"):${PATH}"

if [[ "${MODE}" == "release" ]]; then
  if [[ -z "${TARGET_ENV_ID}" ]]; then
    echo "正式预检必须设置 TARGET_ENV_ID。"
    exit 3
  fi

  ACTIVE_ENV="$("${NODE}" -e "console.log(require('${PROJECT_PATH}/miniprogram/config/env').active||'')")"
  CONFIGURED_ENV_ID="$("${NODE}" -e "const c=require('${PROJECT_PATH}/miniprogram/config/env'); console.log((c.environments[c.active]||{}).cloudEnv||'')")"
  if [[ "${CONFIGURED_ENV_ID}" != "${TARGET_ENV_ID}" ]]; then
    echo "小程序当前环境 ${ACTIVE_ENV}/${CONFIGURED_ENV_ID:-未配置} 与 TARGET_ENV_ID 不一致。"
    exit 3
  fi

  OPERATOR_NAME="$("${NODE}" -e "console.log(require('${PROJECT_PATH}/miniprogram/config/legal').operatorName||'')")"
  if [[ -z "${OPERATOR_NAME}" || "${OPERATOR_NAME}" == "有谱小程序运营者" ]]; then
    echo "隐私政策主体仍是占位值，请替换为微信公众平台登记主体全称。"
    exit 3
  fi

  if [[ "${TARGET_ENV_ID}" == "${PRODUCTION_ENV_ID}" && "${ALLOW_PRODUCTION:-0}" != "1" ]]; then
    echo "已阻止生产预检；确认备份和预发布验收后设置 ALLOW_PRODUCTION=1。"
    exit 3
  fi
else
  TARGET_ENV_ID="${TARGET_ENV_ID:-${PRODUCTION_ENV_ID}}"
fi

find "${PROJECT_PATH}/miniprogram" "${PROJECT_PATH}/cloudfunctions" "${PROJECT_PATH}/tests" \
  -name '*.js' -print0 | xargs -0 -n1 "${NODE}" --check
"${NODE}" --test "${PROJECT_PATH}"/tests/*.test.js

(
  cd "${PROJECT_PATH}/admin"
  "${PNPM}" run typecheck
  VITE_CLOUDBASE_ENV="${TARGET_ENV_ID}" "${PNPM}" run build
)

if [[ "${SKIP_WECHAT_PREVIEW:-0}" != "1" ]]; then
  "${WECHAT_CLI}" preview --project "${PROJECT_PATH}" --qr-format terminal
elif [[ "${MODE}" == "release" ]]; then
  echo "正式发布预检不允许跳过微信预览。"
  exit 4
fi

echo "代码、单元测试、管理端生产构建和微信预览均已通过。"
