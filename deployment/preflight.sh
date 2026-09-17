#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${PREFLIGHT_MODE:-staging}"
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

if [[ -z "${TARGET_ENV_ID}" ]]; then
  echo "预检必须显式设置 TARGET_ENV_ID。"
  exit 3
fi

if [[ "${MODE}" == "production" ]]; then
  RUNTIME_VERSION="release"
else
  RUNTIME_VERSION="develop"
fi
ACTIVE_ENV="$("${NODE}" -e "const c=require('${PROJECT_PATH}/miniprogram/config/env'); const r=c.resolveRuntimeEnvironment({getAccountInfoSync:()=>({miniProgram:{envVersion:'${RUNTIME_VERSION}'}})}); console.log(r.active||'')")"
CONFIGURED_ENV_ID="$("${NODE}" -e "const c=require('${PROJECT_PATH}/miniprogram/config/env'); const r=c.resolveRuntimeEnvironment({getAccountInfoSync:()=>({miniProgram:{envVersion:'${RUNTIME_VERSION}'}})}); console.log((r.environment||{}).cloudEnv||'')")"

if [[ "${MODE}" == "production" ]]; then
  if [[ "${TARGET_ENV_ID}" != "${PRODUCTION_ENV_ID}" || "${ALLOW_PRODUCTION:-0}" != "1" ]]; then
    echo "生产预检仅允许目标为 production 环境，且必须显式设置 ALLOW_PRODUCTION=1。"
    exit 3
  fi

  if [[ "${ACTIVE_ENV}" != "production" ]]; then
    echo "正式预检要求小程序 release 运行时环境为 production，当前为 ${ACTIVE_ENV:-未配置}。"
    exit 3
  fi
  if [[ "${CONFIGURED_ENV_ID}" != "${TARGET_ENV_ID}" ]]; then
    echo "小程序当前环境 ${ACTIVE_ENV}/${CONFIGURED_ENV_ID:-未配置} 与 TARGET_ENV_ID 不一致。"
    exit 3
  fi

  OPERATOR_NAME="$("${NODE}" -e "console.log(require('${PROJECT_PATH}/miniprogram/config/legal').operatorName||'')")"
  LEGAL_VERIFIED="$("${NODE}" -e "console.log(require('${PROJECT_PATH}/miniprogram/config/legal').registrationVerified===true?'true':'false')")"
  if [[ -z "${OPERATOR_NAME}" || "${OPERATOR_NAME}" == "运营者" || "${OPERATOR_NAME}" == "有谱小程序运营者" || "${OPERATOR_NAME}" == "待填写" || "${OPERATOR_NAME}" == "测试主体" || "${OPERATOR_NAME}" == "示例主体" || "${LEGAL_VERIFIED}" != "true" ]]; then
    echo "隐私政策主体尚未由发布负责人确认；请填写微信公众平台登记主体全称并将 registrationVerified 设为 true。"
    exit 3
  fi

elif [[ "${MODE}" == "staging" ]]; then
  if [[ "${TARGET_ENV_ID}" == "${PRODUCTION_ENV_ID}" || "${TARGET_ENV_ID}" == *"REPLACE_WITH"* ]]; then
    echo "已阻止 staging 预检指向 production 或占位环境。"
    exit 3
  fi
  if [[ "${ACTIVE_ENV}" != "staging" || "${CONFIGURED_ENV_ID}" != "${TARGET_ENV_ID}" ]]; then
    echo "staging 预检要求小程序 develop 运行时配置为 staging/${TARGET_ENV_ID}，当前为 ${ACTIVE_ENV}/${CONFIGURED_ENV_ID:-未配置}。"
    exit 3
  fi
  if [[ "${STAGING_PAYMENT_MODE:-}" != "sandbox" ]]; then
    echo "staging 虚拟支付必须设置 STAGING_PAYMENT_MODE=sandbox。"
    exit 3
  fi
  for payment_key in \
    STAGING_VP_APP_ID STAGING_VP_APP_SECRET STAGING_VP_OFFER_ID STAGING_VP_APP_KEY \
    STAGING_VP_INTERNAL_NOTIFY_SECRET; do
    payment_value="${!payment_key:-}"
    if [[ -z "${payment_value}" || "${payment_value}" == *"REPLACE_WITH"* || "${payment_value}" == *"CHANGE_BEFORE_DEPLOY"* ]]; then
      echo "staging 虚拟支付缺少有效配置：${payment_key}。"
      exit 3
    fi
  done
  if [[ "${#payment_value}" -lt 32 ]]; then
    echo "STAGING_VP_INTERNAL_NOTIFY_SECRET 必须是至少 32 字符的 staging 专用随机值。"
    exit 3
  fi
else
  echo "PREFLIGHT_MODE 仅支持 staging 或 production。"
  exit 3
fi

NODE_BIN="${NODE}" PNPM_BIN="${PNPM}" VITE_CLOUDBASE_ENV="${TARGET_ENV_ID}" \
  bash "${PROJECT_PATH}/scripts/check.sh" --build-admin

if [[ "${SKIP_WECHAT_PREVIEW:-0}" != "1" ]]; then
  "${WECHAT_CLI}" preview --project "${PROJECT_PATH}" --qr-format terminal
elif [[ "${MODE}" == "production" ]]; then
  echo "正式发布预检不允许跳过微信预览。"
  exit 4
else
  echo "已按 SKIP_WECHAT_PREVIEW=1 跳过微信预览。"
fi

if [[ "${SKIP_WECHAT_PREVIEW:-0}" == "1" ]]; then
  echo "${MODE} 环境的代码、单元测试和管理端构建均已通过；微信预览未执行。"
else
  echo "${MODE} 环境的代码、单元测试、管理端构建和微信预览均已通过。"
fi
