#!/bin/bash
set -Eeuo pipefail

# ============================================================
# BobAgent Release 打包脚本
#   - 用于生成可分发的 macOS 安装包（.app + .dmg + .zip）
#   - 不使用任何符号链接，所有依赖真实复制进 .app，可在任何 Mac 上安装
#   - 使用系统 hdiutil 生成 DMG（无需安装 create-dmg）
#
# 用法:
#   bash ./scripts/package-release.sh        # 默认 build for 当前架构
#   bash ./scripts/package-release.sh arm64  # 仅打包 Apple Silicon (M1/M2/M3)
#   bash ./scripts/package-release.sh x64    # 仅打包 Intel
#   bash ./scripts/package-release.sh both   # 同时打 arm64 + x64
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ⚠️ 打包为用户安装版时必须使用默认 ~/BobAgent 根目录
# 避免从当前 shell 环境中继承 BOBAGENT_HOME 导致安装版意外指向 Dev 目录
unset BOBAGENT_HOME

APP_NAME="BobAgent"
VERSION="1.0.0"
APP_ID="com.bobagent.app"
ARCH="${1:-arm64}"            # arm64 | x64 | both
OUTPUT_DIR="$PROJECT_DIR/release-dist"
LOG_FILE="$OUTPUT_DIR/build.log"

# 彩色输出
C_GREEN=$'\033[0;32m'
C_YELLOW=$'\033[1;33m'
C_RESET=$'\033[0m'

log()  { echo "==> $*"; }
ok()   { echo "${C_GREEN}✅ $*${C_RESET}"; }
warn() { echo "${C_YELLOW}⚠️  $*${C_RESET}"; }

# ---------- 1. 清理并准备 ----------
rm -rf "$OUTPUT_DIR" >/dev/null 2>&1 || true
mkdir -p "$OUTPUT_DIR"
exec > >(tee "$LOG_FILE") 2>&1

log "============================================"
log "BobAgent v$VERSION Release Build"
log "Arch: $ARCH"
log "============================================"

# ---------- 2. 构建 Next.js standalone ----------
log "Step 1/6: 构建 Next.js (standalone mode) ..."
NEXT_DISABLE_TURBOPACK=1 NODE_OPTIONS="--max-old-space-size=4096" pnpm next build
ok "Next.js 构建完成"

# ---------- 3. 编译 Electron 主进程 ----------
log "Step 2/6: 编译 Electron main + preload ..."
pnpm tsup electron/main.ts electron/preload.ts \
  --format cjs \
  --platform node \
  --target node20 \
  --outDir electron/dist \
  --no-splitting \
  --external electron
ok "主进程编译完成"

# ---------- 4. 查找 Electron 运行时 ----------
log "Step 3/6: 查找 Electron 运行时 ..."
ELECTRON_DIR_GLOB="$PROJECT_DIR/node_modules/.pnpm/electron@*/node_modules/electron/dist"
ELECTRON_DIST="$(ls -d $ELECTRON_DIR_GLOB 2>/dev/null | head -1)"

if [ -z "$ELECTRON_DIST" ] || [ ! -d "$ELECTRON_DIST/Electron.app" ]; then
  echo "❌ 找不到 Electron.app，请先 pnpm install"
  exit 1
fi
ELECTRON_APP="$ELECTRON_DIST/Electron.app"
ok "Electron.app 已找到: $ELECTRON_APP"

# ---------- 4b. 组装资源 staging 目录 ----------
# 先把所有需要的文件放在 staging/，稍后复制到每个架构的 .app 里
STAGING="$OUTPUT_DIR/staging"
rm -rf "$STAGING"
mkdir -p "$STAGING"

# 4b.1 主进程 js
mkdir -p "$STAGING/app"
cp "$PROJECT_DIR/electron/dist/main.js"    "$STAGING/app/main.js"
cp "$PROJECT_DIR/electron/dist/preload.js" "$STAGING/app/preload.js"
cat > "$STAGING/app/package.json" <<EOF
{
  "name": "bob-agent-desktop",
  "version": "$VERSION",
  "main": "main.js"
}
EOF

# 4b.2 复制真实的 node_modules（生产依赖）
# 不做符号链接，使用 rsync 复制所有文件。better-sqlite3 原生模块必须是真实文件
log "复制 node_modules 生产依赖（真实文件，非符号链接）... 这步耗时较长"
mkdir -p "$STAGING/app/node_modules"
rsync -a --quiet \
  --exclude='.pnpm' \
  --exclude='.bin' \
  --exclude='**/node_modules/*/node_modules/.pnpm' \
  --exclude='**/*.test.*' \
  --exclude='**/tsconfig*' \
  --exclude='**/example*' \
  --exclude='**/docs*' \
  "$PROJECT_DIR/node_modules/" "$STAGING/app/node_modules/" 2>/dev/null || true
ok "node_modules 复制完成"

# 4b.3 复制 Next.js standalone build（真实复制）
log "复制 Next.js standalone build ..."
mkdir -p "$STAGING/next-standalone"
cp -R "$PROJECT_DIR/.next/standalone/." "$STAGING/next-standalone/"
rm -rf "$STAGING/next-standalone/release" 2>/dev/null || true
rm -rf "$STAGING/next-standalone/.next/standalone" 2>/dev/null || true
# standalone 里的 node_modules 也替换为真实复制
rm -rf "$STAGING/next-standalone/node_modules"
mkdir -p "$STAGING/next-standalone/node_modules"
rsync -a --quiet \
  --exclude='.pnpm' \
  --exclude='.bin' \
  "$PROJECT_DIR/node_modules/" "$STAGING/next-standalone/node_modules/" 2>/dev/null || true
# 复制 static 与 public
cp -R "$PROJECT_DIR/.next/static" "$STAGING/next-standalone/.next/static"
cp -R "$PROJECT_DIR/public" "$STAGING/next-standalone/public"
# 复制 PDF 脚本
mkdir -p "$STAGING/next-standalone/scripts"
cp "$PROJECT_DIR/src/lib/pdf/pdf_extractor.py"   "$STAGING/next-standalone/scripts/pdf_extractor.py" 2>/dev/null || true
cp "$PROJECT_DIR/src/lib/pdf/pdf_to_images.py"  "$STAGING/next-standalone/scripts/pdf_to_images.py" 2>/dev/null || true
ok "Next.js standalone 准备完成"

# ---------- 5. 生成 icon ----------
log "Step 4/6: 生成应用图标 ..."
LOGO_SRC="$PROJECT_DIR/assets/BobAgent_logo.png"
ICONSET_DIR="$STAGING/logo.iconset"
ICNS_PATH="$STAGING/logo.icns"
mkdir -p "$ICONSET_DIR"
if [ -f "$LOGO_SRC" ]; then
  sips -z 16 16     "$LOGO_SRC" --out "$ICONSET_DIR/icon_16x16.png"     >/dev/null
  sips -z 32 32     "$LOGO_SRC" --out "$ICONSET_DIR/icon_16x16@2x.png"  >/dev/null
  sips -z 32 32     "$LOGO_SRC" --out "$ICONSET_DIR/icon_32x32.png"     >/dev/null
  sips -z 64 64     "$LOGO_SRC" --out "$ICONSET_DIR/icon_32x32@2x.png"  >/dev/null
  sips -z 128 128   "$LOGO_SRC" --out "$ICONSET_DIR/icon_128x128.png"   >/dev/null
  sips -z 256 256   "$LOGO_SRC" --out "$ICONSET_DIR/icon_128x128@2x.png">/dev/null
  sips -z 256 256   "$LOGO_SRC" --out "$ICONSET_DIR/icon_256x256.png"   >/dev/null
  sips -z 512 512   "$LOGO_SRC" --out "$ICONSET_DIR/icon_256x256@2x.png">/dev/null
  sips -z 512 512   "$LOGO_SRC" --out "$ICONSET_DIR/icon_512x512.png"   >/dev/null
  sips -z 1024 1024 "$LOGO_SRC" --out "$ICONSET_DIR/icon_512x512@2x.png">/dev/null
  iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH" >/dev/null 2>&1
  ok "应用图标已生成"
else
  warn "找不到 logo，使用 Electron 默认图标"
fi

# ---------- 6. 对每个架构组装 .app ----------
log "Step 5/6: 组装应用包 ..."

build_arch() {
  local ARCH=$1
  local ARCH_DIR="$OUTPUT_DIR/$ARCH"
  local APP_DIR="$ARCH_DIR/$APP_NAME.app"
  local ARCH_ELECTRON_DIR

  mkdir -p "$ARCH_DIR"

  # 找到对应架构的 Electron 原生模块（better-sqlite3）
  log "  开始构建 $ARCH 版本..."

  # 6a. 复制 Electron.app 基础框架
  cp -R "$ELECTRON_APP" "$APP_DIR"
  # 重命名可执行文件
  mv "$APP_DIR/Contents/MacOS/Electron" "$APP_DIR/Contents/MacOS/$APP_NAME"

  # 6b. 写入 Info.plist
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
    <key>LSArchitecturePriority</key>
    <array><string>$ARCH</string></array>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/></dict>
    <key>NSDocumentsFolderUsageDescription</key>
    <string>BobAgent 需要访问文稿文件夹来保存您的项目与节点文档。</string>
    <key>NSDesktopFolderUsageDescription</key>
    <string>BobAgent 需要访问桌面文件夹来读取或保存项目。</string>
    <key>NSDownloadsFolderUsageDescription</key>
    <string>BobAgent 需要访问下载文件夹来读取您上传的材料。</string>
    <key>NSRemovableVolumesUsageDescription</key>
    <string>BobAgent 需要访问外接磁盘来读取您的项目或导出资料。</string>
</dict>
</plist>
PLIST

  # 6c. 拷贝 logo
  if [ -f "$ICNS_PATH" ]; then
    cp "$ICNS_PATH" "$APP_DIR/Contents/Resources/logo.icns"
  fi
  rm -f "$APP_DIR/Contents/Resources/default_app.asar" 2>/dev/null || true
  rm -f "$APP_DIR/Contents/Resources/electron.icns" 2>/dev/null || true

  # 6d. 拷贝 staging 资源（app + next-standalone）
  cp -R "$STAGING/app/"              "$APP_DIR/Contents/Resources/app/"
  cp -R "$STAGING/next-standalone/"  "$APP_DIR/Contents/Resources/next-standalone/"

  # 6e. 处理 better-sqlite3 原生模块（复制 .node 真实文件，不能符号链接）
  log "  处理 better-sqlite3 原生模块 ..."
  local BS3_GLOB_APP="$APP_DIR/Contents/Resources/app/node_modules/better-sqlite3/build/Release"
  local BS3_GLOB_NEXT="$APP_DIR/Contents/Resources/next-standalone/node_modules/better-sqlite3/build/Release"
  for DIR in $BS3_GLOB_APP $BS3_GLOB_NEXT; do
    [ -d "$DIR" ] || continue
    # 如果 build/Release 没有但有 prebuilt
    if [ ! -f "$DIR/better_sqlite3.node" ]; then
      local PREBUILT="$(find "$APP_DIR/Contents/Resources/app/node_modules/better-sqlite3" -name "*.node" 2>/dev/null | head -1)"
      if [ -n "$PREBUILT" ]; then
        mkdir -p "$DIR"
        cp -L "$PREBUILT" "$DIR/better_sqlite3.node"
      fi
    fi
    # 再做一次去符号链接
    [ -f "$DIR/better_sqlite3.node" ] && cp -fL "$DIR/better_sqlite3.node" "$DIR/better_sqlite3.node.real" \
      && mv "$DIR/better_sqlite3.node.real" "$DIR/better_sqlite3.node" || true
  done

  # 6f. 签名：使用 ad-hoc 签名（--sign -），本地测试完全 OK
  log "  ad-hoc 签名 + 清除隔离属性 ..."
  xattr -cr "$APP_DIR" 2>/dev/null || true
  codesign --force --deep --sign - --entitlements /dev/null --options runtime "$APP_DIR/Contents/MacOS/$APP_NAME" 2>&1 | tail -3 || true
  codesign --force --deep --sign - "$APP_DIR" 2>&1 | tail -3 || warn "签名失败（仅影响 Gatekeeper，可在 系统设置-隐私 中仍可打开）"

  ok "  $ARCH 应用构建完成: $APP_DIR"
}

case "$ARCH" in
  both)
    build_arch arm64
    build_arch x64
    ;;
  arm64|x64)
    build_arch "$ARCH"
    ;;
  *)
    echo "❌ 未知架构: $ARCH（支持: arm64 / x64 / both）"
    exit 1
    ;;
esac

# ---------- 7. 生成 ZIP + DMG ----------
log "Step 6/6: 生成 ZIP 压缩包 + DMG 安装包 ..."

create_zip() {
  local ARCH=$1
  local ARCH_DIR="$OUTPUT_DIR/$ARCH"
  local APP_PATH="$ARCH_DIR/$APP_NAME.app"
  local ZIP_NAME="${APP_NAME}-${VERSION}-macos-${ARCH}.zip"
  local ZIP_PATH="$OUTPUT_DIR/$ZIP_NAME"
  if [ -d "$APP_PATH" ]; then
    ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"
    ok "ZIP: $ZIP_NAME ($(du -sh "$ZIP_PATH" | awk '{print $1}'))"
  fi
}

create_dmg() {
  # 使用系统 hdiutil 创建 DMG，无需额外工具
  local ARCH=$1
  local BG_JPG=""
  local ARCH_DIR="$OUTPUT_DIR/$ARCH"
  local APP_PATH="$ARCH_DIR/$APP_NAME.app"
  local DMG_NAME="${APP_NAME}-${VERSION}-macos-${ARCH}.dmg"
  local DMG_PATH="$OUTPUT_DIR/$DMG_NAME"
  [ -d "$APP_PATH" ] || return 0

  local STAGING_DMG_DIR="$ARCH_DIR/_dmg_staging"
  rm -rf "$STAGING_DMG_DIR" 2>/dev/null || true
  mkdir -p "$STAGING_DMG_DIR"
  cp -R "$APP_PATH" "$STAGING_DMG_DIR/$APP_NAME.app"
  ln -s /Applications "$STAGING_DMG_DIR/Applications"

  # 创建背景图
  mkdir -p "$STAGING_DMG_DIR/.background"
  BACKGROUND_PNG="$STAGING_DMG_DIR/.background/background.png"
  # 生成纯色背景（hdiutil 不强制要求图片，这里用 sips 生成）
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<PYEOF || true
from PIL import Image
img = Image.new("RGB", (640, 400), (250, 248, 243))
img.save("$BACKGROUND_PNG")
PYEOF
  fi
  # 若 PIL 不存在就用 sips 生成一个纯色 jpg → png
  if [ ! -f "$BACKGROUND_PNG" ]; then
    BG_JPG="$ARCH_DIR/_bg.jpg"
    # 使用 sips + 空文件技巧：
    : > "$BG_JPG" || true
    if command -v base64 >/dev/null 2>&1; then
      # 1x1 pixel PNG，后面 sips 放大
      base64 -D <<< 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=' > "$BACKGROUND_PNG.tmp" 2>/dev/null && mv "$BACKGROUND_PNG.tmp" "$BACKGROUND_PNG" && \
        sips -z 400 640 "$BACKGROUND_PNG" --out "$BACKGROUND_PNG" >/dev/null 2>&1 || true
    fi
  fi

  # 计算 DMG 大小
  local SIZE_MB="$(du -sm "$STAGING_DMG_DIR" | awk '{print int($1*1.3+50)}')"

  # 创建临时 DMG
  TMP_DMG="$ARCH_DIR/_tmp.dmg"
  FINAL_DMG="$DMG_PATH"
  rm -f "$TMP_DMG" "$FINAL_DMG" 2>/dev/null || true

  hdiutil create \
    -volname "${APP_NAME} ${VERSION}" \
    -srcfolder "$STAGING_DMG_DIR" \
    -ov -format UDZO \
    -imagekey zlib-level=9 \
    -size "${SIZE_MB}m" \
    "$FINAL_DMG" >/dev/null 2>&1 && \
    ok "DMG: $DMG_NAME ($(du -sh "$FINAL_DMG" | awk '{print $1}'))" || \
    warn "hdiutil DMG 创建失败（不影响 .app 和 ZIP）"

  rm -rf "$STAGING_DMG_DIR" "$BG_JPG" 2>/dev/null || true
}

case "$ARCH" in
  both)
    create_zip arm64; create_dmg arm64
    create_zip x64;   create_dmg x64
    ;;
  arm64|x64)
    create_zip "$ARCH"; create_dmg "$ARCH"
    ;;
esac

# ---------- 收尾 ----------
rm -rf "$STAGING" 2>/dev/null || true

echo ""
echo "============================================"
ok "  Release 构建完成！"
echo "  输出目录: $OUTPUT_DIR"
echo ""
ls -lh "$OUTPUT_DIR" | tail -30
echo ""
echo "📦 安装包分发说明:"
echo "  - .dmg：推荐发给用户的『安装包』——双击打开，把 BobAgent 拖到 Applications"
echo "  - .zip：免安装版——解压后把 BobAgent.app 拖到『应用程序』目录即可使用"
echo "  - 首次在用户机器启动：若被 Gatekeeper 拦截，右键菜单 → 打开（或 系统设置 → 隐私与安全 → 仍要打开）"
echo ""
echo "🧾 完整构建日志: $LOG_FILE"
echo "============================================"
