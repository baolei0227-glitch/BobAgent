#!/usr/bin/env node
/**
 * scripts/check-platform-bounds.mjs —— 平台边界探针（棘轮式）
 *
 * 规则：`src/` 下**除 `src/lib/platform/**` 外**，不得出现平台嗅探
 *       （`process.platform` / `process.arch` / `os.platform()`）。
 *
 * 为什么必须有这条规则：
 *   Windows 化没有在业务代码里散写 `if (isWin)`，而是把平台差异全部收进
 *   `src/lib/platform/**`，业务代码只调平台层。整个「单仓库同时供 mac / win」的
 *   前提就建立在这一条上 —— 一旦嗅探重新散开，两个平台就会开始互相踩，
 *   而这类踩踏**不会报错**，只会表现为「换一个平台某个功能悄悄消失」。
 *   所以边界不能靠自觉，要靠探针焊住。
 *
 * 棘轮（ratchet）语义 —— 现在这张表**是空的**：
 *   探针引入时曾有 3 个文件存在历史嗅探（secrets / sherpa / bridge），当天即全部迁进
 *   平台层，故 LEGACY 已清空 ⇒ 判据回到「一律零容忍」。
 *   保留这套机制（而不是删掉）是为了**下一次迁移能安全落地**：先登记实测处数，再逐步
 *   收紧，避免「一边改业务代码、一边被探针拦」而被迫把探针关掉。
 *   · 表为空时：任何文件出现嗅探 → 红
 *   · 表非空时：已记录文件**新增**一处（哪怕同一文件）→ 红；记录值没被用满 → 只提示，不红
 *   这样边界从今天起是硬的，历史债只减不增。
 *
 * 用法：`node scripts/check-platform-bounds.mjs`
 * 退出码：0 = 无越界；1 = 有越界（CI: macos-smoke / 本地 pnpm validate）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
/** 唯一允许出现平台嗅探的目录 —— 平台层自己。 */
const PLATFORM_DIR = path.join(SRC, 'lib', 'platform') + path.sep;

/** 平台嗅探的写法。新增写法要同步加到这里，否则探针会漏。 */
const PATTERNS = [
  { label: 'process.platform', re: /process\.platform/g },
  { label: 'process.arch', re: /process\.arch/g },
  { label: 'os.platform()', re: /os\.platform\(\)/g },
];

/**
 * 棘轮豁免表：`相对路径 -> 允许的最大处数`。当前**为空**（见文件头的棘轮说明）。
 */
const LEGACY = new Map([
  // 空表 = 零容忍。2026-10-19 迁移完成：
  //   secrets.ts 4 处 → lib/platform/identity（取值与指纹串契约刻意分家）
  //   sherpa.ts 7 处 → ARCH / IS_DARWIN / PLATFORM
  //   sandbox/bridge.ts 1 处 → PLATFORM
  // 将来若必须临时豁免，在此登记 `['相对路径', 当天实测处数]`，并写清豁免理由与迁移出口。
]);

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'out']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out);
      continue;
    }
    if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** 统计一个文件里的嗅探命中数（同一行出现两种写法算两处）。 */
function scan(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const hits = [];
  for (const { label, re } of PATTERNS) {
    const all = new RegExp(re.source, 'g');
    for (let i = 0; i < lines.length; i += 1) {
      const found = lines[i].match(all);
      for (let n = 0; n < (found ? found.length : 0); n += 1) {
        hits.push({ line: i + 1, label, text: lines[i].trim().slice(0, 110) });
      }
    }
  }
  return hits;
}

function main() {
  const files = walk(SRC);
  const inScope = files.filter((f) => !f.startsWith(PLATFORM_DIR));

  const violations = []; // 越界：新文件 / 记录值增长
  const legacyHits = new Map(); // 已记录文件的实测值
  const tighten = []; // 记录值没被用满

  for (const file of inScope) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const hits = scan(file);
    if (hits.length === 0) continue;

    const allowed = LEGACY.get(rel);
    if (allowed === undefined) {
      violations.push({ rel, actual: hits.length, allowed: 0, hits, kind: '新文件出现平台嗅探' });
      continue;
    }
    legacyHits.set(rel, hits.length);
    if (hits.length > allowed) {
      violations.push({ rel, actual: hits.length, allowed, hits, kind: `已记录文件新增（${allowed} → ${hits.length}）` });
    } else if (hits.length < allowed) {
      tighten.push({ rel, actual: hits.length, allowed });
    }
  }

  // 记录值存在、文件却已无命中（或文件已删）⇒ 记录表可收紧
  for (const [rel, allowed] of LEGACY) {
    if (!legacyHits.has(rel)) tighten.push({ rel, actual: 0, allowed });
  }

  console.log('=== 平台边界探针（棘轮）===');
  console.log(`规则      : src/ 下除 src/lib/platform/** 外不得出现平台嗅探`);
  console.log(`扫描范围  : ${inScope.length} 个 .ts/.tsx（已排除 src/lib/platform/**）`);
  console.log(`识别写法  : ${PATTERNS.map((p) => p.label).join(' / ')}`);
  console.log('');

  if (violations.length > 0) {
    console.log('越界（必须修：改走 src/lib/platform）');
    for (const v of violations) {
      console.log(`  [FAIL] ${v.rel}  ${v.actual} 处（允许 ${v.allowed}）—— ${v.kind}`);
      for (const h of v.hits.slice(0, 6)) console.log(`         L${h.line} ${h.label}: ${h.text}`);
      if (v.hits.length > 6) console.log(`         …另有 ${v.hits.length - 6} 处`);
    }
    console.log('');
  }

  console.log('遗留（棘轮：只减不增）');
  if (LEGACY.size === 0) {
    console.log('  （无 —— 平台嗅探已全部收进 src/lib/platform/**）');
  }
  for (const [rel, allowed] of LEGACY) {
    const actual = legacyHits.get(rel) ?? 0;
    const mark = actual > allowed ? 'FAIL' : 'OK  ';
    console.log(`  [${mark}] ${rel}  ${actual}/${allowed}`);
  }
  console.log('');

  if (tighten.length > 0) {
    console.log('可收紧（非失败：把 LEGACY 里的数字改小，让护栏跟上）');
    for (const t of tighten) console.log(`  ${t.rel}  记录 ${t.allowed} → 实际 ${t.actual}`);
    console.log('');
  }

  console.log('=== 结论 ===');
  if (violations.length === 0) {
    console.log(`无越界。遗留 ${LEGACY.size} 个文件 / 共 ${[...legacyHits.values()].reduce((a, b) => a + b, 0)} 处（已焊住，不再增长）。`);
    return 0;
  }
  console.log(`${violations.length} 处越界 —— 平台分支必须收进 src/lib/platform/**，否则 mac 与 Windows 会互相踩。`);
  return 1;
}

process.exit(main());
