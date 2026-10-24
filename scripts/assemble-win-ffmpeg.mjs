#!/usr/bin/env node
/**
 * scripts/assemble-win-ffmpeg.mjs —— 把 win32-x64 的 ffmpeg.exe 收进 .build/bin
 *
 * 为什么需要单独一步：
 *   主进程把 `FFMPEG_PATH` 固定指向 `resources/bin/ffmpeg(.exe)`（见 electron/main.ts 的
 *   spawn env）。electron-builder 的 extraResources 只认**确定的文件路径**，而 pnpm 的
 *   `node_modules/@ffmpeg-installer/win32-x64` 并不在仓库根目录 —— 它作为 optional 依赖
 *   被装在 `@ffmpeg-installer/ffmpeg` 自己的 .pnpm 目录下。直接写根路径的 from
 *   在 Windows CI 上会「文件不存在」直接失败；macOS 交叉打包时根路径也不存在。
 *
 * 判据优先级（两者任一即可，找不到就失败，不静默产出缺 ffmpeg 的包）：
 *   1. 通过 require.resolve('@ffmpeg-installer/ffmpeg/package.json') 找到包目录，
 *      取同级 `../win32-x64/ffmpeg.exe`（pnpm 的稳定布局）；
 *   2. 仓库根 `node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe`（交叉打包时手工放置）。
 *
 * 用法：
 *   node scripts/assemble-win-ffmpeg.mjs
 *   → .build/bin/ffmpeg.exe（由 electron-builder.win.yml 的 extraResources 挂到 resources/bin）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.build', 'bin', 'ffmpeg.exe');
const require_ = createRequire(path.join(ROOT, 'package.json'));

function candidates() {
  const out = [];
  try {
    const pkg = require_.resolve('@ffmpeg-installer/ffmpeg/package.json');
    // .pnpm/@ffmpeg-installer+ffmpeg@x/node_modules/@ffmpeg-installer/ffmpeg/package.json
    out.push(path.join(path.dirname(pkg), '..', 'win32-x64', 'ffmpeg.exe'));
  } catch {
    // 没装 @ffmpeg-installer/ffmpeg：只可能是精简安装，走下面的根路径兜底
  }
  out.push(
    path.join(ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(ROOT, 'node_modules', '.pnpm', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
  );
  return out;
}

const found = candidates().find((p) => fs.existsSync(p));
if (!found) {
  console.error('[win-ffmpeg] ❌ 找不到 win32-x64/ffmpeg.exe，候选路径：');
  for (const p of candidates()) console.error(`  - ${p}`);
  console.error('[win-ffmpeg]    Windows 上请确认 `pnpm install` 装了 optional 依赖；');
  console.error('[win-ffmpeg]    macOS 交叉打包请先放置 node_modules/@ffmpeg-installer/win32-x64/。');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(found, OUT);
const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`[win-ffmpeg] ✅ ${path.relative(ROOT, OUT)}（${mb} MB）← ${path.relative(ROOT, found)}`);
