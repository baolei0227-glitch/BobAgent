import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CORE_EVENT,
  type TrajectoryEvent,
  EventLog,
  deriveMessages,
  buildRenderMessages,
  persistEventLog,
  readEventLog,
} from './event-log';

/** 构造一条 core 事件（seq 递增） */
function ev(seq: number, type: string, payload: Record<string, unknown>): TrajectoryEvent {
  return { seq, type, ts: 1700000000000 + seq, payload };
}

describe('trajectory event-log: P1 derive', () => {
  it('deriveMessages 从 core 事件投影消息主干（user/assistant/tool）', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.TURN_START, {}),
      ev(1, CORE_EVENT.USER_MESSAGE, { role: 'user', content: '帮我查法条' }),
      ev(2, CORE_EVENT.STEP_START, { round: 0 }),
      ev(3, CORE_EVENT.ASSISTANT_ATTEMPT, {
        round: 0,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'intern_search', arguments: '{"q":"买卖不破租赁"}' }],
      }),
      ev(4, CORE_EVENT.TOOL_RESULT, { round: 0, role: 'tool', tool_call_id: 'call_1', content: '法条全文…' }),
      ev(5, CORE_EVENT.ASSISTANT_MESSAGE, { round: 1, role: 'assistant', content: '结论：…', reasoning: '思考过程' }),
      ev(6, CORE_EVENT.TURN_END, { rounds: 2 }),
      // 非 core 事件（SSE 伴生）不参与投影
      ev(7, 'tool_span', { name: 'intern_search' }),
      ev(8, 'done', { done: true }),
    ];

    const msgs = deriveMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(msgs[0].content).toBe('帮我查法条');
    // 工具轮 attempt：标记 attempt 且携带 toolCalls
    expect(msgs[1].attempt).toBe(true);
    expect(msgs[1].toolCalls?.[0]?.id).toBe('call_1');
    expect(msgs[1].toolCalls?.[0]?.arguments).toBe('{"q":"买卖不破租赁"}');
    expect(msgs[2].role).toBe('tool');
    expect(msgs[2].tool_call_id).toBe('call_1');
    // 终答：content + reasoning 完整
    expect(msgs[3].attempt).toBeUndefined();
    expect(msgs[3].content).toBe('结论：…');
    expect(msgs[3].reasoning).toBe('思考过程');
  });

  it('buildRenderMessages 把 tool/result 并入前一条 assistant 的 toolCalls', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.USER_MESSAGE, { role: 'user', content: 'u' }),
      ev(1, CORE_EVENT.ASSISTANT_ATTEMPT, {
        round: 0,
        role: 'assistant',
        toolCalls: [
          { id: 'a', name: 't1' },
          { id: 'b', name: 't2' },
        ],
      }),
      ev(2, CORE_EVENT.TOOL_RESULT, { round: 0, role: 'tool', tool_call_id: 'b', content: 'resB' }),
      // 无匹配的 tool result（id 不存在）→ 保留单列
      ev(3, CORE_EVENT.TOOL_RESULT, { round: 0, role: 'tool', tool_call_id: 'zz', content: 'orphan' }),
      ev(4, CORE_EVENT.ASSISTANT_MESSAGE, { round: 1, role: 'assistant', content: 'final' }),
    ];

    const msgs = buildRenderMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const attempt = msgs[1];
    expect(attempt.toolCalls).toHaveLength(2);
    // 匹配的 result 已挂回对应 toolCall，未匹配的保持原样
    expect(attempt.toolCalls?.[1].result).toBe('resB');
    expect(attempt.toolCalls?.[0].result).toBeUndefined();
    expect(msgs[2].content).toBe('orphan');
  });

  it('persistEventLog / readEventLog roundtrip（容错坏行）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bobwork-trajectory-'));
    const file = join(dir, 'task.jsonl');
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.TURN_START, { taskId: 't1' }),
      ev(1, CORE_EVENT.USER_MESSAGE, { role: 'user', content: 'hi' }),
      ev(2, CORE_EVENT.ASSISTANT_MESSAGE, { role: 'assistant', content: 'hello' }),
    ];
    persistEventLog(file, events);
    // 追加一行坏数据模拟损坏文件
    appendFileSync(file, 'not-json\n');

    const read = readEventLog(file);
    expect(read.map((e) => e.type)).toEqual([
      CORE_EVENT.TURN_START,
      CORE_EVENT.USER_MESSAGE,
      CORE_EVENT.ASSISTANT_MESSAGE,
    ]);
    expect(read[2].payload.content).toBe('hello');
    rmSync(dir, { recursive: true, force: true });
  });

  it('P4c-1 compaction 事件：CORE_EVENT 常量存在、mark 可写入并可持久化读回', () => {
    expect(CORE_EVENT.COMPACTION).toBe('compaction');
    const log = new EventLog();
    log.mark(CORE_EVENT.COMPACTION, 'compaction:t-abc', {
      reason: 'R-14-C 缓存感知压缩',
      shadowedTurns: { from: 2, to: 5 },
      hardFactsCount: 2,
      hardFactsSample: ['2026-07-31', '8000元'],
      summaryGoal: '租赁纠纷分析',
      compactedUntil: 5,
    });

    const events = log.finalize();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe('compaction');
    expect(e.spanId).toBe('compaction:t-abc');
    expect(e.payload.shadowedTurns).toEqual({ from: 2, to: 5 });
    expect(e.payload.compactedUntil).toBe(5);

    // 持久化 roundtrip：readEventLog 读回后字段完整
    const dir = mkdtempSync(join(tmpdir(), 'bobwork-compaction-'));
    const file = join(dir, 'task.jsonl');
    persistEventLog(file, events);
    const read = readEventLog(file);
    expect(read).toHaveLength(1);
    expect(read[0].type).toBe(CORE_EVENT.COMPACTION);
    expect(read[0].payload.summaryGoal).toBe('租赁纠纷分析');
    rmSync(dir, { recursive: true, force: true });
  });
});
