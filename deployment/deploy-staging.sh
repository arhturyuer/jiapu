#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"
cd "${PROJECT_PATH}"
STAGING_FILE="${STAGING_FILE:-${PROJECT_PATH}/deployment/staging.local.env}"
ACTION="${1:-all}"
WECHAT_CLI="${WECHAT_CLI:-/Applications/wechatwebdevtools.app/Contents/MacOS/cli}"
NODE_BIN="${NODE_BIN:-node}"
TCB_BIN="${TCB_BIN:-tcb}"

if [[ ! -f "${STAGING_FILE}" ]]; then
  echo "缺少 ${STAGING_FILE}；请先从 deployment/staging.local.env.example 复制并填写。"
  exit 2
fi
set -a
source "${STAGING_FILE}"
set +a
export DEPLOYMENT_TARGET=staging

"${NODE_BIN}" -e "import('./deployment/target-guard.mjs').then(m => m.assertDeploymentTarget(process.argv[1], 'staging 部署'))" "${STAGING_ENV_ID:-}"

run_functions() {
  "${NODE_BIN}" "${PROJECT_PATH}/deployment/configure-staging.mjs"
  "${TCB_BIN}" --config-file "${PROJECT_PATH}/deployment/cloudbaserc.staging.local.json" \
    -e "${STAGING_ENV_ID}" fn deploy --all --force
}
run_indexes() {
  : "${STAGING_DB_INSTANCE_ID:?staging.local.env 缺少 STAGING_DB_INSTANCE_ID}"
  DEPLOYMENT_TARGET=staging STAGING_ENV_ID="${STAGING_ENV_ID}" \
    INDEX_COLLECTIONS="${INDEX_COLLECTIONS:-}" \
    "${NODE_BIN}" "${PROJECT_PATH}/deployment/apply-indexes.mjs" "${STAGING_ENV_ID}" "${STAGING_DB_INSTANCE_ID}"
}
run_bootstrap() {
  DEPLOYMENT_TARGET=staging STAGING_ENV_ID="${STAGING_ENV_ID}" \
    "${NODE_BIN}" "${PROJECT_PATH}/deployment/bootstrap-staging.mjs"
}
run_security() {
  : "${STAGING_STORAGE_BUCKET:?staging.local.env 缺少 STAGING_STORAGE_BUCKET}"
  if [[ "${STAGING_ALLOW_PERSONAL_PRIVATE_STORAGE:-0}" == "1" ]]; then
    "${TCB_BIN}" storage rules update --acl PRIVATE --json -e "${STAGING_ENV_ID}"
  fi
  DEPLOYMENT_TARGET=staging STAGING_ENV_ID="${STAGING_ENV_ID}" \
    ALLOW_PERSONAL_PRIVATE_STORAGE="${STAGING_ALLOW_PERSONAL_PRIVATE_STORAGE:-0}" \
    "${NODE_BIN}" "${PROJECT_PATH}/deployment/apply-security.mjs" "${STAGING_ENV_ID}" "${STAGING_STORAGE_BUCKET}"
}
run_verify() {
  DEPLOYMENT_TARGET=staging STAGING_ENV_ID="${STAGING_ENV_ID}" \
    "${NODE_BIN}" "${PROJECT_PATH}/deployment/verify-cloud.mjs" "${STAGING_ENV_ID}"
}
run_hosting() {
  VITE_CLOUDBASE_ENV="${STAGING_ENV_ID}" "${PNPM_BIN:-pnpm}" --dir "${PROJECT_PATH}/admin" run build
  "${TCB_BIN}" hosting deploy "${PROJECT_PATH}/admin/dist" -e "${STAGING_ENV_ID}"
}

case "${ACTION}" in
  functions) run_functions ;;
  indexes) run_indexes ;;
  security) run_security ;;
  verify) run_verify ;;
  hosting) run_hosting ;;
  bootstrap) run_bootstrap ;;
  all) run_functions; run_bootstrap; run_indexes; run_security; run_hosting; run_verify ;;
  *) echo "用法: ./deployment/deploy-staging.sh {functions|bootstrap|indexes|security|hosting|verify|all}"; exit 2 ;;
esac
