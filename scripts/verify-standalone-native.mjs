/**
 * scripts/verify-standalone-native.mjs — 断言 standalone 里的原生模块在 **Electron 运行时** 下可用
 *
 * 背景（这一步存在的理由，以及为什么是「验证」而不是「重建」）：
 *
 *   `electron/main.ts` 用 `spawn(process.execPath, [serverPath], { env: {
 *   ELECTRON_RUN_AS_NODE: '1' } })` 启动 Next 服务 —— 服务端跑在 **Electron 自带的 Node**
 *   里，不是系统 node。若某个原生模块是按别的 ABI 编的，症状是
 *   `NODE_MODULE_VERSION 不匹配`，而这条错误发生在 **spawn 出去的 server 进程**里，
 *   主进程只表现为「页面打不开 / 服务起不来」，极难反推。
 *
 *   但「必须重建」是个**未经证实的假设**，这里实测推翻了它：
 *   `better-sqlite3@13.0.1` 依赖 `node-addon-api`（N-API，ABI 稳定），并按
 *   `prebuilds/<platform>-<arch>.node` 选二进制（`lib/win32-x64.js` 直接 require 它）。
 *   N-API 的二进制在 Node 与 Electron 之间通用 ⇒ **不需要 node-gyp 重编**。
 *   反过来，硬去 `npm rebuild` 还会失败：GitHub runner 上是 Visual Studio「18」，
 *   node-gyp 的版本探测不认（报 `unknown version "undefined"`），
 *   于是 install 阶段就红 —— 这正是第一次构建挂掉的原因。
 *
 * 所以本脚本只做一件事：**用 Electron 亲自 require 一遍**。
 *   - 通过 ⇒ 出货；ABI 这件事就算被证明了，而不是从「重编成功」推断出来。
 *   - 不通过 ⇒ 立刻失败，并打印两边的 NODE_MODULE_VERSION 供判断。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = path.join(ROOT, '.next', 'standalone');
const IS_WIN = process.platform === 'win32';

const log = (m) => console.log(`[native] ${m}`);
const fail = (m) => {
  console.error(`[native] ❌ ${m}`);
  process.exit(1);
};
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

function electronBinary() {
  const cands = IS_WIN
    ? [path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')]
    : [
        path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
      ];
  const hit = cands.find(exists);
  if (!hit) {
    fail(
      `找不到 Electron 可执行文件（尝试过 ${cands.join(' / ')}）。\n` +
        '  安装时若用了 --ignore-scripts，必须再单独跑 `node node_modules/electron/install.js`。',
    );
  }
  return hit;
}

function findNativePackages(dir) {
  const found = new Map();
  const walk = (d, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p, depth + 1);
      } else if (ent.name.endsWith('.node')) {
        let cur = path.dirname(p);
        while (cur.startsWith(dir)) {
          if (exists(path.join(cur, 'package.json'))) {
            found.set(cur, path.relative(dir, cur));
            break;
          }
          const up = path.dirname(cur);
          if (up === cur) break;
          cur = up;
        }
      }
    }
  };
  walk(path.join(dir, 'node_modules'));
  return found;
}

const ELECTRON_BIN = electronBinary();
const packages = findNativePackages(STANDALONE);

if (packages.size === 0) {
  // 不是失败：说明这一步真的没有原生依赖。但必须说出来，否则「0 个」会被误读成「全过了」。
  log('standalone 里没有原生模块 —— 本步无事可做（这是合法结果，不是通过 0 项断言）');
  process.exit(0);
}

log(`在 Electron 运行时下逐个加载（${packages.size} 个原生包）…`);

let failed = 0;
for (const [pkgDir, rel] of packages) {
  // JSON.stringify 生成合法 JS 字面量：Windows 路径里的反斜杠必须转义
  const probe =
    `const p=${JSON.stringify(pkgDir)};` +
    `const M=require(p);` +
    `const D=M&&M.default?M.default:M;` +
    // better-sqlite3 这类构造即用：真的开一个内存库，确保 .node 走到实际代码路径，
    // 而不是「模块对象拿到了但绑定是懒加载」也算通过。
    `if(typeof D==='function'){try{const db=new D(':memory:');db.close()}catch(e){` +
    `if(!/not a constructor|Illegal constructor/i.test(String(e))){throw e}}}` +
    `console.log('NODE_MODULE_VERSION='+process.versions.modules+' ELECTRON='+(process.versions.electron||'n/a'));`;

  const r = spawnSync(ELECTRON_BIN, ['-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 120000,
  });

  const out = String(r.stdout || '').trim();
  if (r.status === 0) {
    log(`  ✓ ${rel}（${out || 'loaded'}）`);
    continue;
  }

  failed += 1;
  const tail = `${r.stdout || ''}${r.stderr || ''}`
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-6)
    .join(' | ');
  console.error(`[native] ❌ ${rel} 在 Electron 下加载失败（exit=${r.status}）：${tail}`);
}

if (failed > 0) {
  // 宿主 node 的 modversion 一并打出来：ABI 不匹配时这一行就能直接对照
  fail(
    `${failed}/${packages.size} 个原生模块在 Electron 运行时下不可用 —— 装出去必然启动失败，不打包。\n` +
      `  本机 node 的 NODE_MODULE_VERSION=${process.versions.modules}；Electron 侧见上面的日志。\n` +
      '  处置：确认该包是否有 N-API 预编译（node-addon-api / prebuilds）；没有的话需要按 Electron ABI 重编。',
  );
}

log(`全部通过（${packages.size}/${packages.size}）`);
