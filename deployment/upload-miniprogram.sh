#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"
VERSION="${2:-}"
WECHAT_CLI="${WECHAT_CLI:-/Applications/wechatwebdevtools.app/Contents/MacOS/cli}"
NODE_BIN="${NODE_BIN:-node}"

if [[ -z "${VERSION}" || -n "${3:-}" ]]; then
  echo "用法: ./deployment/upload-miniprogram.sh {staging|production} <版本号>"
  exit 2
fi
if [[ ! -x "${WECHAT_CLI}" ]]; then
  echo "未找到微信开发者工具 CLI：${WECHAT_CLI}"
  exit 2
fi

if [[ "${TARGET}" != "staging" && "${TARGET}" != "production" ]]; then
  echo "上传目标只能是 staging 或 production。"
  exit 2
fi

"${NODE_BIN}" "${PROJECT_PATH}/deployment/configure-staging.mjs"
if [[ "${TARGET}" == "staging" ]]; then
  EXPECTED_RUNTIMES=("develop")
else
  EXPECTED_RUNTIMES=("trial" "release")
fi
for EXPECTED_RUNTIME in "${EXPECTED_RUNTIMES[@]}"; do
  RESOLVED_ENV="$("${NODE_BIN}" -e "const c=require('${PROJECT_PATH}/miniprogram/config/env');console.log(c.resolveRuntimeEnvironment({getAccountInfoSync:()=>({miniProgram:{envVersion:'${EXPECTED_RUNTIME}'}})}).active)")"
  if [[ "${RESOLVED_ENV}" != "${TARGET}" ]]; then
    echo "已阻止上传：运行时 ${EXPECTED_RUNTIME} 会路由到 ${RESOLVED_ENV}，与上传目标 ${TARGET} 不一致。"
    exit 3
  fi
done

DESCRIPTION="$("${NODE_BIN}" "${PROJECT_PATH}/deployment/verify-release-note.mjs" "${VERSION}")"
"${WECHAT_CLI}" upload --project "${PROJECT_PATH}" --version "${VERSION}" --desc "${DESCRIPTION}"

echo "已上传同一运行时路由包：开发版连接 staging，体验版/正式版连接 production。"
