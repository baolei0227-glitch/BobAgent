#!/bin/bash
set -Eeuo pipefail

GH_TOKEN="${1:?usage: $0 <gh_token>}"
GITHUB_OWNER="baolei0227-glitch"
GITHUB_REPO="BobAgent"
PROJECT_DIR="/Users/baolei/Desktop/BobAgent/projects"
OUTPUT_DIR="$PROJECT_DIR/release-dist"

cd "$PROJECT_DIR"

VERSION=$(node -e 'process.stdout.write(require("./package.json").version)')
TAG="v$VERSION"

echo "Creating GitHub Release $TAG ..."

RELEASE_NOTES=$(python3 - "$PROJECT_DIR/RELEASES.md" "$TAG" <<'PYEOF'
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
    \"tag_name\": \"$TAG\",
    \"name\": \"$TAG\",
    \"body\": $RELEASE_NOTES,
    \"draft\": false,
    \"prerelease\": false
  }")

http_code=$(echo "$release_resp" | tail -1)
release_body=$(echo "$release_resp" | sed '$d')

if [ "$http_code" = "201" ]; then
  echo "Release $TAG created"
elif [ "$http_code" = "422" ]; then
  echo "Release $TAG already exists, fetching..."
  release_body=$(curl -s -H "Authorization: token $GH_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/releases/tags/$TAG")
else
  echo "ERROR: Create release failed (HTTP $http_code): $release_body"
  exit 1
fi

upload_url=$(echo "$release_body" | node -e '
const d = JSON.parse(require("fs").readFileSync("/dev/stdin","utf8"));
process.stdout.write(d.upload_url.replace(/\{.*\}/,""));
')
echo "Upload URL: $upload_url"

for file in "$OUTPUT_DIR"/*.dmg "$OUTPUT_DIR"/*.zip "$OUTPUT_DIR"/*.yml; do
  [ ! -f "$file" ] && continue
  fname=$(basename "$file")
  echo "Uploading $fname ..."
  upload_resp=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: token $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$file" \
    "${upload_url}?name=${fname}")
  up_code=$(echo "$upload_resp" | tail -1)
  if [ "$up_code" = "201" ]; then
    echo "  OK: $fname"
  else
    echo "  FAIL (HTTP $up_code): $fname"
  fi
done

echo ""
echo "============================================"
echo "GitHub Release: https://github.com/$GITHUB_OWNER/$GITHUB_REPO/releases/tag/$TAG"
echo "============================================"
