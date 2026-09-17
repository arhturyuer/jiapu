#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="$(cd "$(dirname "$0")/.." && pwd)"
exec "${NODE_BIN:-node}" "${PROJECT_PATH}/scripts/check.mjs" "$@"
