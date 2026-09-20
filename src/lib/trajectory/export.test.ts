import { describe, expect, it } from 'vitest';
import { CORE_EVENT, type TrajectoryEvent } from './event-log';
import { appendPayloadFromEvents, buildExportMessages } from './export';

function ev(seq: number, type: string, payload: Record<string, unknown>, spanId?: string): TrajectoryEvent {
  return { seq, type, ts: 1700000000000 + seq, spanId, payload };
}

describe('trajectory export: buildExportMessages', () => {
  it('按真实事件序融合 core 文本 + SSE 步骤字段', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.USER_MESSAGE, { role: 'user', content: '列出目录文件' }),
      ev(1, CORE_EVENT.STEP_START, { round: 0 }),
      // 工具轮：模型调用侧事实（含参数）
      ev(2, CORE_EVENT.ASSISTANT_ATTEMPT, {
        round: 0,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'list_directory', arguments: '{"path":"/tmp"}' }],
      }),
      // SSE：执行中 → 结果（截断）→ span
      ev(3, 'tool_call_update', { name: 'list_directory', phase: 'running', spanId: 'sp-1', startAt: 100 }, 'sp-1'),
      ev(4, 'tool_result', { name: 'list_directory', phase: 'done', success: true, durationMs: 12, kind: 'tool', summary: '3 项', result: 'a.txt…(截断)', spanId: 'sp-1', endAt: 112 }, 'sp-1'),
      ev(5, 'tool_span', { name: 'list_directory', phase: 'done', durationMs: 12 }, 'sp-1'),
      // core tool/result：模型可见全文（晚于 SSE）
      ev(6, CORE_EVENT.TOOL_RESULT, { round: 0, role: 'tool', tool_call_id: 'call_1', name: 'list_directory', content: 'a.txt\nb.txt\nc.txt' }),
      ev(7, CORE_EVENT.ASSISTANT_MESSAGE, { round: 1, role: 'assistant', content: '目录共 3 个文件。', reasoning: '已读取' }),
      ev(8, CORE_EVENT.TURN_END, { rounds: 2 }),
    ];

    const msgs = buildExportMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);

    const toolRound = msgs[1];
    expect(toolRound.toolCalls).toHaveLength(1);
    const step = toolRound.toolCalls![0];
    // 参数来自 core attempt
    expect(step.toolName).toBe('list_directory');
    expect(step.arguments).toEqual({ path: '/tmp' });
    // 执行字段来自 SSE 帧
    expect(step.success).toBe(true);
    expect(step.phase).toBe('done');
    expect(step.durationMs).toBe(12);
    expect(step.kind).toBe('tool');
    expect(step.spanId).toBe('sp-1');
    // 结果被 core 全文回补（优先于 SSE 截断）
    expect(step.result).toBe('a.txt\nb.txt\nc.txt');

    // 终答独立成条
    expect(msgs[2].content).toBe('目录共 3 个文件。');
    expect(msgs[2].reasoning).toBe('已读取');
  });

  it('无工具纯问答：仅 user + assistant 终答', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.USER_MESSAGE, { role: 'user', content: 'hi' }),
      ev(1, CORE_EVENT.STEP_START, { round: 0 }),
      ev(2, CORE_EVENT.ASSISTANT_MESSAGE, { round: 1, role: 'assistant', content: 'hello' }),
    ];
    const msgs = buildExportMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1].toolCalls).toBeUndefined();
  });
});

describe('trajectory export: appendPayloadFromEvents 空壳终答打捞', () => {
  it('终答只剩 OutputFile 行时，打捞工具轮正文并保留标记行', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.USER_MESSAGE, { role: 'user', content: '法律问题？' }),
      ev(1, CORE_EVENT.STEP_START, { round: 0 }),
      // 模型把完整答复写在 write_file 同一轮（content 带 think 前缀 + 正文）
      ev(2, CORE_EVENT.ASSISTANT_ATTEMPT, {
        round: 0,
        role: 'assistant',
        content: '<think>先检索再写文件</think>\n## 结论\n既不驳回也不搁置，应编入债权表。',
        toolCalls: [{ id: 'call_1', name: 'write_file', arguments: '{"path":"homework/a.md"}' }],
      }),
      ev(3, CORE_EVENT.TOOL_RESULT, { round: 0, role: 'tool', tool_call_id: 'call_1', name: 'write_file', content: 'Written: homework/a.md' }),
      ev(4, CORE_EVENT.STEP_START, { round: 1 }),
      // 工具返回后的终答：只有 OutputFile 行
      ev(5, CORE_EVENT.ASSISTANT_MESSAGE, { round: 1, role: 'assistant', content: 'OutputFile: homework/a.md' }),
    ];

    const payload = appendPayloadFromEvents(events);
    expect(payload.answer).toContain('## 结论');
    expect(payload.answer).toContain('既不驳回也不搁置，应编入债权表。');
    expect(payload.answer).not.toContain('<think>');
    // OutputFile 标记行保留在末尾，产物卡片仍可解析
    expect(payload.answer!.trimEnd().endsWith('OutputFile: homework/a.md')).toBe(true);
  });

  it('终答自带正文时不触发打捞（行为不变）', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.USER_MESSAGE, { role: 'user', content: 'q' }),
      ev(1, CORE_EVENT.ASSISTANT_ATTEMPT, {
        round: 0, role: 'assistant',
        content: '工具轮里的过渡说明',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }],
      }),
      ev(2, CORE_EVENT.TOOL_RESULT, { round: 0, role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'x' }),
      ev(3, CORE_EVENT.ASSISTANT_MESSAGE, { round: 1, role: 'assistant', content: '最终答复正文。' }),
    ];
    expect(appendPayloadFromEvents(events).answer).toBe('最终答复正文。');
  });

  it('终答与工具轮均无正文时保持原样（不臆造内容）', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.USER_MESSAGE, { role: 'user', content: 'q' }),
      ev(1, CORE_EVENT.ASSISTANT_ATTEMPT, {
        round: 0, role: 'assistant', content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }],
      }),
      ev(2, CORE_EVENT.TOOL_RESULT, { round: 0, role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'x' }),
      ev(3, CORE_EVENT.ASSISTANT_MESSAGE, { round: 1, role: 'assistant', content: 'OutputFile: homework/x.md' }),
    ];
    expect(appendPayloadFromEvents(events).answer).toBe('OutputFile: homework/x.md');
  });

  it('无终答（中断）但末条 attempt 带正文：沿用既有收口行为保留该正文', () => {
    const events: TrajectoryEvent[] = [
      ev(0, CORE_EVENT.USER_MESSAGE, { role: 'user', content: 'q' }),
      ev(1, CORE_EVENT.ASSISTANT_ATTEMPT, {
        round: 0, role: 'assistant', content: '半截正文',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }],
      }),
    ];
    // buildExportMessages 收尾时会把未闭合 attempt 收口为末条消息（既有行为）
    expect(appendPayloadFromEvents(events).answer).toBe('半截正文');
  });
});
