/**
 * 组装 release/win-unpacked/resources/next-standalone。
 *
 * 为什么不直接用 electron-builder 的 extraResources：
 *   实测它把 `.next/standalone` 拷过去时**整个 node_modules 丢了**（目标里没有该目录），
 *   而 electron/main.ts:263 是 `cwd = resources/next-standalone` 且不设 NODE_PATH，
 *   node_modules 缺失 ⇒ 内置服务根本起不来。所以这一步自己做、并逐项自检。
 *
 * 两个必须的转换：
 *   1. **剔除 `release/`**：standalone 里有一份 328 MB 的 `release/`（被文件追踪带进去的
 *      自嵌套产物），进包就是纯垃圾。
 *   2. **符号链接实体化**：pnpm 的 `node_modules/next -> .pnpm/next@.../node_modules/next`
 *      是相对符号链接，zip 与 Windows 都不认 ⇒ 必须换成真实目录，否则同样起不来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire, builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '.next', 'standalone');
const RES = path.join(ROOT, 'release', 'win-unpacked', 'resources');
const TARGET = path.join(RES, 'next-standalone');

const log = (m) => console.log(`[asm] ${m}`);

fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });

// ---- 1. 基础拷贝（先保留符号链接，稍后统一实体化；这样能避开 rsync -L 的环）----
const excludes = ['release/', 'e2e/', 'test-results/', '.next/cache/'];
const args = ['-a', ...excludes.flatMap((e) => ['--exclude', e]), `${SRC}/`, `${TARGET}/`];
execFileSync('rsync', args, { stdio: ['ignore', 'ignore', 'inherit'] });
log(`已从 .next/standalone 拷贝（排除 ${excludes.join(' ')}）`);

// ---- 2. 符号链接实体化 ----
let links = 0;
let loops = 0;
function materialize(dir, seen) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync(p);
      } catch {
        log(`⚠️ 断链，已删：${path.relative(TARGET, p)}`);
        fs.unlinkSync(p);
        continue;
      }
      if (seen.has(real)) {
        loops += 1;
        fs.unlinkSync(p);
        log(`⚠️ 环引用，已删：${path.relative(TARGET, p)}`);
        continue;
      }
      fs.unlinkSync(p);
      const nextSeen = new Set(seen).add(real);
      if (fs.statSync(real).isDirectory()) {
        fs.mkdirSync(p, { recursive: true });
        for (const e of fs.readdirSync(real)) {
          const from = path.join(real, e);
          const to = path.join(p, e);
          if (fs.statSync(fs.realpathSync(from)).isDirectory()) {
            fs.cpSync(from, to, { recursive: true, verbatimSymlinks: false, dereference: true });
          } else {
            fs.copyFileSync(fs.realpathSync(from), to);
          }
        }
        materialize(p, nextSeen);
      } else {
        fs.copyFileSync(real, p);
      }
      links += 1;
    } else if (ent.isDirectory()) {
      materialize(p, seen);
    }
  }
}
materialize(TARGET, new Set([fs.realpathSync(SRC)]));
log(`实体化符号链接 ${links} 个（删环/断链 ${loops} 个）`);

// ---- 3. 补 Next 的 static 与 public（它们不在 standalone 里）----
fs.cpSync(path.join(ROOT, '.next', 'static'), path.join(TARGET, '.next', 'static'), { recursive: true });
log('已补 .next/static');
fs.rmSync(path.join(TARGET, 'public'), { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), path.join(TARGET, 'public'), { recursive: true });
log('已补 public');

// ---- 4. ffmpeg 放到主进程约定的 resources/bin/ffmpeg.exe ----
const binDir = path.join(RES, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const ff = path.join(ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
if (fs.existsSync(ff)) {
  fs.copyFileSync(ff, path.join(binDir, 'ffmpeg.exe'));
  log(`已放 resources/bin/ffmpeg.exe（${(fs.statSync(ff).size / 1048576).toFixed(1)} MB）`);
} else {
  log('⚠️ 找不到 win32 ffmpeg.exe');
}

// ---- 4.4 随包嵌入式 Python（Windows 没有系统 python3；评估文档 §10.2-E）----
// 必须随包分发：Office 模板填充 / Word 修订 / PDF 文本提取 / 图片裁剪 都经 pythonBin 调用。
// 缺它会「应用能启动、部分功能静默不可用」，所以这里硬失败，不留降级。
{
  const py = path.join(ROOT, 'scripts', 'assemble-win-python.mjs');
  log('组装嵌入式 Python（python-docx / Pillow / lxml）…');
  execFileSync(process.execPath, [py, '--target', path.join(RES, 'python')], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

shipServerBundleExternals();
slimAppNodeModules();

// ---- 4.5 修 node_modules 结构（Windows 实机报告 D1/D2/D3/D4 的根治）----
// 必须放在最后：前面几步都会往 node_modules 里写包。
// 它做四件事：从开发树补齐 nft 的残缺包、把 .pnpm 里没提升的包提到顶层、
// 删掉 .pnpm（长路径源头）、给 .next 的追踪副本补目标平台原生模块。
// ⚠️ 不固化进流水线的后果：下一次组装会原样退回残缺状态（一次性脚本等于没做）。
{
  const fixer = path.join(ROOT, 'scripts', 'fix-win-node-modules.mjs');
  log('调用 fix-win-node-modules.mjs …');
  execFileSync(process.execPath, [fixer, '--target', TARGET], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

/**
 * 补齐「自定义入口 dist/server.js」的外部依赖。
 *
 * 这是 Windows 启动失败的真根因（2026-10-19 实测）：
 *   `dist/server.js` 是 tsup 产物，tsup 默认把 package.json 的 dependencies 全当 external；
 *   而它**不在 Next 的构建图里**（是 compile-desktop 单独编的），所以 Next 的文件追踪
 *   一个都看不到 ⇒ `better-sqlite3` / `tsdav` / `qrcode` / `mammoth` / `adm-zip` /
 *   `@modelcontextprotocol/sdk/client/*` 全都不在包里。
 *   macOS 上还能靠祖先目录的 dev node_modules 兜住，Windows 上没有任何兜底 ⇒
 *   `Cannot find module 'better-sqlite3'` → exit code 1 → 主进程报「Next.js 服务启动超时」。
 *
 * ⚠️ 验证必须在**仓库外**做：包位于 projects/ 下时，Node 会向上找到开发用的
 *    node_modules，把缺失全部假通过（我第一次就被骗了）。
 */
function shipServerBundleExternals() {
  const bundle = path.join(ROOT, 'dist', 'server.js');
  if (!fs.existsSync(bundle)) {
    log('⚠️ 没有 dist/server.js，跳过外部依赖补齐');
    return;
  }
  const builtins = new Set(builtinModules);
  const src = fs.readFileSync(bundle, 'utf8');
  const specs = new Set();
  for (const m of src.matchAll(/(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) {
    const sp = m[1];
    if (!sp.startsWith('.') && !sp.startsWith('/')) specs.add(sp);
  }
  const roots = new Set();
  for (const sp of specs) {
    const n = sp.startsWith('@') ? sp.split('/').slice(0, 2).join('/') : sp.split('/')[0];
    if (builtins.has(n) || n.startsWith('node:') || n.includes('${')) continue;
    roots.add(n);
  }

  const resolveFrom = (fromDir, name) => {
    for (const base of [fromDir, ROOT].filter(Boolean)) {
      let r;
      try {
        r = createRequire(path.join(base, 'index.js'));
      } catch {
        continue;
      }
      for (const spec of [`${name}/package.json`, name]) {
        try {
          let d = path.dirname(fs.realpathSync(r.resolve(spec)));
          for (let i = 0; i < 8; i += 1) {
            if (fs.existsSync(path.join(d, 'package.json'))) return d;
            if (path.dirname(d) === d) break;
            d = path.dirname(d);
          }
        } catch {
          /* 换下一个候选 */
        }
      }
    }
    return null;
  };

  const keep = new Map();
  const queue = [...roots].map((n) => ({ name: n, from: null }));
  const seen = new Set();
  while (queue.length) {
    const { name, from } = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = resolveFrom(from, name);
    if (!dir) {
      log(`⚠️ 解析不到 ${name}（传递依赖缺失）`);
      continue;
    }
    keep.set(name, dir);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(meta.dependencies || {})) queue.push({ name: dep, from: dir });
    for (const dep of Object.keys(meta.optionalDependencies || {})) queue.push({ name: dep, from: dir });
  }

  const nm = path.join(TARGET, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  for (const [name, dir] of keep) {
    const dst = path.join(nm, name);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(dir, dst, { recursive: true, dereference: true });
  }
  // mac 专属的 swc 是构建期依赖，进 Windows 包纯占 98 MB
  fs.rmSync(path.join(nm, '@next', 'swc-darwin-arm64'), { recursive: true, force: true });
  log(`已补入自定义入口外部依赖 ${keep.size} 个（${[...roots].sort().join(', ')}）`);

  const req = createRequire(path.join(nm, 'index.js'));
  const bad = [];
  for (const sp of [...specs].sort()) {
    const n = sp.startsWith('@') ? sp.split('/').slice(0, 2).join('/') : sp.split('/')[0];
    if (builtins.has(n) || n.startsWith('node:') || n.includes('${')) continue;
    try {
      req.resolve(sp);
    } catch {
      bad.push(sp);
    }
  }
  if (bad.length) fail(`外部依赖仍解析不到：${bad.join(', ')}`);
  log('✅ 自定义入口的每个外部 specifier 均可解析');
}

/**
 * 裁剪 resources/app/node_modules 到「主进程真正 require 到的闭包」。
 *
 * 为什么必须做（2026-10-19 实测）：
 *   electron-builder 会把 package.json 的**全部** production 依赖收进 app 目录，
 *   于是 next / mermaid / echarts / pdfjs / canvas / sharp 这些**服务端**依赖
 *   在 app 里又存了一份（1.0 GB / 32170 个文件），而它们在 next-standalone 里已经有了。
 *   后果不是功能问题，是安装极慢：整包 50706 个文件、49466 个 <100KB 小文件，
 *   NSIS 逐文件写盘 + 杀软逐个扫描 ⇒ 用户感知"装了半天"。
 *
 * 判据是**代码证据**而不是猜：electron/dist/main.js + preload.js 里的 static require
 * 只有 adm-zip 与 electron-updater 两个外部包，其余全是 node 内建。
 *
 * ⚠️ 传递依赖必须从**包自身位置**解析：pnpm 不做扁平提升，fs-extra / semver 这些
 *    只在 `.pnpm/electron-updater@<ver>/node_modules/` 下作为兄弟目录存在。
 *    用项目根的 require 去 resolve 会全部失败（第一次就是这么漏了 8 个包）。
 */
function slimAppNodeModules() {
  const appNm = path.join(RES, 'app', 'node_modules');
  if (!fs.existsSync(appNm)) {
    log('⚠️ 没有 resources/app/node_modules，跳过裁剪');
    return;
  }
  const seeds = ['adm-zip', 'electron-updater'];
  const resolveFrom = (fromDir, name) => {
    for (const base of [fromDir, ROOT].filter(Boolean)) {
      let r;
      try {
        r = createRequire(path.join(base, 'index.js'));
      } catch {
        continue;
      }
      for (const spec of [`${name}/package.json`, name]) {
        try {
          let d = path.dirname(fs.realpathSync(r.resolve(spec)));
          for (let i = 0; i < 8; i += 1) {
            if (fs.existsSync(path.join(d, 'package.json'))) return d;
            if (path.dirname(d) === d) break;
            d = path.dirname(d);
          }
        } catch {
          /* 换候选 */
        }
      }
    }
    return null;
  };

  const keep = new Map();
  const queue = seeds.map((n) => ({ name: n, from: null }));
  const seen = new Set();
  while (queue.length) {
    const { name, from } = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = resolveFrom(from, name);
    if (!dir) {
      log(`⚠️ app 闭包解析不到 ${name}`);
      continue;
    }
    keep.set(name, dir);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(meta.dependencies || {})) queue.push({ name: dep, from: dir });
    for (const dep of Object.keys(meta.optionalDependencies || {})) queue.push({ name: dep, from: dir });
  }

  let removed = 0;
  for (const ent of fs.readdirSync(appNm)) {
    if (ent.startsWith('.') || keep.has(ent)) continue;
    fs.rmSync(path.join(appNm, ent), { recursive: true, force: true });
    removed += 1;
  }
  for (const [name, dir] of keep) {
    const dst = path.join(appNm, name);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(dir, dst, { recursive: true, dereference: true });
  }

  const req = createRequire(path.join(appNm, 'index.js'));
  const bad = seeds.filter((n) => {
    try {
      req.resolve(`${n}/package.json`);
      return false;
    } catch {
      return true;
    }
  });
  if (bad.length) fail(`app 闭包里 ${bad.join(', ')} 不可解析`);
  const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).length;
  log(`app/node_modules 已裁到 ${keep.size} 个包（删掉 ${removed} 个冗余，顶层条目 ${count(appNm)}）`);
}

// ---- 4.5 app-update.yml（自动更新开关）----
// 主进程据此判断「要不要启用更新」以及「去哪里查」：
//   isUpdaterEnabled = fs.existsSync(resources/app-update.yml)
// 少这一份 ⇒ 应用装完能跑，但「检查更新」永远返回 Auto-updater disabled。
// 与 mac 的 scripts/package-release.sh 5c 节、electron-builder.win.yml 的 publish 段保持一致。
const UPDATE_OWNER = process.env.GITCODE_OWNER || 'baolei89';
const UPDATE_REPO = process.env.GITCODE_REPO || 'BobWork';
const appUpdatePath = path.join(RES, 'app-update.yml');
fs.writeFileSync(
  appUpdatePath,
  [
    'provider: generic',
    `url: https://gitcode.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/latest`,
    'channel: latest',
    'updaterCacheDirName: bob-updater',
    '',
  ].join('\n'),
);
log(`已写入 ${path.relative(ROOT, appUpdatePath)}（更新源 GitCode latest 频道）`);

// ---- 5. 自检 ----
const must = [
  'server.js',
  'node_modules/next/package.json',
  'node_modules/react/package.json',
  '.next/server',
  '.next/static/chunks',
  'public',
];
let bad = 0;
for (const rel of must) {
  const p = path.join(TARGET, rel);
  const ok = fs.existsSync(p);
  if (!ok) bad += 1;
  log(`${ok ? '✅' : '❌'} ${rel}`);
}

// 随包 Python（resources/python，与 next-standalone 同级，不在 TARGET 里）
const pyExe = path.join(RES, 'python', 'python.exe');
const pySite = path.join(RES, 'python', 'Lib', 'site-packages');
if (!fs.existsSync(pyExe)) bad += 1;
if (!fs.existsSync(path.join(pySite, 'docx', '__init__.py'))) bad += 1;
if (!fs.existsSync(path.join(pySite, 'PIL', 'Image.py'))) bad += 1;
if (!fs.existsSync(path.join(pySite, 'lxml', 'etree.cp311-win_amd64.pyd'))) bad += 1;
log(`${fs.existsSync(pyExe) ? '✅' : '❌'} ../python/python.exe`);
log(`${fs.existsSync(path.join(pySite, 'docx', '__init__.py')) ? '✅' : '❌'} ../python/Lib/site-packages/docx`);

// 自动更新开关（resources/app-update.yml，与 next-standalone 同级）
const appUpdateOk = fs.existsSync(appUpdatePath);
if (!appUpdateOk) bad += 1;
log(`${appUpdateOk ? '✅' : '❌'} ../app-update.yml`);

// 残留符号链接计数（Windows 上等于坏文件）
let restLinks = 0;
(function count(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) restLinks += 1;
    else if (ent.isDirectory()) count(p);
  }
})(TARGET);
log(restLinks === 0 ? '✅ 无残留符号链接' : `❌ 仍残留 ${restLinks} 个符号链接`);
if (restLinks > 0) bad += 1;

const chunks = fs.readdirSync(path.join(TARGET, '.next', 'static', 'chunks')).length;
log(`static/chunks 条目 ${chunks} 个`);
const text = fs.readFileSync(path.join(TARGET, 'server.js'), 'utf8');
const hasRemote = text.includes('remote-login');
log(`${hasRemote ? '✅' : '❌'} server.js 含 remote-login`);
if (!hasRemote) bad += 1;

log(`next-standalone 体积 ${(execFileSync('du', ['-sh', TARGET]).toString().split('\t')[0])}`);
process.exit(bad === 0 ? 0 : 1);
