/**
 * scripts/rebuild-standalone-native.mjs — 把 standalone 里的原生模块重建到 **Electron ABI**，并当场验证
 *
 * 为什么必须做（这是 Windows 打包最容易漏、且症状最误导人的一步）：
 *
 *   `electron/main.ts:254-267` 用 `spawn(process.execPath, [serverPath], { env: {
 *   ELECTRON_RUN_AS_NODE: '1' } })` 启动 Next 服务 —— 也就是**用 Electron 自带的
 *   Node 运行时**跑服务端。而 `next build` 的 output tracing 是把 `node_modules`
 *   **原样拷一份**进 `.next/standalone`，那份 `.node` 是按**宿主 Node** 的 ABI 编的。
 *
 *   两个 ABI 不同 ⇒ 用户装完一启动就是
 *   `better-sqlite3 … was compiled against a different Node.js version`
 *   （NODE_MODULE_VERSION 对不上）。而这条错误发生在 **spawn 出去的 server 进程里**，
 *   主进程只看到「server 退出了 / 页面打不开」，极难从日志反推。
 *
 * 所以这里做两件事，缺一不可：
 *   ① 用 `npm rebuild --runtime=electron --target=<版本>` 把每个原生包按 Electron ABI 重编；
 *   ② **真机断言**：用 `ELECTRON_RUN_AS_NODE=1 electron.exe -e "require(...)"` 逐个加载，
 *      加载不通过就让构建失败。只「重编成功」不算证据 —— 编错目标的例子太多了。
 *
 * 用法：node scripts/rebuild-standalone-native.mjs
 * 前置：已跑过 scripts/stage-standalone.mjs，且 node_modules/electron 已装好。
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

// ---------- 1. Electron 版本与可执行文件 ----------

const electronPkgPath = path.join(ROOT, 'node_modules', 'electron', 'package.json');
if (!exists(electronPkgPath)) fail('node_modules/electron 不存在 —— 安装依赖时是否用了 --ignore-scripts？');
const electronVersion = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8')).version;

function electronBinary() {
  const cands = IS_WIN
    ? [path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')]
    : [
        path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
      ];
  const hit = cands.find(exists);
  if (!hit) fail(`找不到 Electron 可执行文件（尝试过 ${cands.join(' / ')}）`);
  return hit;
}
const ELECTRON_BIN = electronBinary();

// ---------- 2. 找出所有含 .node 的包 ----------

function findNativePackages(dir) {
  const found = new Map(); // 包根目录 -> 包名
  const walk = (d, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue; // 不跟随，避免 pnpm 环
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p, depth + 1);
      } else if (ent.name.endsWith('.node')) {
        // 向上找到最近的、含 package.json 的包根
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

const packages = findNativePackages(STANDALONE);
if (packages.size === 0) {
  log('standalone 里没有原生模块，跳过重建（这是合法结果，不是失败）');
  process.exit(0);
}
log(`Electron ${electronVersion}；待处理原生包 ${packages.size} 个：`);
for (const rel of packages.values()) log(`  - ${rel}`);

// ---------- 3. 按 Electron ABI 重建 ----------

/**
 * ⚠️ 在**包目录内部**跑 `npm rebuild`，不传包名。
 *
 * 传包名（`npm rebuild better-sqlite3`）在这里是错的：pnpm 布局下真实路径是
 * `node_modules/.pnpm/better-sqlite3@13.0.1/node_modules/better-sqlite3`，
 * 传相对路径不是合法 package spec，npm 会**既不报错也不干活**（silent no-op）；
 * 传包名则要求 `node_modules/better-sqlite3` 这个顶层入口存在（追踪可能只留 .pnpm 那份）。
 * 在 cwd 里 rebuild 走的是 cwd 的 package.json，与布局无关。
 *
 * 即便它真的 no-op 了也不会漏过 —— 第 4 步用 Electron 亲自 require，ABI 不对就红。
 */
function snapshotDotNodes(dir) {
  const out = new Map();
  const walk = (d, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.name.endsWith('.node')) {
        try {
          out.set(p, fs.statSync(p).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return out;
}

for (const [pkgDir, rel] of packages) {
  log(`重建 ${rel} …`);
  const before = snapshotDotNodes(pkgDir);
  const r = spawnSync(
    'npm',
    ['rebuild', '--runtime=electron', `--target=${electronVersion}`, '--dist-url=https://electronjs.org/headers'],
    {
      cwd: pkgDir,
      encoding: 'utf8',
      shell: IS_WIN, // Windows 的 npm 是 npm.cmd，不加 shell 会 ENOENT
      timeout: 20 * 60 * 1000,
    },
  );
  if (r.status !== 0) {
    const tail = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).slice(-15).join(' | ');
    fail(`重建 ${rel} 失败（exit=${r.status}）：${tail}`);
  }
  const after = snapshotDotNodes(pkgDir);
  const touched = [...after].filter(([p, m]) => before.get(p) !== m).map(([p]) => path.basename(p));
  if (touched.length === 0) {
    log(`  ⚠️ ${rel}: 没有 .node 被更新（可能是命中缓存的 Electron 预编译包，也可能什么都没做）`);
  } else {
    log(`  ✓ ${rel}: 更新 ${touched.join(', ')}`);
  }
}

// ---------- 4. 真机断言：用 Electron 自己加载每个原生模块 ----------

log('用 Electron-as-node 逐个加载（打印的是运行时真实的 NODE_MODULE_VERSION）…');
let failed = 0;
for (const [pkgDir, rel] of packages) {
  // 用 JSON.stringify 生成合法的 JS 字符串字面量：Windows 路径里的反斜杠必须转义
  const probe =
    `const p=${JSON.stringify(pkgDir)};` +
    `const M=require(p);` +
    `const D=M&&M.default?M.default:M;` +
    `if(typeof D==='function'){try{new D(':memory:').close()}catch(e){}}` +
    `console.log('LOADED '+(M&&M.name?'':'')+process.versions.modules);`;
  const r = spawnSync(ELECTRON_BIN, ['-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 120000,
  });
  if (r.status === 0) {
    log(`  ✓ ${rel}（modversion ${String(r.stdout || '').trim().replace(/^LOADED\s*/, '')}）`);
  } else {
    failed += 1;
    const tail = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
    console.error(`[native] ❌ ${rel} 在 Electron 下加载失败（exit=${r.status}）：${tail}`);
  }
}

if (failed > 0) {
  fail(`${failed}/${packages.size} 个原生模块在 Electron ABI 下不可用 —— 装出去也是启动即崩，不打包`);
}
log(`全部通过（${packages.size}/${packages.size}）`);
