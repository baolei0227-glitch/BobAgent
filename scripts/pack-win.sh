#!/usr/bin/env bash
# 一键产出 Windows 测试包：组装 → 断言 → NSIS 安装器 → 免安装 zip → 校验摘要
#
# 为什么要有这个脚本（2026-10-19 的教训）：
#   这一版出包时是一串手工命令（stage-standalone → assemble → electron-builder
#   → zip），中间漏一步不会有任何报错，只会表现为「装完打开是白屏」。
#   实际踩到的：assemble 之后又手工修过 node_modules，出安装器时用的却是
#   修复前的 win-unpacked ⇒ 安装版比 zip 少 52 个顶层包（报告 D5）。
#
# 用法：
#   bash scripts/pack-win.sh                  # 组装 + 出包
#   bash scripts/pack-win.sh --skip-assemble   # 复用现有 win-unpacked，只出包
#
# 前置：macOS 上交叉打包，需要 NPMMIRROR（直连 GitHub 会 502）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_ASSEMBLE=0
[[ "${1:-}" == "--skip-assemble" ]] && SKIP_ASSEMBLE=1

TARGET="release/win-unpacked"
STANDALONE="$TARGET/resources/next-standalone"
VERSION="$(node -p "require('./package.json').version")"
ZIP="release/BobWork-${VERSION}-win-x64-免安装.zip"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- 0. 镜像
# 不加镜像时 electron-builder 会去 GitHub 拉 nsis / winCodeSign，实测 502 或挂死。
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
# WorkBuddy 注入的 fs broker shim 会让 fs.rename 返回 CODEBUDDY_BROKER_DENY
unset NODE_OPTIONS 2>/dev/null || true

# electron-builder 会调 `pnpm list --prod` 探测依赖。系统里那个 /Users/*/bin/pnpm
# 可能是 corepack 壳，`pnpm -v` 打出 corepack 版本号、`pnpm list` 直接语法错误。
# 真 pnpm 在 workbuddy 的 node workspace 里，做一个临时 shim 塞到 PATH 最前面。
PNPM_REAL="$HOME/.workbuddy/binaries/node/workspace/node_modules/pnpm/bin/pnpm.cjs"
if [[ -f "$PNPM_REAL" ]]; then
  SHIM="$(mktemp -d)"
  printf '#!/bin/sh\nexec %s %s "$@"\n' "$(command -v node)" "$PNPM_REAL" > "$SHIM/pnpm"
  chmod +x "$SHIM/pnpm"
  export PATH="$SHIM:$PATH"
  ok "pnpm shim → $(pnpm -v 2>/dev/null || echo '?')"
fi

# ---------------------------------------------------------------- 1. 组装
if [[ $SKIP_ASSEMBLE -eq 0 ]]; then
  say "1/4 组装 resources/win-unpacked"
  node scripts/assemble-win-resources.mjs
else
  say "1/4 跳过组装（--skip-assemble）"
  [[ -f "$STANDALONE/server.js" ]] || { bad "没有 $STANDALONE/server.js，不能跳过组装"; exit 1; }
fi

# ---------------------------------------------------------------- 2. 断言
say "2/4 打包前断言"
FAIL=0
assert() { if eval "$2"; then ok "$1"; else bad "$1"; FAIL=$((FAIL+1)); fi; }

assert "server.js 是自定义入口（含 remote-login）" \
  "grep -q 'remote-login' '$STANDALONE/server.js'"
assert "无 .pnpm（长路径源头）" \
  "[[ ! -d '$STANDALONE/node_modules/.pnpm' ]]"
assert "无符号链接（Windows 上是坏文件）" \
  "[[ \$(find '$STANDALONE' -type l | wc -l | tr -d ' ') == 0 ]]"
assert "顶层包数 ≥ 150" \
  "[[ \$(ls '$STANDALONE/node_modules' | grep -v '^\\.' | wc -l | tr -d ' ') -ge 150 ]]"
assert "better-sqlite3 有 win32-x64 预编译" \
  "[[ -f '$STANDALONE/node_modules/better-sqlite3/prebuilds/win32-x64.node' ]]"
assert ".next 追踪副本也有 win32-x64 预编译" \
  "find '$STANDALONE/.next/node_modules' -path '*better-sqlite3*' -name 'win32-x64.node' | grep -q ."
assert "static/chunks 存在" \
  "[[ -d '$STANDALONE/.next/static/chunks' ]]"
# 随包 Python：缺了不会白屏，只会让 Office/PDF/图片功能静默失效，最难排查，必须前置拦住
assert "随包 Python 解释器存在" \
  "[[ -f '$TARGET/resources/python/python.exe' ]]"
assert "随包 Python 含 docx / Pillow / lxml" \
  "[[ -f '$TARGET/resources/python/Lib/site-packages/docx/__init__.py' && -f '$TARGET/resources/python/Lib/site-packages/PIL/Image.py' && -f '$TARGET/resources/python/Lib/site-packages/lxml/etree.cp311-win_amd64.pyd' ]]"
assert "随包 Python 已启用 site-packages（._pth 含 import site）" \
  "grep -q 'import site' '$TARGET/resources/python/python311._pth' && grep -q 'site-packages' '$TARGET/resources/python/python311._pth'"
# MCP 子进程的外部依赖（nft 只按宿主引用追踪，这几类必须由 fixer 补）
assert "MCP external 依赖齐备（openai / pdf-parse / @hono/node-server）" \
  "[[ -f '$STANDALONE/node_modules/openai/package.json' && -f '$STANDALONE/node_modules/pdf-parse/package.json' && -f '$STANDALONE/node_modules/@hono/node-server/package.json' ]]"
# 六个 MCP 的入口都在
assert "6 个 bob-*-mcp 入口齐备" \
  "[[ \$(find '$STANDALONE' -maxdepth 3 -path '*/bob-*-mcp/dist/cli.js' | wc -l | tr -d ' ') -ge 6 ]]"
# 污染包：package.json 只有 {\"type\":\"commonjs\"}（无 name），说明子目录被当成了包根
POLLUTED=$(cd "$STANDALONE/node_modules" && for p in */ @*/*/; do p="${p%/}"; [ -f "$p/package.json" ] || continue; if ! grep -q '"name"' "$p/package.json" 2>/dev/null; then echo "$p"; fi; done | wc -l | tr -d ' ')
if [[ "$POLLUTED" == "0" ]]; then ok "无污染包（package.json 均带 name）"
else bad "有 $POLLUTED 个包的 package.json 缺 name（子目录被当成包根）"; FAIL=$((FAIL+1)); fi

# 最长路径：解压到 C:\BobWork 后必须 < 240（Windows 上限 260，留余量）
# ⚠️ 用 awk 求最大值而不是 `sort -rn | head -1`：head 提前关管道会让 sort 收到
#    SIGPIPE，在 set -o pipefail 下整个命令替换失败并静默退出脚本（实测 "sort: Broken pipe"）。
MAXLEN=$(cd "$STANDALONE" && find . -type f -o -type d | awk '{ if (length($0) > m) m = length($0) } END { print m }')
# 全路径前缀估算（保守）：C:\BobWork\ (10) + win-unpacked\ (13) + resources\next-standalone\ (25)
# 再减掉相对路径开头的 "./"（2 字符）
FULLPATH_LEN=$((MAXLEN - 2 + 48))
if [[ $FULLPATH_LEN -lt 240 ]]; then
  ok "最长路径 ${MAXLEN} 字符（解压到 C:\\BobWork 约 ${FULLPATH_LEN}）"
else
  bad "最长路径 ${MAXLEN} 字符，解压后约 ${FULLPATH_LEN}，已逼近 Windows 260 上限"
  FAIL=$((FAIL+1))
fi

[[ $FAIL -eq 0 ]] || { echo; bad "$FAIL 项断言失败，停止出包"; exit 1; }

# ---------------------------------------------------------------- 3. 安装器
say "3/4 NSIS 安装器"
EB="node_modules/electron-builder/out/cli/cli.js"
[[ -f "$EB" ]] || { bad "找不到 electron-builder：$EB"; exit 1; }
# ⚠️ 必须 --prepackaged：直接 --win nsis 会让 electron-builder 重新组装，
#    把上面手工修好的 node_modules 全部丢掉（D5 就是这么来的）。
node "$EB" \
  --config electron-builder.win.yml \
  --prepackaged "$TARGET" \
  --win nsis --x64 --publish never

EXE="release/BobWork-${VERSION}-win-x64.exe"
[[ -f "$EXE" ]] || { bad "没有产出 $EXE"; exit 1; }
ok "安装器 $(du -h "$EXE" | cut -f1)"
# latest.yml 是 Windows 自动更新的唯一清单（对应 mac 的 latest-mac.yml）。
# 少了它安装包本身能用，但「检查更新」永远静默无结果 —— 出包时就要拦住。
[[ -f release/latest.yml ]] || { bad "没有产出 release/latest.yml（自动更新清单）—— 检查 electron-builder.win.yml 的 publish 段"; exit 1; }
ok "更新清单 latest.yml"

# ---------------------------------------------------------------- 4. 免安装 zip
say "4/4 免安装 zip"
rm -f "$ZIP"
( cd release && zip -q -r -X "$(basename "$ZIP")" win-unpacked )
ok "zip $(du -h "$ZIP" | cut -f1)"

# D5：安装器与 zip 必须出自同一份 win-unpacked，顶层包数一致
TOP=$(ls "$STANDALONE/node_modules" | grep -v '^\.' | wc -l | tr -d ' ')
# `|| true`：grep 无匹配时返回 1，pipefail 下会让整个赋值失败并静默退出
ZIPTOP=$(unzip -l "$ZIP" | awk '{ print $4 }' | grep -oE "win-unpacked/resources/next-standalone/node_modules/[^/]+/$" | sed 's#.*node_modules/##; s#/##' | grep -v '^\.' | sort -u | wc -l | tr -d ' ' || true)
if [[ "$TOP" == "$ZIPTOP" ]]; then ok "zip 顶层包数 $ZIPTOP，与 win-unpacked 一致"
else bad "顶层包数不一致：win-unpacked=$TOP zip=$ZIPTOP"; FAIL=$((FAIL+1)); fi

# ---------------------------------------------------------------- 摘要
say "产物摘要"
printf '  %-46s %8s  %s\n' "$(basename "$EXE")" "$(du -h "$EXE" | cut -f1)" "$(shasum -a 256 "$EXE" | cut -d' ' -f1)"
printf '  %-46s %8s  %s\n' "$(basename "$ZIP")" "$(du -h "$ZIP" | cut -f1)" "$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
printf '  %-46s %8s\n' "$(basename "$EXE").blockmap" "$(du -h "$EXE.blockmap" 2>/dev/null | cut -f1)"
echo
echo "  解压后文件数 $(find "$TARGET" -type f | wc -l | tr -d ' ') ｜ 最长路径 ${MAXLEN} ｜ 顶层包 ${TOP}"
echo
[[ $FAIL -eq 0 ]] && ok "全部通过" || { bad "$FAIL 项未通过"; exit 1; }
