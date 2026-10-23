#!/usr/bin/env node
/**
 * scripts/check-win-update-manifest.mjs —— Windows 自动更新清单校验
 *
 * 为什么需要：
 *   安装包能装 ≠ 能更新。用户装完之后，electron-updater 只认两样东西：
 *     1) resources/app-update.yml —— 决定「检查更新」是否启用、去哪里查；
 *     2) latest.yml                —— 提供版本号、exe 文件名、大小与 sha512。
 *   这两份文件任何一个不对，都不会报错：
 *     - app-update.yml 缺失   → 主进程直接 `Auto-updater disabled`，检查更新永远没结果；
 *     - 版本号比 package.json 旧 → 用户装的是新包，却被告知已是最新；
 *     - sha512/大小对不上     → 下载完校验失败，删了重下，无限循环。
 *   所以出包后必须拿**磁盘上的真实文件**逐项核对，而不是「文件存在即通过」。
 *
 * 用法：
 *   node scripts/check-win-update-manifest.mjs                 # 默认检查 release/
 *   node scripts/check-win-update-manifest.mjs --dir release
 *   node scripts/check-win-update-manifest.mjs --expect-url https://...  # 覆盖期望的更新源
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const DIR = path.resolve(ROOT, arg('--dir', 'release'));
const DEFAULT_URL = 'https://gitcode.com/baolei89/BobWork/releases/download/latest';
const EXPECTED_URL = arg('--expect-url', DEFAULT_URL).replace(/\/+$/, '');

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const failures = [];
const ok = (m) => console.log(`[update-manifest] ✅ ${m}`);
const bad = (m) => {
  failures.push(m);
  console.error(`[update-manifest] ❌ ${m}`);
};
const warn = (m) => console.log(`[update-manifest] ⚠️  ${m}`);

/** 只取顶层 `key: value`（latest.yml 是固定结构，不引入 yaml 依赖） */
function topLevel(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
}

/**
 * 同时给出 hex 与 base64 两种摘要。
 * electron-builder 写的是 base64，mac 侧脚本写的是 hex；
 * 校验端（electron/main.ts 的 sha512Matches）两种都认，这里保持一致。
 */
function sha512Digests(file) {
  const hex = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');
  return { hex, base64: Buffer.from(hex, 'hex').toString('base64') };
}

// ---------- 1. latest.yml ----------
const manifestPath = path.join(DIR, 'latest.yml');
if (!fs.existsSync(manifestPath)) {
  console.error(`[update-manifest] ❌ 找不到 ${path.relative(ROOT, manifestPath)}`);
  console.error('[update-manifest]    electron-builder.win.yml 的 publish 段缺失时不会生成该清单，');
  console.error('[update-manifest]    Windows 端的「检查更新」将永远发现不了新版本。');
  process.exit(1);
}

const manifest = fs.readFileSync(manifestPath, 'utf8');
const version = topLevel(manifest, 'version');
if (version !== PKG.version) {
  bad(`latest.yml 版本 ${version || '(无法解析)'} ≠ package.json ${PKG.version}`);
} else {
  ok(`latest.yml 版本 = ${version}`);
}

// files[] 里第一条就是 Windows 用的 exe
const fileBlock = manifest.match(/files:\s*\n\s*-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)/);
if (!fileBlock) {
  bad('latest.yml 缺少 files[0] 的 url / sha512 / size');
} else {
  const [, rawUrl, expectedSha, rawSize] = fileBlock;
  const artifact = path.join(DIR, path.basename(rawUrl));
  const expectedSize = Number(rawSize);

  if (!fs.existsSync(artifact)) {
    bad(`latest.yml 指向的安装包不存在：${path.basename(rawUrl)}`);
  } else {
    const actualSize = fs.statSync(artifact).size;
    if (actualSize !== expectedSize) {
      bad(`安装包大小不一致：latest.yml=${expectedSize}，磁盘=${actualSize}`);
    } else {
      ok(`安装包大小一致（${(actualSize / 1024 / 1024).toFixed(1)} MB）`);
    }
    const digests = sha512Digests(artifact);
    const wantSha = expectedSha.trim();
    if (digests.base64 !== wantSha && digests.hex !== wantSha.toLowerCase()) {
      bad('安装包 sha512 与 latest.yml 不一致（下载后必然校验失败）');
    } else {
      const format = digests.base64 === wantSha ? 'base64' : 'hex';
      ok(`安装包 sha512 与 latest.yml 一致（${format}）`);
    }
    if (!/^BobWork-.*-win-x64\.exe$/.test(path.basename(artifact))) {
      warn(`产物名不符合 BobWork-<version>-win-x64.exe：${path.basename(artifact)}（不影响更新，但会偏离文档）`);
    }
    const blockmap = `${artifact}.blockmap`;
    if (!fs.existsSync(blockmap)) {
      // 自研断点续传下载器不依赖 blockmap，但 electron-updater 的差分下载需要它
      warn('缺少 .blockmap（全量更新仍可用，差分更新退化为全量）');
    } else {
      ok('.blockmap 已生成');
    }
  }
}

// ---------- 2. app-update.yml（更新开关） ----------
const appUpdatePath = path.join(DIR, 'win-unpacked', 'resources', 'app-update.yml');
if (!fs.existsSync(appUpdatePath)) {
  bad('缺少 resources/app-update.yml —— 主进程会判定 "Auto-updater disabled"，用户永远收不到更新');
} else {
  const conf = fs.readFileSync(appUpdatePath, 'utf8');
  if (!/^provider:\s*generic\s*$/m.test(conf)) {
    bad('app-update.yml 的 provider 不是 generic');
  }
  const url = topLevel(conf, 'url');
  if (!url) {
    bad('app-update.yml 缺少 url');
  } else if (url.replace(/\/+$/, '') !== EXPECTED_URL) {
    bad(`app-update.yml 的更新源为 ${url}，期望 ${EXPECTED_URL}`);
  } else {
    ok(`app-update.yml 指向 ${url}`);
  }
  const channel = topLevel(conf, 'channel');
  if (channel && channel !== 'latest') {
    bad(`app-update.yml 的 channel=${channel}，本项目的发布频道是 latest`);
  } else {
    ok(`app-update.yml channel=${channel || '(默认 latest)'}`);
  }
}

// ---------- 3. 结论 ----------
if (failures.length > 0) {
  console.error(`\n[update-manifest] ${failures.length} 项未通过，不要发布这个包。`);
  process.exit(1);
}
console.log('\n[update-manifest] 全部通过：装上这个包的用户可以正常检查更新。');
