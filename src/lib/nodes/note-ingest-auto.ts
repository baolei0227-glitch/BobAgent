/**
 * src/lib/nodes/note-ingest-auto.ts
 * 研究结论回流触发器（挂在 append 之后，后台跑、用户零等待）。
 *
 * 与成果块自动提炼（./outcome-auto.ts）同构：静默窗 + 单飞 + 游标幂等；
 * 两处**故意不同**：
 *   1) 不做「陈旧上限」兜底 —— 回流是最佳努力，节点持续有输入时晚一批不影响正确性
 *      （游标语义覆盖全部轮次，下次静默窗一并消化）；成果块有锁定闸门才需要它。
 *   2) 排在 'compile' 优先级（成果块提炼 > 研究回流/账本编译），不与成果块抢模型。
 *
 * 是否真的回流由 ./note-ingest-generate 判定：非研究轮次不调模型、不写盘。
 */

import { runBackground } from '@/lib/runtime/project-scheduler';
import { generateNotesFromResearch } from '@/lib/nodes/note-ingest-generate';

/** 静默窗：最后一次 append 之后等这么久再回流（期间又有 append 则重新计时） */
const QUIET_MS = 15_000;

/** 每个节点一个待触发计时器（key = 节点 .md 绝对路径） */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** 正在回流的节点（同节点同时只跑一次，避免并发写同一份 .md 游标） */
const running = new Set<string>();

/**
 * 节点对话落盘后调用（append 成功后）：安排一次研究结论回流。
 * 不阻塞调用方 —— 本轮回答照常返回，回流在后台静默窗后开始。
 */
export function notifyResearchNoteIngest(filePath: string, projectRoot: string): void {
  const pending = timers.get(filePath);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    timers.delete(filePath);
    void refine(filePath, projectRoot);
  }, QUIET_MS);
  // 后台任务不阻止进程退出
  timer.unref?.();
  timers.set(filePath, timer);
}

/** 静默窗到期：交给项目级调度（用户对话在跑时只排队等，不抢模型） */
async function refine(filePath: string, projectRoot: string): Promise<void> {
  if (running.has(filePath)) return;
  running.add(filePath);
  try {
    await runBackground(projectRoot, 'compile', async () => {
      const result = await generateNotesFromResearch(filePath);
      if (!result.ok) {
        // 未配置模型 / 笔记库未启用 / 模型报错：静默，不打扰用户
        console.warn(`[note-ingest] 回流未完成(${filePath}): ${result.error}`);
      }
    });
  } catch (e) {
    console.warn('[note-ingest] 回流异常（已吞）:', e instanceof Error ? e.message : String(e));
  } finally {
    running.delete(filePath);
  }
}