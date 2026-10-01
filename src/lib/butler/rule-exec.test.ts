/**
 * 规则执行器（rule-exec.executeDeterministicRule）回归：
 *   ① 事项文本来源 —— 定时触发取步骤写死的 step.text；语面命中取用户话剥掉触发词；
 *   ② 日程动作（create_scheduled_todo）—— 时刻取自 occurrence，产出 producedRef（event_id）。
 *
 * 隔离：把落盘原语（sticky-write）、项目解析、冲突评估、入日历同步全部 mock 掉，
 * 只断言「交给落盘原语的入参」与「产出的引用」，不触真实 fs / DB。
 * BOBWORK_HOME 指向临时目录，避免 import 链路（rules/storage）误读真实 home。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RuleRecord } from './rules-shared';

/** 捕获交给落盘原语的入参（每个用例前清空） */
const appended: Array<{ content: string; title?: string }> = [];
/** 捕获入日历调用的时段 */
const calCalls: Array<{ start?: string | null; end?: string | null }> = [];

vi.mock('./sticky-write', () => ({
  appendStickyTodoNote: async (input: { content: string; title?: string }) => {
    appended.push({ content: input.content, title: input.title });
    return {
      ok: true,
      notes: [{ id: 'sn-1', title: input.title ?? 'Demo', pages: [{ id: 'pg-1', title: 'P1', content: input.content }] }],
      noteId: 'sn-1',
      pageId: 'pg-1',
      lineIndex: 0,
      title: input.title ?? 'Demo',
      color: 'yellow',
    };
  },
}));

vi.mock('@/lib/project/resolve-explicit-project', () => ({
  resolveProjectWithFallback: async () => ({
    ok: true,
    project: { id: 'p1', name: 'Demo', path: '/tmp/demo' },
  }),
}));

vi.mock('@/lib/calendar/overlaps', () => ({
  assessEventSlot: async () => ({
    level: 'none',
    total_overlaps: 0,
    overlaps: [],
    risks: [],
    alternatives: [],
  }),
}));

vi.mock('@/lib/sticky-calendar-sync', () => ({
  addStickyLineToCalendar: async (
    _projectId: string,
    _note: unknown,
    _pageId: string,
    _lineIndex: number,
    _text?: string,
    opts?: { start_time?: string | null; end_time?: string | null },
  ) => {
    calCalls.push({ start: opts?.start_time, end: opts?.end_time });
    return {
      note: { id: 'sn-1', pages: [{ id: 'pg-1', lineEventIds: [['ev-1']] }] },
      eventIds: ['ev-1'],
      created: true,
    };
  },
  writeStickyNotesFile: async () => {},
}));

let home = '';
let exec: typeof import('./rule-exec');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-rule-exec-'));
  process.env.BOBWORK_HOME = home;
  exec = await import('./rule-exec');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

function mkRule(partial: Partial<RuleRecord> & { id: string }): RuleRecord {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    kind: partial.kind ?? 'rule',
    intentRaw: partial.intentRaw ?? '',
    trigger: partial.trigger ?? { keywords: [] },
    steps: partial.steps ?? [{ kind: 'deterministic', text: 'x', action: 'create_todo' }],
    commitment: partial.commitment ?? '必做到',
    scope: partial.scope ?? 'global',
    priority: partial.priority ?? 50,
    status: partial.status ?? 'active',
    version: partial.version ?? 1,
    createdAt: partial.createdAt ?? '2026-09-28T09:00:00.000Z',
  };
}

describe('executeDeterministicRule —— 事项文本来源', () => {
  it('定时触发（带 occurrence）：取步骤写死的 step.text，忽略用户那句话', async () => {
    appended.length = 0;
    const rule = mkRule({
      id: 'r-20260928-x1',
      trigger: { keywords: ['写周报'] },
      steps: [
        { kind: 'deterministic', text: '写周报', action: 'create_scheduled_todo', actionParams: { when: 'occurrence' } },
      ],
    });
    const res = await exec.executeDeterministicRule({
      rule,
      text: '今天有哪些待办', // 与本次事项无关（只是时间到了）
      anchor: {},
      occurrence: Date.parse('2026-09-28T07:02:00.000Z'),
    });
    expect(res.ok).toBe(true);
    expect(appended[0].content).toBe('写周报');
  });

  it('语面命中（无 occurrence）：取用户话并剥掉命中的触发词', async () => {
    appended.length = 0;
    const rule = mkRule({
      id: 'r-20260928-x2',
      trigger: { keywords: ['记一下'] },
      steps: [{ kind: 'deterministic', text: '待办', action: 'create_todo' }],
    });
    const res = await exec.executeDeterministicRule({ rule, text: '记一下 买咖啡', anchor: {} });
    expect(res.ok).toBe(true);
    expect(appended[0].content).toBe('买咖啡');
  });

  it('语面命中且剥空后回退步骤文本', async () => {
    appended.length = 0;
    const rule = mkRule({
      id: 'r-20260928-x3',
      trigger: { keywords: ['记一下'] },
      steps: [{ kind: 'deterministic', text: '随手记', action: 'create_todo' }],
    });
    const res = await exec.executeDeterministicRule({ rule, text: '记一下', anchor: {} });
    expect(res.ok).toBe(true);
    expect(appended[0].content).toBe('随手记');
  });
});

describe('executeDeterministicRule —— 日程动作时刻与产出引用', () => {
  it('occurrence → 入日历 start_time/end_time（+1h），producedRef = event_id', async () => {
    appended.length = 0;
    calCalls.length = 0;
    const occ = Date.parse('2026-09-28T07:02:00.000Z');
    const rule = mkRule({
      id: 'r-20260928-x4',
      trigger: { keywords: [] },
      steps: [
        { kind: 'deterministic', text: '写周报', action: 'create_scheduled_todo', actionParams: { when: 'occurrence' } },
      ],
    });
    const res = await exec.executeDeterministicRule({ rule, text: '', anchor: {}, occurrence: occ });
    expect(res.ok).toBe(true);
    expect(res.producedRef).toBe('ev-1');
    expect(calCalls[0]).toEqual({
      start: new Date(occ).toISOString(),
      end: new Date(occ + 3_600_000).toISOString(),
    });
  });

  it('日程规则无确定时刻（无 occurrence 且 when 非 ISO）→ 不落盘、明说原因', async () => {
    appended.length = 0;
    const rule = mkRule({
      id: 'r-20260928-x5',
      trigger: { keywords: [] },
      steps: [
        { kind: 'deterministic', text: '写周报', action: 'create_scheduled_todo', actionParams: { when: 'occurrence' } },
      ],
    });
    const res = await exec.executeDeterministicRule({ rule, text: '', anchor: {} });
    expect(res.ok).toBe(false);
    expect(appended).toHaveLength(0);
  });
});