/**
 * 模型调度事件日志 + 自动降权（反馈闭环）
 *
 * 背景：视觉/OCR 分派是"规则驱动"的——候选顺序写死，某模型反复失败也不会有任何调整。
 * 本模块为调度链路补上反馈闭环：
 *   1. logDispatchEvent()：每次分派/尝试追加一条结构化事件到 ~/BobWork/.logs/dispatch.jsonl
 *      （时间 / 链路 / 模型 / 文档类型 / 成功失败 / 质量分 / 耗时 / 错误，每行一个 JSON）
 *   2. loadDispatchStats()：按模型聚合 {尝试, 失败, 质量分, 耗时}（供降权与后续分析）
 *   3. applyDispatchPenalty()：把历史失败率高的模型稳定地排到候选列表末尾（soft 降权，
 *      不硬删除——低置信样本保持中性，绝不因个别失败就禁用某模型）
 *
 * 原则：
 *   - logDispatchEvent 永不抛错（日志绝不影响调度主链路）
 *   - 文件有行数上限（超限保留最近 MAX_LOG_LINES 行），避免无限增长
 *   - 降权排序稳定：正常组/降权组各自保持原相对顺序
 */

import { join } from 'path';
import * as fs from 'fs';
import { resolveAppRoot } from './app-root';

/** 调度事件（写入 .logs/dispatch.jsonl） */
export interface DispatchEvent {
  /** 链路标识：vision-fallback（通用视觉候选兜底）| glm-ocr | online-ocr | vlm-upgrade | ledger */
  chain: 'vision-fallback' | 'glm-ocr' | 'online-ocr' | 'vlm-upgrade' | 'ledger';
  /** 被调度的模型 id（本地识别无模型时为空串，不参与统计） */
  model: string;
  /** 文档类型（按文件扩展名推断）：pdf | image | video | other */
  docType: string;
  /** 是否成功（在线/视觉调用返回了非空文本） */
  ok: boolean;
  /** 输出文本质量分 0~1（可空，仅在有文本可评时写入） */
  quality?: number;
  /** 单次调用耗时 ms */
  ms?: number;
  /** 失败时的错误信息（截断，避免日志膨胀） */
  error?: string;
  /** 择优结果是否被采用（仅在线/VLM 链路，且 ok 时才有意义）：
   *  true=被择优采用；false=有文本但被择优机制拒绝（质量低于本地）。缺省 = 未记录。 */
  adopted?: boolean;
}

/** 按模型聚合的调度统计 */
export interface DispatchModelStats {
  attempts: number;
  fails: number;
  qualitySum: number;
  qualityCount: number;
  totalMs: number;
}

/** 降权前的最低样本数：尝试少于该次数视为"中性"，不参与降权 */
export const MIN_PENALTY_ATTEMPTS = 3;
/** 日志文件最大行数（超限保留最近 N 行） */
const MAX_LOG_LINES = 5000;
/** 单条 error 截断长度 */
const ERROR_MAX_LEN = 200;

const LOG_DIR = join(resolveAppRoot(), '.logs');
const LOG_PATH = join(LOG_DIR, 'dispatch.jsonl');

/** 按文件扩展名推断文档类型（用于统计维度） */
export function inferDocType(filePath: string): string {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'video';
  return 'other';
}

/** 追加一条调度事件（同步 IO，永不抛错；超限时裁剪保留最近行） */
export function logDispatchEvent(ev: DispatchEvent): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        ...ev,
        error: ev.error ? ev.error.slice(0, ERROR_MAX_LEN) : undefined,
      }) + '\n';
    // 裁剪：仅在文件超过预估上限（约 220 字节/行）时才读改写，避免每次 append 都读全量
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > MAX_LOG_LINES * 220) {
        const raw = fs.readFileSync(LOG_PATH, 'utf-8');
        const kept = raw.split('\n').filter(Boolean).slice(-MAX_LOG_LINES);
        fs.writeFileSync(LOG_PATH, kept.join('\n') + '\n', 'utf-8');
      }
    } catch { /* 文件不存在等，忽略 */ }
    fs.appendFileSync(LOG_PATH, line, 'utf-8');
  } catch { /* 日志失败绝不影响调度主链路 */ }
}

/** 读取并聚合调度统计（按模型 id；文件缺失/损坏返回空 Map，即不降权） */
export function loadDispatchStats(): Map<string, DispatchModelStats> {
  const stats = new Map<string, DispatchModelStats>();
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as DispatchEvent;
        if (!e.model) continue;
        const s = stats.get(e.model) ?? { attempts: 0, fails: 0, qualitySum: 0, qualityCount: 0, totalMs: 0 };
        s.attempts++;
        if (!e.ok) {
          s.fails++;
        } else if (e.adopted === false) {
          // 质量信号校准：调用成功（返回了文本）但被"择优采用"拒绝——说明其文本质量低于本地，
          // 视同一次低质信号计入 fails，让降权反映"实际采信质量"而非"是否返回非空"。
          s.fails++;
        }
        if (typeof e.quality === 'number') { s.qualitySum += e.quality; s.qualityCount++; }
        if (typeof e.ms === 'number') s.totalMs += e.ms;
        stats.set(e.model, s);
      } catch { /* 单行损坏跳过 */ }
    }
  } catch { /* 文件不存在/不可读 → 空统计 */ }
  return stats;
}

/** 按链路聚合的调度健康度（供诊断面板/未来校准展示） */
export interface DispatchChainHealth {
  chain: string;
  attempts: number;
  okCount: number;
  /** 被择优采用的次数（仅 ok 且记录了 adopted 的事件） */
  adoptedCount: number;
  /** 被择优拒绝的次数（ok 但 adopted=false） */
  rejectedCount: number;
  avgQuality: number | null;
  avgMs: number | null;
}

/** 读取并聚合调度健康度（按链路；文件缺失返回空数组） */
export function loadDispatchHealth(): DispatchChainHealth[] {
  const map = new Map<string, DispatchChainHealth>();
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as DispatchEvent;
        const h = map.get(e.chain) ?? {
          chain: e.chain, attempts: 0, okCount: 0, adoptedCount: 0, rejectedCount: 0, avgQuality: null, avgMs: null,
        };
        h.attempts++;
        if (e.ok) h.okCount++;
        if (e.ok && e.adopted === true) h.adoptedCount++;
        if (e.ok && e.adopted === false) h.rejectedCount++;
        map.set(e.chain, h);
      } catch { /* 单行损坏跳过 */ }
    }
  } catch { /* 文件不存在 → 空 */ }
  return [...map.values()];
}

/** Laplace 平滑成功率：(成功+1)/(尝试+2)，样本越少越接近中性 0.5 */
function smoothedSuccessRate(s: DispatchModelStats): number {
  return (s.attempts - s.fails + 1) / (s.attempts + 2);
}

/**
 * 按历史成功率给候选排序（自动降权）：
 *   - 无统计 / 尝试 < MIN_PENALTY_ATTEMPTS / 平滑成功率 >= 0.5 → "正常组"（保持原相对顺序）
 *   - 尝试 >= MIN_PENALTY_ATTEMPTS 且平滑成功率 < 0.5 → "降权组"（排在末尾作最后兜底，
 *     不硬删除，避免模型只是暂时抽风就被彻底禁用）
 * 返回：正常组 → 降权组（组内均保持原顺序，稳定排序）
 */
export function applyDispatchPenalty<T>(
  items: T[],
  getModel: (item: T) => string,
  stats?: Map<string, DispatchModelStats>,
): T[] {
  if (!stats || stats.size === 0 || items.length <= 1) return items;
  const good: T[] = [];
  const bad: T[] = [];
  for (const item of items) {
    const s = stats.get(getModel(item));
    if (!s || s.attempts < MIN_PENALTY_ATTEMPTS || smoothedSuccessRate(s) >= 0.5) {
      good.push(item);
    } else {
      bad.push(item);
    }
  }
  return bad.length > 0 ? [...good, ...bad] : items;
}

/** 便捷判断：某模型是否已被历史统计降权（供"自动匹配"环节跳过已知高失败率模型） */
export function isPenalizedModel(model: string, stats?: Map<string, DispatchModelStats>): boolean {
  if (!stats) return false;
  const s = stats.get(model);
  if (!s || s.attempts < MIN_PENALTY_ATTEMPTS) return false;
  return smoothedSuccessRate(s) < 0.5;
}
