/**
 * 中间产物定期清扫（homework/.ai-workspace 临时区）
 *
 * AI 的中间产物（裁剪图、切片、临时脚本、中间数据）按系统提示词规则应写入各项目
 * homework/.ai-workspace/。本模块定期把其中超过保留期的文件清理掉，配合
 * 「任务结束自清理」彻底解决中间文件残留问题。
 *
 * 安全边界：只清理 homework/.ai-workspace/（隐藏临时区），绝不触碰 homework/
 * 其他目录（交付物所在）；每个项目独立处理，单项目文件数有上限防极端耗时。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { listProjects } from '@/lib/project/project-manager';

/** 中间产物保留天数（超过即清理） */
const INTERMEDIATE_MAX_AGE_DAYS = 7;

/** 清扫周期（毫秒）：每 6 小时一次 + 启动兜底一次 */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 单项目文件数量上限，防止极端情况下耗时过长 */
const MAX_FILES_PER_PROJECT = 5000;

/** 递归清扫一个目录中超过截止时间的文件；空目录一并移除。返回删除的文件+目录数。 */
async function sweepDir(dir: string, cutoffMs: number, budget: { left: number }): Promise<number> {
  if (budget.left <= 0) return 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // 目录不存在/不可读
  }

  let removed = 0;
  for (const entry of entries) {
    if (budget.left <= 0) break;
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        removed += await sweepDir(full, cutoffMs, budget);
        // 清空后的空目录一并移除（避免残留空壳）
        const rest = await fs.readdir(full).catch(() => []);
        if (rest.length === 0) {
          await fs.rm(full, { recursive: true, force: true });
          removed++;
        }
      } else {
        const st = await fs.stat(full);
        if (st.mtimeMs < cutoffMs) {
          await fs.rm(full, { force: true });
          removed++;
          budget.left--;
        }
      }
    } catch {
      /* 单文件失败忽略，不阻塞整轮清扫 */
    }
  }
  return removed;
}

/** 全量清扫：遍历所有项目（含归档/垃圾桶，均为磁盘上的真实残留），
 *  删除各自 homework/.ai-workspace/ 中超过保留期的文件。返回删除总数。 */
export async function sweepIntermediateFiles(): Promise<number> {
  let projects: Array<{ id: string; path: string }> = [];
  try {
    const res = await listProjects();
    projects = res.projects.map((p) => ({ id: p.id, path: p.path }));
  } catch (e) {
    console.error('[intermediate-cleanup] 读取项目列表失败:', e instanceof Error ? e.message : String(e));
    return 0;
  }

  const cutoffMs = Date.now() - INTERMEDIATE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let totalRemoved = 0;
  for (const proj of projects) {
    const wsDir = join(proj.path, 'homework', '.ai-workspace');
    totalRemoved += await sweepDir(wsDir, cutoffMs, { left: MAX_FILES_PER_PROJECT });
  }
  return totalRemoved;
}

let sweeperStarted = false;

/** 启动定期清扫（幂等）：启动 10s 后先跑一次兜底，之后每 6 小时一次。 */
export function startIntermediateCleanupSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;

  const run = async () => {
    try {
      const removed = await sweepIntermediateFiles();
      if (removed > 0) {
        console.log(
          `[intermediate-cleanup] 清理 ${removed} 个过期中间文件（homework/.ai-workspace，保留 ${INTERMEDIATE_MAX_AGE_DAYS} 天）`,
        );
      }
    } catch (e) {
      console.error('[intermediate-cleanup] 清扫失败:', e instanceof Error ? e.message : String(e));
    }
  };

  setTimeout(() => { void run(); }, 10_000);
  setInterval(() => { void run(); }, SWEEP_INTERVAL_MS);
}
