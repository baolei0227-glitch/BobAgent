/**
 * scripts/stage-standalone.mjs — 把 `.next/standalone` 整理成「可打包」形态
 *
 * 为什么需要这一步（三个都是会被打成包、但打包前必须动的内容）：
 *
 *   1. **server.js 必须换成自定义入口**（工单 W-4）。`next build` 生成的是原生
 *      standalone wrapper（只 startServer），而 `electron/main.ts` 启动的正是
 *      `resourcesPath/next-standalone/server.js`。不换 ⇒ /remote-login、远程访问
 *      Token 网关、CalDAV 的 PROPFIND/REPORT/MKCOL 全部静默失效，日志里没有一句异常。
 *      以前只有 package-release.sh 做这件事，build:desktop 漏了，Windows 侧同样会漏。
 *
 *   2. **Next 16 的 standalone 可能落在子目录**（`<tracingRoot>/<项目目录名>/server.js`）。
 *      build-electron.sh 里硬编码了 `projects` 这个名字 —— 那是**本机目录名**，
 *      CI 上 checkout 目录叫 `BobAgent`，硬编码必然落空，且落空的形式是
 *      「找不到 server.js」，而不是报错说名字不对。这里改成按内容探测。
 *
 *   3. **不是 import 进来的运行时资源要显式拷**：内置技能（`assets/skills`）与
 *      Python 脚本（PDF 提取 / OOXML 修订 / 包清理）都不在 Next 的依赖图里。
 *
 * 只做「整理」，不删东西：删减交给 electron-builder 与后续瘦身，避免这一步变成
 * 又一处「删多了没人发现」的地方。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = path.join(ROOT, '.next', 'standalone');

/**
 * 目标平台。默认 = 构建机平台（CI 上两者相同，所以以前没暴露问题）；
 * 交叉打包时必须显式给 `--platform win32 --arch x64`，否则会把构建机的
 * darwin-arm64 二进制打进 Windows 安装包 —— 装到 Windows 上 SQLite 直接
 * `MODULE_NOT_FOUND`，而报错里不会出现"平台错了"字样。
 */
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const TARGET_PLATFORM = argOf('--platform', process.platform);
const TARGET_ARCH = argOf('--arch', TARGET_PLATFORM === 'win32' ? 'x64' : process.arch);


const log = (m) => console.log(`[stage] ${m}`);
const fail = (m) => {
  console.error(`[stage] ❌ ${m}`);
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

/** 把 symlink 目标里的 `<child>/` 段去掉并少退一层（与 build-electron.sh 的 sed 等价） */
function repairSymlinksUnder(nodeModulesDir, childName) {
  if (!exists(nodeModulesDir)) return 0;
  let fixed = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        const target = fs.readlinkSync(p);
        const needle = `../${childName}/`;
        if (target.includes(needle)) {
          const next = target.replace(needle, '');
          fs.unlinkSync(p);
          try {
            fs.symlinkSync(next, p);
            fixed += 1;
          } catch (e) {
            log(`⚠️ 重写符号链接失败（${p}）：${e.message}`);
          }
        }
      } else if (ent.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(nodeModulesDir);
  return fixed;
}

/**
 * 把 standalone 子目录提升一层。
 * 只用 fs.cpSync 的 verbatimSymlinks 保留相对符号链接，再按需重写退级。
 */
function hoist(childName) {
  const from = path.join(STANDALONE, childName);
  log(`standalone 落在子目录 "${childName}"，提升一层…`);
  for (const ent of fs.readdirSync(from)) {
    const src = path.join(from, ent);
    const dst = path.join(STANDALONE, ent);
    if (exists(dst)) {
      // 顶层已有同名项（Next 会放 package.json 之类）：保留已有，跳过
      log(`  跳过已存在: ${ent}`);
      continue;
    }
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  }
  const fixed = repairSymlinksUnder(path.join(STANDALONE, '.next', 'node_modules'), childName);
  if (fixed) log(`  修复符号链接 ${fixed} 个`);
  fs.rmSync(from, { recursive: true, force: true });
}

function resolveStandalone() {
  if (!exists(STANDALONE)) fail(`找不到 ${STANDALONE} —— next build 是否用了 output:'standalone'？`);
  if (exists(path.join(STANDALONE, 'server.js'))) return;
  const children = fs
    .readdirSync(STANDALONE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && exists(path.join(STANDALONE, e.name, 'server.js')))
    .map((e) => e.name);
  if (children.length === 0) fail('standalone 里找不到任何 server.js');
  if (children.length > 1) fail(`standalone 里有多份 server.js（${children.join(', ')}），无法判断该用哪份`);
  hoist(children[0]);
}

function copySkills() {
  const src = path.join(ROOT, 'assets', 'skills');
  if (!exists(src)) {
    log('⚠️ assets/skills 不存在，技能功能将不可用');
    return;
  }
  const dst = path.join(STANDALONE, 'assets', 'skills');
  fs.cpSync(src, dst, { recursive: true });
  log(`已拷入 assets/skills（${fs.readdirSync(dst).length} 项）`);
}

/** 运行时才被调用的脚本：不在依赖图里，必须显式拷到 next-standalone/scripts/ */
const RUNTIME_SCRIPTS = [
  'src/lib/pdf/core/pdf_extractor.py',
  'src/lib/docx/ooxml-revise.py',
  'src/lib/python/py-pkg-lifecycle.py',
];

function copyScripts() {
  const dstDir = path.join(STANDALONE, 'scripts');
  fs.mkdirSync(dstDir, { recursive: true });
  const copied = [];
  for (const rel of RUNTIME_SCRIPTS) {
    const src = path.join(ROOT, rel);
    if (!exists(src)) {
      log(`⚠️ 缺脚本（跳过）：${rel}`);
      continue;
    }
    fs.copyFileSync(src, path.join(dstDir, path.basename(rel)));
    copied.push(path.basename(rel));
  }
  // 只报**我拷的**那几个。standalone/scripts 里本来就有 Next 追踪进来的一堆文件
  // （.sh / .ts / .mjs），把整个目录列出来会让日志看起来像「拷进去 29 个」。
  log(`已拷入运行时脚本：${copied.join(', ') || '(无)'}`);
}

/**
 * 从源码树里定位一个包的真实目录（兼容 pnpm 的 `.pnpm/<name>@<ver>/node_modules/<name>`）。
 * `require.resolve` 在包带 `exports` 白名单时会拒绝 `package.json` 子路径，所以这里
 * 直接按目录名找，不依赖 resolve 语义。
 */
function resolvePkgDir(name) {
  const direct = path.join(ROOT, 'node_modules', name);
  if (exists(direct)) return direct;
  const pnpm = path.join(ROOT, 'node_modules', '.pnpm');
  if (!exists(pnpm)) return null;
  const prefix = name.replace('/', '+');
  for (const d of fs.readdirSync(pnpm)) {
    if (d !== prefix && !d.startsWith(`${prefix}@`)) continue;
    const cand = path.join(pnpm, d, 'node_modules', name);
    if (exists(cand)) return cand;
  }
  return null;
}

/** 找出 standalone 里所有带 prebuilds 目录的原生包（返回包目录本身） */
function findNativePkgDirs(dir, depth = 0, out = new Set()) {
  if (depth > 6 || !exists(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink() || !ent.isDirectory()) continue;
    const p = path.join(dir, ent.name);
    if (ent.name === 'prebuilds') {
      out.add(dir);
      continue;
    }
    findNativePkgDirs(p, depth + 1, out);
  }
  return out;
}

/**
 * 确保每个原生包都有「目标平台」的预编译二进制。
 *
 * 为什么必须显式做：Next 的文件追踪只把**构建机上解析到的**那一份 `.node` 追进
 * standalone（实测本机只有 darwin-arm64.node），可 `node-gyp-build` 是运行时按
 * `prebuilds/<platform>-<arch>.node` 找的。交叉打包时不补，包里就缺目标平台的二进制。
 */
function stageNativePrebuilds() {
  const pkgs = findNativePkgDirs(path.join(STANDALONE, 'node_modules'));
  if (pkgs.size === 0) {
    log('未发现带 prebuilds 的原生模块（本步无事可做）');
    return;
  }
  const want = `${TARGET_PLATFORM}-${TARGET_ARCH}.node`;
  for (const pkgDir of pkgs) {
    const pkgJson = path.join(pkgDir, 'package.json');
    const name = exists(pkgJson) ? JSON.parse(fs.readFileSync(pkgJson, 'utf8')).name : path.basename(pkgDir);
    const dst = path.join(pkgDir, 'prebuilds', want);
    if (exists(dst)) {
      log(`原生预编译已就位：${name} → ${want}`);
      continue;
    }
    const srcDir = resolvePkgDir(name);
    const src = srcDir ? path.join(srcDir, 'prebuilds', want) : null;
    if (!src || !exists(src)) {
      fail(`${name} 缺 ${want}，且源码树里也没有 —— ${TARGET_PLATFORM}-${TARGET_ARCH} 不受该包支持`);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    log(`✅ 补入原生预编译：${name}/${want}`);
  }
}

/**
 * 把 ffmpeg 装进 standalone。
 *
 * 为什么 Next 追踪不到：`audio-parser.ts` / `video-parser.ts` 用的是**动态** require
 * （`req('@ffmpeg-installer/ffmpeg')`），静态分析看不见 ⇒ 实测 standalone 里
 * `@ffmpeg-installer` 整个目录都没有，音视频解析在打包版里静默退化。
 *
 * 布局要求（见 @ffmpeg-installer/ffmpeg/index.js）：包装器用
 * `path.resolve(__dirname, '..', '<platform>-<arch>')` 找二进制，即两个包必须是
 * `node_modules/@ffmpeg-installer/{ffmpeg,<platform>-<arch>}` 的兄弟关系。
 */
function stageFfmpeg() {
  const plat = `${TARGET_PLATFORM}-${TARGET_ARCH}`;
  const names = ['@ffmpeg-installer/ffmpeg', `@ffmpeg-installer/${plat}`];
  const dstRoot = path.join(STANDALONE, 'node_modules', '@ffmpeg-installer');
  for (const name of names) {
    const src = resolvePkgDir(name);
    if (!src) {
      log(`⚠️ 源码树缺 ${name} —— 目标平台 ${plat} 的 ffmpeg 不可用`);
      continue;
    }
    const dst = path.join(dstRoot, path.basename(name));
    fs.cpSync(src, dst, { recursive: true, dereference: true });
    if (name === '@ffmpeg-installer/ffmpeg') {
      // 包装器本身不含二进制（它只是按平台转发），断言二进制只会误报
      log('✅ ffmpeg 包装器就位');
      continue;
    }
    const bin = path.join(dst, TARGET_PLATFORM === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    log(exists(bin) ? `✅ ffmpeg 二进制就位：${name}（${(fs.statSync(bin).size / 1048576).toFixed(1)} MB）` : `⚠️ ${name} 拷入但缺二进制（${path.basename(bin)}）`);
  }
}

function installCustomServer() {
  const built = path.join(ROOT, 'dist', 'server.js');
  if (!exists(built) || fs.statSync(built).size < 1024) {
    fail(`自定义 server 产物缺失或过小：${built}（先跑 scripts/compile-desktop.mjs）`);
  }
  fs.mkdirSync(path.join(STANDALONE, 'dist'), { recursive: true });
  fs.copyFileSync(built, path.join(STANDALONE, 'dist', 'server.js'));
  fs.copyFileSync(built, path.join(STANDALONE, 'server.js'));

  // 只断言「文件存在」没有意义：两份产物都存在，区别在内容。
  // /remote-login 是自定义入口独有的字符串（next 生成的 wrapper 里没有）。
  const text = fs.readFileSync(path.join(STANDALONE, 'server.js'), 'utf8');
  if (!text.includes('remote-login')) {
    fail('server.js 覆盖后仍不含 /remote-login —— 复制到了错误产物');
  }
  const kb = (fs.statSync(path.join(STANDALONE, 'server.js')).size / 1024).toFixed(1);
  log(`✅ 自定义 server 就位（${kb} KB，含 /remote-login）`);
}

/**
 * 删掉 Next 文件追踪顺带拷进来的「发布产物 / 文档 / 测试」目录。
 *
 * 为什么必须在这里做（2026-10-26 实测）：
 *   `next build` 的 standalone 会把项目根下若干目录整棵带进来 ——
 *   实测 release/ 198MB、release-dist/ 256MB（都是上一次打包的产物），
 *   再加上 docs/、e2e/、RELEASES.md、tsbuildinfo。
 *   Windows 打包直接吃 standalone（electron-builder 的 extraResources），
 *   于是这 450MB+ 垃圾原样进了安装包：0.7.747 的 Windows 包 478MB 里近一半是它。
 *   next.config 的 outputFileTracingExcludes 对这些目录不生效（实测），
 *   所以在「build 之后、打包之前」这一步统一收口，本地与 CI 两条路径都受益。
 */
const JUNK_DIRS = ['release', 'release-dist', 'docs', 'e2e', 'test-results', '.github', '.trae', '.workbuddy'];
const JUNK_FILE_RE = /^(RELEASES\.md|tsconfig.*\.json|.*\.tsbuildinfo)$/;

function dirSize(p) {
  let total = 0;
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return st.size;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) total += dirSize(path.join(p, e.name));
  return total;
}

function pruneJunk() {
  let freed = 0;
  for (const name of JUNK_DIRS) {
    const p = path.join(STANDALONE, name);
    if (!exists(p)) continue;
    try {
      freed += dirSize(p);
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* 删不掉就留着，不阻断打包 */ }
  }
  for (const name of fs.readdirSync(STANDALONE)) {
    if (!JUNK_FILE_RE.test(name)) continue;
    const p = path.join(STANDALONE, name);
    try {
      freed += fs.lstatSync(p).size;
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* 同上 */ }
  }
  if (freed > 0) log(`已清理非运行时文件 ${(freed / 1048576).toFixed(0)} MB（release/、release-dist/、docs/ 等）`);
}

function report() {
  const nm = path.join(STANDALONE, 'node_modules');
  const native = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6 || !exists(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue; // 不跟随，避免环
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.name.endsWith('.node')) native.push(path.relative(STANDALONE, p));
    }
  };
  walk(nm);
  log(`standalone 原生模块 ${native.length} 个：${native.join(', ') || '(无)'}`);
}

log(`目标平台：${TARGET_PLATFORM}-${TARGET_ARCH}（构建机 ${process.platform}-${process.arch}）`);
resolveStandalone();
installCustomServer();
copySkills();
copyScripts();
stageNativePrebuilds();
stageFfmpeg();
pruneJunk();
report();
log('完成');
