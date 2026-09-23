/**
 * team-events —— engine events → presentation-layer "chat stream" events, as a **pure mapping**
 * (no MCP / no Node dependencies).
 *
 * It lives in its own module because the same mapping is needed on both sides: the server
 * (/api/team/<id>/stream incremental frames) and the browser (/api/team/<id> first-screen snapshot with
 * raw events). team-client is the server-side channel (dynamic-imports the mcp manager) and cannot be
 * referenced from the client, so these pure functions are split out to be shared and avoid two drifting copies.
 */

import type { TeamArtifactItem, TeamChatEvent, TeamEventItem } from '@/lib/types';

export function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : [];
}
export function objOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * 成员产出里的留言块（`[[msg to=x]]…[[/msg]]`）是宿主投递用的协议噪音，不是产出的一部分：
 * 引擎把原始产出直接记进事件文本，映射层在这里剥掉，免得它裸奔到「群聊流」里污染可读性。
 */
const MEMBER_MSG_BLOCK_RE = /\[\[msg\s+to=[^\]]+\]\][\s\S]*?\[\[\/msg\]\]/gi;

export function stripMemberMsgBlocks(text: string): string {
  return text.replace(MEMBER_MSG_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 成员产出文件（engine event meta.artifacts）→ 呈现层条目。
 * 防御式形状校验：事件来自落盘 JSONL，历史数据 / 手改数据都可能形状不对，只放行有 path 的条目
 * （path 是点开文件的唯一凭据，缺它这张卡片点了也没用）。
 */
export function parseArtifacts(v: unknown): TeamArtifactItem[] {
  if (!Array.isArray(v)) return [];
  const out: TeamArtifactItem[] = [];
  for (const raw of v) {
    const a = objOf(raw);
    const path = str(a.path);
    if (!path) continue;
    out.push({
      path,
      name: str(a.name) || path.split('/').pop() || 'file',
      size: num(a.size),
      ...(str(a.kind) ? { kind: str(a.kind) } : {}),
      ...(str(a.source) ? { source: str(a.source) } : {}),
    });
  }
  return out;
}

/**
 * 是否为引擎 plan() 固定发出的那条「计划已生成：N 名成员 / M 个任务，待批准」（见 bob-team-mcp/src/engine/team.ts）。
 *
 * 为什么在呈现层丢掉它：它宣告的是审批门禁这个中间态，而默认策略是自动批准，用户根本看不到「批准」这一步；
 * 剩下的计数信息与紧随其后的 team_start 行（`Run started · N members · M tasks`）完全重复 → 群里纯噪音。
 * 引擎侧照旧落盘（events.jsonl），审计与「未批准草案冷恢复」都读得到，不受这里影响。
 *
 * 判据：结构化优先 —— meta 同时带 members/tasks 数值（team_start 的同款计数，system 事件里仅此一条），
 * 文案前缀作兜底。任一被改动只是让它重新出现在流里（fail-open，不会误伤别的行）。
 */
function isPlanDraftedNotice(e: TeamEventItem, meta: Record<string, unknown>): boolean {
  const counts = typeof meta.members === 'number' && typeof meta.tasks === 'number';
  return counts && (e.text ?? '').startsWith('计划已生成');
}

/**
 * Engine events (the persisted source of truth; field names follow bob-team-mcp types.TeamEvent) → the
 * presentation layer's "chat stream" events.
 * subjects: taskId → task subject (engine member events only carry a taskId, so the subject is filled in
 * from the task table).
 * `system` events are passed through as-is (member added/removed, stranded takeover / cold resume, manual
 * retry, quality chain) and shown as on-stage events in the chat — except the plan-drafted notice, which is
 * dropped here as a duplicate (see isPlanDraftedNotice).
 * `captain` events are the host orchestration session's own lines (dispatch / review / follow-up /
 * synthesis) and render as a participant in the stream (see TeamChatStream).
 */
export function mapEngineEvents(
  items: TeamEventItem[],
  subjects?: Map<string, string>,
): TeamChatEvent[] {
  const out: TeamChatEvent[] = [];
  for (const e of items) {
    const at = num(e.ts);
    const meta = objOf(e.meta);
    const name = e.memberName || e.memberId || 'Member';
    const taskTitle = e.taskId ? subjects?.get(e.taskId) : undefined;
    const memberId = e.memberId ?? '';
    switch (e.kind) {
      case 'team_start':
        out.push({
          kind: 'team_start',
          at,
          goal: str(meta.goal),
          memberNames: strList(meta.memberNames),
          taskCount: num(meta.tasks),
          // 触发本轮的用户原文（宿主在 team_plan 时带进引擎）：群里那条「我的发言」气泡
          ...(str(meta.question) ? { question: str(meta.question) } : {}),
        });
        break;
      case 'member_start':
        out.push({ kind: 'member_start', at, memberId, name, subject: taskTitle, taskId: e.taskId });
        break;
      case 'member_done': {
        // 本轮落盘的文件：群聊流据此在成员那条发言下贴文件卡片（像微信发文件）
        const artifacts = parseArtifacts(meta.artifacts);
        // 成员自己的「群聊发言」（口语一句话）与步骤数：流里那行「谁做了什么」直接用它们，
        // 正文（summary）只在展开时看 —— 旧数据没有这两个字段，呈现层回退动作句。
        const say = str(meta.say);
        const steps = num(meta.steps);
        out.push({
          kind: 'member_done',
          at,
          memberId,
          name,
          subject: taskTitle,
          summary: stripMemberMsgBlocks(e.text ?? ''),
          taskId: e.taskId,
          ...(say ? { say } : {}),
          ...(steps > 0 ? { steps } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
        });
        break;
      }
      case 'member_failed':
        out.push({ kind: 'member_failed', at, memberId, name, subject: taskTitle, error: e.text, taskId: e.taskId });
        break;
      case 'relay':
        out.push({
          kind: 'relay',
          at,
          // 宿主代投的成员留言：引擎记的真实来源在 meta.actor（from 恒为 captain，邮箱语义不变）
          from: str(meta.actor) || e.from || 'captain',
          to: e.to || '',
          text: e.text ?? '',
        });
        break;
      case 'captain':
        out.push({
          kind: 'captain',
          at,
          stage: str(meta.stage) || 'note',
          text: e.text ?? '',
          // 群里那句「人话」（队长说了什么）：完整正文仍在 text，展开可见
          ...(str(meta.line) ? { line: str(meta.line) } : {}),
          memberId,
          name: str(e.memberName),
          targets: strList(meta.targets),
          taskId: e.taskId,
        });
        break;
      case 'team_done':
        out.push({
          kind: 'team_done',
          at,
          done: num(meta.done),
          total: num(meta.tasks),
          failed: num(meta.failed),
          // The engine only emits team_done when "all tasks are terminal"; there is no over-budget cutoff here (that is the host's polling job)
          timedOut: false,
        });
        break;
      default:
        // 计划已生成…待批准：与随后的 Run started 重复，且审批门禁在自动批准下不可见 → 不渲染（见上）
        if (isPlanDraftedNotice(e, meta)) break;
        if (e.text) out.push({ kind: 'system', at, text: e.text });
        break;
    }
  }
  return out;
}
