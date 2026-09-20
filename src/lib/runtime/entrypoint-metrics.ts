/**
 * src/lib/runtime/entrypoint-metrics.ts
 * 「入口必然性」的可量指标留痕（六）。
 *
 * 病是：三个入口工具（read_ledger / search_materials / read_attachment）都挂上了，但调不调
 * 全看模型自觉 —— 软指针只有百来 token，实测它可以不调。要把它从"软门禁"变成"可量的数"，
 * 至少三个指标：① 读账本的首调命中率；② 材料检索的首调命中率；③ 检索命中后是否真走到
 * read_attachment。
 *
 * 留痕写进 `.ledger/log.md`（append-only，与账本同一处；律师要签字的依据链也在这里），
 * 字段极简：turn、工具、参数摘要、命中的 source ids。**每个用户轮一行**，三个指标就是对
 * 这些行做计数，不需要另建统计服务：
 *   - 有 `read_ledger(` 段且后面是 id（不是 `-`）→ 该轮首调命中；
 *   - 有 `search_materials(` 段且后面是路径 → 该轮检索首调命中；
 *   - `fetch=yes` 的比例 → 命中后真取件的比例。
 *
 * 行尾追加字段 `trunc=…`（后向兼容：旧行没有该字段不影响解析）：
 *   - `trunc=no`：本轮无工具返回被截断；
 *   - `trunc=yes(read_attachment,search_materials)`：本轮这些工具的返回含机器标记 `[truncated]`（去重、保持出现顺序）。
 *
 * 只取**首调**：一轮里模型可能反复检索（改关键词重试），首调命中率才是"入口给不给得上力"
 * 的判据；末调命中只是"多试了几次"。
 */

import type { ConversationTurn } from '@/lib/node-markdown';

/** 入口三件套（三级跳）：账本=路由器 → 材料索引=定位器 → read_attachment=取件 */
const ENTRY_TOOLS = ['read_ledger', 'search_materials', 'read_attachment'] as const;
type EntryTool = (typeof ENTRY_TOOLS)[number];

/** 账本条目 id（工具输出里一律反引号包裹：`w-xxxx` / `r-xxxx`） */
const LEDGER_ID_RE = /`([wr]-[A-Za-z0-9-]+)`/g;
/** search_materials 命中行首列的可直接引用来源串（三） */
const MATERIAL_SOURCE_RE = /\[来源:\s*材料:(materials\/[^\s\]#]+)(#p\d+)?\]/g;

const MAX_IDS = 3;
const MAX_ARG_CHARS = 40;

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ARG_CHARS ? `${flat.slice(0, MAX_ARG_CHARS)}…` : flat;
}

/** id 列表 → `a,b,c+2`（超过 3 个只留前 3 个 + 余数，log 是留痕不是证据本体） */
function idsCell(ids: string[]): string {
  if (ids.length === 0) return '-';
  const head = ids.slice(0, MAX_IDS).join(',');
  return ids.length > MAX_IDS ? `${head}+${ids.length - MAX_IDS}` : head;
}

type ToolCall = NonNullable<ConversationTurn['toolCalls']>[number];

/** 参数摘要：只留定位用的关键字段，不抄全文 */
function argsCell(tool: EntryTool, args: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (tool === 'search_materials') {
    const q = str(args.query);
    return q ? `q=${clip(q)}` : '';
  }
  if (tool === 'read_attachment') return clip(str(args.path));
  const id = str(args.id);
  if (id) return `id=${clip(id)}`;
  const ids = Array.isArray(args.ids) ? args.ids.filter((v): v is string => typeof v === 'string') : [];
  if (ids.length > 0) return `ids=${clip(ids.join(','))}`;
  const topics = Array.isArray(args.topics) ? args.topics.filter((v): v is string => typeof v === 'string') : [];
  if (topics.length > 0) return `topics=${clip(topics.join(','))}`;
  return '';
}

/** 命中判定 + 命中物：账本给 id，材料检索给 `路径#页`，取件给路径本身（取到才算命中）。 */
function hitCell(tool: EntryTool, call: ToolCall): { hit: boolean; ids: string[] } {
  const result = typeof call.result === 'string' ? call.result : '';
  if (tool === 'read_attachment') {
    // 路径不存在/非文件是硬错误（五），成功才是取件成功
    const ok = call.success !== false && !result.startsWith('Error');
    const p = typeof call.arguments?.path === 'string' ? (call.arguments.path as string) : '';
    return { hit: ok && !!p, ids: ok && p ? [p] : [] };
  }
  if (tool === 'search_materials') {
    const ids: string[] = [];
    for (const m of result.matchAll(MATERIAL_SOURCE_RE)) ids.push(`${m[1]}${m[2] ?? ''}`);
    return { hit: ids.length > 0, ids };
  }
  const ids: string[] = [];
  for (const m of result.matchAll(LEDGER_ID_RE)) ids.push(m[1]);
  return { hit: ids.length > 0, ids: [...new Set(ids)] };
}

/** 单轮 → 一行留痕；该轮**完全没调工具**（纯闲聊）返回 null —— 不是"该调没调"，不进分母。 */
function traceLineOf(turn: ConversationTurn, turnNo: number): string | null {
  const calls = turn.toolCalls ?? [];
  if (calls.length === 0) return null;
  const cells: string[] = [];

  /** 本轮材料检索命中的路径（去掉 #页） */
  const hitPaths: string[] = [];
  /** 本轮真正取件的路径 */
  const fetchedPaths = new Set<string>();

  for (const tool of ENTRY_TOOLS) {
    const first = calls.find((c) => c.toolName === tool);
    if (!first) {
      cells.push(`${tool}(-)`);
      continue;
    }
    const { hit, ids } = hitCell(tool, first);
    if (tool === 'search_materials') {
      for (const id of ids) {
        const p = id.split('#')[0];
        if (!hitPaths.includes(p)) hitPaths.push(p);
      }
    }
    if (tool === 'read_attachment') {
      const p = typeof first.arguments?.path === 'string' ? (first.arguments.path as string) : '';
      if (hit && p) fetchedPaths.add(p);
    }
    const args = argsCell(tool, first.arguments ?? {});
    cells.push(`${tool}(${args}${args ? ' → ' : ''}${idsCell(ids)})`);
  }

  // ③ 检索命中后是否真走到 read_attachment：本轮没命中检索记 `-`（不进这个比率的分母）
  const fetch = hitPaths.length === 0
    ? '-'
    : hitPaths.some((p) => fetchedPaths.has(p)) ? 'yes' : 'no';

  // 截断留痕（后向兼容，追加在行尾）：本轮任一工具返回含机器标记 [truncated] → 记工具名（去重、保持出现顺序）
  const truncatedTools: string[] = [];
  for (const call of calls) {
    if (typeof call.result !== 'string' || !call.result.includes('[truncated]')) continue;
    if (call.toolName && !truncatedTools.includes(call.toolName)) truncatedTools.push(call.toolName);
  }
  const trunc = truncatedTools.length > 0 ? `yes(${truncatedTools.join(',')})` : 'no';

  return `turn=${turnNo} ${cells.join(' | ')} | fetch=${fetch} | trunc=${trunc}`;
}

/**
 * 本轮（对话数组的最后一轮）→ 一行留痕；纯闲聊轮返回 null（调用方不写）。
 *
 * `turn` 取 `turns.length`（**用户轮**序号，1-based，与 outcome_turns 同口径）：
 * 一轮里五次工具往返不会推游标，与幂等判据一致。
 * 每次 append 只写这一轮 —— log.md 是 append-only 留痕，历史轮不重写。
 */
export function deriveTurnTrace(turns: ConversationTurn[]): string | null {
  const last = turns[turns.length - 1];
  if (!last) return null;
  return traceLineOf(last, turns.length);
}
