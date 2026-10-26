#!/usr/bin/env bash
# release-win.sh —— Windows 版一条命令发版
#
# 为什么要有这个脚本（2026-10-26 的教训）：
#   macOS 与 Windows 是两条独立流水线，`pnpm package:release` 只出 mac。
#   0.7.747 发版时只跑了 mac，Windows 就静默缺席（latest.yml 一直 404）。
#   这条脚本把 Windows 的 8 个手工步骤固化成一条命令，并在发布前逐项校验，
#   避免「发了 mac、忘了 win」和「包坏了才发现」。
#
# 用法：
#   bash scripts/release-win.sh                 # 构建 + 校验（不发布）
#   bash scripts/release-win.sh --publish       # 构建 + 校验 + 上传 GitCode（需 GITCODE_TOKEN）
#   bash scripts/release-win.sh --reuse-next    # 复用已有 .next（源码未改时省 ~7 分钟）
#
# 前置：
#   - 已在 package.json 升好版本，且 RELEASES.md 有对应 `## v<version>` 段；
#   - --publish 时，GitCode 上必须已存在同版本 Release（先发 mac，顺序不能反：
#     否则 latest 频道只有 latest.yml、没有 latest-mac.yml，已装 mac 用户检查更新会静默失败）。
#
# 产物：release/BobWork-<version>-win-x64.exe / .blockmap / latest.yml
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PUBLISH=0
REUSE_NEXT=0
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --reuse-next) REUSE_NEXT=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（支持 --publish / --reuse-next）" >&2; exit 2 ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
OUT_DIR="$ROOT/release"
DOWNLOAD_BASE="https://gitcode.com/baolei89/BobWork/releases/download"

C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[0;31m'; C_CYAN=$'\033[1;36m'; C_RESET=$'\033[0m'
say() { printf '\n%s==> %s%s\n' "$C_CYAN" "$*" "$C_RESET"; }
ok()  { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn(){ printf '  %s⚠%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
bad() { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*"; }

# ---------- 0. 版本与发布记录 ----------
say "0/8 版本检查：${VERSION}"
if ! grep -q "^## v${VERSION}\b" RELEASES.md; then
  bad "RELEASES.md 缺少 '## v${VERSION}' 段（发版前必须先写发布记录）"
  exit 1
fi
ok "RELEASES.md 有 v${VERSION} 段"

if [[ $PUBLISH -eq 1 ]]; then
  : "${GITCODE_TOKEN:? 发布需要设置 GITCODE_TOKEN 环境变量}"
fi

# ---------- 1. 工具链（pnpm shim / 镜像） ----------
say "1/8 工具链"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

# electron-builder 会调 `pnpm list --prod` 探测依赖；系统里的 pnpm 可能是 corepack 壳
# （`pnpm -v` 打出 corepack 帮助、`pnpm list` 语法错误）。真 pnpm 在 workbuddy 的 node workspace。
PNPM_REAL="$HOME/.workbuddy/binaries/node/workspace/node_modules/pnpm/bin/pnpm.cjs"
# 注意：不能用 `pnpm -v` 判断——corepack 壳会返回一个像版本号的数字（实测 0.34.5），
# 但 `pnpm list --prod` 直接语法错误。只要真 pnpm 存在就无脑用它。
if [[ -f "$PNPM_REAL" ]]; then
  SHIM="$(mktemp -d)"
  printf '#!/bin/sh\nexec %s %s "$@"\n' "$(command -v node)" "$PNPM_REAL" > "$SHIM/pnpm"
  chmod +x "$SHIM/pnpm"
  export PATH="$SHIM:$PATH"
  ok "pnpm shim → $(pnpm -v 2>/dev/null || echo '?')"
else
  ok "pnpm $(pnpm -v 2>/dev/null || echo '(系统)')"
fi

# ---------- 2. 编译主进程 / 自定义 server ----------
say "2/8 编译 electron + server"
node scripts/compile-desktop.mjs 2>&1 | tail -3

# ---------- 3. next build（可选复用） ----------
if [[ $REUSE_NEXT -eq 1 && -f .next/standalone/server.js ]]; then
  say "3/8 复用已有 .next（--reuse-next）"
else
  say "3/8 next build（standalone）"
  rm -rf .next
  NEXT_DISABLE_TURBOPACK=1 NODE_OPTIONS='--max-old-space-size=8192' \
    node node_modules/next/dist/bin/next build 2>&1 | tail -5
fi

# ---------- 4. 按 win32-x64 重新 stage ----------
say "4/8 stage-standalone（win32-x64）"
node scripts/stage-standalone.mjs --platform win32 --arch x64 2>&1 | tail -6

# ---------- 5. 先出 dir（拿到 resources/app，afterPack 会裁剪 node_modules） ----------
say "5/8 electron-builder --win dir（app 目录 + afterPack 裁剪）"
rm -rf "${OUT_DIR}"
if ! node node_modules/electron-builder/out/cli/cli.js --config electron-builder.win.yml \
  --win dir --x64 --publish never > /tmp/rw-dir.log 2>&1; then
  tail -15 /tmp/rw-dir.log
  bad "electron-builder --win dir 失败"
  exit 1
fi
grep -E "win-slim" /tmp/rw-dir.log || true
APP_FILES=$(find "${OUT_DIR}/win-unpacked/resources/app" -type f 2>/dev/null | wc -l | tr -d ' ')
if [[ "${APP_FILES}" -gt 2000 ]]; then
  bad "app/node_modules 未裁剪（${APP_FILES} 个文件）——检查 electron-builder.win.yml 的 afterPack"
  exit 1
fi
ok "app 文件数 ${APP_FILES}（已裁剪）"

# ---------- 6. assemble：实体化依赖 + Python + ffmpeg + app-update.yml ----------
say "6/8 assemble-win-resources（去符号链接 / 随包 Python / 内置 ffmpeg）"
node scripts/assemble-win-resources.mjs 2>&1 | tail -12

# ---------- 7. NSIS + 校验 ----------
say "7/8 NSIS 安装包"
node node_modules/electron-builder/out/cli/cli.js --config electron-builder.win.yml \
  --prepackaged "${OUT_DIR}/win-unpacked" --win nsis --x64 --publish never 2>&1 | tail -8

EXE="${OUT_DIR}/BobWork-${VERSION}-win-x64.exe"
[[ -f "${EXE}" ]] || { bad "没有产出 ${EXE}"; exit 1; }
ok "安装器 $(du -h "${EXE}" | cut -f1)"

node scripts/check-win-update-manifest.mjs --dir "${OUT_DIR}" || { bad "更新清单校验未通过"; exit 1; }

# 关键完整性断言：Next 的 traced 别名必须非空（2026-10-24 就是这里空了，
# 装着能启动、一用 SQLite/ws 就崩）。
NS="${OUT_DIR}/win-unpacked/resources/next-standalone"
ALIAS_FILES=$(find "${NS}/.next/node_modules" -type f 2>/dev/null | wc -l | tr -d ' ')
LINKS=$(find "${NS}" -type l 2>/dev/null | wc -l | tr -d ' ')
[[ "${ALIAS_FILES}" -gt 0 ]] || { bad ".next/node_modules 别名是空目录（服务端会崩）"; exit 1; }
[[ "${LINKS}" -eq 0 ]] || { bad "next-standalone 仍有 ${LINKS} 个符号链接（Windows 上不可用）"; exit 1; }
ok "依赖别名 ${ALIAS_FILES} 个文件 / 符号链接 0"

if [[ $PUBLISH -eq 0 ]]; then
  say "完成（未发布）"
  echo "  安装包：${EXE}"
  echo "  发布：bash scripts/release-win.sh --publish"
  exit 0
fi

# ---------- 8. 发布 ----------
say "8/8 发布到 GitCode"
# 顺序闸门：mac 同版本必须已发（否则 latest 频道结构不完整）
code=$(curl -s -o /tmp/rw-release.json -w '%{http_code}' -m 30 \
  "https://api.gitcode.com/api/v5/repos/baolei89/BobWork/releases/tags/${TAG}?access_token=$GITCODE_TOKEN" || true)
if [[ "$code" != "200" ]]; then
  bad "GitCode 上没有 Release ${TAG}（HTTP $code）——必须先发同版本 macOS"
  exit 1
fi
ok "Release ${TAG} 已存在（mac 已先行）"

GITCODE_TOKEN="$GITCODE_TOKEN" UPLOAD_PLATFORM=win bash scripts/upload-to-gitcode.sh

# 最终校验：线上清单可读且与新包一致
curl -s -L -m 60 "$DOWNLOAD_BASE/latest/latest.yml" -o /tmp/rw-latest.yml
node -e '
const fs=require("fs"),c=require("crypto");
const local=fs.readFileSync(process.argv[1]);
const sha=c.createHash("sha512").update(local).digest("base64");
const yml=fs.readFileSync("/tmp/rw-latest.yml","utf8");
const remote=(yml.match(/sha512:\s*(\S+)/)||[])[1];
const size=(yml.match(/size:\s*(\d+)/)||[])[1];
if (sha !== remote || String(local.length) !== size) {
  console.error(`✗ 线上清单与本地不一致：local=${local.length}/${sha} remote=${size}/${remote}`);
  process.exit(1);
}
console.log(`✓ 线上清单一致：${size} bytes`);
' "${EXE}"

say "完成：Windows ${VERSION} 已发布"
echo "  ${DOWNLOAD_BASE}/${TAG}/"
