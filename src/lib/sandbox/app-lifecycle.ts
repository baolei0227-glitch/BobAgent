/**
 * 小程序生命周期级联（2026-10-10 新增）—— 删除一个「小程序」时，把它在 BobWork 里的
 * 其它"连接点"一起收干净。
 *
 * 为什么需要：删除原实现只 `rm -rf apps/<appId>/`，而一个 appId 还散落在这些地方：
 *   1) settings.json 的 sandboxChatPermissions / sandboxGraphPermissions（授权表）
 *   2) 各项目 notes-memory/*.md 节点 frontmatter 的 `sandbox_app_id`（画布节点绑定）
 *      —— 不清理会让该 Coding 节点**永久** "Write failed: 原子写入小程序文件失败"
 *   3) 客户端 localStorage 的标星表（服务端删不到 → 由 UI 广播 sandbox-deleted 后自清）
 *   4) 预览页所在标签页（桥是无状态的，靠存在性闸让下一次调用 410）
 *
 * 语义（2026-10-10 定）：节点绑定被**自动清空、节点保留**，并在返回值里报告解绑数量。
 */

import { join } from 'path';
import { readdir, readFile, writeFile } from 'fs/promises';
import { resolveAppRoot, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';
import { listProjects } from '@/lib/project/project-manager';
import { readSettingsFromFile, writeSettingsToFile } from '@/lib/settings-server';
import { sanitizeAppId, trashApp, type SandboxApp } from './apps';

export interface DeleteCascadeResult {
  ok: boolean;
  appId?: string;
  trashId?: string;
  /** 被解绑的节点文件数 */
  nodesUnbound: number;
  /** 是否清掉了授权表里的条目 */
  permissionsCleared: boolean;
  reason?: string;
}

/** 清掉授权表里该 appId 的两条记录（chat / graph）。返回是否真的删掉了东西。 */
export async function clearAppPermissions(appId: string): Promise<boolean> {
  const safeId = sanitizeAppId(appId);
  if (!safeId) return false;
  try {
    const settings = await readSettingsFromFile();
    let changed = false;
    for (const key of ['sandboxChatPermissions', 'sandboxGraphPermissions'] as const) {
      const table = settings[key] as Record<string, unknown> | undefined;
      if (table && Object.prototype.hasOwnProperty.call(table, safeId)) {
        delete table[safeId];
        changed = true;
      }
    }
    if (changed) await writeSettingsToFile(settings);
    return changed;
  } catch {
    return false;
  }
}

/** frontmatter 里去掉引用该 appId 的 `sandbox_app_id` 行（只在首个 frontmatter 块内动手）。 */
export function stripSandboxAppId(md: string, appId: string): string | null {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = m[1];
  const line = new RegExp(`^[ \\t]*sandbox_app_id:[ \\t]*["']?${appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?[ \\t]*$`, 'm');
  if (!line.test(fm)) return null;
  const nextFm = fm.split('\n').filter((l) => !line.test(l)).join('\n');
  return md.replace(m[0], `---\n${nextFm}\n---`);
}

/**
 * 扫所有项目（含归档/回收站项目）的 notes-memory/*.md，把引用该 appId 的节点解绑。
 * 返回被改写的节点文件数。单个文件失败不影响其它文件。
 */
export async function unbindNodesFromApp(appId: string): Promise<number> {
  const safeId = sanitizeAppId(appId);
  if (!safeId) return 0;
  const { projects } = await listProjects().catch(() => ({ projects: [] as Array<{ path: string }> }));
  let count = 0;
  for (const project of projects) {
    if (!project?.path) continue;
    const dir = join(project.path, 'notes-memory');
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const file = join(dir, f);
      try {
        const raw = await readFile(file, 'utf-8');
        const next = stripSandboxAppId(raw, safeId);
        if (next === null) continue;
        await writeFile(file, next, 'utf-8');
        count += 1;
      } catch {
        /* 单文件失败跳过 */
      }
    }
  }
  return count;
}

/** 删除小程序 = 进回收站 + 清授权表 + 解绑节点。 */
export async function deleteAppCascade(id: unknown): Promise<DeleteCascadeResult> {
  const safeId = sanitizeAppId(id);
  if (!safeId) return { ok: false, nodesUnbound: 0, permissionsCleared: false, reason: 'invalid appId' };
  const trashed = await trashApp(safeId);
  if (!trashed.ok) {
    return { ok: false, nodesUnbound: 0, permissionsCleared: false, reason: trashed.reason || 'trash failed' };
  }
  const [permissionsCleared, nodesUnbound] = await Promise.all([
    clearAppPermissions(safeId),
    unbindNodesFromApp(safeId),
  ]);
  return { ok: true, appId: safeId, trashId: trashed.trashId, nodesUnbound, permissionsCleared };
}

/** 孤儿巡检：apps/ 下没有可读 manifest 的"幽灵目录"（历史删除后又被 saveAppData 复活的那种）。 */
export async function listGhostAppDirs(): Promise<string[]> {
  const root = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const ghosts: string[] = [];
  for (const name of entries) {
    const safe = sanitizeAppId(name);
    if (!safe) {
      ghosts.push(name);
      continue;
    }
    try {
      const raw = await readFile(join(root, safe, 'manifest.json'), 'utf-8');
      const mf = JSON.parse(raw) as SandboxApp;
      if (typeof mf?.id !== 'string' || !mf.id) ghosts.push(safe);
    } catch {
      ghosts.push(safe);
    }
  }
  return ghosts;
}
