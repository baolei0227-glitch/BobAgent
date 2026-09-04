#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PORT=5000
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT}}"

# 数据目录统一使用 ~/BobWork
export BOBWORK_HOME="${BOBWORK_HOME:-$HOME/BobWork}"
# sandbox 也跟随 BOBWORK_HOME（但不切换 cwd）
export COZE_WORKSPACE_PATH="${BOBWORK_HOME}/.sandbox"

cd "${PROJECT_DIR}"

kill_port_if_listening() {
    local pids
    # macOS 用 lsof（ss 仅 Linux 有，缺失时会误判端口空闲 → EADDRINUSE）
    if command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -ti tcp:${DEPLOY_RUN_PORT} 2>/dev/null | paste -sd' ' - || true)
    else
        pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    fi
    if [[ -z "${pids}" ]]; then
      echo "Port ${DEPLOY_RUN_PORT} is free."
      return
    fi
    echo "Port ${DEPLOY_RUN_PORT} in use by PIDs: ${pids} (SIGKILL)"
    echo "${pids}" | xargs -I {} kill -9 {}
    sleep 1
    if command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -ti tcp:${DEPLOY_RUN_PORT} 2>/dev/null | paste -sd' ' - || true)
    else
        pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    fi
    if [[ -n "${pids}" ]]; then
      echo "Warning: port ${DEPLOY_RUN_PORT} still busy after SIGKILL, PIDs: ${pids}"
    else
      echo "Port ${DEPLOY_RUN_PORT} cleared."
    fi
}

echo "Clearing port ${DEPLOY_RUN_PORT} before start."
kill_port_if_listening
echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for dev..."

# PATH 补全：TRAE 托管 shell 缺少系统目录，npm/node 相关命令会 command not found
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH

# 直接调用项目本地 tsx，绕过损坏的 pnpm corepack shim（`pnpm tsx` 报 Unknown Syntax Error）
PORT=${DEPLOY_RUN_PORT} "${PROJECT_DIR}/node_modules/.bin/tsx" watch src/server.ts
