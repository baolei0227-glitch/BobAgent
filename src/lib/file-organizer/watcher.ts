/**
 * 文件自动整理 —— 应用运行期常驻监听投递箱（由设置里的开关驱动）。
 *
 * 设置「File Organizer」开启且配好投递箱目录时，监听该目录：
 * 放入新文件 → 静置 + 防抖 → 复用 CLI 同一套流程改名并移入分类子目录。
 * 由 instrumentation.ts 在服务启动时拉起；开关/目录变更通过周期对账感知，
 * 因此应用运行期间随时改设置都能生效（应用未运行时不做任何事）。
 */
import { watch, type FSWatcher, promises as fs } from 'fs';
import { basename, isAbsolute, resolve } from 'path';

import { readSettingsFromFile } from '@/lib/settings-server';
import { SETTLE_MS, commitPlan, scanAndPlan } from '../../../tools/organize/core';
import { normalizeCategories } from '../../../tools/organize/model';
import { appendLog, normalizeNaming, todayStamp, type MoveRecord } from '../../../tools/organize/naming';

/** 监听事件防抖窗口（毫秒） */
const DEBOUNCE_MS = 2500;
/** 设置对账间隔（毫秒）：开关/目录变更最迟这么久生效 */
const RECONCILE_MS = 5000;

let started = false;
let folderWatcher: FSWatcher | null = null;
let watchedDir = '';
let debounceTimer: NodeJS.Timeout | null = null;
let busy = false;
/** 上次已告警的缺失目录：避免 reconcile 周期重复打印同一条警告 */
let warnedMissingDir = '';

/** 启动常驻监听（幂等：重复调用只生效一次） */
export async function startFileOrganizerWatcher(): Promise<void> {
  if (started) return;
  started = true;
  await reconcile();
  const timer = setInterval(() => void reconcile(), RECONCILE_MS);
  timer.unref?.();
}

/** 按当前设置对齐监听状态：未开启/未配目录 → 不监听；目录变化 → 重挂 */
async function reconcile(): Promise<void> {
  let dir = '';
  try {
    const settings = await readSettingsFromFile();
    const fo = settings.fileOrganizer ?? {};
    if (fo.enabled === true) dir = (fo.inboxDir ?? '').trim();
  } catch (e) {
    console.error('[file-organizer] 读取设置失败:', e);
    return;
  }

  if (!dir) {
    closeFolderWatcher();
    return;
  }
  const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  if (abs === watchedDir && folderWatcher) return;
  closeFolderWatcher();
  await openFolderWatcher(abs);
}

/** 挂载投递箱监听：非递归（分类子目录由本工具创建，不需要监听其内部） */
async function openFolderWatcher(dir: string): Promise<void> {
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) {
    if (dir !== warnedMissingDir) {
      console.warn(`[file-organizer] 投递箱目录不存在或不是目录，暂不监听：${dir}`);
      warnedMissingDir = dir;
    }
    return;
  }
  try {
    const w = watch(dir, { persistent: false }, () => schedule());
    w.on('error', (e) => {
      console.error('[file-organizer] 监听中断:', e);
      if (folderWatcher === w) closeFolderWatcher();
    });
    folderWatcher = w;
    watchedDir = dir;
    warnedMissingDir = '';
    console.log(`[file-organizer] 已监听投递箱：${dir}`);
    schedule(SETTLE_MS); // 切换/启动后先扫一遍，覆盖监听挂上前放入的文件
  } catch (e) {
    console.error(`[file-organizer] 无法监听 ${dir}:`, e);
  }
}

function closeFolderWatcher(): void {
  if (folderWatcher) {
    try { folderWatcher.close(); } catch { /* 忽略关闭异常 */ }
  }
  folderWatcher = null;
  watchedDir = '';
}

function schedule(ms = DEBOUNCE_MS): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void tick();
  }, ms);
  debounceTimer.unref?.();
}

/** 整理一轮：仍在写入的文件稍后自动重试 */
async function tick(): Promise<void> {
  const root = watchedDir;
  if (!root || busy) return;
  busy = true;
  let retry = false;
  try {
    const settings = await readSettingsFromFile();
    const fo = settings.fileOrganizer ?? {};
    if (fo.enabled !== true) {
      closeFolderWatcher();
      return;
    }

    const { plans, total, writing } = await scanAndPlan({
      root,
      categories: normalizeCategories(fo.categories),
      stamp: todayStamp(),
      settle: true,
      naming: normalizeNaming(fo.naming),
    });
    if (total === 0) return;

    const records: MoveRecord[] = [];
    for (const plan of plans) {
      try {
        const rec = await commitPlan(plan);
        records.push(rec);
        console.log(
          `[file-organizer] ${basename(rec.from)} → ${rec.category}/${basename(rec.to)}`
          + `（置信度 ${Math.round(rec.confidence * 100)}%）`,
        );
      } catch (e) {
        console.error(`[file-organizer] 整理失败 ${basename(plan.from)}:`, e);
      }
    }
    if (records.length > 0) await appendLog(root, records);
    retry = writing.length > 0;
  } catch (e) {
    console.error('[file-organizer] 整理出错:', e);
  } finally {
    busy = false;
  }
  if (retry) schedule(SETTLE_MS);
}
