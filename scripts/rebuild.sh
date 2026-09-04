#!/bin/bash
# rebuild.sh — 一键重建并部署 BobWork（构建 + 部署 + 重启 + 验证 8321）
# 用法: bash scripts/rebuild.sh
# 说明: 改完源码后只需跑这一个脚本，8321 端口即为最新代码
set -Eeuo pipefail

WORK="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORK"

echo "[rebuild] 1/4 构建中（next build，约 1-2 分钟）..."
node_modules/.bin/next build

echo "[rebuild] 2/4 部署到 /Applications/BobWork.app ..."
bash scripts/deploy-app.sh

echo "[rebuild] 3/4 等待应用启动..."
sleep 6

echo "[rebuild] 4/4 验证 8321 端口..."
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8321/ || echo 000)
if [ "$CODE" = "200" ]; then
  echo "[rebuild] 成功：http://localhost:8321 已返回 HTTP 200，新版本生效"
else
  echo "[rebuild] 警告：8321 当前返回 $CODE，可能仍在启动，稍后访问 http://localhost:8321 确认" >&2
  exit 1
fi
echo "[rebuild] DONE"