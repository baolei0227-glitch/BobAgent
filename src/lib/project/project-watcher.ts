/**
 * 项目工作区目录监听（磁盘变化 → 实时对账 → 通知前端刷新）
 *
 * 用 fs.watch 递归监听工作区大文件夹（内置 BobWorkspace + 自定义默认目录）：
 *  - 直接子目录增删（用户手动拖入/删除项目文件夹）→ 防抖后执行 syncProjectsFromDisk 磁盘对账，
 *    有变更则通过 project-events 广播 projects-changed（/api/projects/events SSE 推送给侧边栏）。
 *  - 项目内文件增删改（用户在 Finder 里直接操作 homework/materials 等可见目录）→ 广播 files-changed，
 *    驱动已展开项目的文件树实时刷新。
 *  文件树不可见的内容（隐藏文件/目录、notes-memory、wanted、sticky-notes 等内部数据路径）不触发
 *  files-changed，避免应用自身写库/写节点造成无谓的文件树刷新。
 * 由 instrumentation.ts 在服务启动时调用，不依赖任何第三方依赖（recursive 监听需 macOS/Windows）。
 */
import { watch, type FSWatcher, promises as fs } from 'fs';
import { getProjectWorkspaceDirs, syncProjectsFromDisk } from './project-manager';
import { emitProjectsChanged, emitProjectFilesChanged } from './project-events';

let started = false;
let debounceTimer: NodeJS.Timeout | null = null;
/** 防抖窗口内是否出现了影响文件树展示的变更（合并多次事件为一次推送） */
let pendingFilesChanged = false;
const watchers = new Map<string, FSWatcher>();

/** 启动工作区目录监听（幂等：重复调用只生效一次） */
export async function startProjectsDiskWatcher(): Promise<void> {
  if (started) return;
  started = true;
  await ensureWatchers();
  // 兜底：启动 3s 后先做一次全量对账，覆盖 watcher 挂起前已发生的磁盘变更
  setTimeout(() => {
    scheduleSync(false);
  }, 3000);
}

/** 为尚未监听的工作区目录补挂 watcher（用户切换默认保存位置后新目录也能被监听） */
async function ensureWatchers(): Promise<void> {
  let dirs: string[] = [];
  try {
    dirs = await getProjectWorkspaceDirs();
  } catch (e) {
    console.error('[project-watcher] 获取工作区目录失败:', e);
    return;
  }
  for (const dir of dirs) {
    if (watchers.has(dir)) continue;
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      continue; // 目录不可建（权限等），跳过监听，GET 惰性对账仍会兜底
    }
    let w: FSWatcher;
    try {
      // 递归监听整个工作区树：项目文件夹级增删 + 项目内文件增删改都能感知
      w = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
        const rel = typeof filename === 'string' ? filename : null;
        scheduleSync(!shouldIgnoreFsPath(rel));
      });
    } catch {
      // 仅 macOS/Windows 支持 recursive；不支持时回退单层监听（只对项目文件夹级增删对账）
      try {
        w = watch(dir, { persistent: false }, () => scheduleSync(false));
      } catch {
        continue;
      }
    }
    w.on('error', () => {
      watchers.delete(dir);
    });
    watchers.set(dir, w);
  }
}

/** 防抖触发磁盘对账 + 广播（事件风暴合并为一次） */
function scheduleSync(notifyFiles: boolean): void {
  if (notifyFiles) pendingFilesChanged = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    const shouldNotifyFiles = pendingFilesChanged;
    pendingFilesChanged = false;
    try {
      // 对账前补挂可能新增的监听（自定义目录切换）
      await ensureWatchers();
      const changed = await syncProjectsFromDisk();
      if (changed) emitProjectsChanged();
      // 项目列表有变（增删/复活）必然影响文件树；可见文件变更则按需推送
      if (changed || shouldNotifyFiles) emitProjectFilesChanged();
    } catch (e) {
      console.error('[project-watcher] 磁盘对账失败:', e instanceof Error ? e.message : String(e));
    }
  }, 800);
}

/** 判断递归事件对应的相对路径是否属于文件树不可见内容（命中则无需推送 files-changed）：
 *  - 隐藏文件/目录（.project.db / .ai-workspace / .DS_Store 等）
 *  - 应用内部数据目录（notes-memory / wanted / sticky-notes，文件树扫描时跳过）
 *  filename 以被监听的工作区目录为根，形如 "<项目名>/<子路径>"；无路径信息时保守按可见变更处理。 */
function shouldIgnoreFsPath(filename: string | null): boolean {
  if (!filename) return false;
  const segs = filename.split('/');
  // 任意层级的隐藏条目都不影响文件树展示（隐藏项在扫描时被整体跳过）
  if (segs.some((s) => s.startsWith('.'))) return true;
  // 文件树扫描跳过这些项目内部数据目录（第二段起，第一段是项目文件夹名）
  if (segs.length > 1) {
    const inner = segs.slice(1);
    if (inner.includes('notes-memory') || inner.includes('wanted') || inner.includes('sticky-notes')) {
      return true;
    }
  }
  return false;
}
