/**
 * src/lib/nodes/outcome-auto.ts
 * 成果块自动生成触发器（挂在 append 之后，后台跑、用户零等待）。
 *
 * 为什么是「静默窗 + 单飞」而不是「一轮一调」：
 * 提炼一次要读完整对话记录，成本随轮次增长；用户连问几轮时若每轮都调，既贵又会被
 * 后一轮覆盖前一轮的结果（纯浪费）。所以每轮 append 只重置计时器，等这个节点**静默**
 * 一段时间（没人再追问）后提炼一次，覆盖当时为止的全部轮次。
 *
 * 幂等：以 frontmatter 的 outcome_turns 为「已覆盖到第几轮」的游标 —— 无新轮次且成果块
 * 非空则直接跳过（不调模型）；R-9 已锁定节点不重写（由 generateOutcomeForNode 兜住）。
 */

import { promises as fs } from 'fs';
import { parseNodeMarkdown } from '@/lib/node-markdown';
import { generateOutcomeForNode, isOutcomeBlank } from '@/lib/nodes/outcome-generate';
import { emitNodeOutcomeChanged } from '@/lib/project/project-events';
import { runBackground } from '@/lib/runtime/project-scheduler';

/** 静默窗：最后一次 append 之后等这么久再提炼（期间又有 append 则重新计时） */
const QUIET_MS = 15_000;

/** 陈旧上限（静默窗的反面兜底）：节点一直有输入就永远等不到静默 ——
 *  律师连续追问、团队轮流在同一节点补材料，成果块会一直停在旧版本。
 *  连续输入累计到这么多轮即无视静默立即提炼一次。
 *
 *  为什么只有轮数判据、没有并行的「超 N 分钟」判据：静默窗只有 15s，
 *  只要两次输入间隔 ≥15s，静默提炼必然先触发并把计数清零；
 *  能一直排在待提炼状态就意味着间隔始终 <15s，那样累计轮数早在几分钟内先到上限 ——
 *  时间判据恒不可达（除非它先于轮数上限，而 QUIET_MS 决定了这不可能）。 */
const MAX_PENDING_TURNS = 8;

/** 每个节点一个待触发计时器（key = 节点 .md 绝对路径） */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** 正在提炼的节点（同节点同时只跑一次，避免并发写同一份 .md） */
const running = new Set<string>();
/** 距上次提炼累计的输入次数（陈旧上限的判据；每次 append 计一次） */
const pendingCount = new Map<string, number>();

/** 清掉该节点的待触发状态（提炼已开始 / 已被在跑的提炼覆盖） */
function clearPending(filePath: string): void {
  pendingCount.delete(filePath);
}

/**
 * 节点对话落盘后调用（append 成功后）：安排一次成果块提炼。
 * 不阻塞调用方 —— 本轮回答照常返回，提炼在后台静默窗后开始。
 * projectRoot 用于项目级调度（用户对话 > 成果块提炼 > 账本编译，见 @/lib/runtime/project-scheduler）。
 */
export function notifyNodeConversationAppended(filePath: string, projectRoot: string): void {
  const pending = timers.get(filePath);
  if (pending) clearTimeout(pending);

  const count = (pendingCount.get(filePath) ?? 0) + 1;
  pendingCount.set(filePath, count);

  // 陈旧上限：累计输入轮数到位 → 立即提炼（不再等静默）
  const overdue = count >= MAX_PENDING_TURNS;

  const timer = setTimeout(() => {
    timers.delete(filePath);
    void refine(filePath, projectRoot);
  }, overdue ? 0 : QUIET_MS);
  // 后台任务不阻止进程退出
  timer.unref?.();
  timers.set(filePath, timer);
}

/** 静默窗到期：判断是否真的需要提炼，需要才调模型 */
async function refine(filePath: string, projectRoot: string): Promise<void> {
  if (running.has(filePath)) {
    clearPending(filePath);
    return;
  }
  running.add(filePath);
  clearPending(filePath);
  try {
    // 项目级互斥 + 优先级：用户对话在跑时这里只排队等，不抢模型。排队不丢信息 ——
    // 真正提炼时才读文件，读到的是当时为止的全部轮次（新轮次落盘也会覆盖进去）。
    await runBackground(projectRoot, 'outcome', async () => {
      const node = parseNodeMarkdown(await fs.readFile(filePath, 'utf-8'));
      if (node.frontmatter.outcome_status === 'locked') return;
      if (node.conversations.length === 0) return;
      // 无新轮次且已有成果块 → 无需提炼
      const coveredTurns = node.frontmatter.outcome_turns ?? 0;
      if (node.conversations.length <= coveredTurns && !isOutcomeBlank(node.outcome)) return;

      const result = await generateOutcomeForNode(filePath);
      if (!result.ok) {
        // 未配置模型 / 无对话 / 模型报错：静默，不打扰用户（锁定时仍会正经报错兜底）
        console.warn(`[outcome-auto] 自动提炼未完成(${filePath}): ${result.error}`);
        return;
      }
      // 通知前端刷新该节点状态：提炼发生在服务端后台，画布上的成果块/锁图标不会自己知道
      emitNodeOutcomeChanged(node.frontmatter.node_id);

      // 提炼期间又来了新轮次 → 再等一个静默窗补提炼（否则这几轮会漏在成果块外）
      const after = parseNodeMarkdown(await fs.readFile(filePath, 'utf-8'));
      if (after.frontmatter.outcome_status !== 'locked' &&
          after.conversations.length > (after.frontmatter.outcome_turns ?? 0)) {
        notifyNodeConversationAppended(filePath, projectRoot);
      }
    });
  } catch (e) {
    console.warn('[outcome-auto] 自动提炼异常（已吞）:', e instanceof Error ? e.message : String(e));
  } finally {
    running.delete(filePath);
  }
}