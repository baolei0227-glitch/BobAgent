/**
 * md-annotations 联动清理 helper
 *
 * 删除文档（homework/materials 产物、本地文件、节点 .md、整个项目）时，
 * 同步删除其对应的批注/修订 sidecar（~/BobWork/md-annotations/<sha256(key)前24>.json），
 * 避免删除文档后残留孤儿 JSON。
 *
 * 为什么用「扫描 key 比对」而不是「反推 key 算 hash」：
 *   DocEditor 写入时 key = nodeMdId | filePath | `${projectId}:${filePath}`，
 *   filePath 可能是绝对路径也可能是项目内相对路径，且存在历史版本差异——
 *   无法从被删文件唯一确定其当年所用的 key 形态。因此反向遍历 sidecar 目录，
 *   读取每个 JSON 的 key 并归一化为"可能的文档绝对路径"，与目标路径比对，命中即删。
 *
 * 由各删除主流程（local-files / materials / nodes / tools 的 delete_file 等）调用，
 * 删除动作成功后调用（sidecar 存在与否不影响主流程，本函数内部静默容错）。
 */
import { promises as fs } from 'fs';
import { join, resolve, sep } from 'path';
import { createHash } from 'crypto';
import { resolveAppRoot } from '@/lib/app-root';
import { readProjectRefs } from '@/lib/project/project-config';

const ANNOTATIONS_DIR = () => join(resolveAppRoot(), 'md-annotations');

/** 目标 key → sidecar 文件绝对路径（与 md-annotations API 的命名规则一致） */
function sidecarPathFor(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return join(ANNOTATIONS_DIR(), `${hash}.json`);
}

/** 把归一化后的绝对路径与目标路径做命中判断（支持目录前缀） */
function pathHit(normPath: string, targets: { abs: string; isDir: boolean }[]): boolean {
  for (const t of targets) {
    if (t.isDir) {
      if (normPath === t.abs || normPath.startsWith(t.abs + sep)) return true;
    } else if (normPath === t.abs) {
      return true;
    }
  }
  return false;
}

export interface MdAnnotationCleanupTarget {
  /** 被删除文档/目录的绝对路径 */
  abs: string;
  /** 是否为目录（目录删除时，其下所有文档的 sidecar 一并清理） */
  isDir?: boolean;
}

export interface MdAnnotationCleanupOptions {
  /** 被删除文档/目录（本地文件、homework/materials 产物等） */
  targets?: MdAnnotationCleanupTarget[];
  /** 被删除节点的 nodeId（节点自身 .md 文档的 key = nodeMdId = nodeId） */
  nodeIds?: string[];
  /** 删除整个项目：清理该项目的全部 sidecar（key 前缀 = 项目 id，或路径位于项目内） */
  projectIds?: string[];
}

/**
 * 根据删除目标扫描并清理匹配的 sidecar。返回清理数量。
 * 幂等：md-annotations 目录不存在 / sidecar 不存在 / key 无法归一时静默跳过。
 */
export async function cleanupMdAnnotationSidecars(opts: MdAnnotationCleanupOptions): Promise<number> {
  try {
    const dir = ANNOTATIONS_DIR();
    const files = await fs.readdir(dir);
    if (files.length === 0) return 0;

    // 项目 id → 项目根路径映射（key 前缀可能是项目 id，也可能是目录名）
    let projects: { id: string; path: string }[] = [];
    try {
      projects = await readProjectRefs();
    } catch { /* 无项目配置时按绝对路径处理 */ }

    const targets = (opts.targets || []).map((t) => ({ abs: resolve(t.abs), isDir: !!t.isDir }));
    const nodeIds = new Set(opts.nodeIds || []);
    const projectIds = new Set(opts.projectIds || []);
    const projectRootById = new Map<string, string>();
    for (const p of projects) projectRootById.set(p.id, p.path);

    let removed = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const sidecar = join(dir, f);
      let key = '';
      try {
        const data = JSON.parse(await fs.readFile(sidecar, 'utf-8')) as { key?: unknown };
        if (typeof data.key === 'string' && data.key) key = data.key;
      } catch { continue; } // 损坏/空 sidecar：不删（保留给人工排查）

      // 命中规则 1：nodeId 节点文档（key 即 nodeId / nodeMdId）
      if (nodeIds.has(key)) {
        await fs.unlink(sidecar).catch(() => {});
        removed++;
        continue;
      }
      // 命中规则 2：整个项目删除（key 前缀 = 项目 id，或 key 内的路径落在项目根内）
      if (projectIds.size > 0) {
        const colonIdx = key.indexOf(':');
        const keyPrefix = colonIdx >= 0 ? key.slice(0, colonIdx) : '';
        if (projectIds.has(keyPrefix)) {
          await fs.unlink(sidecar).catch(() => {});
          removed++;
          continue;
        }
        // 项目根前缀命中（绝对路径形态 key，如 /…/BobWorkspace/<proj>/homework/x.md）
        let hit = false;
        for (const pid of projectIds) {
          const root = projectRootById.get(pid);
          if (!root) continue;
          if (key === root || key.startsWith(root + sep)) { hit = true; break; }
        }
        if (hit) {
          await fs.unlink(sidecar).catch(() => {});
          removed++;
          continue;
        }
      }
      if (targets.length === 0) continue;

      // 命中规则 3：文档文件删除 —— 把 key 归一化为候选绝对路径后比对
      const candidates: string[] = [];
      if (key.startsWith('/') || key.startsWith('~')) {
        // 绝对路径形态（含无 projectId 前缀、或 `projectId:/abs` 的后段）
        candidates.push(key.startsWith('~') ? key.replace(/^~/, process.env.HOME || '') : key);
      }
      if (key.includes(':')) {
        const colonIdx = key.indexOf(':');
        const prefix = key.slice(0, colonIdx);
        const rest = key.slice(colonIdx + 1);
        if (rest.startsWith('/') || rest.startsWith('~')) {
          candidates.push(rest.startsWith('~') ? rest.replace(/^~/, process.env.HOME || '') : rest);
        } else {
          // 相对路径形态：projectId:homework/x.md 或 projectId:materials/x.md
          const root = projectRootById.get(prefix);
          if (root) candidates.push(resolve(root, rest));
        }
      }

      let matched = false;
      for (const cand of candidates) {
        const normCand = resolve(cand);
        if (pathHit(normCand, targets)) { matched = true; break; }
      }
      if (matched) {
        await fs.unlink(sidecar).catch(() => {});
        removed++;
      }
    }
    return removed;
  } catch {
    // md-annotations 目录不存在或读取失败：无可清理，静默返回
    return 0;
  }
}

/** 便捷方法：按 key 精确删除单个 sidecar（ENOENT 视为成功） */
export async function deleteMdAnnotationSidecarByKey(key: string): Promise<boolean> {
  try {
    await fs.unlink(sidecarPathFor(key));
    return true;
  } catch { return false; }
}
