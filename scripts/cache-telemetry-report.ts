/**
 * 前缀缓存 per-call 遥测报告：把 `.logs/cache-telemetry.jsonl` 变成三个能直接决策的数
 *
 * 回答的问题（与《BobWork缓存优化交付说明_20261002.md》§7 一一对应）：
 *   Q1 **漂移占 miss 多少**：toolsChanged / historyRewritten / lastTurnRewritten 各自带走了多少
 *      miss token（并用"同上下文规模分档"的基线做对照，避免把"长上下文天然 miss 多"算成漂移）；
 *   Q2 **首调成本占比**：每个任务 callIdx=1 的 miss 占该任务 miss 多少（冷启动还能不能压）；
 *   Q3 **historyRewritten 是否集中在带 @引用的轮次**：按 lastUserRefBlocks 分组对比
 *      —— 这是「P1-A 当前轮 user 块未被持久化、每轮重放丢块」值不值得修的关键判据。
 *
 * 用法：
 *   pnpm tsx scripts/cache-telemetry-report.ts
 *   pnpm tsx scripts/cache-telemetry-report.ts --home ~/BobWork-Dev      # 指向别的数据根
 *   pnpm tsx scripts/cache-telemetry-report.ts --input 2.0 --hit 0.04    # 单价（CNY / 1M tokens）
 *
 * 数据来源：应用运行时会写 `<appRoot>/.logs/cache-telemetry.jsonl`（8MB 滚动一代 .1）。
 * 若文件不存在 → 说明还没跑过带遥测的版本（改的是服务端代码，需重启应用）。
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveAppRoot } from '../src/lib/app-root';

interface CallRec {
  t: string;
  taskId: string;
  nodeId?: string;
  agent?: string;
  model?: string;
  callIdx: number;
  systemHash: string;
  toolsHash: string;
  toolsBytes: number;
  toolCount: number;
  toolsChanged: boolean;
  historyHash: string;
  historyCount: number;
  historyRewritten: boolean;
  lastTurnRewritten: boolean;
  lastUserRefBlocks: boolean;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cumPromptTokens: number;
  cumCacheHitTokens: number;
  cumCacheMissTokens: number;
  payloadChars: number;
  messageCount: number;
}

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argOf('home')) process.env.BOBWORK_HOME = argOf('home');
const MISS_PRICE = Number(argOf('input') ?? 2.0); // CNY / 1M（deepseek-flash 高峰价）
const HIT_PRICE = Number(argOf('hit') ?? 0.04);

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const k = (n: number): string => `${(n / 1000).toFixed(1)}k`;
const pct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const cny = (tokens: number): string => `¥${((tokens * MISS_PRICE) / 1e6).toFixed(2)}`;

function loadRecords(): CallRec[] {
  const logsDir = join(resolveAppRoot(), '.logs');
  const files = [join(logsDir, 'cache-telemetry.jsonl.1'), join(logsDir, 'cache-telemetry.jsonl')].filter((f) =>
    existsSync(f),
  );
  if (files.length === 0) {
    console.error(
      `\n找不到遥测文件：${join(logsDir, 'cache-telemetry.jsonl')}\n` +
        `→ 需要先跑过带 per-call 遥测的版本（2026-10-02 之后），且**重启过应用**（改的是服务端代码）。\n` +
        `  想指向别的数据根：--home <path>\n`,
    );
    process.exit(1);
  }
  const out: CallRec[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s) as CallRec);
      } catch {
        // 半行（进程被杀）→ 跳过
      }
    }
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}

/** 拖尾一行说明的漂移分类（优先级：工具段 > 历史改写 > 上轮输入改写 > 纯新增） */
function driftClass(r: CallRec): 'tools' | 'history' | 'lastTurn' | 'none' {
  if (r.toolsChanged) return 'tools';
  if (r.historyRewritten) return 'history';
  if (r.lastTurnRewritten) return 'lastTurn';
  return 'none';
}

/** 上下文规模分档（用 payloadChars，发送体字符数；约 chars/2.5 ≈ tokens） */
function sizeBucket(chars: number): string {
  if (chars < 30_000) return '<12k tok';
  if (chars < 75_000) return '12-30k tok';
  if (chars < 150_000) return '30-60k tok';
  if (chars < 300_000) return '60-120k tok';
  return '>120k tok';
}

function main(): void {
  const all = loadRecords();
  if (all.length === 0) {
    console.error('遥测文件为空（可能刚重启还没跑过对话）。');
    process.exit(1);
  }
  const byTask = new Map<string, CallRec[]>();
  for (const r of all) {
    const list = byTask.get(r.taskId);
    if (list) list.push(r);
    else byTask.set(r.taskId, [r]);
  }

  const sum = (rows: CallRec[], pick: (r: CallRec) => number): number => rows.reduce((s, r) => s + pick(r), 0);
  const hit = (rows: CallRec[]): number => sum(rows, (r) => r.cacheHitTokens);
  const miss = (rows: CallRec[]): number => sum(rows, (r) => r.cacheMissTokens);

  // ==================== 1. 总览 ====================
  const totalHit = hit(all);
  const totalMiss = miss(all);
  console.log('\n================ 1. 总览 ================');
  console.log(`时间范围   ${all[0].t.slice(0, 16)} → ${all[all.length - 1].t.slice(0, 16)}`);
  console.log(`调用 / 任务   ${all.length} / ${byTask.size}`);
  console.log(
    `输入 tokens   ${k(totalHit + totalMiss)}   命中 ${k(totalHit)} (${pct(totalHit, totalHit + totalMiss)})   未命中 ${k(totalMiss)}`,
  );
  console.log(
    `输入成本      命中 ¥${((totalHit * HIT_PRICE) / 1e6).toFixed(2)} + 未命中 ${cny(totalMiss)} = ¥${(
      (totalHit * HIT_PRICE + totalMiss * MISS_PRICE) /
      1e6
    ).toFixed(2)}（按 --input/--hit 单价）`,
  );
  console.log(`输出 tokens   ${k(sum(all, (r) => r.completionTokens))}`);

  // ==================== 2. Q1 漂移归因 ====================
  console.log('\n================ 2. Q1 漂移占 miss 多少 ================');
  const classes: Array<{ key: ReturnType<typeof driftClass>; label: string }> = [
    { key: 'tools', label: '工具段本轮变化（toolsChanged）' },
    { key: 'history', label: '历史被改写/变短（historyRewritten）' },
    { key: 'lastTurn', label: '上轮输入被改写（lastTurnRewritten）' },
    { key: 'none', label: '无漂移标记（≈纯新增内容）' },
  ];
  console.log('按优先级归因（互斥口径，每个调用只归一类）：');
  for (const c of classes) {
    const rows = all.filter((r) => driftClass(r) === c.key);
    if (rows.length === 0) continue;
    const m = miss(rows);
    console.log(
      `  ${c.label.padEnd(34)} 调用 ${String(rows.length).padStart(4)}  miss ${k(m).padStart(9)}  ` +
        `占 miss ${pct(m, totalMiss).padStart(6)}  ≈ ${cny(m)}`,
    );
  }
  console.log('\n各标记单独命中量（可重叠，用于看单项影响上限）：');
  for (const [label, pick] of [
    ['toolsChanged', (r: CallRec) => r.toolsChanged],
    ['historyRewritten', (r: CallRec) => r.historyRewritten],
    ['lastTurnRewritten', (r: CallRec) => r.lastTurnRewritten],
    ['@引用块轮次（lastUserRefBlocks）', (r: CallRec) => r.lastUserRefBlocks],
  ] as Array<[string, (r: CallRec) => boolean]>) {
    const rows = all.filter(pick);
    console.log(`  ${label.padEnd(34)} 调用 ${String(rows.length).padStart(4)}  miss ${k(miss(rows)).padStart(9)}  ≈ ${cny(miss(rows))}`);
  }

  // 同上下文规模分档对照：漂移调用 vs 无漂移调用的 miss 率
  console.log('\n同上下文规模分档对照（miss 占该次 prompt 的比例，越低越好）：');
  const buckets = [...new Set(all.map((r) => sizeBucket(r.payloadChars)))];
  for (const b of buckets) {
    const rows = all.filter((r) => sizeBucket(r.payloadChars) === b);
    const clean = rows.filter((r) => driftClass(r) === 'none');
    const dirty = rows.filter((r) => driftClass(r) !== 'none');
    const rate = (g: CallRec[]): string => pct(miss(g), hit(g) + miss(g));
    console.log(
      `  ${b.padEnd(12)} n=${String(rows.length).padStart(4)}  无漂移 ${rate(clean).padStart(6)}` +
        (dirty.length > 0 ? `   有漂移 ${rate(dirty).padStart(6)} (n=${dirty.length})` : ''),
    );
  }

  // 分标记 × 分档：区分"哪些标记真的贵"。同一档位内横向比较才有意义——
  // 整体看 historyRewritten 的 miss/call 可能比首调还低，但同档位一比就是 2 倍。
  console.log('\n分标记 × 同规模档位（同档位内横向比，才看得出哪个标记真的在烧钱）：');
  const flagDefs: Array<[string, (r: CallRec) => boolean]> = [
    ['toolsChanged', (r) => r.toolsChanged],
    ['historyRewritten', (r) => r.historyRewritten],
    ['lastTurnRewritten', (r) => r.lastTurnRewritten],
  ];
  console.log(`  ${'档位'.padEnd(12)} ${'无任何标记'.padStart(16)} ${flagDefs.map(([n]) => n.padStart(18)).join(' ')}`);
  for (const b of buckets) {
    const rows = all.filter((r) => sizeBucket(r.payloadChars) === b);
    const cell = (g: CallRec[]): string => (g.length === 0 ? '-' : `${pct(miss(g), hit(g) + miss(g))} (n=${g.length})`);
    const clean = rows.filter((r) => !flagDefs.some(([, pick]) => pick(r)));
    console.log(
      `  ${b.padEnd(12)} ${cell(clean).padStart(16)} ` +
        flagDefs.map(([, pick]) => cell(rows.filter(pick)).padStart(18)).join(' '),
    );
  }

  // ==================== 3. Q2 首调成本 ====================
  console.log('\n================ 3. Q2 首调成本占比 ================');
  const firstCalls = all.filter((r) => r.callIdx === 1);
  const restCalls = all.filter((r) => r.callIdx > 1);
  console.log(
    `callIdx=1（任务冷启动）  调用 ${firstCalls.length}  输入 ${k(hit(firstCalls) + miss(firstCalls))}  ` +
      `命中 ${pct(hit(firstCalls), hit(firstCalls) + miss(firstCalls))}  miss ${k(miss(firstCalls))} (${pct(miss(firstCalls), totalMiss)} of 全部 miss)`,
  );
  console.log(
    `callIdx>1（任务内续轮）  调用 ${restCalls.length}  输入 ${k(hit(restCalls) + miss(restCalls))}  ` +
      `命中 ${pct(hit(restCalls), hit(restCalls) + miss(restCalls))}  miss ${k(miss(restCalls))} (${pct(miss(restCalls), totalMiss)})`,
  );
  // 每个任务内部：首调 miss / 任务 miss
  const perTaskShare: number[] = [];
  for (const rows of byTask.values()) {
    const m = miss(rows);
    if (m <= 0) continue;
    perTaskShare.push(miss(rows.filter((r) => r.callIdx === 1)) / m);
  }
  if (perTaskShare.length > 0) {
    perTaskShare.sort((a, b) => a - b);
    const mid = perTaskShare[Math.floor(perTaskShare.length / 2)];
    const avg = perTaskShare.reduce((s, v) => s + v, 0) / perTaskShare.length;
    console.log(
      `\n任务内部首调 miss 占比  中位 ${(mid * 100).toFixed(1)}%  均值 ${(avg * 100).toFixed(1)}%  ` +
        `（n=${perTaskShare.length} 个有 miss 的任务）`,
    );
    const single = [...byTask.values()].filter((rows) => rows.length === 1).length;
    console.log(`其中单次调用任务 ${single} 个（首调占比必然 100%，是"一次冷读"的下限形态）`);
  }

  // 工具段规模 × 首调成本：工具块越大，冷启动越贵（实测最大的一根杠杆）
  console.log('\n工具段规模 × 首调成本（工具块越大 → 冷启动全价读越多）：');
  const toolBucket = (bytes: number): string =>
    bytes <= 40960 ? '<=40KB' : bytes <= 81920 ? '40-80KB' : bytes <= 122880 ? '80-120KB' : '>120KB';
  for (const b of ['<=40KB', '40-80KB', '80-120KB', '>120KB']) {
    const rows = firstCalls.filter((r) => toolBucket(r.toolsBytes) === b);
    if (rows.length === 0) continue;
    const prompt = hit(rows) + miss(rows);
    console.log(
      `  ${b.padEnd(9)} n=${String(rows.length).padStart(3)}  首调命中 ${pct(hit(rows), prompt).padStart(6)}  ` +
        `miss/call ${fmt(miss(rows) / rows.length).padStart(9)}  miss 合计 ${k(miss(rows)).padStart(8)}`,
    );
  }
  const bigFirst = firstCalls.filter((r) => r.toolsBytes > 81920);
  if (bigFirst.length > 0) {
    console.log(
      `  → 工具段 >80KB 的首调占全部 miss 的 ${pct(miss(bigFirst), totalMiss)}（${bigFirst.length} 次调用，` +
        `平均工具段 ${(bigFirst.reduce((s, r) => s + r.toolsBytes, 0) / bigFirst.length / 1024).toFixed(0)}KB）`,
    );
  }
  const toolCounts = all.map((r) => r.toolCount).sort((a, b) => a - b);
  if (toolCounts.length > 0) {
    const medianTools = toolCounts[Math.floor(toolCounts.length / 2)];
    console.log(
      `  工具数：中位 ${medianTools}，最大 ${toolCounts[toolCounts.length - 1]}` +
        (medianTools > 60 ? '（中位 >60 → 场景 sticky 在累积，值得加衰减/上限）' : ''),
    );
  }

  // ==================== 4. Q3 @引用块与漂移 ====================
  console.log('\n================ 4. Q3 漂移是否集中在带 @引用的轮次 ================');
  console.log('（只统计每个任务的首调：后续轮次的"末条消息"是工具结果，@引用位不适用）');
  const firstWithRef = firstCalls.filter((r) => r.lastUserRefBlocks);
  const firstNoRef = firstCalls.filter((r) => !r.lastUserRefBlocks);
  const line = (label: string, rows: CallRec[]): void => {
    if (rows.length === 0) return;
    const prompt = hit(rows) + miss(rows);
    console.log(
      `  ${label.padEnd(22)} n=${String(rows.length).padStart(4)}  命中 ${pct(hit(rows), prompt).padStart(6)}  ` +
        `miss/call ${fmt(miss(rows) / rows.length).padStart(9)}  historyRewritten ${String(rows.filter((r) => r.historyRewritten).length).padStart(3)}  ` +
        `lastTurnRewritten ${String(rows.filter((r) => r.lastTurnRewritten).length).padStart(3)}`,
    );
  };
  line('带 @引用块', firstWithRef);
  line('不带 @引用块', firstNoRef);
  const rate = (rows: CallRec[]): number => (rows.length > 0 ? miss(rows) / rows.length : 0);
  if (firstWithRef.length > 0 && firstNoRef.length > 0) {
    const ratio = rate(firstNoRef) > 0 ? rate(firstWithRef) / rate(firstNoRef) : 0;
    console.log(
      `\n  → 带 @引用块的首调，每次 miss 是不带的 ${ratio.toFixed(2)} 倍` +
        (ratio > 1.3 ? '（差距明显，P1-A/@块重放丢失值得修）' : '（差距不大，P1-A 优先级可下调）'),
    );
  } else {
    console.log('\n  样本不足（一侧为 0），继续积累数据后再看。');
  }

  // ==================== 5. 一句话结论 ====================
  const driftMiss = totalMiss - miss(all.filter((r) => driftClass(r) === 'none'));
  console.log('\n================ 5. 小结 ================');
  console.log(
    `  可归因漂移 miss ${k(driftMiss)} = 全部 miss 的 ${pct(driftMiss, totalMiss)} ≈ ${cny(driftMiss)}；` +
      `若全部消除，整体命中率 ${pct(totalHit, totalHit + totalMiss)} → ${pct(
        totalHit + driftMiss,
        totalHit + totalMiss,
      )}`,
  );
  const firstShare = miss(firstCalls) / (totalMiss || 1);
  console.log(
    `  首调 miss 占比 ${(firstShare * 100).toFixed(1)}%` +
      (firstShare > 0.45 ? '（偏高：冷启动是主要成本，优先压头部体积/提高复用）' : '（正常：miss 主要来自任务内新内容）'),
  );
  console.log('');
}

main();
