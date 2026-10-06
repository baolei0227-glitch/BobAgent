/**
 * lib/butler/runtime.ts —— Butler 运行时门面（server-only，Phase 3 §3.1）
 *
 * 定位：Butler **一切主动行为**的唯一入口。此前 Butler 的「运行」散落两处——
 *   ① 主链路 /api/chat 的 butler 分支（每轮 POST 里搭车一次裁决）；
 *   ② 抽屉对话 streamButlerChat（形态上是临时聊天节点，`source ?? 'panel'`）。
 * 没有任何一个地方能回答「Butler 这一刻该做什么」。本门面把这件事收敛成唯一入口 butlerTick()。
 *
 * 边界表（本 Phase 的核心产物；「对话层」与「运行层」严格分开）：
 *
 *   | 环节                                    | 归属                  | 说明                            |
 *   | --------------------------------------- | --------------------- | ------------------------------- |
 *   | 用户交互（说、点、确认）                | **对话层**            | 只有这里经过 chat 传输          |
 *   | 自然语言回复的生成                      | **对话层**            | 仍需模型                        |
 *   | 能力注册 / 匹配 / 执行 / 信号回写 / 版本管理 | **运行层（Butler 自有）** | 不经模型，不经 SSE 流       |
 *   | 落盘（rules / skills / state / logs）   | **存储层**            | 复用 butlerRoot() / STATE_DIR   |
 *
 * 关键：本文件**只做编排与边界，不含新逻辑**——候选生成 / 裁决 / 执行 / 信号回写
 * 全部沿用 Phase 1/2 的既有实现（rule-exec.adjudicateAndExecute），保证零行为变更、可独立验证。
 * 定时候选（rule-timer.dueTimerRules）与语面/场景候选同源，沿用既有幂等反查（读 hits），不新增计数器。
 */
import { listRules } from './rules';
import { dueTimerRules, missedTimerRules, type MissedTimerHit } from './rule-timer';
import {
  adjudicateAndExecute,
  type AdjudicateResult,
  type RuleAnchor,
} from './rule-exec';
import { rememberFromText, type LearnOutcome } from './rule-nearmiss';
import { sweepForgottenDrafts } from './rule-forget';

/**
 * 触发源：Butler 被唤醒的原因。
 *   - `speech`：用户在对话里说了一句话（主链路 / 抽屉对话）；
 *   - `scene` ：场景切换（进入某项目 / 打开某面板）；
 *   - `timer` ：时间到达（独立 tick 端点，不依赖对话）；
 *   - `skill-match`：技能适用条件命中（3c 起启用）。
 * 目前四条触发源共用同一套「能力匹配 → 裁决 → 执行 → 信号回写」内核；
 * kind 只作语义标注，便于后续按触发源分档（例如 scene 触发可跳过语面候选）。
 */
export type ButlerTrigger =
  | { kind: 'speech'; text: string; scene?: string }
  | { kind: 'scene'; scene?: string; text?: string }
  | { kind: 'timer' }
  | { kind: 'skill-match'; text?: string; scene?: string };

export interface ButlerTickInput {
  trigger: ButlerTrigger;
  /** 运行锚点：当前项目 / 会话线程（作用域具体度判定与预算计数用） */
  anchor: RuleAnchor;
}

/** 从触发源取本轮语面（仅 speech / scene / skill-match 带文本；timer 无用户话） */
function triggerText(trigger: ButlerTrigger): string {
  if (trigger.kind === 'speech') return trigger.text;
  if (trigger.kind === 'scene' || trigger.kind === 'skill-match') return trigger.text ?? '';
  return '';
}

/** 心跳结果：裁决结果 + 「错过且不会补跑」的定时实例（只用于告知，见 `missedTimerRules`） */
export type ButlerTickResult = AdjudicateResult & {
  missed: MissedTimerHit[];
  /** 本轮「一次即记忆」的产物（新建 / 印证 draft）；无动作时缺省 */
  learned?: LearnOutcome | null;
  /** 本轮惰性遗忘清除的 draft（供审计；无则缺省） */
  forgotten?: { id: string; name: string }[];
};

/**
 * Butler 心跳：能力匹配 → 裁决 → 执行 → 信号回写。
 *
 * 与既有 /api/chat butler 分支**行为完全一致**（3a 是零行为变更的重构）：
 * 先查「已到期且未执行过」的周期规则（幂等去重由 rule-timer 读 hits 完成，不新增计数器），
 * 再把语面 + 定时候选一起交 adjudicateAndExecute 裁决；返回一行状态陈述（notice）供调用方注入上下文。
 * 执行与写 hits 由 rule-exec 统一负责（不变量 7：运行层不写盘状态，只产决策与陈述）。
 *
 * `missed`（2026-10-02 新增）：应用未运行期间错过、且超出 24h 补偿窗口的实例。
 * 只挂在**定时**触发上——语面触发时用户就在跟前，此时报告「你不在时错过了」既是噪音也无意义。
 */
export async function butlerTick(input: ButlerTickInput): Promise<ButlerTickResult> {
  const { trigger, anchor } = input;
  const now = new Date();
  const activeRules = (await listRules()).filter((r) => r.status === 'active');
  const timerHits = await dueTimerRules(activeRules, now);
  const result = await adjudicateAndExecute({
    text: triggerText(trigger),
    anchor,
    timerHits,
  });
  const missed = trigger.kind === 'timer' ? await missedTimerRules(activeRules, now) : [];

  // 主动遗忘（惰性 sweep，不接调度器）：清理超期 draft；失败不影响主链路。
  const forgotten = await sweepForgottenDrafts(now).catch(() => [] as { id: string; name: string }[]);

  // 「一次即记忆」：只在**用户说话**时学（scene/timer 无用户原话，学了也无意义）。
  // 命中弱触发且尚无覆盖规则 → 静默落一条 draft（不执行、不打扰），冒头走面板「待确认」收件箱（拉模式）。
  const learned = trigger.kind === 'speech' ? await rememberFromText(trigger.text).catch(() => null) : null;

  return { ...result, missed, learned, ...(forgotten.length > 0 ? { forgotten } : {}) };
}