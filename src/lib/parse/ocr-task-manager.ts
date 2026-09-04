/**
 * OCR 异步任务管理器（BobWork 侧调度层）
 *
 * 把长耗时识别（本地 VLM 分钟级 / 整份大 PDF）从「同步等待撞超时」改为
 * 「提交 → 后台轮询 → 完成写缓存」三段：
 *   1. read_attachment 提交异步任务（插件 async=true），立即返回 taskId + 进度提示
 *   2. 本模块后台轮询插件 ocr.task_status（进程内定时器，不占模型轮次/token）
 *   3. 任务 done → 结果写主缓存（setCache）+ 二级索引（registerOcrPages）
 *      → 模型下轮 read_attachment 命中缓存秒回（缓存即结果通道）
 *
 * 单飞去重：同一文件 hash 已有进行中任务 → 返回同一 taskId，不重复提交。
 * 多 agent 协同：跨会话共享本模块（进程内单例），多 agent 并发读同一文件合并为一个任务。
 * 崩溃恢复：任务结果落缓存/落盘，进程重启后已完成的直接命中；未完成的重新提交即可（幂等）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

interface OcrTaskRec {
  taskId: string;
  filePath: string;
  projectPath: string;
  upgrade: 'off' | 'auto' | 'always';
  /** 分页读取（pagesArg）：只识别部分页，不写整份缓存 */
  pagesArg?: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress?: number;
  progressText?: string;
  /** 排队位置（queued 时有效，1 起） */
  position?: number;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  /** 完成回调：把插件结果写入 BobWork 主缓存 + 二级索引 */
  onDone?: (rec: OcrTaskRec, result: unknown) => Promise<void>;
}

/** 进行中任务表（hash → 任务记录） */
const tasksByHash = new Map<string, OcrTaskRec>();
/** taskId → 任务记录（状态查询用） */
const tasksById = new Map<string, OcrTaskRec>();

/** 后台轮询句柄 */
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3000;

/**
 * 提交异步 OCR 任务（单飞去重）。
 * 若该文件已有进行中任务 → 返回现有 taskId（不重复提交）。
 * @returns 任务记录（status=queued/running 表示进行中；done 表示已完成可直接复用）
 */
export async function submitOcrTask(opts: {
  filePath: string;
  projectPath: string;
  hash: string;
  upgrade?: 'off' | 'auto' | 'always';
  pagesArg?: string;
  onDone?: (rec: OcrTaskRec, result: unknown) => Promise<void>;
}): Promise<OcrTaskRec> {
  const hash = opts.hash;
  const existing = tasksByHash.get(hash);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    return existing;
  }
  // 已完成 → 直接复用（结果已在缓存）
  if (existing && existing.status === 'done') return existing;

  const { submitRecognizeTask } = await import('@/lib/mcp/ocr-client');
  const submitted = await submitRecognizeTask(opts.filePath, opts.upgrade ?? 'auto');
  if (!submitted?.taskId) {
    throw new Error('无法提交 OCR 异步任务：bob-ocr-mcp 不可用');
  }
  const rec: OcrTaskRec = {
    taskId: submitted.taskId,
    filePath: opts.filePath,
    projectPath: opts.projectPath,
    upgrade: opts.upgrade ?? 'auto',
    pagesArg: opts.pagesArg,
    status: 'queued',
    createdAt: Date.now(),
    onDone: opts.onDone,
  };
  tasksByHash.set(hash, rec);
  tasksById.set(rec.taskId, rec);
  ensurePolling();
  // 立即同步一次插件状态（拿到排队位置/进度），让 read_attachment 首次提示更准确
  void (async () => {
    const { getOcrTaskStatus } = await import('@/lib/mcp/ocr-client');
    const st = await getOcrTaskStatus(rec.taskId).catch(() => null);
    if (!st) return;
    if (typeof st.progress === 'number') rec.progress = st.progress;
    if (typeof st.progressText === 'string') rec.progressText = st.progressText;
    if (typeof st.position === 'number') rec.position = st.position;
  })();
  return rec;
}

/** 查询某文件的任务（hash 维度） */
export function getOcrTaskByHash(hash: string): OcrTaskRec | null {
  return tasksByHash.get(hash) ?? null;
}

/** 查询某文件是否有进行中任务 */
export function hasRunningOcrTask(hash: string): boolean {
  const t = tasksByHash.get(hash);
  return !!t && (t.status === 'queued' || t.status === 'running');
}

/** 启动后台轮询（惰性：首个任务提交时启动） */
function ensurePolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void pollAll().catch(() => {});
  }, POLL_INTERVAL_MS);
  // 立即跑一次，加速首个任务状态可见
  void pollAll().catch(() => {});
}

/** 轮询所有进行中任务：状态 → 完成时写缓存并清理 */
async function pollAll(): Promise<void> {
  const { getOcrTaskStatus } = await import('@/lib/mcp/ocr-client');
  for (const rec of tasksById.values()) {
    if (rec.status !== 'queued' && rec.status !== 'running') continue;
    const st = await getOcrTaskStatus(rec.taskId).catch(() => null);
    if (!st) continue; // 插件暂时不可达，下轮再试
    rec.status = st.status as OcrTaskRec['status'];
    if (typeof st.progress === 'number') rec.progress = st.progress;
    if (typeof st.progressText === 'string') rec.progressText = st.progressText;
    if (typeof st.position === 'number') rec.position = st.position;
    if (st.error) rec.error = st.error;
    if (st.status === 'done' || st.status === 'failed') {
      rec.finishedAt = Date.now();
      if (st.status === 'done' && rec.onDone && st.result !== undefined) {
        try {
          await rec.onDone(rec, st.result);
        } catch (e) {
          rec.status = 'failed';
          rec.error = `完成回调失败: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
  }
  // 清理已完成的哈希条目（保留 byId 供状态查询）
  for (const [hash, rec] of tasksByHash) {
    if (rec.status === 'done' || rec.status === 'failed') tasksByHash.delete(hash);
  }
}

/** 停止轮询（进程退出/测试用） */
export function stopOcrTaskPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
