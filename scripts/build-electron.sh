#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

APP_NAME="BobAgent"
APP_DIR="$PROJECT_DIR/release/$APP_NAME.app"

echo "==> Step 1/4: Building Next.js (standalone)..."
NEXT_DISABLE_TURBOPACK=1 NODE_OPTIONS="--max-old-space-size=2048" pnpm next build

echo "==> Step 2/4: Compiling Electron main process..."
pnpm tsup electron/main.ts electron/preload.ts \
  --format cjs \
  --platform node \
  --target node20 \
  --outDir electron/dist \
  --no-splitting \
  --external electron

echo "==> Step 3/4: Assembling .app bundle (with symlink to project node_modules)..."

rm -rf "$APP_DIR"
# 同时清理 Finder 自动重命名的残留文件（如 BobAgent 2.app）
rm -rf "$PROJECT_DIR/release/BobAgent"*".app" 2>/dev/null || true
mkdir -p "$(dirname "$APP_DIR")"

ELECTRON_APP_PATH="$PROJECT_DIR/node_modules/.pnpm/electron@*/node_modules/electron/dist/Electron.app"
ELECTRON_APP="$(ls -d $ELECTRON_APP_PATH 2>/dev/null | head -1)"

if [ -z "$ELECTRON_APP" ]; then
  echo "ERROR: Electron.app not found. Run 'pnpm install' first."
  exit 1
fi

cp -R "$ELECTRON_APP" "$APP_DIR"
mv "$APP_DIR/Contents/MacOS/Electron" "$APP_DIR/Contents/MacOS/BobAgent"

mkdir -p "$APP_DIR/Contents/Resources/app"
cp "$PROJECT_DIR/electron/dist/main.js" "$APP_DIR/Contents/Resources/app/main.js"
cp "$PROJECT_DIR/electron/dist/preload.js" "$APP_DIR/Contents/Resources/app/preload.js"

cat > "$APP_DIR/Contents/Resources/app/package.json" << 'PKGJSON'
{
  "name": "bob-agent-desktop",
  "version": "1.0.0",
  "main": "main.js"
}
PKGJSON

# 创建 node_modules 符号链接，让主进程能访问 electron-updater 等依赖
ln -s "$PROJECT_DIR/node_modules" "$APP_DIR/Contents/Resources/app/node_modules"

# Copy Next.js standalone build
cp -R "$PROJECT_DIR/.next/standalone/." "$APP_DIR/Contents/Resources/next-standalone/"
rm -rf "$APP_DIR/Contents/Resources/next-standalone/release" "$APP_DIR/Contents/Resources/next-standalone/release-dist" 2>/dev/null
rm -rf "$APP_DIR/Contents/Resources/next-standalone/.next/standalone" 2>/dev/null

# Copy Python PDF extractor for PDF Bridge
mkdir -p "$APP_DIR/Contents/Resources/next-standalone/scripts"
cp "$PROJECT_DIR/src/lib/pdf/pdf_extractor.py" "$APP_DIR/Contents/Resources/next-standalone/scripts/pdf_extractor.py"
cp "$PROJECT_DIR/src/lib/pdf/pdf_to_images.py" "$APP_DIR/Contents/Resources/next-standalone/scripts/pdf_to_images.py"

# Replace standalone's node_modules with a SYMLINK to project node_modules
# This is fast (instant) and guarantees all deps are available
rm -rf "$APP_DIR/Contents/Resources/next-standalone/node_modules"
ln -s "$PROJECT_DIR/node_modules" "$APP_DIR/Contents/Resources/next-standalone/node_modules"

# Copy static assets and public folder
cp -R "$PROJECT_DIR/.next/static" "$APP_DIR/Contents/Resources/next-standalone/.next/static"
cp -R "$PROJECT_DIR/public" "$APP_DIR/Contents/Resources/next-standalone/public"

# Replace Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>BobAgent</string>
    <key>CFBundleDisplayName</key>
    <string>BobAgent</string>
    <key>CFBundleIdentifier</key>
    <string>com.bobagent.app</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>BobAgent</string>
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

# Copy custom icon (固定使用 BobAgent logo)
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
    echo "⚠️ BobAgent logo.png not found, using default icon"
fi

rm -f "$APP_DIR/Contents/Resources/default_app.asar" 2>/dev/null
rm -f "$APP_DIR/Contents/Resources/electron.icns" 2>/dev/null

# 创建开发版标记文件，启动时自动使用 ~/BobAgent-Dev 数据目录
touch "$APP_DIR/Contents/Resources/.bobagent-dev"

echo "==> Step 4/4: Code signing..."
xattr -cr "$APP_DIR" 2>/dev/null || true
codesign --force --deep --sign - "$APP_DIR" 2>&1 || echo "WARNING: codesign failed (not blocking for local use)"

echo ""
echo "✅ Build complete!"
echo "   App: $APP_DIR"
echo "   启动方式: open \"$APP_DIR\""
echo ""
echo "   注意: node_modules 是符号链接到项目目录，移动项目位置后需要重新构建"
