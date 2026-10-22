/**
 * 计划树数据层 —— 项目私有 `.butler/plans.json` 的类型契约与读写。
 *
 * 背景：计划树此前整套（类型 + 读写 + 派生计算）都内联在 butler 工具执行体
 * （`app/api/chat/tools/butler.ts`）里，导致「界面想只读展示计划」时无处可依，
 * 只能复制一份解析逻辑 —— 计划落盘结构一旦调整，两份实现就会静默漂移。
 * 现把**数据层**（类型 / 落盘路径 / 读写 / 派生视图）收拢到本模块：
 *   - butler 工具（写侧：创建/推进/收尾）与只读 HTTP API（`GET /api/projects/plans`）共用同一契约；
 *   - 工具执行/状态机（转场规则、渲染文案）仍留在 butler.ts，属交互层，不下沉。
 *
 * 落盘结构：`{ plans: ProjectPlan[] }`（原子写：先写 tmp 再 rename，避免半截文件）。
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join } from 'path';

/** 步骤状态：pending 待办 / in_progress 进行中 / done 完成 / blocked 受阻 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

/** 计划步骤：title/status 为骨架；due / owner / artifact 为可选登记项（旧数据无这些字段，向后兼容）：
 *  - due     ：期望完成时间（ISO 或日期串，不强制解析）
 *  - owner   ：责任人 / 负责 agent
 *  - artifact：该步骤产出物的路径或名称（便于事后定位）
 */
export type PlanStep = {
  id: string;
  title: string;
  status: PlanStepStatus;
  note?: string;
  due?: string;
  owner?: string;
  artifact?: string;
};

/** 里程碑：其下步骤全 done 才置 done（见 butler.ts recalcMilestone） */
export type PlanMilestone = {
  id: string;
  title: string;
  status: 'active' | 'done';
  steps: PlanStep[];
};

/** 计划状态：active 进行中；done 完成；abandoned 放弃 —— done/abandoned 为终态 */
export type PlanStatus = 'active' | 'done' | 'abandoned';

export type ProjectPlan = {
  id: string;
  title: string;
  goal?: string;
  status: PlanStatus;
  milestones: PlanMilestone[];
  createdAt: string;
  updatedAt: string;
};

/** 计划落盘目录 / 文件名（项目根下） */
export const PLANS_DIR = '.butler';
export const PLANS_FILE = 'plans.json';

/** 计划停滞判定阈值（天）：plan.updatedAt 距今达到该天数仍为 active → 视为停滞。
 *  与管家 project_plans_overview 的默认阈值、Today 建议的「计划停滞」口径保持一致。 */
export const PLAN_STALLED_DAYS = 14;

/** 读取某项目的计划树；文件缺失 / 损坏一律返回空数组（不打断调用方） */
export async function readProjectPlans(root: string): Promise<ProjectPlan[]> {
  try {
    const raw = await readFile(join(root, PLANS_DIR, PLANS_FILE), 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.plans) ? (data.plans as ProjectPlan[]) : [];
  } catch {
    return [];
  }
}

/** 原子写入计划树（tmp + rename） */
export async function writeProjectPlans(root: string, plans: ProjectPlan[]): Promise<void> {
  const dir = join(root, PLANS_DIR);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${PLANS_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
  await writeFile(tmp, JSON.stringify({ plans }, null, 2), 'utf-8');
  await rename(tmp, join(dir, PLANS_FILE));
}

/** 距今整日数（负数 = 未来；无法解析 → null） */
export function daysUntil(dateStr: string): number | null {
  const ms = new Date(dateStr).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.ceil((ms - Date.now()) / 86400000);
}

/** 逾期步骤（已过期仍未完成） */
export interface OverdueStep {
  step: string;
  stepId: string;
  milestone: string;
  due: string;
  /** 逾期天数（正数） */
  daysOverdue: number;
}

/** 单个计划的派生视图（进度 / 逾期 / 下一到期）—— 只读展示与总览共用，避免两处各算一遍 */
export interface PlanSummary {
  /** 步骤总数 */
  steps: number;
  /** 已完成步骤数 */
  done: number;
  /** 已过期未完成步骤（按 due 升序） */
  overdue: OverdueStep[];
  /** 未完成步骤里最早的 due（无则 null） */
  nextDue: string | null;
  /** 计划最近更新距今天数（>=0 = 多少天前；无法解析 → null） */
  updatedDaysAgo: number | null;
}

/** 汇总单个计划：进度、逾期步骤、下一到期、距今更新天数 */
export function summarizePlan(plan: ProjectPlan): PlanSummary {
  const overdue: OverdueStep[] = [];
  let nextDue: string | null = null;
  let steps = 0;
  let done = 0;

  for (const m of plan.milestones) {
    for (const s of m.steps) {
      steps += 1;
      if (s.status === 'done') done += 1;
      if (!s.due) continue;
      const d = daysUntil(s.due);
      if (d === null) continue;
      if (s.status !== 'done' && d < 0) {
        overdue.push({ step: s.title, stepId: s.id, milestone: m.title, due: s.due, daysOverdue: -d });
      } else if (s.status !== 'done' && (nextDue === null || s.due < nextDue)) {
        nextDue = s.due;
      }
    }
  }

  overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);
  const updated = daysUntil(plan.updatedAt);
  return { steps, done, overdue, nextDue, updatedDaysAgo: updated === null ? null : -updated };
}
