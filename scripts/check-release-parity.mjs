/**
 * scripts/check-release-parity.mjs —— 发版跨平台一致性校验
 *
 * 为什么需要：
 *   两个平台各自构建、各自生成更新清单（latest-mac.yml / latest.yml），
 *   但**版本号只有一个来源**（package.json）。任何一边单独升版本，都会造成：
 *     - 已装 mac 的用户收到 0.7.747，Windows 用户永远停在 0.7.746；
 *     - 同一个 GitCode Release tag 下挂着两个不同版本的产物；
 *     - 上传 latest 频道时，后上传的清单会覆盖另一平台的分发目标。
 *   这类漂移不会报错，只会表现为「一边更新了、另一边没动静」，因此必须在发版前拦截。
 *
 * 判据：
 *  1. 存在哪个清单，就要求它的 version === package.json version；
 *  2. 清单指向的安装包文件必须真实存在（清单可能比产物先落盘，或反之）；
 *  3. `--strict`（正式发版）：mac 与 win 的清单必须同时存在。
 *
 * 用法：
 *   node scripts/check-release-parity.mjs            # 校验已存在的清单
 *   node scripts/check-release-parity.mjs --strict   # 正式发版：两边缺一即失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const MAC_DIR = path.join(ROOT, 'release-dist');
const WIN_DIR = path.join(ROOT, 'release');

const ok = (m) => console.log(`[parity] ✅ ${m}`);
const warn = (m) => console.log(`[parity] ⚠️  ${m}`);
const bad = (m) => {
  console.error(`[parity] ❌ ${m}`);
  failures += 1;
};
let failures = 0;

/** 从 electron-updater 清单里取 version（只认顶层 `version:`，不引入 yaml 依赖） */
function manifestVersion(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^version:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

function checkSide(label, dir, manifests, artifacts) {
  const present = manifests.filter((f) => fs.existsSync(path.join(dir, f)));
  if (!present.length) {
    if (STRICT) bad(`${label}：缺少更新清单（${manifests.join(' / ')}）`);
    else warn(`${label}：未构建（跳过）`);
    return;
  }
  for (const f of present) {
    const v = manifestVersion(path.join(dir, f));
    if (v !== VERSION) bad(`${label} ${f} 版本 ${v ?? '(无法解析)'} ≠ package.json ${VERSION}`);
  }
  if (!artifacts.some((a) => fs.existsSync(path.join(dir, a)))) {
    bad(`${label}：清单存在但安装包不存在（找过 ${artifacts.join(' / ')}）`);
  } else {
    ok(`${label}：version=${VERSION}，安装包就位`);
  }
}

console.log(`[parity] package.json version = ${VERSION}${STRICT ? '（strict 模式）' : ''}`);

checkSide(
  'macOS',
  MAC_DIR,
  ['latest-mac.yml', 'latest-mac-arm64.yml'],
  [`BobWork-${VERSION}-macos-arm64.zip`],
);

checkSide(
  'Windows',
  WIN_DIR,
  ['latest.yml'],
  [`BobWork-${VERSION}-win-x64.exe`],
);

if (failures > 0) {
  console.error(`[parity] 失败 ${failures} 项 —— 两平台版本必须同源，修好再发版`);
  process.exit(1);
}
console.log('[parity] 通过');
