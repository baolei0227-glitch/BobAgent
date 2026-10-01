import { describe, it, expect } from 'vitest';
import { solveSchedule, DEFAULT_WORKING_HOURS, type SolveInput } from './solve';

const NOW = '2026-09-28T00:00:00.000Z'; // 周一 08:00 Asia/Shanghai

function base(over: Partial<SolveInput> = {}): SolveInput {
  return {
    tasks: [],
    busy: [],
    workingHours: DEFAULT_WORKING_HOURS,
    now: NOW,
    horizonDays: 7,
    ...over,
  };
}

describe('solveSchedule', () => {
  it('is deterministic: same input → identical output', () => {
    const input = base({
      tasks: [
        { event_id: 'b', title: 'B', priority: 'normal', estimated_minutes: 60, due_at: '2026-09-29T10:00:00.000Z' },
        { event_id: 'a', title: 'A', priority: 'high', estimated_minutes: 45, due_at: '2026-09-28T09:00:00.000Z' },
      ],
      busy: [{ start: '2026-09-28T01:00:00.000Z', end: '2026-09-28T02:00:00.000Z' }],
    });
    const first = solveSchedule(input);
    const second = solveSchedule(input);
    expect(second).toEqual(first);
  });

  it('never overlaps busy blocks and respects working hours', () => {
    const input = base({
      tasks: [{ event_id: 'a', title: 'A', estimated_minutes: 60 }],
      busy: [{ start: '2026-09-28T01:00:00.000Z', end: '2026-09-28T03:00:00.000Z' }], // 09:00–11:00 本地
    });
    const { assignments } = solveSchedule(input);
    expect(assignments).toHaveLength(1);
    const a = assignments[0];
    const start = Date.parse(a.start);
    const end = Date.parse(a.end);
    // 不与忙块重叠（含 10min buffer）
    expect(start >= Date.parse('2026-09-28T03:00:00.000Z')).toBe(true);
    // 落在本地 09:00–18:00（UTC 01:00–10:00）
    expect(start >= Date.parse('2026-09-28T01:00:00.000Z')).toBe(true);
    expect(end <= Date.parse('2026-09-28T10:00:00.000Z')).toBe(true);
  });

  it('puts tasks that cannot fit before their deadline into unplaced', () => {
    const input = base({
      tasks: [{ event_id: 'u', title: 'Urgent', estimated_minutes: 120, due_at: '2026-09-28T00:30:00.000Z' }],
    });
    const { assignments, unplaced } = solveSchedule(input);
    expect(assignments).toHaveLength(0);
    expect(unplaced).toEqual([{ event_id: 'u', reason: 'no_slot_before_due' }]);
  });

  it('skips locked tasks (they are placed by the user)', () => {
    const input = base({
      tasks: [{ event_id: 'l', title: 'Locked', estimated_minutes: 60, block_locked: true }],
    });
    const { assignments, unplaced } = solveSchedule(input);
    expect(assignments).toHaveLength(0);
    expect(unplaced).toHaveLength(0);
  });
});
