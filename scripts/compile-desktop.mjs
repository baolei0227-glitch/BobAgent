#!/usr/bin/env node
/**
 * scripts/compile-desktop.mjs — 桌面端产物编译（跨平台，无 bash / 无 npx）
 *
 * 现状问题（为什么需要这个脚本）：
 *   - `scripts/build-electron.sh:16` 用 `npx tsup …` 编主进程；
 *   - `scripts/package-release.sh:346` 用 `corepack pnpm tsup …` 编 server 入口；
 *   两者都是 bash + 包管理器代理。Windows 上没有 bash，且 `npx`/`corepack` 在 `.bin`
 *   缺失时会去联网取一个**非本仓库版本**，构建结果静默漂移（项目既有纪律：构建脚本不得用 npx）。
 *
 * 本脚本直接 `node node_modules/tsup/dist/cli-default.js`：
 *   - tsup 的 bin 是普通 JS（`"bin": {"tsup": "dist/cli-default.js"}`），不走 Mach-O/CMD shim，
 *     Windows 与 POSIX 都能用同一份代码调用；
 *   - 版本由 pnpm-lock 固定，不会漂移。
 *
 * 用法：
 *   node scripts/compile-desktop.mjs              # 编全部（electron + server）
 *   node scripts/compile-desktop.mjs electron     # 只编主进程/preload
 *   node scripts/compile-desktop.mjs server       # 只编自定义 server 入口
 *
 * 两个产物分别回答两个问题（别混）：
 *   electron/  → 主进程能否被 esbuild 打包成 CJS（Electron 加载 main.js）
 *   dist/server.js → 打包版要把它**覆盖**到 next-standalone/server.js 上，
 *                    否则跑的是 Next 自动生成的 wrapper：**鉴权网关、登录页、
 *                    优雅停服端点全部消失**（见 scripts/package-release.sh:340 的注释）。
 *                    ⚠️ 而 `scripts/build-electron.sh`（build:desktop）目前**没有**这一步 ——
 *                    它产出的 .app 里 server.js 是 Next 原生那份。这是既有缺陷，未在本脚本处理，
 *                    因为修它等于改 build:desktop 的产物行为，要单独确认。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSUP = path.join(ROOT, 'node_modules', 'tsup', 'dist', 'cli-default.js');

/** @type {{name: string, args: string[], outputs: string[]}[]} */
const TARGETS = [
  {
    name: 'electron',
    args: [
      'electron/main.ts',
      'electron/preload.ts',
      '--format', 'cjs',
      '--platform', 'node',
      '--target', 'node20',
      '--outDir', 'electron/dist',
      '--no-splitting',
      '--external', 'electron',
    ],
    outputs: ['electron/dist/main.js', 'electron/dist/preload.js'],
  },
  {
    name: 'server',
    args: [
      'src/server.ts',
      '--format', 'cjs',
      '--platform', 'node',
      '--target', 'node20',
      '--outDir', 'dist',
      '--no-splitting',
      '--no-minify',
    ],
    outputs: ['dist/server.js'],
  },
];

function die(msg) {
  console.error(`\n[compile-desktop] 失败：${msg}`);
  process.exit(1);
}

if (!existsSync(TSUP)) {
  die(`找不到 tsup 入口 ${TSUP}（先 pnpm install）`);
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = wanted.length ? TARGETS.filter((t) => wanted.includes(t.name)) : TARGETS;
if (selected.length === 0) {
  die(`未知目标 ${wanted.join(',')}；可用：${TARGETS.map((t) => t.name).join(', ')}`);
}

for (const t of selected) {
  console.log(`\n[compile-desktop] tsup ${t.name} …`);
  const r = spawnSync(process.execPath, [TSUP, ...t.args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
  });
  if (r.error) die(`${t.name} 启动失败：${r.error.message}`);
  if (r.status !== 0) die(`${t.name} 退出码 ${r.status}`);

  // 断言产物真的在，而不是「tsup 退出码 0 就当成功」——
  // 缺产物时错误会推迟到用户双击应用那一刻才出现（且只有一句「服务未启动」）。
  for (const rel of t.outputs) {
    const p = path.join(ROOT, rel);
    if (!existsSync(p)) die(`tsup 退出码 0 但产物缺失：${rel}`);
    const size = statSync(p).size;
    if (size < 1024) die(`产物过小（${size}B），几乎肯定没打进去：${rel}`);
    console.log(`  ✓ ${rel}  ${(size / 1024).toFixed(1)} KB`);
  }
}

console.log('\n[compile-desktop] 全部完成');
