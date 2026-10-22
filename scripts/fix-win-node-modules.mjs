/**
 * 把 next-standalone/node_modules 修成「扁平 + 完整 + 无 .pnpm」。
 *
 * 为什么需要（2026-10-19 Windows 实测，报告 D1/D2/D4）：
 *   1. Next 的 `output: 'standalone'` 用 @vercel/nft 做文件追踪，**只复制追踪到的文件，
 *      从不复制整包**。于是 `which` / `hasown` / `json-schema-traverse` 这类包的目录里
 *      只剩一个 package.json，`zod` 缺 index.cjs / index.js / locales。运行期必崩：
 *        Cannot find module '...\json-schema-traverse\index.js'
 *   2. pnpm 的 `.pnpm/<pkg>@<ver>_<peer-hash>_...` 目录名极长，
 *      解压到 C:\BobWork 后最长路径达 275 字符 > Windows 的 260 上限
 *      ⇒ 资源管理器/360 压缩静默跳过文件 ⇒ node_modules 残缺。
 *   3. 顶层只有 133 个包，`.pnpm` 里另有 27 个没有提升上来，
 *      Node 从顶层 require 时找不到。
 *
 * 做法（三件事，幂等，可重复执行）：
 *   A. **以开发树为准补齐**：对包里每个包实例，若其入口文件在目标缺失、而在
 *      `node_modules/.pnpm/<name>@<ver>/node_modules/<name>` 里存在 ⇒ 用完整副本覆盖。
 *   B. **提升**：`.pnpm` 里有、顶层没有的包，复制到顶层。
 *   C. **删除 `.pnpm`**：长路径、残缺副本、重复体积一并消失。
 *
 * 用法：
 *   node scripts/fix-win-node-modules.mjs [--target <next-standalone 目录>]
 *   默认 target = release/win-unpacked/resources/next-standalone
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const TARGET = path.resolve(
  argOf('--target', path.join(ROOT, 'release', 'win-unpacked', 'resources', 'next-standalone')),
);
const PUBLISH = !process.argv.includes('--dry-run');

const log = (m) => console.log(`[nm] ${m}`);

if (!fs.existsSync(path.join(TARGET, 'node_modules'))) {
  console.error(`[nm] ❌ 找不到 ${path.join(TARGET, 'node_modules')}`);
  process.exit(1);
}
const NM = path.join(TARGET, 'node_modules');

// ---------------- 开发树索引：name -> [{version, dir}] ----------------
const DEV_NM = path.join(ROOT, 'node_modules');
const devIndex = new Map();

function addDev(name, dir) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return;
  }
  if (!meta.version) return;
  if (!devIndex.has(name)) devIndex.set(name, []);
  const arr = devIndex.get(name);
  if (!arr.some((x) => x.version === meta.version && x.dir === dir)) {
    arr.push({ version: meta.version, dir });
  }
}

function indexDir(nmDir) {
  if (!fs.existsSync(nmDir)) return;
  for (const ent of fs.readdirSync(nmDir, { withFileTypes: true })) {
    const p = path.join(nmDir, ent.name);
    if (ent.name.startsWith('@')) {
      if (!fs.existsSync(p)) continue;
      for (const e2 of fs.readdirSync(p)) {
        const q = path.join(p, e2);
        if (fs.existsSync(q)) addDev(`${ent.name}/${e2}`, fs.realpathSync(q));
      }
    } else if (ent.name !== '.pnpm' && ent.name !== '.bin' && !ent.name.startsWith('.')) {
      if (fs.existsSync(p)) addDev(ent.name, fs.realpathSync(p));
    }
  }
}
indexDir(DEV_NM);
// 开发树里 `.pnpm/<hash>/node_modules/<name>` 才是完整副本的真实位置
const devPnpm = path.join(DEV_NM, '.pnpm');
if (fs.existsSync(devPnpm)) {
  for (const d of fs.readdirSync(devPnpm)) {
    indexDir(path.join(devPnpm, d, 'node_modules'));
  }
}
log(`开发树索引：${devIndex.size} 个包名`);

// ---------------- 完整性判据 ----------------
/** 取 package.json 里所有「应该存在」的入口相对路径 */
function entryTargets(meta) {
  const out = new Set();
  if (typeof meta.main === 'string') out.add(meta.main);
  const walk = (v) => {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  const ex = meta.exports;
  if (ex !== undefined) {
    if (typeof ex === 'string' || Array.isArray(ex)) walk(ex);
    else if (ex && typeof ex === 'object') walk(ex['.'] !== undefined ? ex['.'] : ex);
  }
  return [...out]
    .filter((s) => s.startsWith('./'))
    .map((s) => s.slice(2))
    .filter((s) => !s.includes('*'));
}

function metaOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 返回 null 表示完整；否则返回缺失说明。
 *
 * 分两档，避免体积失控：
 *   hard —— 入口文件缺失（no package.json / 只有 package.json / main 或 exports 目标不在）
 *           ⇒ 运行期**必然**报 Cannot find module，必须用完整副本覆盖。
 *   soft —— 文件数明显少于开发树同版本（nft 只留了追踪到的文件）。这本身是 Next 的正常行为，
 *           不修；只在日志里提示，防止「以为补过其实没补」。
 */
function probe(dir, devDir) {
  const meta = metaOf(dir);
  if (!meta) return { hard: 'no package.json', soft: null };
  const files = fs.readdirSync(dir).filter((n) => n !== 'package.json');
  if (files.length === 0) return { hard: 'only package.json', soft: null };
  const devMeta = devDir ? metaOf(devDir) : null;
  const wanted = new Set([...entryTargets(meta), ...(devMeta ? entryTargets(devMeta) : [])]);
  const missing = [];
  for (const rel of wanted) {
    if (fs.existsSync(path.join(dir, rel))) continue;
    // 只报「开发树里确实有」的，避免把可选平台文件当缺失
    if (devDir && !fs.existsSync(path.join(devDir, rel))) continue;
    missing.push(rel);
  }
  if (missing.length) return { hard: `missing ${missing.slice(0, 3).join(', ')}`, soft: null };
  if (devDir) {
    const count = (d) => fs.readdirSync(d).length;
    if (count(dir) * 3 < count(devDir) && count(devDir) < 400) {
      return { hard: null, soft: `truncated (${count(dir)}/${count(devDir)} files)` };
    }
  }
  return { hard: null, soft: null };
}

// ---------------- 扫描包内所有包实例 ----------------
/** @returns {Map<string, Map<string, string>>} name -> version -> [dirs...] */
const inst = new Map();
function noteInstance(name, dir) {
  const meta = metaOf(dir);
  if (!meta || !meta.version) return;
  if (!inst.has(name)) inst.set(name, new Map());
  const byVer = inst.get(name);
  if (!byVer.has(meta.version)) byVer.set(meta.version, []);
  byVer.get(meta.version).push(dir);
}

function scanNm(nmDir) {
  for (const ent of fs.readdirSync(nmDir, { withFileTypes: true })) {
    const p = path.join(nmDir, ent.name);
    if (ent.name === '.pnpm' || ent.name === '.bin') continue;
    if (ent.name.startsWith('@')) {
      if (!fs.existsSync(p)) continue;
      for (const e2 of fs.readdirSync(p)) {
        const q = path.join(p, e2);
        if (fs.existsSync(q)) noteInstance(`${ent.name}/${e2}`, q);
      }
    } else if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      noteInstance(ent.name, p);
    }
  }
}
scanNm(NM);

const pnpmDir = path.join(NM, '.pnpm');
const pnpmDirs = fs.existsSync(pnpmDir) ? fs.readdirSync(pnpmDir) : [];
for (const d of pnpmDirs) {
  const nm = path.join(pnpmDir, d, 'node_modules');
  if (fs.existsSync(nm)) scanNm(nm);
}
log(`包内包实例：${[...inst.values()].reduce((a, b) => a + b.size, 0)} 个版本，${inst.size} 个包名`);

// ---------------- A. 用开发树完整副本补齐残缺 ----------------
const topNames = new Set(
  fs.readdirSync(NM, { withFileTypes: true }).flatMap((ent) => {
    if (ent.name === '.pnpm' || ent.name === '.bin') return [];
    if (ent.name.startsWith('@')) {
      const p = path.join(NM, ent.name);
      return fs.existsSync(p) ? fs.readdirSync(p).map((x) => `${ent.name}/${x}`) : [];
    }
    return [ent.name];
  }),
);

let repaired = 0;
let softCount = 0;
const unrepaired = [];
const dirSize = (d) => {
  let n = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else if (e.isFile()) n += fs.statSync(q).size;
    }
  };
  try {
    walk(d);
  } catch {
    /* 读不到大小不影响主流程 */
  }
  return n;
};
let addedBytes = 0;
for (const [name, byVer] of inst) {
  for (const [version, dirs] of byVer) {
    const dev = (devIndex.get(name) || []).find((x) => x.version === version);
    for (const dir of dirs) {
      const { hard, soft } = probe(dir, dev ? dev.dir : null);
      if (!hard) {
        if (soft) softCount += 1;
        continue;
      }
      if (!dev) {
        unrepaired.push(`${name}@${version} (${hard}) — 开发树无同版本副本`);
        continue;
      }
      if (!PUBLISH) {
        repaired += 1;
        continue;
      }
      const before = dirSize(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.cpSync(dev.dir, dir, { recursive: true, dereference: true });
      addedBytes += Math.max(0, dirSize(dir) - before);
      repaired += 1;
      log(`  补齐 ${name}@${version}：${hard}`);
    }
  }
}
log(
  `A 补齐残缺包实例 ${repaired} 个（净增 ${(addedBytes / 1048576).toFixed(1)} MB），` +
    `另有 ${softCount} 个仅「文件数偏少」未处理${unrepaired.length ? `，无法补 ${unrepaired.length} 个` : ''}`,
);
for (const u of unrepaired.slice(0, 10)) log(`  ⚠️ ${u}`);

// ---------------- B. 提升到顶层 ----------------
let hoisted = 0;
for (const [name, byVer] of inst) {
  if (topNames.has(name)) continue;
  // 多个版本时优先取「开发树里也存在的那个」
  const candidates = [...byVer.entries()];
  const pick =
    candidates.find(([v]) => (devIndex.get(name) || []).some((x) => x.version === v)) || candidates[0];
  const src = pick[1][0];
  const dst = path.join(NM, name);
  if (PUBLISH) {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, dereference: true });
  }
  topNames.add(name);
  hoisted += 1;
}
log(`B 提升到顶层 ${hoisted} 个`);

// ---------------- D. 原生模块：把目标平台的 .node 补进 Next 的追踪副本 ----------------
/**
 * Next 的 nft 会把原生模块的 prebuilds 按**构建机平台**复制。
 * 实测 `.next/node_modules/better-sqlite3-857f4bd.../prebuilds/` 里只有
 * `darwin-arm64.node`，Windows 上必然回落到不存在的 `build/Release/` ⇒
 * `[butler/threads] 读取历史会话失败（跳过迁移）`。
 *
 * 做法：给 `.next/node_modules/<name>-<hash>/` 这类追踪目录，
 * 从顶层同名包的 `prebuilds/` 里补 `win32-x64.node`。
 *
 * ⚠️ 只补不删。曾经顺手删掉 darwin 那份想省 1.5 MB，结果**在 mac 上做冒烟测试时
 *    better-sqlite3 反而加载失败**（binding.js 走 prebuilds 找不到就回退 build/Release，
 *    那里也没有 ⇒ MODULE_NOT_FOUND）。1.5 MB 不值得牺牲「能在开发机验证」。
 */
const TARGET_PLATFORM = argOf('--platform', 'win32');
const TARGET_ARCH = argOf('--arch', 'x64');
let nativesFixed = 0;
const nextNm = path.join(TARGET, '.next', 'node_modules');
const HASH_SUFFIX = /-[0-9a-f]{16}$/;
function fixTracedDir(dir) {
  const base = path.basename(dir).replace(HASH_SUFFIX, '');
  const parent = path.dirname(dir);
  // 作用域包：.next/node_modules/@scope/name-<hash> → 顶层是 @scope/name
  const parentBase = path.basename(parent);
  const pname = parentBase.startsWith('@') ? `${parentBase}/${base}` : base;
  const topDir = path.join(NM, pname);
  if (!fs.existsSync(topDir)) return;
  const srcPre = path.join(topDir, 'prebuilds');
  if (fs.existsSync(srcPre)) {
    const dstPre = path.join(dir, 'prebuilds');
    if (PUBLISH) fs.mkdirSync(dstPre, { recursive: true });
    for (const f of fs.readdirSync(srcPre)) {
      if (!f.endsWith('.node')) continue;
      const dst = path.join(dstPre, f);
      if (fs.existsSync(dst)) continue;
      if (PUBLISH) fs.copyFileSync(path.join(srcPre, f), dst);
      if (f === `${TARGET_PLATFORM}-${TARGET_ARCH}.node`) nativesFixed += 1;
    }
  }
  // 有些包把 .node 放在 build/Release/
  const srcRel = path.join(topDir, 'build', 'Release');
  if (fs.existsSync(srcRel)) {
    const dstRel = path.join(dir, 'build', 'Release');
    if (PUBLISH) fs.mkdirSync(dstRel, { recursive: true });
    for (const f of fs.readdirSync(srcRel)) {
      if (f.endsWith('.node') && PUBLISH) fs.copyFileSync(path.join(srcRel, f), path.join(dstRel, f));
    }
  }
}
if (fs.existsSync(nextNm)) {
  for (const ent of fs.readdirSync(nextNm, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('@')) {
      for (const e2 of fs.readdirSync(path.join(nextNm, ent.name))) {
        const q = path.join(nextNm, ent.name, e2);
        if (fs.existsSync(q) && fs.statSync(q).isDirectory()) fixTracedDir(q);
      }
    } else {
      fixTracedDir(path.join(nextNm, ent.name));
    }
  }
}
log(`D 原生模块：为 .next 追踪副本补 ${TARGET_PLATFORM}-${TARGET_ARCH}.node 共 ${nativesFixed} 个`);

// ---------------- E. 工作区 MCP 包：补 dist + 补 external 依赖 ----------------
/**
 * Next 的追踪把 monorepo 根下 `bob-*-mcp` 目录带进了包，但**只带目录、没带 dist**
 * （Next 构建时 nft 只认 JS 引用，不认 `spawn` 出来的子进程入口）。
 * 结果是运行期 `Cannot find module '.../bob-team-mcp/dist/cli.js'`，四个 MCP 服务全挂。
 *
 * ⚠️ 2026-10-19 补记（仓库外实测才暴露，见记忆「包内依赖验证必须把包拷到仓库外」）：
 *   只补 dist 不够。`bob-ocr-mcp/scripts/build.mjs:12` 把 `pdf-parse` / `openai` /
 *   `@modelcontextprotocol/sdk` 标成 esbuild external，运行期要从 node_modules 解析；
 *   `bob-preview-mcp` 更糟——它代码里 `import '@hono/node-server'`，但 package.json
 *   **根本没声明**这个依赖，纯粹靠 pnpm 本地提升偶然可用。
 *   在仓库外跑 `node bob-ocr-mcp/dist/cli.js --help` 直接：
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'openai' imported from .../bob-ocr-mcp/dist/cli.js
 *     Error: Cannot find module '@hono/node-server'
 *   ⇒ Windows 上 OCR 插件与预览插件必然起不来（白屏之外的第二类「静默失能」）。
 *
 * 做法：扫 dist/cli.js 里的裸模块引用（esbuild 保留 external 为字面量 import），
 * 用 Node 自己的解析规则从开发树里定位真实目录，递归补齐 dependencies / optionalDependencies，
 * 落到**顶层** node_modules（MCP 从 `bob-x-mcp/dist/` 向上两级即命中，且与宿主共享体积）。
 * 顶层已有的包跳过——不覆盖宿主版本（如 @modelcontextprotocol/sdk）。
 */
const MONOREPO = path.dirname(ROOT);
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** 该目录是否真是 `spec` 这个包的根（必须是带 name 的 package.json，不能是 dist/cjs 里那种） */
function isPkgRoot(dir, spec) {
  const pj = path.join(dir, 'package.json');
  if (!fs.existsSync(pj) || !fs.statSync(pj).isFile()) return false;
  try {
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    return typeof j.name === 'string' && j.name === spec;
  } catch {
    return false;
  }
}

/** 从任意文件出发做 Node 式解析，返回包根目录（含 package.json 的那一层） */
function resolvePkgRoot(spec, fromFile) {
  if (BUILTINS.has(spec)) return null;
  // ① 先走 Node 解析（能正确处理 exports / 条件导出）
  try {
    const req = createRequire(fromFile);
    const p = req.resolve(spec);
    // 内置模块会原样返回 'fs' 而非绝对路径；此时 dirname 退化成 '.'，
    // 会把 cwd 的 package.json 当成该「包」，进而把整个项目依赖递归一遍（实测踩到）。
    if (path.isAbsolute(p)) {
      let d = path.dirname(p);
      for (let i = 0; i < 12; i += 1) {
        // ⚠️ 不能用「第一个含 package.json 的目录」：hono/dist/cjs/package.json 是
        //    `{"type":"commonjs"}`（无 name），会把 dist/cjs 当成包根，进而把该子目录
        //    整个复制成 node_modules/hono（实测把 hono 弄成 189 文件的假包）。
        if (isPkgRoot(d, spec)) return d;
        const up = path.dirname(d);
        if (up === d) break;
        d = up;
      }
    }
  } catch {
    /* 交给下面的退路 */
  }
  // ② 退路：沿 node_modules 链直接找包目录。
  //    有些包的 exports **不暴露 "."**，`require.resolve('<包名>')` 必然抛
  //    ERR_PACKAGE_PATH_NOT_EXPORTED —— `@modelcontextprotocol/sdk` 就是，
  //    结果整条依赖链（含 @hono/node-server）被静默丢弃，运行期才炸。
  let d = path.dirname(path.resolve(fromFile));
  for (let i = 0; i < 12; i += 1) {
    const cand = path.join(d, 'node_modules', spec);
    if (isPkgRoot(cand, spec)) return fs.realpathSync(cand);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  // ③ 最后退路：直接扫 pnpm 虚拟存储 `node_modules/.pnpm/<name>@<ver>/node_modules/<name>`。
  //    根 node_modules 只暴露**直接依赖**，`long` / `formdata-node` 这类传递依赖
  //    在别处都找不到，但 pnpm store 里一定有（scoped 包名转义成 @scope+pkg@ver）。
  const store = path.join(ROOT, 'node_modules', '.pnpm');
  if (fs.existsSync(store)) {
    const prefix = spec.startsWith('@') ? `${spec.replace('/', '+')}@` : `${spec}@`;
    for (const ent of fs.readdirSync(store)) {
      if (!ent.startsWith(prefix)) continue;
      const cand = path.join(store, ent, 'node_modules', spec);
      if (isPkgRoot(cand, spec)) return fs.realpathSync(cand);
    }
  }
  return null;
}

/**
 * dist/cli.js 头部出现的裸包名。
 *
 * ⚠️ 不能用「扫全文件 + 宽松正则」：这些 dist 里内联了整个前端 bundle，
 * 字符串里充满 `from "react-markdown"` 之类的噪声，宽松正则还会跨行吃到
 * `) ?? void 0,\n to: url.searchParams.get(` 这种垃圾（实测）。
 * 收紧三处：① 扫全文（external import 分散在各自模块顶部，不在文件头）；
 * ② `from` / `require` 前必须是分隔符，排除 `foo.from("x")`；
 * ③ 包名必须合法，且**能在开发树解析到**才算（解析不到的一律当噪声丢弃）。
 */
const PKG_NAME_RE = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;
function scanBareImports(file) {
  // 必须扫全文：bob-ocr-mcp/dist/cli.js 310 KB，`openai` 的 import 在第 100 KB 之后
  // （esbuild 按模块顺序拼接，external import 落在各自模块的顶部而非文件顶部）。
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  const pats = [
    /(?:^|[\s;{}])(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|[\s;{}])from\s+['"]([^'"]+)['"]/g,
    // esbuild 在 ESM 输出里会把 require 重命名成 require2 / __require，
    // 只写 `require\(` 会漏掉 `require2("pdf-parse")`（实测踩到）。
    // 关键词前后都要允许标识符字符，否则 `require2(` 回溯后剩 `2(` 匹配不上。
    /(?:^|[\s;{}])[A-Za-z0-9_$]*(?:import|require)[A-Za-z0-9_$]*\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of pats) {
    let m = re.exec(src);
    while (m) {
      const s = m[1];
      if (s && !/^(\.|\/|node:|data:|file:|#)/.test(s)) {
        const seg = s.split('/');
        const name = s.startsWith('@') ? seg.slice(0, 2).join('/') : seg[0];
        if (PKG_NAME_RE.test(name) && resolvePkgRoot(name, file)) out.add(name);
      }
      m = re.exec(src);
    }
  }
  return out;
}

const mcpMissing = new Map(); // 包名 → 被哪个 MCP 需要
const mcpCopied = new Set();
function ensureDepClosure(name, fromFile, neededBy) {
  if (mcpCopied.has(name) || BUILTINS.has(name)) return;
  // 纯类型包（openai v4 把 @types/* 写进了 dependencies）运行期不需要，缺失不算问题
  if (name.startsWith('@types/')) {
    mcpCopied.add(name);
    return;
  }

  const inBundlePj = path.join(NM, name, 'package.json');
  const inBundle = fs.existsSync(inBundlePj);
  // 依赖来源优先开发树：包内的 package.json 可能被 Next 规范化成 `{"type":"commonjs"}`，
  // 根本读不到 dependencies（`@modelcontextprotocol/sdk` 实测如此 ⇒ 漏掉 @hono/node-server）。
  const devDir = resolvePkgRoot(name, fromFile);
  const srcDir = devDir || (inBundle ? path.join(NM, name) : null);
  if (!srcDir) {
    if (!mcpMissing.has(name)) mcpMissing.set(name, neededBy);
    return;
  }
  mcpCopied.add(name);

  // 顶层已存在 ⇒ 不覆盖宿主版本，但**仍要递归它的依赖**（这次的坑就在这）
  if (!inBundle && PUBLISH) {
    const dst = path.join(NM, name);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // dereference：pnpm 的包目录是符号链接，不跟随后拷进去就是断链
    fs.cpSync(srcDir, dst, { recursive: true, dereference: true });
  }

  let pj = {};
  for (const p of [path.join(srcDir, 'package.json'), inBundlePj]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.dependencies || j.optionalDependencies) {
        pj = j;
        break;
      }
    } catch {
      /* 读不到就看下一个来源 */
    }
  }
  const deps = { ...(pj.dependencies || {}), ...(pj.optionalDependencies || {}) };
  for (const dep of Object.keys(deps)) {
    ensureDepClosure(dep, path.join(srcDir, 'package.json'), `${neededBy}→${name}`);
  }
}

let mcpFixed = 0;
const mcpNames = [];
for (const name of fs.readdirSync(MONOREPO)) {
  if (!/^bob-.*-mcp$/.test(name)) continue;
  const srcPkg = path.join(MONOREPO, name);
  if (!fs.statSync(srcPkg).isDirectory()) continue;
  const srcCli = path.join(srcPkg, 'dist', 'cli.js');
  if (!fs.existsSync(srcCli)) {
    log(`⚠️ E ${name}：monorepo 里没有 dist/cli.js（未构建），跳过`);
    continue;
  }
  mcpNames.push(name);
  const dstPkg = path.join(TARGET, name);
  const dstCli = path.join(dstPkg, 'dist', 'cli.js');
  // dist 本体：幂等（已补过就跳过）
  if (!fs.existsSync(dstCli)) {
    if (PUBLISH) {
      fs.rmSync(dstPkg, { recursive: true, force: true });
      fs.mkdirSync(dstPkg, { recursive: true });
      fs.cpSync(path.join(srcPkg, 'dist'), path.join(dstPkg, 'dist'), {
        recursive: true,
        dereference: true,
      });
      for (const f of ['package.json', 'README.md']) {
        const s = path.join(srcPkg, f);
        if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dstPkg, f));
      }
    }
    mcpFixed += 1;
  }
  // external 依赖闭包：每次都要算（新依赖可能后加）
  for (const dep of scanBareImports(srcCli)) ensureDepClosure(dep, srcCli, name);
}
log(`E 工作区 MCP 包补 dist ${mcpFixed} 个，external 依赖补齐 ${mcpCopied.size} 个`);
if (mcpCopied.size) log(`   已具备：${[...mcpCopied].sort().join(', ')}`);
if (mcpMissing.size) {
  log(`⚠️ E 未能定位的依赖 ${mcpMissing.size} 个：`);
  for (const [k, v] of mcpMissing) log(`     ${k}  (需要方 ${v})`);
}

// ---------------- G. 修复「子目录被当成包根」的污染包 ----------------
/**
 * 现象：`node_modules/<pkg>/package.json` 只有 `{"type":"commonjs"}`（21~25 字节、无 name），
 * 目录内容其实是该包的 `dist/cjs` 之类子目录。
 * 后果：包的 exports/main 全丢，子路径解析（如 `hono/ws`）必然失败；
 *       更阴险的是「真包根」与「子目录」看起来都是合法 JS，运行时才 `Cannot find module`。
 * 判据：package.json 的 name 必须等于包名本身。
 */
let pollutedFound = 0;
let pollutedFixed = 0;
for (const ent of fs.readdirSync(NM, { withFileTypes: true })) {
  if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
  const names = ent.name.startsWith('@')
    ? (() => {
        try {
          return fs
            .readdirSync(path.join(NM, ent.name), { withFileTypes: true })
            .filter((x) => x.isDirectory())
            .map((x) => `${ent.name}/${x.name}`);
        } catch {
          return [];
        }
      })()
    : [ent.name];
  for (const name of names) {
    const dir = path.join(NM, name);
    const pj = path.join(dir, 'package.json');
    if (!fs.existsSync(pj)) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    } catch {
      continue;
    }
    if (j.name === name) continue;
    pollutedFound += 1;
    let devDir = null;
    for (const n of mcpNames) {
      devDir = resolvePkgRoot(name, path.join(MONOREPO, n, 'dist', 'cli.js'));
      if (devDir) break;
    }
    if (!devDir) devDir = resolvePkgRoot(name, path.join(MONOREPO, 'package.json'));
    if (!devDir) {
      log(`⚠️ G ${name} 被污染（package.json 无 name），开发树定位不到`);
      continue;
    }
    if (PUBLISH) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.cpSync(devDir, dir, { recursive: true, dereference: true });
    }
    pollutedFixed += 1;
  }
}
log(`G 污染包（package.json 无 name）：发现 ${pollutedFound} 个，修复 ${pollutedFixed} 个`);

// ---------------- F. 行为级自检：MCP 子进程真能起来吗 ----------------
/**
 * 为什么静态分析不够（2026-10-19 实测）：
 *   nft 是**文件级**追踪，包里很多包只复制了「被宿主用到的那几个文件」。
 *   - `hono`：开发树 550 文件，包里只有 189 → 缺 `dist/cjs/helper/websocket/`
 *     ⇒ `Cannot find module 'hono/ws'`（SDK 的 streamableHttp 用 HTTP 模式时会走到）
 *   - `formdata-node`：package.json 被 Next 规范化成 `{}`，**读不到 dependencies**
 *     ⇒ 永远不知道它还要 `web-streams-polyfill`
 *   这两类都修不了「按声明递归」，只有真跑一遍才知道。
 *
 * 做法：在**仓库外**（否则 Node 会向上找到 projects/node_modules 假通过）用硬链接
 * 建一份 node_modules 镜像，逐个 spawn `<mcp>/dist/cli.js --help`，从报错里
 * 提取缺失模块名，回开发树整包覆盖，最多迭代 10 轮。
 */
function linkTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    fs.cpSync(src, dst, { recursive: true, dereference: true });
  } else if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src)) linkTree(path.join(src, e), path.join(dst, e));
  } else {
    try {
      fs.linkSync(src, dst);
    } catch {
      fs.copyFileSync(src, dst);
    }
  }
}

let mcpProbeBad = [];
if (PUBLISH && mcpNames.length) {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-mcp-probe-'));
  try {
    linkTree(NM, path.join(probe, 'node_modules'));
    for (const n of mcpNames) {
      const s = path.join(TARGET, n);
      if (fs.existsSync(s)) linkTree(s, path.join(probe, n));
    }

    let probeFixed = 0;
    for (let round = 0; round < 10; round += 1) {
      let changed = false;
      for (const n of mcpNames) {
        const cli = path.join(probe, n, 'dist', 'cli.js');
        if (!fs.existsSync(cli)) continue;
        const r = spawnSync(process.execPath, [cli, '--help'], {
          cwd: probe,
          timeout: 8000,
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: '' },
        });
        // MCP 是 stdio server，--help 后可能等 stdin ⇒ 超时也算起来了
        if (r.status === 0 || (r.error && r.error.code === 'ETIMEDOUT')) continue;
        const txt = `${r.stderr || ''}${r.stdout || ''}`;
        const m = txt.match(/Cannot find (?:module|package) '([^']+)'/);
        if (!m) {
          // 非「缺模块」类错误：可能是真 bug，但也可能是本轮还没轮到的中间态 ⇒ 先不判负
          continue;
        }
        const raw = m[1];
        const spec = raw.startsWith('@') ? raw.split('/').slice(0, 2).join('/') : raw.split('/')[0];
        const devDir = resolvePkgRoot(spec, path.join(MONOREPO, n, 'dist', 'cli.js'));
        if (!devDir) {
          log(`⚠️ F ${n} 缺 ${spec}，开发树也定位不到`);
          continue;
        }
        // 用开发树完整副本覆盖两处（TARGET 是真产物，probe 是下一轮要用的镜像）
        for (const dest of [path.join(NM, spec), path.join(probe, 'node_modules', spec)]) {
          fs.rmSync(dest, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.cpSync(devDir, dest, { recursive: true, dereference: true });
        }
        log(`F 补齐 ${spec}（${n} 实测报告缺失）`);
        probeFixed += 1;
        changed = true;
      }
      if (!changed) break;
    }
    // 终判：迭代稳定后再跑一遍，仍然起不来的才记异常
    for (const n of mcpNames) {
      const cli = path.join(probe, n, 'dist', 'cli.js');
      if (!fs.existsSync(cli)) continue;
      const r = spawnSync(process.execPath, [cli, '--help'], {
        cwd: probe,
        timeout: 8000,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      if (r.status === 0 || (r.error && r.error.code === 'ETIMEDOUT')) continue;
      mcpProbeBad.push(n);
    }
    log(`F 行为自检：${mcpNames.length} 个 MCP，补包 ${probeFixed} 个，异常 ${mcpProbeBad.length} 个`);
    for (const n of mcpProbeBad) log(`⚠️ F ${n} 仍无法启动`);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

// ---------------- C. 删除 .pnpm ----------------
if (fs.existsSync(pnpmDir)) {
  const before = fs.readdirSync(pnpmDir).length;
  if (PUBLISH) fs.rmSync(pnpmDir, { recursive: true, force: true });
  log(`C 删除 .pnpm（${before} 个子目录）`);
}

// ---------------- 断言 ----------------
let bad = 0;
const stillBroken = [];
for (const name of topNames) {
  const dir = path.join(NM, name);
  if (!fs.existsSync(dir)) {
    stillBroken.push(`${name} → 目录不存在`);
    continue;
  }
  const meta = metaOf(dir);
  if (!meta) {
    stillBroken.push(`${name} → 无 package.json`);
    continue;
  }
  const dev = (devIndex.get(name) || []).find((x) => x.version === meta.version);
  const { hard } = probe(dir, dev ? dev.dir : null);
  if (hard) stillBroken.push(`${name}@${meta.version} → ${hard}`);
}
if (stillBroken.length) {
  bad += 1;
  log(`❌ 顶层仍有 ${stillBroken.length} 个包不完整：`);
  for (const s of stillBroken.slice(0, 25)) log(`   ${s}`);
} else {
  log(`✅ 顶层 ${topNames.size} 个包入口均完整`);
}

// 最长路径（相对 TARGET，Windows 解压后 = 解压目录 + 1 + 该长度）
let maxLen = 0;
let maxPath = '';
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    const rel = path.relative(TARGET, p).split(path.sep).join('/');
    if (rel.length > maxLen) {
      maxLen = rel.length;
      maxPath = rel;
    }
    if (ent.isDirectory()) walk(p);
  }
})(TARGET);
log(`最长相对路径 ${maxLen} 字符 → 解压到 C:\\BobWork 后约 ${maxLen + 10} 字符 ${maxLen + 10 < 240 ? '✅' : '❌'}`);
log(`   ${maxPath}`);
if (maxLen + 10 >= 240) bad += 1;

log(`node_modules 顶层包数 ${topNames.size}`);
process.exit(bad === 0 ? 0 : 1);
