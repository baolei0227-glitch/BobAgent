#!/bin/bash
set -Eeuo pipefail

# ============================================================
# BobWork GitCode Release 上传脚本
#
# 将构建产物（.dmg / .zip / .yml）上传到 GitCode Release，
# 作为国内镜像源加速自动更新下载。
#
# 依赖环境变量：
#   GITCODE_TOKEN   GitCode 访问令牌（必填）
#   GITCODE_OWNER   仓库所属用户/组织（默认 baolei89）
#   GITCODE_REPO    仓库名（默认 BobWork）
#   UPLOAD_PLATFORM 只传某一平台：both（默认）/ mac / win。
#                   用于「补发单平台」：避免把已上线的 250MB zip 再传一遍，
#                   也避免重复文件被 GitCode 拒绝后中断整批上传。
#
# 用法（在 projects/ 目录下执行）：
#   bash ./scripts/upload-to-gitcode.sh
#
# 产物下载地址：
#   https://gitcode.com/<owner>/<repo>/releases/download/v<version>/<file>
#   https://gitcode.com/<owner>/<repo>/releases/download/latest/latest-mac.yml
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ---------- 配置 ----------
: "${GITCODE_TOKEN:? 请设置 GITCODE_TOKEN 环境变量}"
GITCODE_OWNER="${GITCODE_OWNER:-baolei89}"
GITCODE_REPO="${GITCODE_REPO:-BobWork}"
VERSION=$(node -e 'process.stdout.write(require("./package.json").version)')
TAG="v$VERSION"
OUTPUT_DIR="$PROJECT_DIR/release-dist"
GITCODE_API="https://api.gitcode.com/api/v5"
DOWNLOAD_BASE="https://gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO}/releases/download"

C_GREEN=$'\033[0;32m'
C_YELLOW=$'\033[1;33m'
C_RED=$'\033[0;31m'
C_RESET=$'\033[0m'

log()  { echo "==> $*"; }
ok()   { echo "${C_GREEN}✅ $*${C_RESET}"; }
warn() { echo "${C_YELLOW}⚠️  $*${C_RESET}"; }
err()  { echo "${C_RED}❌ $*${C_RESET}"; }

# ---------- 1. 检查产物文件 ----------
log "检查构建产物 ..."
FILES=()
OUTPUT_DIR_MAC="$OUTPUT_DIR"
# Windows 产物由 pack-win.sh 直接落在 release/（mac 仍走 release-dist）。
# 两者都扫，但**互不要求**：只发 mac 或只发 win 都能跑。
WIN_OUTPUT_DIR="$PROJECT_DIR/release"
UPLOAD_PLATFORM="${UPLOAD_PLATFORM:-both}"
add_file() {
  local f="$1"
  [ -f "$f" ] || return 0
  case "$UPLOAD_PLATFORM" in
    # 用 if 而不是 `[[ ]] &&`：后者在条件不成立时返回 1，set -e 会让整个脚本
    # 在第一个被过滤掉的文件处静默退出（错误信息都不打印）。
    mac) if [[ "$f" == "$OUTPUT_DIR_MAC"/* ]]; then FILES+=("$f"); fi ;;
    win) if [[ "$f" == "$WIN_OUTPUT_DIR"/* ]]; then FILES+=("$f"); fi ;;
    both) FILES+=("$f") ;;
    *) err "UPLOAD_PLATFORM 只能是 both / mac / win（当前：$UPLOAD_PLATFORM）"; exit 1 ;;
  esac
  return 0
}
add_file "$OUTPUT_DIR_MAC/BobWork-${VERSION}-macos-arm64.dmg"
add_file "$OUTPUT_DIR_MAC/BobWork-${VERSION}-macos-arm64.zip"
add_file "$OUTPUT_DIR_MAC/latest-mac-arm64.yml"
add_file "$OUTPUT_DIR_MAC/latest-mac.yml"
add_file "$WIN_OUTPUT_DIR/BobWork-${VERSION}-win-x64.exe"
add_file "$WIN_OUTPUT_DIR/BobWork-${VERSION}-win-x64.exe.blockmap"
add_file "$WIN_OUTPUT_DIR/latest.yml"

if [ ${#FILES[@]} -eq 0 ]; then
  err "未找到任何构建产物（mac: ${OUTPUT_DIR} / win: ${WIN_OUTPUT_DIR}）"
  err "请先执行 package-release.sh（mac）或 pack-win.sh（Windows）生成产物"
  exit 1
fi

log "待上传文件："
for f in "${FILES[@]}"; do
  echo "  - $(basename "$f") ($(du -h "$f" | awk '{print $1}'))"
done

# 跨平台一致性闸门：两边的更新清单 version 必须都等于 package.json 的版本。
# 缺一边只警告（允许单平台补发），但版本不一致直接拒绝上传 —— 否则会出现
# 「mac 已更新到 .747、Windows 用户永远停在 .746」这种无声漂移。
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
node "$PROJECT_DIR/scripts/check-release-parity.mjs" || {
  err "跨平台版本不一致，已中止上传（见上方 parity 报告）"
  exit 1
}

# ---------- 2. 提取 Release Notes ----------
# 用 node 而非 python3：macOS 的 /usr/bin/python3 是 Xcode 垫片，未同意 Xcode 许可协议时
# 会直接抛「You have not agreed to the Xcode license agreements」并以 69 退出，整个上传
# 还没发请求就失败（2026-10-01 实测：v0.7.664 因此漏发，远端 latest 仍停在上一版）。
# 语义与原先的 python 版本一致：取 `## <tag>` 标题行之后的正文，直到下一个 `## ` 标题或文末，再 strip。
RELEASE_NOTES=$(node -e '
const fs = require("fs");
const [file, tag] = process.argv.slice(1);
let notes = "";
try {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("## " + tag));
  if (start !== -1) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    notes = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  }
} catch {}
process.stdout.write(JSON.stringify(notes));
' "$PROJECT_DIR/RELEASES.md" "$TAG")

# ---------- 3. 创建 Release ----------
log "创建 GitCode Release $TAG ..."

create_release() {
  local resp http_code body
  resp=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    "${GITCODE_API}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases?access_token=${GITCODE_TOKEN}" \
    -d "{\"tag_name\":\"${TAG}\",\"name\":\"${TAG}\",\"body\":${RELEASE_NOTES},\"release_status\":\"latest\"}")
  http_code=$(echo "$resp" | tail -1)
  body=$(echo "$resp" | sed '$d')

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    ok "Release $TAG 创建成功"
    return 0
  fi
  if echo "$body" | grep -q "already exist" 2>/dev/null; then
    warn "Release $TAG 已存在，复用"
    return 0
  fi
  err "创建 Release 失败 (HTTP $http_code): $body"
  return 1
}

create_release || exit 1

# ---------- 4. 上传单个文件 ----------
upload_file() {
  local file_path="$1"
  local fname
  fname=$(basename "$file_path")
  log "上传 $fname ..."

  # 4a. 获取 OBS 上传地址（含签名 URL + 必需 headers）
  local upload_info obs_url
  upload_info=$(curl -s \
    "${GITCODE_API}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${TAG}/upload_url?access_token=${GITCODE_TOKEN}&file_name=${fname}")

  obs_url=$(echo "$upload_info" | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!d.url) { console.error("未获取到上传 URL:", JSON.stringify(d)); process.exit(1); }
    console.log(d.url);
  ') || { err "  获取上传地址失败"; return 1; }

  # 4b. 构造 headers 参数（必须原样传回 OBS）
  local header_args=()
  while IFS= read -r line; do
    header_args+=("-H" "$line")
  done < <(echo "$upload_info" | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const [k, v] of Object.entries(d.headers || {})) {
      console.log(k + ": " + v);
    }
  ')

  # 4c. PUT 上传二进制到 OBS
  local up_code
  up_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT \
    "${header_args[@]}" \
    --data-binary "@${file_path}" \
    "$obs_url")

  if [ "$up_code" = "200" ]; then
    ok "  $fname 上传成功"
    return 0
  fi
  err "  $fname 上传失败 (HTTP $up_code)"
  return 1
}

# ---------- 5. 上传所有产物（含重试） ----------
MAX_RETRIES=3
FAIL_COUNT=0

for f in "${FILES[@]}"; do
  fname=$(basename "$f")
  success=false
  for attempt in $(seq 1 $MAX_RETRIES); do
    if upload_file "$f"; then
      success=true
      break
    fi
    warn "  重试 $attempt/$MAX_RETRIES ..."
    sleep 3
  done
  if [ "$success" != "true" ]; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

# ---------- 6. 验证自动更新清单可访问 ----------
# Windows 的 latest.yml 与 mac 的 latest-mac.yml 是**同一目录下的两个不同文件**，
# 必须都验：只验 mac 时，Windows 用户「检查更新」会静默停在旧版本（HTTP 404 被 updater 吞掉）。
for yml in latest-mac.yml latest.yml; do
  log "验证 ${yml} 下载地址 ..."
  YML_CHECK=$(curl -s -o /dev/null -w "%{http_code}" -L \
    "${DOWNLOAD_BASE}/latest/${yml}")
  if [ "$YML_CHECK" = "200" ]; then
    ok "${yml} 可访问: ${DOWNLOAD_BASE}/latest/${yml}"
  else
    warn "${yml} 暂不可访问 (HTTP $YML_CHECK)，可能需要等待 CDN 缓存刷新"
  fi
done

# ---------- 7. 输出下载地址 ----------
echo ""
echo "============================================"
if [ "$FAIL_COUNT" -eq 0 ]; then
  ok "  GitCode 上传完成！"
else
  err "  GitCode 上传完成（$FAIL_COUNT 个文件失败）"
fi
echo ""
echo "📦 GitCode 下载地址（国内推荐）:"
echo "   ${DOWNLOAD_BASE}/${TAG}/"
echo ""
echo "🔗 自动更新清单:"
echo "   macOS  ${DOWNLOAD_BASE}/latest/latest-mac.yml"
echo "   Windows ${DOWNLOAD_BASE}/latest/latest.yml"
echo ""
echo "🌐 Release 页面:"
echo "   https://gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${TAG}"
echo "============================================"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
