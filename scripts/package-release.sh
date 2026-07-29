#!/bin/bash
set -Eeuo pipefail

# ============================================================
# BobAgent Release 打包脚本
#   - 用于生成可分发的 macOS 安装包（.app + .dmg + .zip）
#   - 确保所有依赖（包括 electron-updater）完整打包
#   - 使用系统 hdiutil 生成 DMG（无需安装 create-dmg）
#
# 用法:
#   bash ./scripts/package-release.sh        # 默认 build for 当前架构
#   bash ./scripts/package-release.sh arm64  # 仅打包 Apple Silicon (M1/M2/M3)
#   bash ./scripts/package-release.sh x64    # 仅打包 Intel
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

unset BOBAGENT_HOME

APP_NAME="BobAgent"
VERSION="1.0.2"
APP_ID="com.bobagent.app"
ARCH="${1:-arm64}"
OUTPUT_DIR="$PROJECT_DIR/release-dist"
LOG_FILE="$OUTPUT_DIR/build.log"
GITHUB_OWNER="baolei0227-glitch"
GITHUB_REPO="BobAgent"

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
if [ "${SKIP_NEXT_BUILD:-0}" != "1" ]; then
  log "Step 1/6: 构建 Next.js (standalone mode) ..."
  NEXT_DISABLE_TURBOPACK=1 NODE_OPTIONS="--max-old-space-size=4096" pnpm next build
  ok "Next.js 构建完成"
else
  log "Step 1/6: 跳过 Next.js 构建 (SKIP_NEXT_BUILD=1)"
fi

# ---------- 3. 编译 Electron 主进程 ----------
log "Step 2/6: 编译 Electron main + preload ..."
pnpm tsup electron/main.ts electron/preload.ts \
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
cat > "$STAGING/app/package.json" <<'EOF'
{
  "name": "bob-agent-desktop",
  "version": "1.0.0",
  "main": "main.js"
}
EOF

# 5b. 为 app/ 安装最小依赖（main.js 只有 electron-updater 是外部依赖，其余已由 tsup 打包）
log "Step 4/6: 安装 Electron 主进程最小依赖 ..."
node -e "
const pkg = {
  name: 'bob-desktop-runtime',
  private: true,
  main: 'main.js',
  dependencies: {
    'electron-updater': require('$PROJECT_DIR/package.json').dependencies['electron-updater'] || '^6.0.0'
  }
};
require('fs').writeFileSync('$STAGING/app/package.json', JSON.stringify(pkg, null, 2));
"
npm --prefix "$STAGING/app" install --omit=dev --no-optional 2>&1 | tail -3
ok "Electron 主进程依赖安装完成 ($(du -sh "$STAGING/app/node_modules" | awk '{print $1}'))"

# 5c. 生成 app-update.yml
# GH_TOKEN 从环境变量读取；构建时需设置
: "${GH_TOKEN:? 构建前请设置 GH_TOKEN 环境变量}"
cat > "$STAGING/app-update.yml" <<EOF
provider: github
owner: $GITHUB_OWNER
repo: $GITHUB_REPO
private: true
token: $GH_TOKEN
publishAutoUpdate: true
updaterCacheDirName: bob-updater
EOF

# 5d. Next.js standalone（保留其自带的精简 node_modules）
log "组装 Next.js standalone build ..."
mkdir -p "$STAGING/next-standalone"
cp -R "$PROJECT_DIR/.next/standalone/." "$STAGING/next-standalone/"
rm -rf "$STAGING/next-standalone/release" 2>/dev/null || true
rm -rf "$STAGING/next-standalone/.next/standalone" 2>/dev/null || true
rm -rf "$STAGING/next-standalone/release-dist" 2>/dev/null || true
# 保留 standalone 自带的 node_modules（Next.js 已做 tree-shaking，~211MB）
# 只删除明显不需要的目录
rm -rf "$STAGING/next-standalone/node_modules/.cache" 2>/dev/null || true
cp -R "$PROJECT_DIR/.next/static" "$STAGING/next-standalone/.next/"
cp -R "$PROJECT_DIR/public" "$STAGING/next-standalone/"
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

  [ -f "$STAGING/logo.icns" ] && cp "$STAGING/logo.icns" "$APP_DIR/Contents/Resources/logo.icns"
  rm -f "$APP_DIR/Contents/Resources/default_app.asar" 2>/dev/null || true

  # 复制 app 和 next-standalone（各有独立的精简 node_modules）
  log "  复制依赖与资源 ..."
  cp -R "$STAGING/app/"         "$APP_DIR/Contents/Resources/app/"
  cp -R "$STAGING/next-standalone/" "$APP_DIR/Contents/Resources/next-standalone/"
  [ -f "$STAGING/app-update.yml" ] && cp "$STAGING/app-update.yml" "$APP_DIR/Contents/Resources/app-update.yml"

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

  # 签名
  log "  签名 ..."
  xattr -cr "$APP_DIR" 2>/dev/null || true
  codesign --force --deep --sign - "$APP_DIR" 2>/dev/null || warn "签名失败"

  ok "  $ARCH 应用构建完成"
}

case "$ARCH" in
  both) build_arch arm64; build_arch x64 ;;
  arm64|x64) build_arch "$ARCH" ;;
  *) echo "❌ 未知架构: $ARCH"; exit 1 ;;
esac

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

  # 复制背景图
  mkdir -p "$DMG_STAGING/.background"
  if [ -f "$BG_PATH" ]; then
    cp "$BG_PATH" "$DMG_STAGING/.background/background.png"
  else
    : > "$DMG_STAGING/.background/background.png"
  fi

  local SIZE_MB="$(du -sm "$DMG_STAGING" | awk '{print int($1*1.3+50)}')"
  local VOLNAME="BobAgent $VERSION"

  # 创建临时 DMG（未压缩，用于布局）
  local TMP_DMG="$ARCH_DIR/_tmp.dmg"
  rm -f "$TMP_DMG"
  hdiutil create -volname "$VOLNAME" -srcfolder "$DMG_STAGING" -ov -format UDRW -size "${SIZE_MB}m" "$TMP_DMG" >/dev/null 2>&1

  # 挂载并布局
  local MOUNT_POINT="/Volumes/$VOLNAME"
  hdiutil attach -readwrite -noverify -noautoopen "$TMP_DMG" >/dev/null 2>&1
  sleep 1

  # AppleScript 设置窗口布局
  osascript <<APPLESCRIPT
    tell application "Finder"
      tell disk "$VOLNAME"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {200, 200, 860, 600}
        set viewOptions to the icon view options of container window
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 68
        set background picture of viewOptions to file ".background:background.png"
        set position of item "$APP_NAME.app" of container window to {170, 290}
        set position of item "Applications" of container window to {490, 290}
        close
        open
        update without registering applications
        delay 1
      end tell
    end tell
APPLESCRIPT

  # 卸载
  hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1
  sleep 1

  # 转换为压缩 DMG
  rm -f "$DMG_PATH"
  hdiutil convert "$TMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" >/dev/null 2>&1
  rm -f "$TMP_DMG"
  rm -rf "$DMG_STAGING"
  ok "DMG: $(du -sh "$DMG_PATH" | awk '{print $1}')"
}

case "$ARCH" in
  both)
    create_dmg arm64; create_dmg x64 ;;
  arm64|x64)
    create_dmg "$ARCH" ;;
esac

# 清理 .app 目录（只保留 DMG 用于分发）
log "清理 .app 构建产物 ..."
rm -rf "$OUTPUT_DIR"/arm64 2>/dev/null || true
rm -rf "$OUTPUT_DIR"/x64 2>/dev/null || true
ok ".app 已清理，仅保留 DMG"

# ---------- 8. 生成 latest-mac.yml（electron-updater 必需）----------
log "生成 latest-mac.yml ..."
generate_yml() {
  local ARCH=$1
  local DMG_FILE="${APP_NAME}-${VERSION}-macos-${ARCH}.dmg"
  local DMG_PATH="$OUTPUT_DIR/$DMG_FILE"
  local YML_PATH="$OUTPUT_DIR/latest-mac-${ARCH}.yml"

  local DMG_SIZE=$(stat -f%z "$DMG_PATH" 2>/dev/null || echo 0)
  local DMG_SHA512=$(shasum -a 512 "$DMG_PATH" | awk '{print $1}' 2>/dev/null || echo "")
  local RELEASE_DATE=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  cat > "$YML_PATH" <<EOF
version: $VERSION
files:
  - url: $DMG_FILE
    sha512: $DMG_SHA512
    size: $DMG_SIZE
path: $DMG_FILE
sha512: $DMG_SHA512
releaseDate: $RELEASE_DATE
EOF
  # 同时创建不带架构后缀的 latest-mac.yml（electron-updater 查找此文件）
  ln -sf "latest-mac-${ARCH}.yml" "$OUTPUT_DIR/latest-mac.yml"
  ok "latest-mac-${ARCH}.yml / latest-mac.yml 已生成"
}
case "$ARCH" in
  both) generate_yml arm64; generate_yml x64 ;;
  arm64|x64) generate_yml "$ARCH" ;;
esac

# ---------- 收尾 ----------
rm -rf "$STAGING" 2>/dev/null || true

echo ""
echo "============================================"
ok "  Release 构建完成！"
echo "  输出目录: $OUTPUT_DIR"
echo ""
ls -lh "$OUTPUT_DIR"/*.dmg "$OUTPUT_DIR"/*.zip "$OUTPUT_DIR"/*.yml 2>/dev/null
echo ""
echo "📦 安装包下载地址:"
echo "   https://github.com/baolei0227-glitch/BobAgent/releases/tag/v$VERSION"
echo "============================================"
