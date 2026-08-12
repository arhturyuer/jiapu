#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"
STAGING_FILE="${STAGING_FILE:-${PROJECT_PATH}/deployment/staging.local.env}"

if [[ ! -f "${STAGING_FILE}" ]]; then
  echo "缺少 ${STAGING_FILE}；请先从 deployment/staging.local.env.example 复制并填写。"
  exit 2
fi

set -a
source "${STAGING_FILE}"
set +a

if [[ -z "${STAGING_ENV_ID:-}" ]]; then
  echo "staging.local.env 缺少 STAGING_ENV_ID。"
  exit 2
fi

NODE_BIN="${NODE_BIN:-node}" "${PROJECT_PATH}/deployment/configure-staging.mjs"
DEPLOYMENT_TARGET=staging STAGING_ENV_ID="${STAGING_ENV_ID}" \
  PREFLIGHT_MODE=staging TARGET_ENV_ID="${STAGING_ENV_ID}" \
  "${PROJECT_PATH}/deployment/preflight.sh"
