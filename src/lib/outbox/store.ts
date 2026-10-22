/**
 * lib/outbox/store.ts —— Butler 派发会话的「产物暂存区」（Outbox，server-only）
 *
 * 背景：管家（Butler）通过 create_session 派活后，产物原先直接落「当前项目」的 homework/，
 * 用户既察觉不到、也不该让当前项目被污染。现在的口径：
 *   管家派发的会话默认 output_mode='outbox' —— 最终交付物写到 <appRoot>/outbox/<批次>/homework/，
 *   中间产物写到 <appRoot>/outbox/<批次>/.ai-workspace/，对项目目录零写入；
 *   用户在「Outbox」面板（或让管家调 outbox_assign）指定归口项目后，文件才被搬进目标项目。
 *
 * 一批 = 一次管家派发的会话任务。每批**自包含**：目录内一份 manifest.json 描述本批的来源、
 * 文件清单与状态——单批写入失败不影响其他批，删除目录即整批消失，不留孤儿索引。
 *
 * 归属口径与 todo-move.ts 一致：搬入目标项目时**先写目标、校验后再删源**，
 * 中途失败最坏只是目标多一份副本（可人工处理），不会出现「源已删、目标未建」的空洞。
 */
import { mkdir, readFile, readdir, rm, stat, copyFile, unlink } from 'fs/promises';
import { join, relative, sep, basename } from 'path';
import { randomBytes, createHash } from 'crypto';
import { resolveOutboxRoot } from '@/lib/app-root';
import { atomicWriteFile } from '@/lib/butler/fs-atomic';
import { classifyOutputKind } from '@/lib/homework/kind';

/** 批次状态：待归口 / 已归口 / 用户保留（免自动清理） / 已丢弃 */
export type OutboxBatchStatus = 'pending' | 'assigned' | 'kept' | 'discarded';

/** 批次内单个文件的登记项（rel 为相对**批次根**的路径，如 homework/report.md） */
export interface OutboxFileEntry {
  rel: string;
  name: string;
  size: number;
  kind: string;
}

/** 一批产物的完整契约（manifest.json 的落盘形状） */
export interface OutboxBatch {
  batch_id: string;
  /** 派发该批的会话节点 id（前端回填，可为空） */
  session_id: string | null;
  /** 来源项目 id（会话所在项目，**仅作痕迹**，不作为归属） */
  origin_project_id: string | null;
  /** 来源会话标题，用于面板展示 */
  origin_label: string;
  created_at: string;
  files: OutboxFileEntry[];
  status: OutboxBatchStatus;
  /** 归口后的目标项目 id */
  assigned_to: string | null;
  assigned_at: string | null;
  /** 归口过程中的异常说明（同名跳过 / 复制失败等），供面板与工具回执提示 */
  note?: string;
}

/** 一批的磁盘路径三件套 */
export interface OutboxBatchPaths {
  /** 批次根：<appRoot>/outbox/<batchId> */
  root: string;
  /** 最终交付物目录（管家会话的 homework 落点） */
  homework: string;
  /** 中间产物目录（管家会话的 .ai-workspace 落点） */
  workspace: string;
  /** 批次契约文件 */
  manifest: string;
}

const MANIFEST_NAME = 'manifest.json';
/** 文件清单扫描时跳过的隐藏目录/文件（.ai-workspace 属于中间产物，不进交付物清单） */
const HIDDEN_PREFIX = '.';

/** 批次 id：otb_<YYYYMMDD>_<8位随机>（可读、可按日期粗排、无碰撞） */
export function newBatchId(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `otb_${y}${m}${d}_${randomBytes(4).toString('hex')}`;
}

/** 解析一批的磁盘路径（不校验存在性） */
export function batchPaths(batchId: string): OutboxBatchPaths {
  const root = join(resolveOutboxRoot(), batchId);
  return {
    root,
    homework: join(root, 'homework'),
    workspace: join(root, 'homework', '.ai-workspace'),
    manifest: join(root, MANIFEST_NAME),
  };
}

/**
 * 建一批并落盘（供管家 create_session 派发时调用）。
 * 同时创建 homework/ 与 .ai-workspace/，让会话拿到工作区即用。
 */
export async function createBatch(input: {
  sessionId?: string | null;
  originProjectId?: string | null;
  originLabel?: string;
  batchId?: string;
}): Promise<{ batch: OutboxBatch; paths: OutboxBatchPaths }> {
  const batchId = input.batchId ?? newBatchId();
  const paths = batchPaths(batchId);
  await mkdir(paths.workspace, { recursive: true });
  const batch: OutboxBatch = {
    batch_id: batchId,
    session_id: input.sessionId ?? null,
    origin_project_id: input.originProjectId ?? null,
    origin_label: input.originLabel ?? '',
    created_at: new Date().toISOString(),
    files: [],
    status: 'pending',
    assigned_to: null,
    assigned_at: null,
  };
  await writeBatch(batch);
  return { batch, paths };
}

/**
 * 管家对话（非派发）的批次 id：由 threadId 派生，同一会话多轮写入恒落同一批。
 * 形如 otb_chat_<净化后的 threadId>_<8位哈希>，满足工具侧 /^otb_[A-Za-z0-9_-]{1,64}$/ 校验。
 */
export function chatBatchId(threadId: string): string {
  const safe = threadId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'thread';
  const h = createHash('sha1').update(threadId).digest('hex').slice(0, 8);
  return `otb_chat_${safe}_${h}`;
}

/**
 * 取管家对话的批次（存在则复用，不存在则建）。
 * 路径 A（管家在自己的会话里直接回复并写文件）没有派发节点/批次，靠 threadId 稳定复用；
 * 被丢弃的批次目录已不存在，下一次写入会重建。
 */
export async function ensureChatBatch(
  threadId: string,
  input: { originProjectId?: string | null; originLabel?: string } = {},
): Promise<OutboxBatch> {
  const batchId = chatBatchId(threadId);
  const existing = await readBatch(batchId);
  if (existing) return existing;
  const { batch } = await createBatch({
    batchId,
    sessionId: threadId,
    originProjectId: input.originProjectId ?? null,
    originLabel: input.originLabel ?? 'Butler',
  });
  return batch;
}

/** 读取一批的契约；目录/文件缺失或损坏时返回 null（不抛错，供列表与面板容错） */
export async function readBatch(batchId: string): Promise<OutboxBatch | null> {
  try {
    const raw = await readFile(batchPaths(batchId).manifest, 'utf-8');
    const parsed = JSON.parse(raw) as OutboxBatch;
    if (!parsed || typeof parsed !== 'object' || !parsed.batch_id) return null;
    // 归一化可选字段，避免旧数据缺字段导致下游读到 undefined
    return {
      ...parsed,
      session_id: parsed.session_id ?? null,
      origin_project_id: parsed.origin_project_id ?? null,
      origin_label: parsed.origin_label ?? '',
      files: Array.isArray(parsed.files) ? parsed.files : [],
      status: parsed.status ?? 'pending',
      assigned_to: parsed.assigned_to ?? null,
      assigned_at: parsed.assigned_at ?? null,
    };
  } catch {
    return null;
  }
}

/** 原子写回一批的契约（临时文件 + rename，防并行覆盖） */
export async function writeBatch(batch: OutboxBatch): Promise<void> {
  await atomicWriteFile(batchPaths(batch.batch_id).manifest, JSON.stringify(batch, null, 2));
}

/** 递归列出批次 homework/ 下的交付文件（跳过隐藏目录，如 .ai-workspace） */
async function listBatchFiles(root: string, dir = root, acc: OutboxFileEntry[] = []): Promise<OutboxFileEntry[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc; // 目录不存在/不可读 → 空清单
  }
  for (const ent of entries) {
    if (ent.name.startsWith(HIDDEN_PREFIX)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await listBatchFiles(root, full, acc);
    } else if (ent.isFile()) {
      let size = 0;
      try {
        size = (await stat(full)).size;
      } catch {
        continue; // 单个文件 stat 失败不阻断整批扫描
      }
      const rel = relative(root, full).split(sep).join('/');
      acc.push({ rel, name: ent.name, size, kind: classifyOutputKind(ent.name) });
    }
  }
  return acc;
}

/**
 * 重扫批次 homework/，把最新文件清单写回契约（会话结束/面板刷新时调用）。
 * 空清单也会如实写回——便于面板区分「会话还没产出」与「产物被清掉」。
 */
export async function refreshBatchFiles(batchId: string): Promise<OutboxBatch | null> {
  const batch = await readBatch(batchId);
  if (!batch) return null;
  const next: OutboxBatch = { ...batch, files: await listBatchFiles(batchPaths(batchId).homework) };
  await writeBatch(next);
  return next;
}

/** 列出全部批次（按创建时间倒序）；扫描时顺带刷新文件清单，保证面板显示与磁盘一致 */
export async function listBatches(): Promise<OutboxBatch[]> {
  let ids: string[];
  try {
    ids = (await readdir(resolveOutboxRoot(), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith(HIDDEN_PREFIX))
      .map((e) => e.name);
  } catch {
    return []; // outbox 尚未创建（从未派过活）
  }
  const batches: OutboxBatch[] = [];
  for (const id of ids) {
    const batch = await refreshBatchFiles(id);
    if (batch) batches.push(batch);
  }
  return batches.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** 用户「保留」一批：置 kept，免自动清理（仍可手动归口或丢弃） */
export async function keepBatch(batchId: string): Promise<OutboxBatch | null> {
  const batch = await readBatch(batchId);
  if (!batch) return null;
  const next: OutboxBatch = { ...batch, status: 'kept' };
  await writeBatch(next);
  return next;
}

/** 丢弃一批：整目录删除（含中间产物）。仅删该批次根，不触碰 outbox 其他内容 */
export async function discardBatch(batchId: string): Promise<boolean> {
  // 防目录逃逸：batchId 必须是不含分隔符的单段名（来自我们自己的生成，仍做硬校验）
  if (!batchId || batchId.includes('/') || batchId.includes('\\') || batchId.startsWith(HIDDEN_PREFIX)) {
    return false;
  }
  try {
    await rm(batchPaths(batchId).root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 归口目标解析契约（默认走 resolveProjectWithFallback；可注入以便单测不触达项目库） */
export interface AssignDeps {
  resolveTarget: (
    ref: string,
  ) => Promise<{ ok: true; id: string; name: string; path: string } | { ok: false; message: string }>;
}

/** 默认依赖：真实项目库（显式优先 + 当前项目兜底 + 同 resolve-explicit-project 口径） */
export const defaultAssignDeps: AssignDeps = {
  resolveTarget: async (ref) => {
    const { resolveProjectWithFallback } = await import('@/lib/project/resolve-explicit-project');
    const pr = await resolveProjectWithFallback(ref);
    if (!pr.ok) {
      let msg = '目标项目无法解析，请让用户确认项目名。';
      try {
        const parsed = JSON.parse(pr.payload) as { message?: string };
        if (parsed?.message) msg = parsed.message;
      } catch {
        /* payload 非 JSON → 用保底文案 */
      }
      return { ok: false, message: msg };
    }
    if (!pr.project) return { ok: false, message: '目标项目无法解析（空引用）。' };
    return { ok: true, id: pr.project.id, name: pr.project.name || pr.project.id, path: pr.project.path };
  },
};

/** 归口结果：成功搬运的文件、因同名跳过/失败而滞留的文件 */
export interface AssignResult {
  ok: boolean;
  message: string;
  assigned?: { from: string; to: string }[];
  remaining?: string[];
  /** 已归口却仍未搬走的文件（同名冲突/复制失败）→ 面板可提示 */
  conflicts?: number;
  target?: { id: string; name: string };
  batchDeleted?: boolean;
}

/** 把一批产物归口到目标项目：逐文件「复制 → 校验 → 删源」，全部搬走后整批目录删除 */
export async function assignBatch(
  args: { batchId: string; target: string },
  deps: AssignDeps = defaultAssignDeps,
): Promise<AssignResult> {
  const batch = await refreshBatchFiles(args.batchId);
  if (!batch) return { ok: false, message: `未找到批次「${args.batchId}」（可能已被清理）。` };
  const files = batch.files ?? [];
  const resolved = await deps.resolveTarget(args.target);
  if (!resolved.ok) return { ok: false, message: resolved.message };

  if (files.length === 0) {
    return { ok: false, message: `批次「${args.batchId}」没有可归口的产物（会话可能还没产出文件）。` };
  }

  const paths = batchPaths(args.batchId);
  const targetHomework = join(resolved.path, 'homework');
  await mkdir(targetHomework, { recursive: true });

  const assigned: { from: string; to: string }[] = [];
  const failed: string[] = [];
  let conflicts = 0;

  for (const f of files) {
    const src = join(paths.homework, ...f.rel.split('/'));
    const dest = join(targetHomework, basename(f.rel));
    try {
      const destStat = await stat(dest).catch(() => null);
      if (destStat) {
        // 目标已存在同名文件：**不覆盖**（守「既有文件不被静默改写」），源一并清掉避免重复留在 outbox
        if (destStat.size === f.size) {
          await unlink(src).catch(() => undefined);
          assigned.push({ from: f.rel, to: `homework/${basename(f.rel)}` });
        } else {
          conflicts += 1;
          failed.push(f.rel);
        }
        continue;
      }
      await copyFile(src, dest);
      // 校验：复制后大小一致才算成功，再删源（先目标后源的落盘顺序）
      const copied = await stat(dest);
      if (copied.size !== f.size) {
        failed.push(f.rel);
        continue;
      }
      await unlink(src);
      assigned.push({ from: f.rel, to: `homework/${basename(f.rel)}` });
    } catch {
      failed.push(f.rel);
    }
  }

  const allMoved = failed.length === 0;
  if (allMoved) {
    // 全部搬走 → 整批目录删除（含 .ai-workspace 中间产物），不再占用面板
    await discardBatch(args.batchId);
    return {
      ok: true,
      message: `已把 ${assigned.length} 个产物归口到「${resolved.name}」。`,
      assigned,
      conflicts,
      target: { id: resolved.id, name: resolved.name },
      batchDeleted: true,
    };
  }

  // 部分滞留（同名冲突/失败）→ 保留批次并把状态置 assigned，交面板/sweeper 处理
  const note = `${failed.length} 个文件未能搬入（${conflicts} 个与目标同名且大小不同，已保留在 Outbox）`;
  await writeBatch({
    ...batch,
    files: await listBatchFiles(paths.homework),
    status: 'assigned',
    assigned_to: resolved.id,
    assigned_at: new Date().toISOString(),
    note,
  });
  return {
    ok: true,
    message: `已归口 ${assigned.length} 个产物到「${resolved.name}」；${note}。`,
    assigned,
    remaining: failed,
    conflicts,
    target: { id: resolved.id, name: resolved.name },
    batchDeleted: false,
  };
}
