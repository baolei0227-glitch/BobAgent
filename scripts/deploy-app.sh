#!/bin/bash
# deploy-app.sh — 将构建产物安全部署到已安装的 BobWork.app
#
# 用法: bash scripts/deploy-app.sh [--no-restart]
#
# 安全性设计（防"客户端打不开"事故）:
#   1. 源完整性校验    — 缺 server.js / package.json / .next/BUILD_ID 任一即中止，不触碰 app
#   2. 兼容两种结构    — 自动检测 standalone 产物在根目录或 projects/ 子目录
#   3. 部署前备份      — 带时间戳备份当前 next-standalone，latest 软链指向最近一份
#   4. 部署后校验      — server.js / BUILD_ID 缺失则自动回滚备份
#   5. static 同步     — 新构建 chunk 必须到位，避免页面 chunk 404
set -Eeuo pipefail

APP_NAME="BobWork"
APP_DIR="/Applications/BobWork.app/Contents/Resources/next-standalone"
WORK="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ROOT="$WORK/.next/standalone"
BACKUP_DIR="/tmp/bobwork-deploy-backup"

RESTART=1
[[ "${1:-}" == "--no-restart" ]] && RESTART=0

# ---- 1. 定位真实 standalone 源（兼容根目录 / projects/ 子目录两种输出结构）----
SRC=""
if [ -f "$SRC_ROOT/server.js" ]; then
  SRC="$SRC_ROOT"
elif [ -f "$SRC_ROOT/projects/server.js" ]; then
  SRC="$SRC_ROOT/projects"
else
  echo "[deploy] ERROR: standalone 产物不完整，找不到 server.js（请先执行 next build）" >&2
  exit 1
fi

# ---- 2. 源完整性校验（缺任一项即中止，不触碰 app）----
for f in server.js package.json .next/BUILD_ID; do
  if [ ! -f "$SRC/$f" ]; then
    echo "[deploy] ERROR: 源缺失 $SRC/$f，已中止（未改动 app）" >&2
    exit 1
  fi
done
echo "[deploy] 源: $SRC"

# ---- 3. 部署前备份（带时间戳 + latest 软链）----
BACKUP="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
rm -rf "$BACKUP_DIR/latest"
rsync -a "$APP_DIR/" "$BACKUP/"
ln -s "$BACKUP" "$BACKUP_DIR/latest"
echo "[deploy] 已备份到 $BACKUP"

# ---- 4. 同步核心产物（源校验通过后 --delete 安全）----
rsync -a --delete "$SRC/" "$APP_DIR/"

# ---- 5. 同步 static（新构建 chunk 必须到位）----
if [ -d "$WORK/.next/static" ]; then
  rsync -a "$WORK/.next/static/" "$APP_DIR/.next/static/"
fi

# ---- 5.5 Turbopack 原生模块 external 修复 ----
# Turbopack 16.x 对 serverExternalPackages 中的原生模块（better-sqlite3）生成的
# [externals]_better-sqlite3_*.js 会 require("better-sqlite3-<hash>") 虚拟模块名，
# Node 运行时找不到该模块，导致所有依赖 better-sqlite3 的操作（如删除节点时删边）失败。
# 这里把 hash 名修正为真实包名，保证 standalone 部署后原生模块可正常加载。
patch_turbopack_externals() {
  local chunks="$APP_DIR/.next/server/chunks"
  local patched=0
  for f in "$chunks"/\[externals\]_better-sqlite3_*._.js; do
    [ -f "$f" ] || continue
    if grep -q 'better-sqlite3-[0-9a-f]\{14,16\}' "$f"; then
      sed -i '' -E 's/better-sqlite3-[0-9a-f]{14,16}/better-sqlite3/g' "$f"
      echo "[deploy] patched native external: $(basename "$f")"
      patched=$((patched + 1))
    fi
  done
  [ "$patched" -gt 0 ] && echo "[deploy] 已修复 $patched 个原生模块 external chunk" || true
}
patch_turbopack_externals

# ---- 5.6 补建 better-sqlite3 顶层软链 ----
# standalone 将 better-sqlite3 作为 external 后不会追踪复制其 pnpm 顶层软链，
# 运行时 require("better-sqlite3") 会因 node_modules 下无该包而失败。
fix_native_symlink() {
  local nm="$APP_DIR/node_modules"
  if [ -d "$nm/.pnpm/better-sqlite3@13.0.1" ] && [ ! -e "$nm/better-sqlite3" ]; then
    ln -s ".pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3" "$nm/better-sqlite3"
    echo "[deploy] 已补建 better-sqlite3 顶层软链"
  fi
}
fix_native_symlink

# ---- 5.7 分发随包 MCP 插件 ----
# 步骤 4 的 rsync --delete 会清掉 app 内非 standalone 产物的目录（含手工同步的插件），
# 这里在核心产物落位后统一重新分发。各插件 dist/cli.js 已 esbuild 打成
# 自包含单文件（无运行时 node_modules 依赖），可直接镜像分发。
# 注意：必须覆盖全部 {BUNDLED} 预置插件，漏掉任何一个都会在部署后"插件消失/回退旧版"。
distribute_bundled_plugins() {
  local plugins="bob-team-mcp bob-notes-mcp bob-preview-mcp"
  local name
  for name in $plugins; do
    local plugin_src="$WORK/../$name/dist"
    local plugin_dst="$APP_DIR/$name/dist"
    if [ ! -f "$plugin_src/cli.js" ]; then
      echo "[deploy] WARN: 未找到随包插件 $plugin_src/cli.js，跳过分发" >&2
      continue
    fi
    if rsync -a --delete "$plugin_src/" "$plugin_dst/" && [ -f "$plugin_dst/cli.js" ]; then
      echo "[deploy] 已分发随包插件 $name ($(du -h "$plugin_dst/cli.js" | cut -f1))"
    else
      echo "[deploy] WARN: 随包插件分发失败，应用内将无法使用该 MCP" >&2
    fi
  done
}
distribute_bundled_plugins

# ---- 6. 部署后校验，失败自动回滚 ----
if [ ! -f "$APP_DIR/server.js" ] || [ ! -f "$APP_DIR/.next/BUILD_ID" ]; then
  echo "[deploy] ERROR: 部署后校验失败，自动回滚到 $BACKUP" >&2
  rsync -a "$BACKUP/" "$APP_DIR/"
  echo "[deploy] 已回滚" >&2
  exit 1
fi
echo "[deploy] 部署完成 BUILD_ID=$(cat "$APP_DIR/.next/BUILD_ID")"

# ---- 7. 重启（默认开启）----
if [ "$RESTART" -eq 1 ]; then
  osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || true
  sleep 2
  open "/Applications/$APP_NAME.app"
  echo "[deploy] 已重启 $APP_NAME"
fi
echo "[deploy] DONE"
