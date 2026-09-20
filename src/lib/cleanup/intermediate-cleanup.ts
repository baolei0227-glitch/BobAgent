/**
 * 中间产物定期清扫（homework/.ai-workspace 临时区 + 兜底工作区）
 *
 * AI 的中间产物（裁剪图、切片、临时脚本、中间数据）按系统提示词规则应写入各项目
 * homework/.ai-workspace/。本模块定期把其中超过保留期的文件清理掉，配合
 * 「任务结束自清理」彻底解决中间文件残留问题。
 * 另含兜底沙盒 exports/ 的「数量上限 + 过期时长」保留策略（导出页是产物，不用 7 天口径）。
 *
 * 安全边界：清理 homework/.ai-workspace/（隐藏临时区）与兜底工作区（~/BobWork/.sandbox）的
 * 根层文件，绝不触碰 homework/ 其他目录（交付物所在）与兜底工作区的子目录（各有归属）；
 * 每个项目独立处理，单项目文件数有上限防极端耗时。
 */
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { listProjects } from '@/lib/project/project-manager';
import { SANDBOX_DIRNAME } from '@/lib/app-root';

/** 中间产物保留天数（超过即清理） */
const INTERMEDIATE_MAX_AGE_DAYS = 7;

/** 清扫周期（毫秒）：每 6 小时一次 + 启动兜底一次 */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 单项目文件数量上限，防止极端情况下耗时过长 */
const MAX_FILES_PER_PROJECT = 5000;

/** 无激活项目时的兜底工作区：与 tools/shared.ts 的 getWorkspacePath() 回退同源，
 *  临时脚本直接落该目录根层。 */
const FALLBACK_WORKSPACE_DIR = join(homedir(), 'BobWork', SANDBOX_DIRNAME);

/** exports/ 目录保留上限（个）——导出页是可供分享的产物，额度比 captures 宽松些 */
const EXPORTS_KEEP_MAX = 30;

/** exports/ 目录保留时长（毫秒，超过即删） */
const EXPORTS_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** 递归清扫一个目录中超过截止时间的文件；空目录一并移除。返回删除的文件+目录数。
 *  `maxDepth` 限制递归层数：0 = 只清该目录自身的文件、不进入子目录
 *  （兜底工作区用——其子目录 homework/ captures/ exports/ 各有归属，不能按临时文件规则删）。 */
async function sweepDir(
  dir: string,
  cutoffMs: number,
  budget: { left: number },
  maxDepth = Number.POSITIVE_INFINITY,
): Promise<number> {
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
        if (maxDepth <= 0) continue; // 达到层数上限：子目录不归本清扫管
        removed += await sweepDir(full, cutoffMs, budget, maxDepth - 1);
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

/**
 * 清理兜底沙盒 exports/（沙盒小程序导出的独立页面）：只保留最近 EXPORTS_KEEP_MAX 个，
 * 且删除超过 EXPORTS_KEEP_MS 的旧文件——数量上限防堆积，过期策略保证「不再导出也会被清」。
 * 只处理 .html（导出产物），按 mtime 排序，单个失败静默。返回删除数。
 */
async function pruneExportsDir(): Promise<number> {
  const dir = join(FALLBACK_WORKSPACE_DIR, 'exports');
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const htmls = entries.filter((n) => n.toLowerCase().endsWith('.html'));
  const stats = await Promise.all(
    htmls.map(async (n) => {
      try {
        const st = await fs.stat(join(dir, n));
        return { name: n, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const files = stats.filter((s): s is { name: string; mtimeMs: number } => s !== null);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs); // 新的在前

  const now = Date.now();
  const toRemove = new Set<string>();
  for (const f of files) {
    if (now - f.mtimeMs > EXPORTS_KEEP_MS) toRemove.add(f.name);
  }
  for (let i = EXPORTS_KEEP_MAX; i < files.length; i++) {
    toRemove.add(files[i]!.name);
  }

  let removed = 0;
  for (const name of toRemove) {
    try {
      await fs.rm(join(dir, name), { force: true });
      removed++;
    } catch {
      /* 单个失败忽略 */
    }
  }
  return removed;
}

/** 全量清扫：遍历所有项目（含归档/垃圾桶，均为磁盘上的真实残留），
 *  删除各自 homework/.ai-workspace/ 中超过保留期的文件；
 *  另清扫无激活项目时的兜底工作区（见 FALLBACK_WORKSPACE_DIR 注释）。返回删除总数。 */
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
  // 兜底工作区不在项目列表内（getWorkspacePath 在无激活项目时回退到这里，临时脚本直接落根层），
  // 只清根层文件、不递归：其子目录各有归属——homework/（无项目时的交付物）、
  // captures/（浏览器截图，另有 pruneCaptureDir 保留最近 20 张）、exports/（导出页面，按下方保留策略清理）、wechat-media/。
  totalRemoved += await sweepDir(FALLBACK_WORKSPACE_DIR, cutoffMs, { left: MAX_FILES_PER_PROJECT }, 0);
  // exports/ 单独按「数量上限 + 过期时长」清理，不套用中间产物的 7 天口径
  totalRemoved += await pruneExportsDir();
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
          `[intermediate-cleanup] 清理 ${removed} 个文件（中间产物保留 ${INTERMEDIATE_MAX_AGE_DAYS} 天；exports 保留最近 ${EXPORTS_KEEP_MAX} 个 / ${EXPORTS_KEEP_MS / (24 * 60 * 60 * 1000)} 天）`,
        );
      }
    } catch (e) {
      console.error('[intermediate-cleanup] 清扫失败:', e instanceof Error ? e.message : String(e));
    }
  };

  setTimeout(() => { void run(); }, 10_000);
  setInterval(() => { void run(); }, SWEEP_INTERVAL_MS);
}
