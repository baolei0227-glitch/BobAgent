/**
 * team-events —— engine events → presentation-layer "chat stream" events, as a **pure mapping**
 * (no MCP / no Node dependencies).
 *
 * It lives in its own module because the same mapping is needed on both sides: the server
 * (/api/team/<id>/stream incremental frames) and the browser (/api/team/<id> first-screen snapshot with
 * raw events). team-client is the server-side channel (dynamic-imports the mcp manager) and cannot be
 * referenced from the client, so these pure functions are split out to be shared and avoid two drifting copies.
 */

import type { TeamChatEvent, TeamEventItem } from '@/lib/types';

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
 * Engine events (the persisted source of truth; field names follow bob-team-mcp types.TeamEvent) → the
 * presentation layer's "chat stream" events.
 * subjects: taskId → task subject (engine member events only carry a taskId, so the subject is filled in
 * from the task table).
 * `system` events are passed through as-is (member added/removed, stranded takeover / cold resume, manual
 * retry, quality chain) and shown as on-stage events in the chat.
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
        });
        break;
      case 'member_start':
        out.push({ kind: 'member_start', at, memberId, name, subject: taskTitle, taskId: e.taskId });
        break;
      case 'member_done':
        out.push({ kind: 'member_done', at, memberId, name, subject: taskTitle, summary: e.text, taskId: e.taskId });
        break;
      case 'member_failed':
        out.push({ kind: 'member_failed', at, memberId, name, subject: taskTitle, error: e.text, taskId: e.taskId });
        break;
      case 'relay':
        out.push({ kind: 'relay', at, from: e.from || 'captain', to: e.to || '', text: e.text ?? '' });
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
        if (e.text) out.push({ kind: 'system', at, text: e.text });
        break;
    }
  }
  return out;
}
