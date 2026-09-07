import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { readEventLog, CORE_EVENT, type TrajectoryEvent } from './event-log';
import { appendPayloadFromEvents } from './export';

const FIXTURE = join(__dirname, '__fixtures__', 'mtr7mweq-5c9e5e79.jsonl');

function ev(seq: number, type: string, payload: Record<string, unknown>, spanId?: string): TrajectoryEvent {
  return { seq, type, ts: 1700000000000 + seq, spanId, payload };
}

describe('trajectory append fidelity（方案 C 一致性）', () => {
  it('真实纯问答任务日志 → 派生摘要与前端 append 内容一致', () => {
    const events = readEventLog(FIXTURE);
    expect(events.length).toBeGreaterThanOrEqual(6);
    const p = appendPayloadFromEvents(events);
    // question = 用户输入原文
    expect(p.question).toBe('P1 事件溯源验证：请只回复“OK”两字，不要调用任何工具。');
    // answer = 终答正文（stripThink 由 append 服务端处理，此处保持原文）
    expect(p.answer).toBe('OK');
    // reasoning = 终答思考（真实样本含较长文本）
    expect(p.reasoning).toBeDefined();
    expect(p.reasoning!.length).toBeGreaterThan(20);
    // 无工具轮
    expect(p.toolCalls).toBeUndefined();
    expect(p.toolNames).toEqual([]);
  });

  it('含工具轮 + 输出文件的日志 → 派生摘要还原 toolCalls 与 outputFiles', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.USER_MESSAGE, { role: 'user', content: '把报告写到 homework' }),
      ev(1, CORE_EVENT.STEP_START, { round: 0 }),
      ev(2, CORE_EVENT.ASSISTANT_ATTEMPT, {
        round: 0, role: 'assistant', content: '',
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"path":"homework/报告.md"}' }],
      }),
      ev(3, 'tool_call_update', { name: 'write_file', phase: 'running', spanId: 'sp-1', startAt: 200 }, 'sp-1'),
      ev(4, 'tool_result', { name: 'write_file', phase: 'done', success: true, durationMs: 42, kind: 'tool', summary: '已写入', result: '（截断）', spanId: 'sp-1', endAt: 242 }, 'sp-1'),
      ev(5, CORE_EVENT.TOOL_RESULT, { round: 0, role: 'tool', tool_call_id: 'c1', name: 'write_file', content: 'homework/报告.md 已写入（完整结果）' }),
      ev(6, 'output_files', { files: [{ path: 'homework/报告.md', name: '报告.md', size: 120, kind: 'doc', source: 'write_file' }], nodeId: 'n1' }),
      ev(7, CORE_EVENT.ASSISTANT_MESSAGE, { round: 1, role: 'assistant', content: '已生成报告。' }),
      ev(8, CORE_EVENT.TURN_END, { rounds: 2 }),
    ];

    const p = appendPayloadFromEvents(events);
    expect(p.question).toBe('把报告写到 homework');
    expect(p.answer).toBe('已生成报告。');
    // 工具步骤：核心字段从 SSE/全文恢复
    expect(p.toolCalls).toHaveLength(1);
    const tc = p.toolCalls![0];
    expect(tc.toolName).toBe('write_file');
    expect(tc.arguments).toEqual({ path: 'homework/报告.md' });
    expect(tc.success).toBe(true);
    expect(tc.phase).toBe('done');
    expect(tc.durationMs).toBe(42);
    expect(tc.result).toContain('homework/报告.md 已写入'); // core 全文回补
    // 输出文件卡提取
    expect(p.outputFiles).toHaveLength(1);
    expect(p.outputFiles![0].path).toBe('homework/报告.md');
  });

  it('中断任务（无终答）→ answer 为空但不丢 question', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.USER_MESSAGE, { role: 'user', content: '中途断线' }),
      ev(1, CORE_EVENT.STEP_START, { round: 0 }),
      ev(2, 'done', { done: true }),
    ];
    const p = appendPayloadFromEvents(events);
    expect(p.question).toBe('中途断线');
    expect(p.answer).toBeUndefined();
  });
});
