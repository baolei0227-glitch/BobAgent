#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

APP_NAME="BobWork"
APP_DIR="$PROJECT_DIR/release/$APP_NAME.app"

echo "==> Step 1/4: Building Next.js (standalone)..."
NEXT_DISABLE_TURBOPACK=1 NODE_OPTIONS="--max-old-space-size=2048" npx next build

echo "==> Step 2/4: Compiling Electron main process..."
npx tsup electron/main.ts electron/preload.ts \
  --format cjs \
  --platform node \
  --target node20 \
  --outDir electron/dist \
  --no-splitting \
  --external electron

echo "==> Step 3/4: Assembling .app bundle (with symlink to project node_modules)..."

rm -rf "$APP_DIR"
# 同时清理 Finder 自动重命名的残留文件（如 BobWork 2.app）
rm -rf "$PROJECT_DIR/release/BobWork"*".app" 2>/dev/null || true
mkdir -p "$(dirname "$APP_DIR")"

ELECTRON_APP_PATH="$PROJECT_DIR/node_modules/.pnpm/electron@*/node_modules/electron/dist/Electron.app"
ELECTRON_APP="$(ls -d $ELECTRON_APP_PATH 2>/dev/null | head -1)"

if [ -z "$ELECTRON_APP" ]; then
  echo "ERROR: Electron.app not found. Run 'pnpm install' first."
  exit 1
fi

cp -R "$ELECTRON_APP" "$APP_DIR"
mv "$APP_DIR/Contents/MacOS/Electron" "$APP_DIR/Contents/MacOS/BobWork"

mkdir -p "$APP_DIR/Contents/Resources/app"
cp "$PROJECT_DIR/electron/dist/main.js" "$APP_DIR/Contents/Resources/app/main.js"
cp "$PROJECT_DIR/electron/dist/preload.js" "$APP_DIR/Contents/Resources/app/preload.js"
# 全局截图 OCR（Cmd+Shift+O）本地 Swift Vision 兜底脚本：与主进程 __dirname 对齐（Resources/app/pdf/core/）
mkdir -p "$APP_DIR/Contents/Resources/app/pdf/core"
cp "$PROJECT_DIR/src/lib/pdf/core/ocr_vision.swift" "$APP_DIR/Contents/Resources/app/pdf/core/ocr_vision.swift"
# 屏幕录制权限预检脚本（SCShareableContent，与 screencapture 同一责任链）
mkdir -p "$APP_DIR/Contents/Resources/app/swift"
cp "$PROJECT_DIR/src/lib/screen-ocr/screen_permission.swift" "$APP_DIR/Contents/Resources/app/swift/screen_permission.swift"
# BobWorkCapture 截图插件助手（独立 TCC 身份）：随包分发到 Resources
if [ -d "$PROJECT_DIR/../screenshot-plugin/dist/BobWorkCapture.app" ]; then
  cp -R "$PROJECT_DIR/../screenshot-plugin/dist/BobWorkCapture.app" "$APP_DIR/Contents/Resources/BobWorkCapture.app"
  echo "✅ BobWorkCapture 截图助手已随包分发"
else
  echo "⚠️ 未找到 BobWorkCapture.app（先运行 screenshot-plugin/build-helper.sh）；Cmd+Shift+O 将回退内置链路"
fi

cat > "$APP_DIR/Contents/Resources/app/package.json" << 'PKGJSON'
{
  "name": "bob-work-desktop",
  "version": "1.0.0",
  "main": "main.js"
}
PKGJSON

# 创建 node_modules 符号链接，让主进程能访问 electron-updater 等依赖
ln -s "$PROJECT_DIR/node_modules" "$APP_DIR/Contents/Resources/app/node_modules"

# Copy Next.js standalone build
cp -R "$PROJECT_DIR/.next/standalone/." "$APP_DIR/Contents/Resources/next-standalone/"
# Next.js 16 standalone 输出到 <项目目录名>/ 子目录（如 projects/），检测并提升一层
if [ ! -f "$APP_DIR/Contents/Resources/next-standalone/server.js" ] && [ -f "$APP_DIR/Contents/Resources/next-standalone/projects/server.js" ]; then
  cp -R "$APP_DIR/Contents/Resources/next-standalone/projects/." "$APP_DIR/Contents/Resources/next-standalone/"
  rm -rf "$APP_DIR/Contents/Resources/next-standalone/projects"
  # 修复提升后失效的相对符号链接（Next 16 原生模块 external，同 package-release.sh）：
  # ../../../projects/node_modules/.pnpm/<pkg>/node_modules/<pkg> → ../../node_modules/...
  _symlink_dir="$APP_DIR/Contents/Resources/next-standalone/.next/node_modules"
  if [ -d "$_symlink_dir" ]; then
    # 递归处理所有符号链接（含 scope 子目录如 @modelcontextprotocol/）：
    # 统一规则：去掉 "projects/" 段并减少一层 "../"（即把 "../projects/" 替换为空）。
    while IFS= read -r -d '' _symlink; do
      _symlink_target="$(readlink "$_symlink")"
      case "$_symlink_target" in
        */projects/node_modules/*)
          _symlink_new="$(printf '%s' "$_symlink_target" | sed 's#\.\./projects/##')"
          rm -f "$_symlink"
          ln -s "$_symlink_new" "$_symlink"
          echo "  修复符号链接 $(basename "$_symlink") -> $_symlink_new"
          ;;
      esac
    done < <(find "$_symlink_dir" -type l -print0)
  fi
fi
rm -rf "$APP_DIR/Contents/Resources/next-standalone/release" "$APP_DIR/Contents/Resources/next-standalone/release-dist" 2>/dev/null
rm -rf "$APP_DIR/Contents/Resources/next-standalone/.next/standalone" 2>/dev/null

# Copy Python PDF extractor for PDF Bridge
mkdir -p "$APP_DIR/Contents/Resources/next-standalone/scripts"
cp "$PROJECT_DIR/src/lib/pdf/pdf_extractor.py" "$APP_DIR/Contents/Resources/next-standalone/scripts/pdf_extractor.py"
cp "$PROJECT_DIR/src/lib/pdf/pdf_to_images.py" "$APP_DIR/Contents/Resources/next-standalone/scripts/pdf_to_images.py"
# OOXML 修订引擎脚本（docx track changes）复制到 standalone scripts/
cp "$PROJECT_DIR/src/lib/docx/ooxml-revise.py" "$APP_DIR/Contents/Resources/next-standalone/scripts/ooxml-revise.py"
# 本地 OCR（macOS Vision）Swift 脚本：存在则复制（缺少 swift 环境时运行时自动降级）
cp "$PROJECT_DIR/src/lib/pdf/ocr_vision.swift" "$APP_DIR/Contents/Resources/next-standalone/scripts/ocr_vision.swift" 2>/dev/null || true
cp "$PROJECT_DIR/src/lib/pdf/crop_regions.swift" "$APP_DIR/Contents/Resources/next-standalone/scripts/crop_regions.swift" 2>/dev/null || true
# 独立 docx-template-mcp 包脚本（scan_placeholders / fill_template）随包分发：
# 复制到 next-standalone/docx-template-mcp/assets/scripts/（匹配 resolveDocxTemplateScript 的 cwd 候选）
if [ -d "$PROJECT_DIR/../docx-template-mcp/assets/scripts" ]; then
  mkdir -p "$APP_DIR/Contents/Resources/next-standalone/docx-template-mcp/assets/scripts"
  cp "$PROJECT_DIR/../docx-template-mcp/assets/scripts/scan_placeholders.py" "$APP_DIR/Contents/Resources/next-standalone/docx-template-mcp/assets/scripts/"
  cp "$PROJECT_DIR/../docx-template-mcp/assets/scripts/fill_template.py" "$APP_DIR/Contents/Resources/next-standalone/docx-template-mcp/assets/scripts/"
fi

# Replace standalone's node_modules with a SYMLINK to project node_modules
# This is fast (instant) and guarantees all deps are available
# 注意：rm 可能被环境安全策略（safe-delete）拦截 → 容错继续 + ln -sfn 强制覆盖
if [ ! -L "$APP_DIR/Contents/Resources/next-standalone/node_modules" ]; then
  rm -rf "$APP_DIR/Contents/Resources/next-standalone/node_modules" 2>/dev/null || true
fi
ln -sfn "$PROJECT_DIR/node_modules" "$APP_DIR/Contents/Resources/next-standalone/node_modules"

# Copy static assets and public folder
mkdir -p "$APP_DIR/Contents/Resources/next-standalone/.next"
cp -R "$PROJECT_DIR/.next/static" "$APP_DIR/Contents/Resources/next-standalone/.next/static"
cp -R "$PROJECT_DIR/public" "$APP_DIR/Contents/Resources/next-standalone/public"
# 校验：static 缺失会导致前端 JS 全 404（页面 SSR-only、覆盖窗口卡加载），缺失即中止
_STATIC_CHUNKS="$APP_DIR/Contents/Resources/next-standalone/.next/static/chunks"
if [ ! -d "$_STATIC_CHUNKS" ] || [ -z "$(ls -A "$_STATIC_CHUNKS" 2>/dev/null)" ]; then
  echo "❌ ERROR: static chunks 拷贝失败/为空（$_STATIC_CHUNKS），中止打包"
  exit 1
fi
echo "✅ static 资源已就绪: $(ls "$_STATIC_CHUNKS" | wc -l | tr -d ' ') chunks"
# 内置技能（assets/skills）随包分发：打包版 cwd 为 next-standalone，loader 读取 ./assets/skills
cp -R "$PROJECT_DIR/assets/skills" "$APP_DIR/Contents/Resources/next-standalone/assets/skills"

# 内置头像（随包分发，供头像池内置项使用）
if [ -d "$PROJECT_DIR/assets/avatars" ]; then
    mkdir -p "$APP_DIR/Contents/Resources/avatars"
    cp "$PROJECT_DIR/assets/avatars/"*.png "$APP_DIR/Contents/Resources/avatars/" 2>/dev/null || true
    echo "✅ Built-in avatars copied"
fi

# Replace Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>BobWork</string>
    <key>CFBundleDisplayName</key>
    <string>BobWork</string>
    <key>CFBundleIdentifier</key>
    <string>com.bobwork.app</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>BobWork</string>
    <key>CFBundleIconFile</key>
    <string>logo.icns</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
PLIST

# Copy custom icon (固定使用 BobWork logo)
LOGO_SRC="$PROJECT_DIR/assets/BobAgent_logo.png"
if [ -f "$LOGO_SRC" ]; then
    mkdir -p "$APP_DIR/Contents/Resources/logo.iconset"
    sips -z 16 16     "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_16x16.png"
    sips -z 32 32     "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_16x16@2x.png"
    sips -z 32 32     "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_32x32.png"
    sips -z 64 64     "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_32x32@2x.png"
    sips -z 128 128   "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_128x128.png"
    sips -z 256 256   "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_128x128@2x.png"
    sips -z 256 256   "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_256x256.png"
    sips -z 512 512   "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_256x256@2x.png"
    sips -z 512 512   "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_512x512.png"
    sips -z 1024 1024 "$LOGO_SRC" --out "$APP_DIR/Contents/Resources/logo.iconset/icon_512x512@2x.png"
    iconutil -c icns "$APP_DIR/Contents/Resources/logo.iconset" -o "$APP_DIR/Contents/Resources/logo.icns"
    rm -rf "$APP_DIR/Contents/Resources/logo.iconset"
    echo "✅ Custom icon copied and converted"
else
    echo "⚠️ BobWork logo.png not found, using default icon"
fi

rm -f "$APP_DIR/Contents/Resources/default_app.asar" 2>/dev/null
rm -f "$APP_DIR/Contents/Resources/electron.icns" 2>/dev/null

echo "==> Step 4/4: Code signing..."
xattr -cr "$APP_DIR" 2>/dev/null || true
# 防中断兜底：可执行文件已 mv 为 BobWork，确保 Info.plist 的 CFBundleExecutable 指向正确
# （否则 LaunchServices open 报 "executable is missing"）
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable BobWork" "$APP_DIR/Contents/Info.plist" 2>/dev/null || true
# 固定本地证书签名：签名恒定，屏幕录制授权跨版本保留（避免每次重打包后重新授权）。
# 证书缺失时回退 ad-hoc 保证构建可用（但授权将随重打包失效，需重新授权）。
if codesign --force --deep --sign "BobWork Local Signing" "$APP_DIR" 2>&1; then
  echo "   ✅ 固定证书签名成功"
else
  echo "   ⚠️ 未找到固定签名证书 BobWork Local Signing，回退 ad-hoc"
  codesign --force --deep --sign - "$APP_DIR" 2>&1 || echo "WARNING: codesign failed (not blocking for local use)"
fi

echo ""
echo "✅ Build complete!"
echo "   App: $APP_DIR"
echo "   启动方式: open \"$APP_DIR\""
echo ""
echo "   注意: node_modules 是符号链接到项目目录，移动项目位置后需要重新构建"
