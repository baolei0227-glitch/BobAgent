#!/bin/bash
set -Eeuo pipefail

# 确保 node/corepack 可定位（沙箱环境 PATH 可能被裁剪）
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# ============================================================
# BobWork Release 打包脚本
#   - 用于生成可分发的 macOS 安装包（.app + .zip + .dmg）
#   - 确保所有依赖（包括 electron-updater）完整打包
#   - 默认同时生成 ZIP + DMG + latest-mac.yml（自动更新优先 DMG 更新包）
#   - DMG 优先走完整版（Finder 布局），若 hdiutil attach 被沙箱拦截
#     则自动降级为一步式 DMG（无需挂载 /dev）；SKIP_DMG=1 可跳过 DMG
#
# 用法:
#   bash ./scripts/package-release.sh        # 默认构建 arm64（ZIP + DMG）
#   bash ./scripts/package-release.sh arm64  # 仅打包 Apple Silicon (M1/M2/M3)
#   SKIP_DMG=1 bash ./scripts/package-release.sh  # 仅 ZIP（跳过 DMG）
#
# ⚠️ 发布规则（2026-08 起）：仅生成 ARM 架构（Apple Silicon）。
#    传入 both / x64 会被忽略并自动降级为 arm64。
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

unset BOBWORK_HOME

APP_NAME="BobWork"
VERSION=$(node -e 'process.stdout.write(require("./package.json").version)')
APP_ID="com.bobwork.app"
ARCH="arm64"
OUTPUT_DIR="$PROJECT_DIR/release-dist"
LOG_FILE="$OUTPUT_DIR/build.log"
GITHUB_OWNER="baolei0227-glitch"
GITHUB_REPO="BobAgent"

C_GREEN=$'\033[0;32m'
C_YELLOW=$'\033[1;33m'
C_RED=$'\033[0;31m'
C_RESET=$'\033[0m'

log()  { echo "==> $*"; }
ok()   { echo "${C_GREEN}✅ $*${C_RESET}"; }
warn() { echo "${C_YELLOW}⚠️  $*${C_RESET}"; }
err()  { echo "${C_RED}❌ $*${C_RESET}"; }

# ---------- 构建新鲜度守卫 ----------
# 历史问题：多次出现「安装版不含修复」——源码在编译/组装期间被改动，产物落后于源码，
# 而脚本照常打包上传，直到用户装上新版才发现改动缺失。此处从打包链路根治：
#   1) 构建前 rm -rf .next，强制全量编译（消除 Next 增量缓存复用旧 chunk）；
#   2) 记录构建起始时间戳，打包前校验期间无源文件改动，有则中止（不产出、不上传）。
BUILD_MARKER="$OUTPUT_DIR/.build-marker"

assert_build_fresh() {
  [ -f "$BUILD_MARKER" ] || return 0
  local stale
  stale="$(find "$PROJECT_DIR/src" "$PROJECT_DIR/electron" "$PROJECT_DIR/public" "$PROJECT_DIR/assets" \
    -type d \( -name node_modules -o -name dist -o -name .next \) -prune -o \
    -type f -newer "$BUILD_MARKER" -print 2>/dev/null | sed -n '1,20p')"
  if [ -n "$stale" ]; then
    echo ""
    err "严重错误：以下源文件在本次构建期间被修改，产物已陈旧，中止打包（不产出、不上传）："
    echo "$stale" | sed 's/^/     /'
    echo ""
    err "   请确认源码已保存稳定后重新执行：rm -rf .next && bash ./scripts/package-release.sh"
    exit 1
  fi
  ok "构建新鲜度校验通过（编译/组装期间无源文件改动）"
}

# 发布规则（2026-08 起）：仅生成 ARM 架构，both / x64 一律降级为 arm64
if [ "${1:-}" != "" ] && [ "$1" != "arm64" ]; then
  warn "发布规则：仅支持 arm64，忽略参数 '$1'，按 arm64 构建"
fi

# ---------- 0. 版本号冲突检查 ----------
check_version_conflict() {
  if [ -z "${GH_TOKEN:-}" ]; then
    warn "GH_TOKEN 未设置，跳过版本号冲突检查"
    return 0
  fi

  local tag="v$VERSION"
  log "检查 $tag 是否已发布 ..."

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: token $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/releases/tags/$tag" 2>/dev/null)

  if [ "$http_code" = "200" ]; then
    echo ""
    echo "============================================"
    err " 版本号冲突：$tag 已发布在 GitHub Release 上！"
    echo ""
    echo "  当前 package.json 版本: $VERSION"
    echo "  请先更新版本号后再构建："
    echo ""
    echo "    # 方式 1：手动修改 package.json 中的 version 字段"
    echo "    # 方式 2：使用 npm version"
    echo "    npm version patch    # 1.0.6 -> 1.0.7"
    echo "    npm version minor    # 1.0.6 -> 1.1.0"
    echo ""
    echo "  并在 RELEASES.md 中记录新版本的变更内容。"
    echo "============================================"
    exit 1
  fi

  ok "$tag 未发布，可以构建"
}

check_version_conflict

# ---------- 1. 清理并准备 ----------
rm -rf "$OUTPUT_DIR" >/dev/null 2>&1 || true
mkdir -p "$OUTPUT_DIR"
# 构建起始标记：供 assert_build_fresh 校验「构建期间源码是否被改动」
touch "$BUILD_MARKER"
# 注意：不使用 exec > >(tee ...) 进程替换（部分沙箱环境不允许 /dev/fd/）
# 改为直接重定向到日志文件，同时在 stderr 输出关键进度
exec > "$LOG_FILE" 2>&1

# ---------- 0.5 清理旧更新下载缓存（防止 bob-updater 无限膨胀）----------
# electron-updater 每次下载的安装包都留在 ~/Library/Caches/bob-updater/{downloads,pending}，
# 从不自动清理，数十个版本累积可达数百 MB~GB（2026-09-11 实测 739M）。
# 该缓存仅含旧版本安装包，删除后下次更新会重新下载，无副作用。
UPDATER_CACHE_DIR="$HOME/Library/Caches/bob-updater"
if [ -d "$UPDATER_CACHE_DIR" ]; then
  log "清理旧更新下载缓存 ($UPDATER_CACHE_DIR) ..."
  rm -rf "$UPDATER_CACHE_DIR"/downloads/* "$UPDATER_CACHE_DIR"/pending/* 2>/dev/null || true
  ok "更新下载缓存已清理（剩余 $(du -sh "$UPDATER_CACHE_DIR" 2>/dev/null | awk '{print $1}')）"
fi

log "============================================"
log "BobWork v$VERSION Release Build"
log "Arch: $ARCH"
log "============================================"

# ---------- 2. 构建 Next.js standalone ----------
if [ "${SKIP_NEXT_BUILD:-0}" != "1" ]; then
  # 全量清空 .next：Next 增量构建会复用旧 cache chunk，曾多次导致「源码改动未进包」
  # （用户装上新版仍看不到修复）。Release 构建必须全量，宁可慢也要准。
  rm -rf "$PROJECT_DIR/.next" "$PROJECT_DIR/.next/standalone 2" 2>/dev/null || true
  log "Step 1/6: 构建 Next.js (standalone mode) ..."
  NEXT_DISABLE_TURBOPACK=1 NODE_OPTIONS="--max-old-space-size=4096" corepack pnpm next build
  ok "Next.js 构建完成"
  # 校验客户端静态资源已生成：standalone 模式不会自动把 .next/static 并入 standalone，
  # 若此处为空，最终 zip 将缺失全部客户端 JS chunk → 应用打开后卡 Loading / 客户端异常。
  # 历史教训：v1.2.58/1.2.59 因 .next 缓存损坏（多次构建失败残留）导致 static 缺失，线上用户全部打不开。
  if [ ! -d "$PROJECT_DIR/.next/static" ] || [ -z "$(ls -A "$PROJECT_DIR/.next/static/chunks" 2>/dev/null)" ]; then
    err "❌ 严重错误：next build 未生成客户端静态资源 (.next/static/chunks 为空)！"
    err "   请先清理 .next 缓存后重新构建：rm -rf .next && $0"
    exit 1
  fi
  ok "客户端静态资源校验通过（chunks: $(ls "$PROJECT_DIR/.next/static/chunks" | wc -l | tr -d ' ')）"
else
  log "Step 1/6: 跳过 Next.js 构建 (SKIP_NEXT_BUILD=1)"
fi

# ---------- 3. 编译 Electron 主进程 ----------
log "Step 2/6: 编译 Electron main + preload ..."
corepack pnpm tsup electron/main.ts electron/preload.ts \
  --format cjs --platform node --target node20 \
  --outDir electron/dist --no-splitting --external electron
ok "主进程编译完成"

# ---------- 4. 查找 Electron 运行时 ----------
log "Step 3/6: 查找 Electron 运行时 ..."
ELECTRON_DIR_GLOB="$PROJECT_DIR/node_modules/.pnpm/electron@*/node_modules/electron/dist"
ELECTRON_DIST="$(ls -d $ELECTRON_DIR_GLOB 2>/dev/null | head -1)"
if [ -z "$ELECTRON_DIST" ] || [ ! -d "$ELECTRON_DIST/Electron.app" ]; then
  echo "❌ 找不到 Electron.app"
  exit 1
fi
ELECTRON_APP="$ELECTRON_DIST/Electron.app"
ok "Electron.app 已找到"

# ---------- 5. 组装 staging ----------
STAGING="$OUTPUT_DIR/staging"
rm -rf "$STAGING"
mkdir -p "$STAGING"

# 5a. 主进程 JS
mkdir -p "$STAGING/app"
cp "$PROJECT_DIR/electron/dist/main.js"    "$STAGING/app/main.js"
cp "$PROJECT_DIR/electron/dist/preload.js" "$STAGING/app/preload.js"
# 全局截图 OCR（Cmd+Shift+O）本地 Swift Vision 兜底脚本：与主进程 __dirname 对齐（app/pdf/core/）
mkdir -p "$STAGING/app/pdf/core"
cp "$PROJECT_DIR/src/lib/pdf/core/ocr_vision.swift" "$STAGING/app/pdf/core/ocr_vision.swift"
# 屏幕录制权限预检脚本（SCShareableContent，与 screencapture 同一责任链）
mkdir -p "$STAGING/app/swift"
cp "$PROJECT_DIR/src/lib/screen-ocr/screen_permission.swift" "$STAGING/app/swift/screen_permission.swift"
cat > "$STAGING/app/package.json" <<'EOF'
{
  "name": "bob-work-desktop",
  "version": "1.0.0",
  "main": "main.js"
}
EOF

# 5b. 为 app/ 安装最小依赖
# ⚠️ 这份清单是**手抄**的，必须与 electron/dist/main.js 里 require 的外部模块一致。
#    漏一个的后果不是「少个功能」，而是主进程在 load 期直接 MODULE_NOT_FOUND ——
#    双击图标没反应，或弹 "A JavaScript error occurred in the main process: Cannot find module 'xxx'"。
#    2026-10-19 就是这么崩的：main.ts 新增静态 `import AdmZip from 'adm-zip'`（tsup 原样外置成
#    require，load 期求值），而本清单只写了 electron-updater ⇒ 装完启动即崩。
#    故装完必须**按 main.js 实际 require 的模块逐个断言**（见下方 5b-assert），清单不再是唯一防线。
log "Step 4/6: 安装 Electron 主进程最小依赖 ..."
node -e "
const deps = require('$PROJECT_DIR/package.json').dependencies;
const pkg = {
  name: 'bob-desktop-runtime',
  private: true,
  main: 'main.js',
  dependencies: {
    'electron-updater': deps['electron-updater'] || '^6.0.0',
    'adm-zip': deps['adm-zip'] || '^0.6.0'
  }
};
require('fs').writeFileSync('$STAGING/app/package.json', JSON.stringify(pkg, null, 2));
"
npm --prefix "$STAGING/app" install --omit=dev --no-optional 2>&1 | tail -3
ok "Electron 主进程依赖安装完成 ($(du -sh "$STAGING/app/node_modules" | awk '{print $1}'))"

# 5b-assert. 断言 main.js 里 require 的每个外部模块都能在 app/node_modules 解析到。
#   与 .github/workflows/windows-build.yml 的同名断言同源（Windows 侧早已吃过这个亏；
#   mac 侧此前只靠手抄清单，于是漏了 adm-zip）。
node -e "
const fs = require('fs'), path = require('path'), { builtinModules } = require('module');
const dir = '$STAGING/app/node_modules';
const js = fs.readFileSync('$STAGING/app/main.js', 'utf8');
const re = /require\(\s*['\"]([^'\"]+)['\"]\s*\)/g;
const names = new Set();
let m;
while ((m = re.exec(js))) {
  const n = m[1];
  if (n.startsWith('.') || n.startsWith('/') || n.startsWith('node:')) continue;
  const bare = n.startsWith('@') ? n.split('/').slice(0, 2).join('/') : n.split('/')[0];
  if (builtinModules.includes(bare) || bare === 'electron') continue;
  names.add(bare);
}
const missing = [...names].filter((n) => !fs.existsSync(path.join(dir, n, 'package.json')));
if (missing.length) {
  console.error('❌ app/node_modules 缺少 main.js 需要的外部模块: ' + missing.join(', '));
  process.exit(1);
}
console.log('✅ main.js 外部依赖齐全: ' + [...names].sort().join(', '));
"

# 5c. 生成 app-update.yml
# 自动更新源：GitCode（国内 CDN 加速，检查更新 + 下载安装包全走 GitCode）
# electron-updater generic provider 会在 url 下查找 latest-mac.yml
GITCODE_OWNER="${GITCODE_OWNER:-baolei89}"
GITCODE_REPO="${GITCODE_REPO:-BobWork}"
cat > "$STAGING/app-update.yml" <<EOF
provider: generic
url: https://gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO}/releases/download/latest
channel: latest
updaterCacheDirName: bob-updater
EOF

# 5d. Next.js standalone（保留其自带的精简 node_modules）
log "组装 Next.js standalone build ..."
mkdir -p "$STAGING/next-standalone"
cp -R "$PROJECT_DIR/.next/standalone/." "$STAGING/next-standalone/"
# 清理误入 standalone 的构建残留/备份（.next.bak-*/.next.old-*/release 曾分别把 462M/1.8G/363M 打进安装包）
find "$STAGING/next-standalone" -maxdepth 1 \( -name '.next.bak-*' -o -name '.next.old-*' -o -name 'release' \) -exec rm -rf {} + 2>/dev/null || true
# Next.js 16 standalone 输出到 <项目目录名>/ 子目录（如 projects/），检测并提升一层
if [ ! -f "$STAGING/next-standalone/server.js" ] && [ -f "$STAGING/next-standalone/projects/server.js" ]; then
  cp -R "$STAGING/next-standalone/projects/." "$STAGING/next-standalone/"
  rm -rf "$STAGING/next-standalone/projects"
  # 修复提升后失效的相对符号链接（Next 16 原生模块 external）：
  # standalone 在 projects/.next/node_modules/ 下生成指向
  #   ../../../projects/node_modules/.pnpm/<pkg>/node_modules/<pkg>
  # 的相对符号链接（better-sqlite3 / pg 等 serverExternalPackages）。
  # 提升后 projects/ 已删除，原相对路径解析失败 → 运行时 require('better-sqlite3-<hash>')
  # 报 "Cannot find module 'better-sqlite3-<hash>'"（日历/DB 功能直接崩）。
  # 此处把前缀 ../../../projects/node_modules/ 改写为 ../../node_modules/（提升后 node_modules 已上移一层）。
  _symlink_dir="$STAGING/next-standalone/.next/node_modules"
  if [ -d "$_symlink_dir" ]; then
    # 递归处理所有符号链接（含 scope 子目录如 @modelcontextprotocol/）：
    # 顶层 better-sqlite3/pg 形如 ../../../projects/node_modules/...，
    # scope 子目录形如 ../../../../projects/node_modules/...，统一规则：
    # 去掉 "projects/" 段并减少一层 "../"（即把 "../projects/" 替换为空）。
    while IFS= read -r -d '' _symlink; do
      _symlink_target="$(readlink "$_symlink")"
      case "$_symlink_target" in
        */projects/node_modules/*)
          _symlink_new="$(printf '%s' "$_symlink_target" | sed 's#\.\./projects/##')"
          rm -f "$_symlink"
          ln -s "$_symlink_new" "$_symlink"
          log "  修复符号链接 $(basename "$_symlink") -> $_symlink_new"
          ;;
      esac
    done < <(find "$_symlink_dir" -type l -print0)
  fi
fi

# 补齐「裸名」顶层符号链接（修复自定义 server 入口的 serverExternalPackages 解析）
# 为什么要补：自定义 server 入口由 tsup 打包（见步骤 5e），tsup 会把 package.json 依赖
# 保留为**裸名**外部引用（产物里是 `import("better-sqlite3")` 这种原样 specifier）；
# 而 Next standalone 只在 .next/node_modules 下以 `<pkg>-<hash>` 的哈希别名暴露这些
# serverExternalPackages，根 node_modules 里**没有裸名入口** —— 于是 server.js 运行时解析
# 失败：`Cannot find package 'better-sqlite3'`（日历后台同步 worker 直接失效，日志
# `[calendar-sync] background sync error`）。Next 自己编译的路由走哈希别名不受影响，
# 只有这个自建入口会踩到。此处把每个哈希别名镜像成根 node_modules 下的裸名符号链接
# （包本体与原生二进制都已在包内，只是缺一个入口）。
_sa_alias_dir="$STAGING/next-standalone/.next/node_modules"
_sa_nm_dir="$STAGING/next-standalone/node_modules"
if [ -d "$_sa_alias_dir" ]; then
  while IFS= read -r -d '' _alias; do
    _alias_rel="${_alias#$_sa_alias_dir/}"
    _pkg_name="$(printf '%s' "$_alias_rel" | sed -E 's#-[0-9a-f]{16}$##')"
    _alias_target="$(readlink "$_alias")"
    # 必须真的去掉了一段哈希后缀（否则包名本身就形如 foo-<16hex>，属误判）
    [ "$_pkg_name" != "$_alias_rel" ] || continue
    # 目标末节须与包名末节一致（防止改写错包）
    [ "$(basename "$_alias_target")" = "$(basename "$_pkg_name")" ] || continue
    if [ -e "$_sa_nm_dir/$_pkg_name" ]; then continue; fi
    # 别名在 .next/node_modules 下，裸名链接上移一层 → 相对目标去掉一个前导 ../
    mkdir -p "$(dirname "$_sa_nm_dir/$_pkg_name")"
    ln -s "$(printf '%s' "$_alias_target" | sed 's#^\.\./##')" "$_sa_nm_dir/$_pkg_name"
    log "  补齐裸名依赖 $_pkg_name"
  done < <(find "$_sa_alias_dir" -type l -print0)
fi

rm -rf "$STAGING/next-standalone/release" 2>/dev/null || true
rm -rf "$STAGING/next-standalone/.next/standalone" 2>/dev/null || true
# 清理 release-dist 构建产物目录及其并发冲突副本（防止被循环打包）
rm -rf "$STAGING/next-standalone/release-dist" "$STAGING/next-standalone/release-dist 2" 2>/dev/null || true
rm -rf "$STAGING/next-standalone"/*" 2" 2>/dev/null || true
# 保留 standalone 自带的 node_modules（Next.js 已做 tree-shaking）
# 只删除明显不需要的目录
rm -rf "$STAGING/next-standalone/node_modules/.cache" 2>/dev/null || true

# --- standalone 运行时非必需文件清理（体积优化）---
# e2e 测试代码与产物：运行时完全不需要
rm -rf "$STAGING/next-standalone/e2e" "$STAGING/next-standalone/test-results" 2>/dev/null || true
# 源码目录：.next 已包含编译产物，src 不参与运行
rm -rf "$STAGING/next-standalone/src" "$STAGING/next-standalone/nodes" 2>/dev/null || true
# 开发配置文件：运行时不读取
rm -f "$STAGING/next-standalone/tsconfig.json" \
      "$STAGING/next-standalone/tsconfig.tsbuildinfo" \
      "$STAGING/next-standalone/pnpm-lock.yaml" \
      "$STAGING/next-standalone/eslint.config.mjs" \
      "$STAGING/next-standalone/stylelint.config.mjs" \
      "$STAGING/next-standalone/tailwind.config.js" \
      "$STAGING/next-standalone/postcss.config.js" \
      "$STAGING/next-standalone/components.json" \
      "$STAGING/next-standalone/.babelrc" \
      "$STAGING/next-standalone/.npmrc" \
      "$STAGING/next-standalone/.gitignore" \
      "$STAGING/next-standalone/playwright.config.ts" \
      "$STAGING/next-standalone/playwright-mcp-config.json" \
      2>/dev/null || true
# 文档与设计文档：运行时不读取
rm -f "$STAGING/next-standalone/README.md" \
      "$STAGING/next-standalone/LICENSE" \
      "$STAGING/next-standalone/FORMAT.md" \
      "$STAGING/next-standalone/DESIGN.md" \
      "$STAGING/next-standalone/AGENTS.md" \
      "$STAGING/next-standalone/RELEASES.md" \
      "$STAGING/next-standalone/BobWork-实习律师使用说明书.md" \
      "$STAGING/next-standalone/install-skill-方案-20260730.md" \
      "$STAGING/next-standalone/workflow-template-方案-20260730.md" \
      "$STAGING/next-standalone/next.config.ts" \
      2>/dev/null || true

# 5e. 自定义 server 入口（远程访问鉴权网关 + CalDAV 自定义 HTTP 方法）
# 为什么必须覆盖：Electron 启动的是 next-standalone/server.js（见 electron/main.ts），
# 而 Next build 生成的该文件是「原生 standalone wrapper」——只有 startServer，不含任何
# 自定义逻辑。不覆盖的话，远程访问 Token 网关与 CalDAV 的 PROPFIND/REPORT/MKCOL 等方法
# 在打包版里全部失效（2026-10-01 实测：整包搜不到 remote-login / PROPFIND 路由）。
# 产物同时覆盖 dist/server.js，避免包内残留上一轮构建的陈旧副本。
log "编译自定义 server 入口 (src/server.ts) ..."
corepack pnpm tsup src/server.ts \
  --format cjs --platform node --target node20 \
  --outDir "$STAGING/next-standalone/dist" --no-splitting --no-minify
cp "$STAGING/next-standalone/dist/server.js" "$STAGING/next-standalone/server.js"
ok "自定义 server 已就位（$(wc -c < "$STAGING/next-standalone/server.js" | tr -d ' ') bytes）"

cp -R "$PROJECT_DIR/.next/static" "$STAGING/next-standalone/.next/"
cp -R "$PROJECT_DIR/public" "$STAGING/next-standalone/"
# 内置技能（assets/skills）随包分发：打包版 cwd 为 next-standalone，loader 读取 ./assets/skills
cp -R "$PROJECT_DIR/assets/skills" "$STAGING/next-standalone/assets/skills"
# PDF 提取脚本复制到 standalone scripts/（T1-1 修复：从 core/ 真源复制；顶层曾是 172B 占位 stub。
# pdf_to_images.py / crop_regions.swift：projects 瘦壳已不引用，不再分发）
mkdir -p "$STAGING/next-standalone/scripts"
cp "$PROJECT_DIR/src/lib/pdf/core/pdf_extractor.py" "$STAGING/next-standalone/scripts/pdf_extractor.py"
cp "$PROJECT_DIR/src/lib/pdf/core/ocr_vision.swift" "$STAGING/next-standalone/scripts/ocr_vision.swift" 2>/dev/null || true
# OOXML 修订引擎脚本（docx track changes）复制到 standalone scripts/
cp "$PROJECT_DIR/src/lib/docx/ooxml-revise.py" "$STAGING/next-standalone/scripts/ooxml-revise.py"
# Python 包生命周期清理脚本（AI 安装包超过30天未使用自动卸载）
cp "$PROJECT_DIR/src/lib/python/py-pkg-lifecycle.py" "$STAGING/next-standalone/scripts/py-pkg-lifecycle.py"
# 声纹提取 C 源码（speaker-embed 运行时用 clang 现场编译，不是 import 出来的）：
# 打包收尾会删掉 next-standalone/src，靠 outputFileTracingIncludes 追踪进来的源码会随之丢失，故显式复制
cp "$PROJECT_DIR/src/lib/stt/native/spk_embed.c" "$STAGING/next-standalone/scripts/spk_embed.c"
# 常驻标点服务 C 源码（punct-server 同款：运行时 clang 现场编译；同样必须绕开被删的 src 树）
cp "$PROJECT_DIR/src/lib/stt/native/punct_server.c" "$STAGING/next-standalone/scripts/punct_server.c"
# 独立 docx-template-mcp 包脚本（scan_placeholders / fill_template）随包分发：
# 复制到 next-standalone/docx-template-mcp/assets/scripts/（匹配 resolveDocxTemplateScript 的 cwd 候选，
# 否则安装版字段识别会因脚本缺失而静默失败）
if [ -d "$PROJECT_DIR/../docx-template-mcp/assets/scripts" ]; then
  mkdir -p "$STAGING/next-standalone/docx-template-mcp/assets/scripts"
  cp "$PROJECT_DIR/../docx-template-mcp/assets/scripts/scan_placeholders.py" "$STAGING/next-standalone/docx-template-mcp/assets/scripts/"
  cp "$PROJECT_DIR/../docx-template-mcp/assets/scripts/fill_template.py" "$STAGING/next-standalone/docx-template-mcp/assets/scripts/"
  ok "docx-template-mcp 脚本已随包分发"
else
  warn "docx-template-mcp/assets/scripts 不存在，字段识别将不可用"
fi
# 内置 bob-team-mcp（Agent Teams 多成员编排 MCP）：
#   构建插件 → 复制 dist + package.json 到 next-standalone/bob-team-mcp/ → 安装运行时依赖。
#   standalone 的 node_modules 不含 @modelcontextprotocol/sdk（Next tree-shaking 未收录），
#   插件必须自带 node_modules；预置配置里 {BUNDLED}:bob-team-mcp/dist/cli.js 在 server
#   读取 settings 时按 cwd（=next-standalone）解析成绝对路径（见 settings-server.ts）。
TEAM_MCP_DIR="$PROJECT_DIR/../bob-team-mcp"
if [ -d "$TEAM_MCP_DIR" ]; then
  log "内置 bob-team-mcp（Agent Teams）..."
  # 直接用插件本地 tsc 编译（绕过 corepack/pnpm 包装层，历史教训见构建脚本注释）
  if ! (cd "$TEAM_MCP_DIR" && "$TEAM_MCP_DIR/node_modules/.bin/tsc" -p tsconfig.json >/dev/null 2>&1); then
    warn "bob-team-mcp 构建失败，Agent Teams 功能将不可用"
  else
    mkdir -p "$STAGING/next-standalone/bob-team-mcp"
    cp -R "$TEAM_MCP_DIR/dist" "$STAGING/next-standalone/bob-team-mcp/dist"
    cp "$TEAM_MCP_DIR/package.json" "$STAGING/next-standalone/bob-team-mcp/package.json"
    npm --prefix "$STAGING/next-standalone/bob-team-mcp" install --omit=dev --no-optional --silent 2>&1 | tail -1 || true
    ok "bob-team-mcp 已内置 ($(du -sh "$STAGING/next-standalone/bob-team-mcp" | awk '{print $1}'))"
  fi
else
  warn "bob-team-mcp 目录不存在，Agent Teams 功能不可用"
fi
# 内置 bob-preview-mcp（网页/小程序预览渲染 CDP 插件）：
#   构建插件 → 复制 dist + package.json 到 next-standalone/bob-preview-mcp/ → 安装运行时依赖。
#   与 bob-team-mcp 同理，必须自带 node_modules（standalone 不含 @modelcontextprotocol/sdk）。
#   预置配置里 {BUNDLED}:bob-preview-mcp/dist/cli.js 在 server 读取 settings 时按 cwd 解析。
PREVIEW_MCP_DIR="$PROJECT_DIR/../bob-preview-mcp"
if [ -d "$PREVIEW_MCP_DIR" ]; then
  log "内置 bob-preview-mcp（Preview CDP）..."
  if ! (cd "$PREVIEW_MCP_DIR" && npm run build >/dev/null 2>&1); then
    warn "bob-preview-mcp 构建失败，Preview CDP 功能将不可用"
  else
    mkdir -p "$STAGING/next-standalone/bob-preview-mcp"
    cp -R "$PREVIEW_MCP_DIR/dist" "$STAGING/next-standalone/bob-preview-mcp/dist"
    cp "$PREVIEW_MCP_DIR/package.json" "$STAGING/next-standalone/bob-preview-mcp/package.json"
    npm --prefix "$STAGING/next-standalone/bob-preview-mcp" install --omit=dev --no-optional --silent 2>&1 | tail -1 || true
    ok "bob-preview-mcp 已内置 ($(du -sh "$STAGING/next-standalone/bob-preview-mcp" | awk '{print $1}'))"
  fi
else
  warn "bob-preview-mcp 目录不存在，Preview CDP 功能不可用"
fi
# 内置 bob-notes-mcp（个人知识库 · Karpathy LLM Wiki 笔记插件）：
#   构建插件 → 复制 dist + package.json 到 next-standalone/bob-notes-mcp/。
#   bob-notes-mcp 的 cli.js 为 esbuild 单文件 bundle（已内联 @modelcontextprotocol/sdk 与 web 面板），
#   无需再安装运行时依赖；预置配置里 {BUNDLED}:bob-notes-mcp/dist/cli.js 在 server 读取
#   settings 时按 cwd（=next-standalone）解析成绝对路径（见 settings-server.ts）。
NOTES_MCP_DIR="$PROJECT_DIR/../bob-notes-mcp"
if [ -d "$NOTES_MCP_DIR" ]; then
  log "内置 bob-notes-mcp（Notes · Karpathy LLM Wiki）..."
  if ! (cd "$NOTES_MCP_DIR" && npm run build >/dev/null 2>&1); then
    warn "bob-notes-mcp 构建失败，Notes 功能将不可用"
  else
    mkdir -p "$STAGING/next-standalone/bob-notes-mcp"
    cp -R "$NOTES_MCP_DIR/dist" "$STAGING/next-standalone/bob-notes-mcp/dist"
    cp "$NOTES_MCP_DIR/package.json" "$STAGING/next-standalone/bob-notes-mcp/package.json"
    ok "bob-notes-mcp 已内置 ($(du -sh "$STAGING/next-standalone/bob-notes-mcp" | awk '{print $1}'))"
  fi
else
  warn "bob-notes-mcp 目录不存在，Notes 功能不可用"
fi
# 内置 bob-mind-mcp（Bob-Mind 独立思维便签插件）：构建 + 复制 dist/package.json。
#   cli.js 同为 esbuild 单文件 bundle（内联 SDK 与 web 面板），无需运行时安装。
MIND_MCP_DIR="$PROJECT_DIR/../bob-mind-mcp"
if [ -d "$MIND_MCP_DIR" ]; then
  log "内置 bob-mind-mcp（Bob-Mind）..."
  if ! (cd "$MIND_MCP_DIR" && npm run build >/dev/null 2>&1); then
    warn "bob-mind-mcp 构建失败，Bob-Mind 功能将不可用"
  else
    mkdir -p "$STAGING/next-standalone/bob-mind-mcp"
    cp -R "$MIND_MCP_DIR/dist" "$STAGING/next-standalone/bob-mind-mcp/dist"
    cp "$MIND_MCP_DIR/package.json" "$STAGING/next-standalone/bob-mind-mcp/package.json"
    ok "bob-mind-mcp 已内置 ($(du -sh "$STAGING/next-standalone/bob-mind-mcp" | awk '{print $1}'))"
  fi
else
  warn "bob-mind-mcp 目录不存在，Bob-Mind 功能不可用"
fi
# 内置 coze-mcp（扣子 OpenAPI 桥 MCP）：构建 + 复制 dist/package.json。
#   cli.js 为 esbuild 单文件 bundle（已内联 @modelcontextprotocol/sdk），无需运行时安装依赖；
#   预置配置里 {BUNDLED}:coze-mcp/dist/cli.js 在 server 读取 settings 时按 cwd 解析。
COZE_MCP_DIR="$PROJECT_DIR/../coze-mcp"
if [ -d "$COZE_MCP_DIR" ]; then
  log "内置 coze-mcp（Coze · 扣子）..."
  if ! (cd "$COZE_MCP_DIR" && npm run build >/dev/null 2>&1); then
    warn "coze-mcp 构建失败，Coze 功能将不可用"
  else
    mkdir -p "$STAGING/next-standalone/coze-mcp"
    cp -R "$COZE_MCP_DIR/dist" "$STAGING/next-standalone/coze-mcp/dist"
    cp "$COZE_MCP_DIR/package.json" "$STAGING/next-standalone/coze-mcp/package.json"
    ok "coze-mcp 已内置 ($(du -sh "$STAGING/next-standalone/coze-mcp" | awk '{print $1}'))"
  fi
else
  warn "coze-mcp 目录不存在，Coze 功能不可用"
fi
# 内置 bobby-mcp（Bobby node · 桌面软件 GUI 自动化 MCP）：
#   构建插件 → 复制 dist + package.json + scripts 到 next-standalone/bobby-mcp/ → 安装运行时依赖。
#   注意两点：
#   1) 依赖 @modelcontextprotocol/sdk，cli.js 非单文件 bundle，必须自带 node_modules；
#   2) scripts/*.swift 必须一并随包——SCRIPTS_DIR 由 dist 上级目录推导（ocr-recovery.ts:27），
#      input_events / ax_tree / ocr_locate / ocr_vision / screen_capture / screen_info / permissions_check
#      均在运行时按需 swiftc 编译，缺失会导致全部 GUI 动作失败。
#   预置配置里 {BUNDLED}:bobby-mcp/dist/cli.js 在 server 读取 settings 时按 cwd 解析。
BOBBY_MCP_DIR="$PROJECT_DIR/../bobby-mcp"
if [ -d "$BOBBY_MCP_DIR" ]; then
  log "内置 bobby-mcp（Bobby node · 桌面控制）..."
  if ! (cd "$BOBBY_MCP_DIR" && npm run build >/dev/null 2>&1); then
    warn "bobby-mcp 构建失败，Bobby node 功能将不可用"
  else
    mkdir -p "$STAGING/next-standalone/bobby-mcp"
    cp -R "$BOBBY_MCP_DIR/dist" "$STAGING/next-standalone/bobby-mcp/dist"
    cp "$BOBBY_MCP_DIR/package.json" "$STAGING/next-standalone/bobby-mcp/package.json"
    if [ -d "$BOBBY_MCP_DIR/scripts" ]; then
      cp -R "$BOBBY_MCP_DIR/scripts" "$STAGING/next-standalone/bobby-mcp/scripts"
    else
      warn "bobby-mcp/scripts 不存在，GUI 动作（Swift helper）将不可用"
    fi
    npm --prefix "$STAGING/next-standalone/bobby-mcp" install --omit=dev --no-optional --silent 2>&1 | tail -1 || true
    ok "bobby-mcp 已内置 ($(du -sh "$STAGING/next-standalone/bobby-mcp" | awk '{print $1}'))"
  fi
else
  warn "bobby-mcp 目录不存在，Bobby node 功能不可用"
fi
# 内置 bob-video-shot-mcp（视频自动截图工具 · Next.js 网页面板插件）：
#   与前面几个 MCP 插件有两点结构差异，不处理的话用户点开面板只会看到空态：
#   1) panel.mode = 'serve'（不是 static）。宿主在 /api/plugin-web/bob-video-shot-mcp
#      处把请求反代到插件自己拉起的网页进程（见 projects/src/lib/http/plugin-web-proxy.ts）。
#      端口是宿主动态分配的，所以 Hippo 书签必须记宿主反代地址、**不能**记插件端口。
#   2) web/ 是 **Next standalone 产物**（自带 server.js 与裁剪过的 node_modules），
#      不是内联在 cli.js 里的 HTML 字符串。dist/cli.js 只含 MCP 那半边。
#      ⚠️ server.js 与 node_modules **缺一不可**；完整性判据见下方（只看 server.js 会静默漏掉 53MB）。
#   ⚠️ web/ 里的资源前缀在 `next build` 时就被烘焙成 basePath
#      （= /api/plugin-web/bob-video-shot-mcp，见 bob-video-shot-mcp/web-src/next.config.ts）。
#      改动 panel.hostPath 后必须重跑 `npm run build:web`，否则页面能开、静态资源全 404。
VIDEO_SHOT_MCP_DIR="$PROJECT_DIR/../bob-video-shot-mcp"
# web/ 完整性判据 = server.js **且** node_modules/next/package.json。
#   build-web.sh 第 48 行 `cp -R .next/standalone/. "$WEB/"` 是把 server.js 与
#   node_modules（≈53MB：next / react / react-dom / styled-jsx / @next / @swc / client-only）
#   **一起**拷进 web/ 的——后者才是 `node web/server.js` 里 require('next') 的运行时来源。
#   只判 server.js 的后果：node_modules 若被裁掉（例如手工清盘），本脚本会**静默复用**这份残缺产物——
#   包小 53MB 看着「更瘦」，实则 require('next') 只能向上回退到宿主 next-standalone/node_modules，
#   而那里只有 next / react / react-dom（无 styled-jsx / @next / @swc / client-only）
#   ⇒ 用户点开面板直接白屏。**体积变小是症状，不是优化。**
video_shot_web_complete() {
  [ -f "$VIDEO_SHOT_MCP_DIR/web/server.js" ] \
    && [ -f "$VIDEO_SHOT_MCP_DIR/web/node_modules/next/package.json" ]
}
if [ -d "$VIDEO_SHOT_MCP_DIR" ]; then
  log "内置 bob-video-shot-mcp（Video Shot）..."
  if ! (cd "$VIDEO_SHOT_MCP_DIR" && npm run build >/dev/null 2>&1); then
    warn "bob-video-shot-mcp 构建失败，Video Shot 功能将不可用"
  else
    # web/ 构建很慢（next build + web-src 依赖安装），只在 basePath 或网页源码变更时才需要重做
    # → 已完整就复用，不完整才自愈，避免每次打包白等几分钟。
    if ! video_shot_web_complete; then
      # 自愈优先走便宜的那档：standalone 中间产物里就存着 build-web.sh 的拷贝源，
      # 直接回填 node_modules 即可；重跑 next build 那档只留给「首次 / 源码变更」。
      if [ -f "$VIDEO_SHOT_MCP_DIR/web/server.js" ] \
         && [ -d "$VIDEO_SHOT_MCP_DIR/web-src/.next/standalone/node_modules/next" ]; then
        log "  web/node_modules 缺失，从 web-src/.next/standalone 回填（免重跑 next build）..."
        # 必须先删：目标目录已存在时 `cp -R src dst` 会嵌套成 dst/node_modules/node_modules
        rm -rf "$VIDEO_SHOT_MCP_DIR/web/node_modules"
        cp -R "$VIDEO_SHOT_MCP_DIR/web-src/.next/standalone/node_modules" "$VIDEO_SHOT_MCP_DIR/web/node_modules"
      else
        log "  web/ 缺失或不完整，构建网页面板（首次较慢）..."
        if ! (cd "$VIDEO_SHOT_MCP_DIR" && npm run build:web >/dev/null 2>&1); then
          warn "  网页面板构建失败，Video Shot 面板将无法打开"
        fi
      fi
    fi
    mkdir -p "$STAGING/next-standalone/bob-video-shot-mcp"
    cp -R "$VIDEO_SHOT_MCP_DIR/dist" "$STAGING/next-standalone/bob-video-shot-mcp/dist"
    cp "$VIDEO_SHOT_MCP_DIR/package.json" "$STAGING/next-standalone/bob-video-shot-mcp/package.json"
    if video_shot_web_complete; then
      cp -R "$VIDEO_SHOT_MCP_DIR/web" "$STAGING/next-standalone/bob-video-shot-mcp/web"
      ok "bob-video-shot-mcp 已内置 ($(du -sh "$STAGING/next-standalone/bob-video-shot-mcp" | awk '{print $1}'))"
    else
      # 不完整时**不拷**：半份 web/ 只会让用户白屏，且体积伪装成「已瘦身」；
      # 空态面板（「插件未运行」）至少是诚实的失败。
      warn "  web/ 不完整（缺 server.js 或 node_modules），Video Shot 面板将显示「插件未运行」空态"
    fi
  fi
else
  warn "bob-video-shot-mcp 目录不存在，Video Shot 功能不可用"
fi
# 内置 bob-ocr-mcp（Bob OCR · 扫描件/图片识别常驻桥）：
#   2026-10-12 前它**不在随包清单里** —— 桥要用户自己 `npm i -g bob-ocr-mcp` 再 `--install-daemon`；
#   普通用户装完 BobWork 只会在 Extensions Store 看到「Bob OCR plugin is offline or not configured」。
#   现在随包分发，由宿主 mcp/ocr-bridge.ts 托管拉起（{BUNDLED}:bob-ocr-mcp/dist/cli.js --serve）。
#   两点与 bob-team/bobby 同构，漏掉就会「装完不能用」：
#   1) cli.js 是 esbuild 单文件 bundle，但 pdf-parse / @modelcontextprotocol/sdk / openai 保持 external
#      ⇒ 必须自带 node_modules（standalone 的 node_modules 不含 SDK）；
#   2) assets/（pdf_extractor.py / pdf_to_images.py / ocr_vision.swift / crop_regions.swift）
#      是识别管线的真实执行件，findPackageAssetsDir 从 dist 上级目录定位 ⇒ 必须与 dist 同级随包。
OCR_MCP_DIR="$PROJECT_DIR/../bob-ocr-mcp"
if [ -d "$OCR_MCP_DIR" ]; then
  log "内置 bob-ocr-mcp（Bob OCR）..."
  if ! (cd "$OCR_MCP_DIR" && "$OCR_MCP_DIR/node_modules/.bin/tsc" --noEmit -p tsconfig.json >/dev/null 2>&1 && node scripts/build.mjs >/dev/null 2>&1); then
    warn "bob-ocr-mcp 构建失败，Bob OCR 将不可用（用户只能自行安装 daemon）"
  else
    mkdir -p "$STAGING/next-standalone/bob-ocr-mcp"
    cp -R "$OCR_MCP_DIR/dist" "$STAGING/next-standalone/bob-ocr-mcp/dist"
    cp "$OCR_MCP_DIR/package.json" "$STAGING/next-standalone/bob-ocr-mcp/package.json"
    if [ -d "$OCR_MCP_DIR/assets" ]; then
      cp -R "$OCR_MCP_DIR/assets" "$STAGING/next-standalone/bob-ocr-mcp/assets"
    else
      warn "  bob-ocr-mcp/assets 不存在，本地 Vision / PDF 解析脚本将不可用（仅剩线上引擎）"
    fi
    npm --prefix "$STAGING/next-standalone/bob-ocr-mcp" install --omit=dev --no-optional --silent 2>&1 | tail -1 || true
    # 校验运行时依赖真的落地：npm 缓存权限异常（~/.npm 里有 root 属主文件）时 install 会失败，
    # 而 `|| true` 会把它吞掉 —— 缺 node_modules 的随包副本在用户机器上直接 MODULE_NOT_FOUND。
    if [ -d "$STAGING/next-standalone/bob-ocr-mcp/node_modules/@modelcontextprotocol/sdk" ] \
      && [ -d "$STAGING/next-standalone/bob-ocr-mcp/node_modules/pdf-parse" ] \
      && [ -d "$STAGING/next-standalone/bob-ocr-mcp/node_modules/openai" ]; then
      ok "bob-ocr-mcp 已内置 ($(du -sh "$STAGING/next-standalone/bob-ocr-mcp" | awk '{print $1}'))"
    else
      warn "bob-ocr-mcp 运行时依赖不完整（node_modules 缺 sdk/pdf-parse/openai）——随包桥启动会失败，请检查 npm 缓存权限后重跑"
    fi
  fi
else
  warn "bob-ocr-mcp 目录不存在，Bob OCR 不可用"
fi
ok "Next.js standalone 准备完成（node_modules: $(du -sh "$STAGING/next-standalone/node_modules" 2>/dev/null | awk '{print $1}')）"

# ---------- 6. 生成 icon ----------
log "Step 5/6: 生成应用图标 ..."
LOGO_SRC="$PROJECT_DIR/assets/BobAgent_logo.png"
ICONSET_DIR="$STAGING/logo.iconset"
mkdir -p "$ICONSET_DIR"
if [ -f "$LOGO_SRC" ]; then
  for size in 16 32 64 128 256 512 1024; do
    sips -z $size $size "$LOGO_SRC" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
    if [ $size -lt 1024 ]; then
      NEXT_SIZE=$((size * 2))
      sips -z $size $size "$LOGO_SRC" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
    fi
  done
  iconutil -c icns "$ICONSET_DIR" -o "$STAGING/logo.icns" >/dev/null 2>&1
  ok "应用图标已生成"
else
  warn "找不到 logo，使用默认图标"
fi

# ---------- 7. 组装 .app ----------
log "组装应用包 ..."

# 内置 ffmpeg 二进制到 Resources/bin/（视频识别用）
#   - 本机 node_modules 已有对应架构二进制 → 直接复制
#   - 缺失（如 Intel 机器构建 x64 时）→ 从 npmmirror 按需安装 @ffmpeg-installer/darwin-<arch>
copy_ffmpeg() {
  local ARCH=$1
  local DEST_DIR="$APP_DIR/Contents/Resources/bin"
  mkdir -p "$DEST_DIR"

  local SRC="$PROJECT_DIR/node_modules/@ffmpeg-installer/darwin-$ARCH/ffmpeg"
  if [ -f "$SRC" ]; then
    cp -fL "$SRC" "$DEST_DIR/ffmpeg"
    chmod +x "$DEST_DIR/ffmpeg"
    ok "  ffmpeg ($ARCH) 已内置 ($(du -sh "$DEST_DIR/ffmpeg" | awk '{print $1}'))"
    return 0
  fi

  warn "  本机无 $ARCH 架构 ffmpeg 二进制，尝试从 npmmirror 按需安装 ..."
  local TMP_INSTALL="$OUTPUT_DIR/ffmpeg-install-$ARCH"
  rm -rf "$TMP_INSTALL"; mkdir -p "$TMP_INSTALL"
  if npm --prefix "$TMP_INSTALL" install "@ffmpeg-installer/darwin-$ARCH" --registry=https://registry.npmmirror.com --no-optional --no-save --silent >/dev/null 2>&1; then
    local INSTALLED_BIN
    INSTALLED_BIN=$(find "$TMP_INSTALL" -path "*/@ffmpeg-installer/darwin-$ARCH/ffmpeg" -type f 2>/dev/null | head -1)
    if [ -n "$INSTALLED_BIN" ]; then
      cp -fL "$INSTALLED_BIN" "$DEST_DIR/ffmpeg"
      chmod +x "$DEST_DIR/ffmpeg"
      ok "  ffmpeg ($ARCH) 按需安装并内置成功 ($(du -sh "$DEST_DIR/ffmpeg" | awk '{print $1}'))"
      rm -rf "$TMP_INSTALL"
      return 0
    fi
  fi
  rm -rf "$TMP_INSTALL"
  warn "  ffmpeg ($ARCH) 内置失败，视频识别功能将不可用"
}

build_arch() {
  local ARCH=$1
  local ARCH_DIR="$OUTPUT_DIR/$ARCH"
  local APP_DIR="$ARCH_DIR/$APP_NAME.app"
  mkdir -p "$ARCH_DIR"

  log "  构建 $ARCH 版本..."
  cp -R "$ELECTRON_APP" "$APP_DIR"
  mv "$APP_DIR/Contents/MacOS/Electron" "$APP_DIR/Contents/MacOS/$APP_NAME"

  # Info.plist
  cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$APP_ID</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundleIconFile</key><string>logo.icns</string>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
    <key>LSArchitecturePriority</key><array><string>$ARCH</string></array>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/></dict>
    <key>NSDocumentsFolderUsageDescription</key>
    <string>BobWork 需要访问文稿文件夹来保存您的项目与节点文档。</string>
    <key>NSDesktopFolderUsageDescription</key>
    <string>BobWork 需要访问桌面文件夹来读取或保存项目。</string>
    <key>NSDownloadsFolderUsageDescription</key>
    <string>BobWork 需要访问下载文件夹来读取您上传的材料。</string>
    <key>NSRemovableVolumesUsageDescription</key>
    <string>BobWork 需要访问外接磁盘来读取您的项目或导出资料。</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>BobWork 需要使用麦克风来接收您的语音输入并转成文字。</string>
    <key>NSAudioCaptureUsageDescription</key>
    <string>BobWork 需要在会议模式中采集系统音频，以便记录远端参会人的发言。</string>
</dict>
</plist>
PLIST

  [ -f "$STAGING/logo.icns" ] && cp "$STAGING/logo.icns" "$APP_DIR/Contents/Resources/logo.icns"
  rm -f "$APP_DIR/Contents/Resources/default_app.asar" 2>/dev/null || true

  # 复制 app 和 next-standalone（各有独立的精简 node_modules）
  log "  复制依赖与资源 ..."
  cp -R "$STAGING/app/"         "$APP_DIR/Contents/Resources/app/"
  cp -R "$STAGING/next-standalone/" "$APP_DIR/Contents/Resources/next-standalone/"
  # BobWorkCapture 截图插件助手（独立 TCC 身份）：随包分发到 Resources
  if [ -d "$PROJECT_DIR/../screenshot-plugin/dist/BobWorkCapture.app" ]; then
    cp -R "$PROJECT_DIR/../screenshot-plugin/dist/BobWorkCapture.app" "$APP_DIR/Contents/Resources/BobWorkCapture.app"
    log "  ✅ BobWorkCapture 截图助手已随包分发"
  else
    log "  ⚠️ 未找到 BobWorkCapture.app（先运行 screenshot-plugin/build-helper.sh）；Cmd+Shift+O 将回退内置链路"
  fi
  # 内置头像（随包分发，供头像池内置项使用）
  # 体积优化：透明 PNG 转 WebP（体积大幅下降），WebP 质量足够且保留透明通道。
  if [ -d "$PROJECT_DIR/assets/avatars" ]; then
    mkdir -p "$APP_DIR/Contents/Resources/avatars"
    if python3 -c "import PIL" >/dev/null 2>&1; then
      # Pillow 可用：转 WebP 减小体积
      AVATAR_SRC="$PROJECT_DIR/assets/avatars" \
      AVATAR_DST="$APP_DIR/Contents/Resources/avatars" \
      python3 -c '
import os, glob
from PIL import Image
src_dir = os.environ["AVATAR_SRC"]
dst_dir = os.environ["AVATAR_DST"]
n = 0
for p in sorted(glob.glob(os.path.join(src_dir, "*.png"))):
    name = os.path.splitext(os.path.basename(p))[0] + ".webp"
    Image.open(p).save(os.path.join(dst_dir, name), "WEBP", quality=82, method=6)
    n += 1
print(f"converted {n} built-in avatars to webp")
'
      ok "内置头像已转为 WebP"
    else
      # 无 Pillow：回退复制 PNG（体积不优化，但功能不受影响）
      cp "$PROJECT_DIR/assets/avatars/"*.png "$APP_DIR/Contents/Resources/avatars/" 2>/dev/null || true
      warn "未检测到 Pillow，内置头像以 PNG 原样复制"
    fi
  fi
  # 防御性清理：确保 release-dist 构建产物目录及其冲突副本绝不被循环打包进 .app
  rm -rf "$APP_DIR/Contents/Resources/next-standalone/release-dist" \
         "$APP_DIR/Contents/Resources/next-standalone/release-dist 2" 2>/dev/null || true
  [ -f "$STAGING/app-update.yml" ] && cp "$STAGING/app-update.yml" "$APP_DIR/Contents/Resources/app-update.yml"

  # 内置 ffmpeg 二进制（视频识别用）：目标架构二进制缺失时从 npmmirror 按需安装
  copy_ffmpeg "$ARCH"

  # 处理 better-sqlite3 原生模块（在 standalone 的 node_modules 中）
  log "  处理原生模块 ..."
  local BS3_DIR="$APP_DIR/Contents/Resources/next-standalone/node_modules/better-sqlite3"
  if [ -d "$BS3_DIR" ]; then
    local BS3_BUILD="$BS3_DIR/build/Release"
    mkdir -p "$BS3_BUILD"
    local NODE_FILE="$(find "$BS3_DIR" -name "better_sqlite3.node" 2>/dev/null | head -1)"
    if [ -n "$NODE_FILE" ]; then
      cp -fL "$NODE_FILE" "$BS3_BUILD/better_sqlite3.node"
    elif [ -f "$PROJECT_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
      cp -fL "$PROJECT_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "$BS3_BUILD/"
    fi
  fi

  # 签名：固定本地证书（签名恒定 → 屏幕录制授权跨版本保留）；证书缺失回退 ad-hoc 保证构建
  log "  签名 ..."
  # 将 app 复制到非同步目录（/tmp）再签名：
  # 根因：release-dist 位于 iCloud 同步目录（Desktop），fileprovider 会给新建文件打上受保护属性
  # （com.apple.fileprovider.fpfs#P / FinderInfo），codesign 遇到即拒绝，且无法被 xattr 清除；
  # 在同步目录内 ditto 重建也无法避免文件系统自身回写属性。搬到 /tmp 后彻底无此干扰。
  local SIGN_STAGE="/tmp/bobwork-sign-stage"
  rm -rf "$SIGN_STAGE"
  mkdir -p "$SIGN_STAGE"
  ditto --noextattr --norsrc "$APP_DIR" "$SIGN_STAGE/$APP_NAME.app" 2>/dev/null
  if codesign --force --deep --sign "BobWork Local Signing" "$SIGN_STAGE/$APP_NAME.app" >/tmp/bobwork-sign.log 2>&1; then
    ok "  固定证书签名成功"
    # 签名成功后替换回同步目录产物
    rm -rf "$APP_DIR"
    mv "$SIGN_STAGE/$APP_NAME.app" "$APP_DIR"
  else
    warn "固定签名证书 BobWork Local Signing 签名失败（详见 /tmp/bobwork-sign.log），回退 ad-hoc（授权将随重打包失效）"
    codesign --force --deep --sign - "$SIGN_STAGE/$APP_NAME.app" >>/tmp/bobwork-sign.log 2>&1
    rm -rf "$APP_DIR"
    mv "$SIGN_STAGE/$APP_NAME.app" "$APP_DIR"
    warn "ad-hoc 签名完成（如见 /tmp/bobwork-sign.log 报错请检查）"
  fi
  rm -rf "$SIGN_STAGE"

  # 自检：Info.plist 声明的 CFBundleExecutable 必须与实际可执行文件一致（macOS 更新后 LaunchServices 严格校验，不一致会报"已损坏或不完整"）
  local DECLARED_EXEC
  DECLARED_EXEC=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP_DIR/Contents/Info.plist" 2>/dev/null)
  if [ -n "$DECLARED_EXEC" ] && [ -f "$APP_DIR/Contents/MacOS/$DECLARED_EXEC" ]; then
    ok "  自检通过：CFBundleExecutable=$DECLARED_EXEC 与可执行文件一致"
  else
    echo "❌ 构建失败：CFBundleExecutable=$DECLARED_EXEC 与实际可执行文件不一致"
    exit 1
  fi

  ok "  $ARCH 应用构建完成"
}

case "$ARCH" in
  both) build_arch arm64; build_arch x64 ;;
  arm64|x64) build_arch "$ARCH" ;;
  *) echo "❌ 未知架构: $ARCH"; exit 1 ;;
esac

# 打包前最后一道关：确认没有源文件在本次构建期间被改动，否则产物陈旧，直接中止
assert_build_fresh

# ---------- 8. 生成 ZIP + DMG ----------
log "生成压缩包 ..."

create_zip() {
  local ARCH=$1
  local ARCH_DIR="$OUTPUT_DIR/$ARCH"
  local APP_PATH="$ARCH_DIR/$APP_NAME.app"
  local ZIP_PATH="$OUTPUT_DIR/${APP_NAME}-${VERSION}-macos-${ARCH}.zip"
  [ -d "$APP_PATH" ] && ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"
  ok "ZIP: $(du -sh "$ZIP_PATH" | awk '{print $1}')"
}

create_dmg() {
  local ARCH=$1
  local ARCH_DIR="$OUTPUT_DIR/$ARCH"
  local APP_PATH="$ARCH_DIR/$APP_NAME.app"
  local DMG_PATH="$OUTPUT_DIR/${APP_NAME}-${VERSION}-macos-${ARCH}.dmg"
  [ -d "$APP_PATH" ] || return 0

  # 生成背景图
  local BG_PATH="$PROJECT_DIR/assets/dmg-background.png"
  if [ ! -f "$BG_PATH" ]; then
    python3 "$PROJECT_DIR/scripts/generate-dmg-background.py" 2>/dev/null || warn "背景图生成失败，使用纯色背景"
  fi

  local DMG_STAGING="$ARCH_DIR/_dmg"
  rm -rf "$DMG_STAGING"
  mkdir -p "$DMG_STAGING"
  cp -R "$APP_PATH" "$DMG_STAGING/"
  ln -s /Applications "$DMG_STAGING/Applications"

  # 复制安装引导文件（Gatekeeper 绕过提示）
  # 注意：.command / .sh 文件同样会被 Gatekeeper 拦截，所以不再使用脚本
  # 改为：背景图文字 + 安装说明 HTML，告诉用户直接右键打开或终端命令
  local DMG_EXTRAS="$PROJECT_DIR/assets/dmg-extras"
  if [ -d "$DMG_EXTRAS" ]; then
    cp "$DMG_EXTRAS/安装说明.html" "$DMG_STAGING/" 2>/dev/null
  fi

  # 复制背景图
  mkdir -p "$DMG_STAGING/.background"
  if [ -f "$BG_PATH" ]; then
    cp "$BG_PATH" "$DMG_STAGING/.background/background.png"
  else
    : > "$DMG_STAGING/.background/background.png"
  fi

  local SIZE_MB="$(du -sm "$DMG_STAGING" | awk '{print int($1*1.3+50)}')"
  local VOLNAME="BobWork $VERSION"
  local DMG_OK=0

  # 方案一：完整版（UDRW 镜像 + attach 布局 + convert）
  # attach 依赖挂载 /dev 块设备，部分沙箱环境会拦截，失败则降级
  local TMP_DMG="$ARCH_DIR/_tmp.dmg"
  rm -f "$TMP_DMG"
  if hdiutil create -volname "$VOLNAME" -srcfolder "$DMG_STAGING" -ov -format UDRW -size "${SIZE_MB}m" "$TMP_DMG" >/dev/null 2>&1; then
    local MOUNT_POINT="/Volumes/$VOLNAME"
    if hdiutil attach -readwrite -noverify -noautoopen "$TMP_DMG" >/dev/null 2>&1; then
      # AppleScript 设置窗口布局（Finder 自动化权限缺失时失败，不致命）
      osascript >/dev/null 2>&1 <<APPLESCRIPT || warn "Finder 布局失败，使用默认布局"
    tell application "Finder"
      tell disk "$VOLNAME"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {200, 200, 860, 620}
        set viewOptions to the icon view options of container window
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 68
        set background picture of viewOptions to file ".background:background.png"
        set position of item "$APP_NAME.app" of container window to {250, 150}
        set position of item "Applications" of container window to {410, 150}
        set position of item "安装说明.html" of container window to {330, 340}
        close
        open
        update without registering applications
        delay 1
      end tell
    end tell
APPLESCRIPT
      hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
      sleep 1
      rm -f "$DMG_PATH"
      if hdiutil convert "$TMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" >/dev/null 2>&1; then
        DMG_OK=1
      fi
    else
      warn "hdiutil attach 被沙箱拦截（/dev 受限），降级为一步式 DMG（无 Finder 布局）"
    fi
    rm -f "$TMP_DMG"
  fi

  # 方案二：一步式创建（无需挂载块设备，沙箱下可用）
  if [ "$DMG_OK" != "1" ]; then
    rm -f "$DMG_PATH"
    if hdiutil create -volname "$VOLNAME" -srcfolder "$DMG_STAGING" -ov -format UDZO -imagekey zlib-level=9 "$DMG_PATH" >/dev/null 2>&1; then
      DMG_OK=1
    fi
  fi

  rm -rf "$DMG_STAGING"
  if [ "$DMG_OK" = "1" ]; then
    ok "DMG: $(du -sh "$DMG_PATH" | awk '{print $1}')"
  else
    err "DMG 生成失败（完整版与一步式均失败）"
  fi
}

case "$ARCH" in
  both)
    # 仅 ARM 规则下不会走到这里；保留兼容
    create_zip arm64; create_zip x64
    if [ "${SKIP_DMG:-0}" != "1" ]; then create_dmg arm64; create_dmg x64; fi
    ;;
  arm64|x64)
    create_zip "$ARCH"
    if [ "${SKIP_DMG:-0}" = "1" ]; then
      log "跳过 DMG 生成（SKIP_DMG=1，仅 ZIP）"
    else
      create_dmg "$ARCH"
    fi
    ;;
esac

# 清理 .app 目录（ZIP 已包含完整 .app，只保留发布产物）
log "清理 .app 构建产物 ..."
rm -rf "$OUTPUT_DIR"/arm64 2>/dev/null || true
rm -rf "$OUTPUT_DIR"/x64 2>/dev/null || true
ok ".app 已清理，仅保留发布产物"

# ---------- 8. 生成 latest-mac.yml（electron-updater 必需）----------
log "生成 latest-mac.yml ..."
generate_yml() {
  local ARCH=$1
  # electron-updater 自动更新必须使用 ZIP（不是 DMG）
  local FILE="${APP_NAME}-${VERSION}-macos-${ARCH}.zip"
  local PATH_ABS="$OUTPUT_DIR/$FILE"
  local YML_PATH="$OUTPUT_DIR/latest-mac-${ARCH}.yml"
  local SIZE="0"
  local SHA512=""
  local RELEASE_DATE=""
  SIZE=$(stat -f%z "$PATH_ABS" 2>/dev/null || echo 0)
  SHA512=$(shasum -a 512 "$PATH_ABS" | awk '{print $1}' 2>/dev/null || echo "")
  RELEASE_DATE=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  # url 必须是相对文件名（不能是绝对 URL）
  # provider:github 会自动拼接为 https://github.com/<owner>/<repo>/releases/download/<tag>/<filename>
  cat > "$YML_PATH" <<EOF
version: $VERSION
files:
  - url: $FILE
    sha512: $SHA512
    size: $SIZE
path: $FILE
sha512: $SHA512
releaseDate: $RELEASE_DATE
EOF
  # 同时创建不带架构后缀的 latest-mac.yml（electron-updater 查找此文件）
  cp "$YML_PATH" "$OUTPUT_DIR/latest-mac.yml"
  ok "latest-mac-${ARCH}.yml / latest-mac.yml 已生成（${FILE}）"
}
case "$ARCH" in
  both) generate_yml arm64; generate_yml x64 ;;
  arm64|x64) generate_yml "$ARCH" ;;
esac

# ---------- 上传到 GitCode Release（国内 CDN，优先上传）----------
upload_to_gitcode() {
  if [ -z "${GITCODE_TOKEN:-}" ]; then
    warn "GITCODE_TOKEN 未设置，跳过 GitCode 上传"
    return 0
  fi
  log "上传到 GitCode Release（国内 CDN）..."
  bash "$PROJECT_DIR/scripts/upload-to-gitcode.sh" || warn "GitCode 上传失败（不影响主流程）"
}

# ---------- 上传到 GitHub Release（备用发布源）----------
upload_to_github() {
  if [ -z "${GH_TOKEN:-}" ]; then
    warn "GH_TOKEN 未设置，跳过 GitHub Release 上传"
    return 0
  fi

  local tag="v$VERSION"
  log "创建 GitHub Release $tag ..."

  local release_resp
  # 从 RELEASES.md 提取当前版本的 Release Notes（用 python3，兼容 macOS/BSD sed）
  local release_notes
  release_notes=$(python3 - "$PROJECT_DIR/RELEASES.md" "$tag" <<'PYEOF'
import json, re, sys
path, tag = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
m = re.search(r"^## " + re.escape(tag) + r"[^\n]*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
notes = m.group(1).strip() if m else ""
print(json.dumps(notes))
PYEOF
)
  release_resp=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: token $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/releases" \
    -d "{
      \"tag_name\": \"$tag\",
      \"name\": \"$tag\",
      \"body\": $release_notes,
      \"draft\": false,
      \"prerelease\": false
    }")

  local http_code
  http_code=$(echo "$release_resp" | tail -1)
  local release_body
  release_body=$(echo "$release_resp" | sed '$d')

  if [ "$http_code" = "201" ]; then
    ok "Release $tag 创建成功"
  elif [ "$http_code" = "422" ]; then
    log "Release $tag 已存在，获取已有 Release ..."
    release_body=$(curl -s -H "Authorization: token $GH_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/releases/tags/$tag")
  else
    err "创建 Release 失败 (HTTP $http_code): $release_body"
    return 0
  fi

  local upload_url
  upload_url=$(echo "$release_body" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")).upload_url.replace(/\{.*\}/,""))')

  if [ -z "$upload_url" ]; then
    err "无法获取上传 URL"
    return 0
  fi

  # 上传所有产物
  for file in "$OUTPUT_DIR"/*.dmg "$OUTPUT_DIR"/*.zip "$OUTPUT_DIR"/*.yml; do
    if [ ! -f "$file" ]; then continue; fi
    local fname
    fname=$(basename "$file")
    log "上传 $fname ..."
    local upload_resp
    upload_resp=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Authorization: token $GH_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$file" \
      "${upload_url}?name=${fname}")
    local up_code
    up_code=$(echo "$upload_resp" | tail -1)
    if [ "$up_code" = "201" ]; then
      ok "  $fname 上传成功"
    else
      err "  $fname 上传失败 (HTTP $up_code)"
    fi
  done
}

# GitCode 优先上传，GitHub 作为备用
upload_to_gitcode
upload_to_github

# ---------- 收尾 ----------
rm -rf "$STAGING" 2>/dev/null || true

echo ""
echo "============================================"
ok "  Release 构建完成！"
echo "  输出目录: $OUTPUT_DIR"
echo ""
ls -lh "$OUTPUT_DIR"/*.dmg "$OUTPUT_DIR"/*.zip "$OUTPUT_DIR"/*.yml 2>/dev/null || true
echo ""
echo "📦 安装包下载地址:"
echo "   国内（推荐）: https://gitcode.com/${GITCODE_OWNER:-baolei89}/${GITCODE_REPO:-BobWork}/releases/v$VERSION"
echo "   备用（GitHub）: https://github.com/${GITHUB_OWNER:-baolei0227-glitch}/${GITHUB_REPO:-BobAgent}/releases/tag/v$VERSION"
echo ""
echo "⚠️  Windows 不会随本脚本发布：mac 发完还要单独跑 Windows"
echo "   pnpm release:win --publish"
echo "============================================"
