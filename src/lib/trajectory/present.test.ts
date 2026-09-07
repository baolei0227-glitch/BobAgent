/**
 * P5a-1 事件窗口 schema 状态机单测（present.ts）
 *
 * 覆盖：SSE 归一规则（type 提取/包裹形态/累积标记）、tool_call 建 span、tool_call_update
 * running 幂等（重复 keepalive 不虚挂）、tool_result 按 spanId/同名结算、无 spanId 兜底 id
 * 稳定、未识别/无目标帧安全忽略、done 收 meta、finishWindow 流末收口。
 * 与 assembleTraceSpans 的语义对比属 P5a-2 渲染切换验证门，本步不涉及。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { join } from 'path';
import { readEventLog } from './event-log';
import {
  createTraceWindow,
  normalizeSseFrame,
  pushWindowFrame,
  finishWindow,
  eventsToTraceWindow,
  type TraceWindowState,
} from './present';
import { windowToTrajectoryItems } from './render';

const FIXTURE = join(__dirname, '__fixtures__', 'mtr7mweq-5c9e5e79.jsonl');

/** 状态机驱动：feed 一条原始 SSE 帧（走 normalize → push 全链路） */
function feedFrame(win: TraceWindowState, raw: Record<string, unknown>): TraceWindowState {
  const ev = normalizeSseFrame(raw);
  return ev ? pushWindowFrame(win, ev) : win;
}

describe('normalizeSseFrame：SSE 归一规则', () => {
  it('非对象 / 空对象 → null（安全忽略）', () => {
    expect(normalizeSseFrame(null)).toBeNull();
    expect(normalizeSseFrame(undefined)).toBeNull();
    expect(normalizeSseFrame({})).toBeNull();
    expect(normalizeSseFrame('x' as unknown as Record<string, unknown>)).toBeNull();
  });

  it('原始 SSE 帧：type = payload 首 key（与 eventLog.record 同规则），整帧为载荷', () => {
    const ev = normalizeSseFrame({ tool_call: { name: 'web_search' }, nodeId: 'n1' });
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('tool_call');
    expect(ev!.payload.tool_call).toEqual({ name: 'web_search' });
    expect(ev!.payload.nodeId).toBe('n1');
  });

  it('显式 type 字段优先（已归一事件形态 { type, payload }）', () => {
    const ev = normalizeSseFrame({ type: 'tool_result', payload: { tool_result: { name: 'read_file', result: 'r' } } });
    expect(ev!.type).toBe('tool_result');
    // 载荷取 payload 内层（与原始 SSE 帧的载荷形态一致：可继续 dig payload.tool_result）
    expect(ev!.payload.tool_result).toEqual({ name: 'read_file', result: 'r' });
  });

  it('包裹形态 { data: {...} }：type 取内层首 key', () => {
    const ev = normalizeSseFrame({ data: { content: 'hi', nodeId: 'n1' } });
    expect(ev!.type).toBe('content');
    expect(ev!.payload.content).toBe('hi');
  });

  it('reasoning/content 帧不在此丢弃（产累积标记事件，由 pushWindowFrame 累积）', () => {
    expect(normalizeSseFrame({ reasoning: 'x' })!.type).toBe('reasoning');
    expect(normalizeSseFrame({ content: 'y' })!.type).toBe('content');
  });
});

describe('pushWindowFrame / finishWindow：事件窗口状态机', () => {
  let win: TraceWindowState;

  /** 从空窗口连续喂帧，返回最终窗口 */
  const run = (frames: Array<Record<string, unknown>>): TraceWindowState => {
    let w = createTraceWindow();
    for (const f of frames) w = feedFrame(w, f);
    return w;
  };

  beforeEach(() => {
    win = createTraceWindow();
  });

  it('matchedSkills / context_meter / reasoning / content 帧：meta 与累积缓冲', () => {
    let w = feedFrame(win, { matchedSkills: ['web_search'], skillDetails: [], forcedSkills: [], nodeId: 'n1' });
    expect(w.meta.matchedSkills).toEqual(['web_search']);
    expect(w.spans).toHaveLength(0);

    w = feedFrame(w, { context_meter: { system: 1, tools: 2, capacity: 1_000_000 }, prefixHash: 'ab' });
    expect(w.meta.contextMeter).toMatchObject({ system: 1, capacity: 1_000_000 });

    w = feedFrame(w, { reasoning: '首先分析。', nodeId: 'n1' });
    w = feedFrame(w, { reasoning: '接着拆解。', nodeId: 'n1' });
    w = feedFrame(w, { content: '结论一。', nodeId: 'n1' });
    w = feedFrame(w, { content: '结论二。', nodeId: 'n1' });
    // 连续 token 帧不产独立事件，仅累积
    expect(w.spans).toHaveLength(0);
    expect(w.reasoningAccum).toBe('首先分析。接着拆解。');
    expect(w.contentAccum).toBe('结论一。结论二。');
    // 空字符串 / 非字符串内容不产生累积
    const before = w.contentAccum;
    w = feedFrame(w, { content: '', nodeId: 'n1' });
    expect(w.contentAccum).toBe(before);
  });

  it('tool_call → tool_call_update(running)×N 幂等 → tool_result 按 spanId 结算（乱序并行不串扰）', () => {
    // 两工具并行：A(web_search, sp-a) 先建，B(read_attachment, sp-b) 后建；B 结果先到
    const w = run([
      { matchedSkills: ['web_search'], nodeId: 'n1' },
      { reasoning: '先搜后读。', nodeId: 'n1' },
      // A 建 span（pending）
      { tool_call: { name: 'web_search', arguments: { q: '法条' }, phase: 'pending', spanId: 'sp-a', startAt: 1000, purpose: '检索资料' }, nodeId: 'n1' },
      // keepalive ×3：running 幂等，不得虚挂/新建
      { tool_call_update: { name: 'web_search', phase: 'running', spanId: 'sp-a', startAt: 1000 }, nodeId: 'n1' },
      { tool_call_update: { name: 'web_search', phase: 'running', spanId: 'sp-a', startAt: 1000 }, nodeId: 'n1' },
      { tool_call_update: { name: 'web_search', phase: 'running', spanId: 'sp-a', startAt: 1000 }, nodeId: 'n1' },
      // B 建 span（pending）
      { tool_call: { name: 'read_attachment', arguments: {}, phase: 'pending', spanId: 'sp-b', startAt: 2000 }, nodeId: 'n1' },
      { tool_call_update: { name: 'read_attachment', phase: 'running', spanId: 'sp-b', startAt: 2000 }, nodeId: 'n1' },
      { content: '工具并行分析中', nodeId: 'n1' },
      // B 结果先于 A 到达（按 spanId 结算，不依赖创建顺序）
      { tool_result: { name: 'read_attachment', result: '附件正文…', durationMs: 3000, success: true, phase: 'done', spanId: 'sp-b', kind: 'tool', summary: '读取附件 3 页', startAt: 2000, endAt: 5000 }, nodeId: 'n1' },
      // A keepalive 仍在发（B 已结算后不串扰 A）
      { tool_call_update: { name: 'web_search', phase: 'running', spanId: 'sp-a', startAt: 1000 }, nodeId: 'n1' },
      // A 结果到达
      { tool_result: { name: 'web_search', result: '检索到 3 条结果', durationMs: 4000, success: true, phase: 'done', spanId: 'sp-a', kind: 'tool', summary: '命中 3 条', cardHtml: '<b>卡片</b>', startAt: 1000, endAt: 5000 }, nodeId: 'n1' },
    ]);
    expect(w.spans).toHaveLength(2);

    const a = w.spans.find((s) => s.spanId === 'sp-a')!;
    expect(a.toolName).toBe('web_search');
    expect(a.phase).toBe('done');
    expect(a.status).toBe('done');
    expect(a.result).toBe('检索到 3 条结果');
    expect(a.summary).toBe('命中 3 条');
    expect(a.cardHtml).toBe('<b>卡片</b>');
    expect(a.kind).toBe('tool');
    expect(a.durationMs).toBe(4000);
    expect(a.startAt).toBe(1000);
    expect(a.endAt).toBe(5000);
    expect(a.purpose).toBe('检索资料');

    const b = w.spans.find((s) => s.spanId === 'sp-b')!;
    expect(b.phase).toBe('done');
    expect(b.result).toBe('附件正文…');
    expect(b.durationMs).toBe(3000);
    expect(b.summary).toBe('读取附件 3 页');
    expect(b.endAt).toBe(5000);

    // 重复 keepalive 不虚挂：A 全程只有一条 span
    expect(w.spans.filter((s) => s.toolName === 'web_search')).toHaveLength(1);
    expect(w.reasoningAccum).toBe('先搜后读。');
    expect(w.contentAccum).toBe('工具并行分析中');
    expect(w.meta.matchedSkills).toEqual(['web_search']);
  });

  it('无 spanId 工具：兜底 id 稳定（name#seq），update 按同名最后 / result 按同名未结算结算', () => {
    const w = run([
      { tool_call: { name: 'write_file', arguments: { path: 'homework/a.md' }, phase: 'pending', startAt: 1000 }, nodeId: 'n1' },
      // 无 spanId update → fallback 同名最后一个（此处仅一个）→ running
      { tool_call_update: { name: 'write_file', phase: 'running', startAt: 1000 }, nodeId: 'n1' },
      { tool_call: { name: 'write_file', arguments: { path: 'homework/b.md' }, phase: 'pending', startAt: 2000 }, nodeId: 'n1' },
      // 两条同名均 pending 时：无 spanId update 命中"最后一个"（b）
      { tool_call_update: { name: 'write_file', phase: 'running', startAt: 2000 }, nodeId: 'n1' },
    ]);
    expect(w.spans).toHaveLength(2);
    const [first, second] = w.spans;
    // 兜底 id 稳定且互不相同（name#帧序）
    expect(first.spanId).toMatch(/^write_file#\d+$/);
    expect(second.spanId).toMatch(/^write_file#\d+$/);
    expect(first.spanId).not.toBe(second.spanId);
    expect(first.phase).toBe('running');
    expect(second.phase).toBe('running');

    // 无 spanId result：同名未结算的"第一个"被结算（与 ChatNodeKernel result==='...' 兜底同规则）
    let w2 = feedFrame(w, { tool_result: { name: 'write_file', result: 'r1', durationMs: 100, success: true }, nodeId: 'n1' });
    expect(w2.spans[0].phase).toBe('done');
    expect(w2.spans[0].result).toBe('r1');
    expect(w2.spans[1].phase).toBe('running');
    // 第二条结算
    w2 = feedFrame(w2, { tool_result: { name: 'write_file', result: 'r2', durationMs: 200, success: true }, nodeId: 'n1' });
    expect(w2.spans[1].phase).toBe('done');
    expect(w2.spans[1].result).toBe('r2');
  });

  it('无 spanId 创建的 span 经 update 吸收真实 spanId（后续 result 可精确命中）', () => {
    const w = run([
      { tool_call: { name: 'run_command', arguments: { command: 'ls' }, phase: 'pending' }, nodeId: 'n1' },
      // 心跳携带真实 spanId → span 吸收，替换兜底 id
      { tool_call_update: { name: 'run_command', phase: 'running', spanId: 'sp-real', startAt: 100 }, nodeId: 'n1' },
      { tool_result: { name: 'run_command', result: 'ok', durationMs: 50, success: true, spanId: 'sp-real', kind: 'tool' }, nodeId: 'n1' },
    ]);
    expect(w.spans).toHaveLength(1);
    expect(w.spans[0].spanId).toBe('sp-real');
    expect(w.spans[0].phase).toBe('done');
    expect(w.spans[0].result).toBe('ok');
  });

  it('未识别帧 / 无目标 update / 无目标 result / 未知帧：安全忽略，不产 span', () => {
    const frames: Array<Record<string, unknown>> = [
      { tool_call: { name: 'web_search', spanId: 'sp-a' }, nodeId: 'n1' },
      { tool_call_update: { name: 'ghost_tool', phase: 'running', spanId: 'sp-ghost' }, nodeId: 'n1' },
      { tool_result: { name: 'ghost_tool', result: 'x', success: true }, nodeId: 'n1' },
      { vision_progress: { phase: 'start', current: 0, total: 0 } },
      { content_truncated: true, nodeId: 'n1' },
      { tool_summary: { name: 'web_search', summary: 's' } },
      { output_files: [{ path: 'homework/x.md' }] },
    ];
    const w = run(frames);
    expect(w.spans).toHaveLength(1);
    expect(w.spans[0].spanId).toBe('sp-a');
    expect(w.spans[0].phase).toBe('pending');
    // 无目标帧不破坏既有 span
    expect(w.spans[0].result).toBeUndefined();
    // frameCount 仍随每帧递增（帧序分配器）
    expect(w.frameCount).toBe(frames.length);
  });

  it('交互帧独立保留进 meta.interactions（coding_phase/questions_request/tool_confirm 等）', () => {
    const w = run([
      { tool_call: { name: 'write_file', spanId: 'sp-a' }, nodeId: 'n1' },
      { coding_phase: { phase: 'running', tool: 'write_file' }, nodeId: 'n1' },
      { tool_confirm: { confirmId: 'c9', name: 'run_command', timeoutSec: 600 }, nodeId: 'n1' },
      { questions_request: { requestId: 'q1', questions: [{ id: 'q' }] }, nodeId: 'n1' },
      { planner_confirm: { confirmId: 'p1', name: 'calendar' }, nodeId: 'n1' },
      { login_required: { requestId: 'l1', siteName: 'x' }, nodeId: 'n1' },
      { grant_required: { target: 'browser' }, nodeId: 'n1' },
    ]);
    expect(w.meta.interactions).toBeDefined();
    expect(w.meta.interactions!.coding_phase).toEqual({ phase: 'running', tool: 'write_file' });
    expect(w.meta.interactions!.tool_confirm).toMatchObject({ confirmId: 'c9' });
    expect(w.meta.interactions!.questions_request).toMatchObject({ requestId: 'q1' });
    expect(w.meta.interactions!.planner_confirm).toMatchObject({ confirmId: 'p1' });
    expect(w.meta.interactions!.login_required).toMatchObject({ requestId: 'l1' });
    expect(w.meta.interactions!.grant_required).toEqual({ target: 'browser' });
    expect(w.spans).toHaveLength(1);
  });

  it('done 帧收任务级 meta（taskId/usage/contextMeter/matchedSkills/doneAt）', () => {
    const w = run([
      { tool_call: { name: 'web_search', spanId: 'sp-a' }, nodeId: 'n1' },
      { done: true, nodeId: 'n1', taskId: 'task-1', matchedSkills: ['web_search'], usage: { promptTokens: 100, completionTokens: 50 }, stats: { durationMs: 5000 }, contextMeter: { system: 1, capacity: 1_000_000 } },
    ]);
    expect(w.meta.taskId).toBe('task-1');
    expect(w.meta.usage).toMatchObject({ promptTokens: 100, completionTokens: 50 });
    expect(w.meta.contextMeter).toMatchObject({ capacity: 1_000_000 });
    expect(w.meta.matchedSkills).toEqual(['web_search']);
    expect(typeof w.meta.doneAt).toBe('number');
  });

  it('error 帧标记到 state.error，不影响既有 span', () => {
    const w = run([
      { tool_call: { name: 'web_search', spanId: 'sp-a' }, nodeId: 'n1' },
      { error: '模型不可用', nodeId: 'n1', taskId: 'task-1' },
    ]);
    expect(w.error).toBe('模型不可用');
    expect(w.spans).toHaveLength(1);
    expect(w.spans[0].phase).toBe('pending');
  });

  it('tool_call 帧自带 error 阶段 → 建 error span（服务端 4188 形态）', () => {
    const w = run([{ tool_call: { name: 'web_fetch', arguments: {}, phase: 'error', spanId: 'sp-e', startAt: 1 }, nodeId: 'n1' }]);
    expect(w.spans).toHaveLength(1);
    expect(w.spans[0].phase).toBe('error');
    expect(w.spans[0].status).toBe('error');
  });

  it('finishWindow：pending/running 全部收口 done（等价 ChatNodeKernel 流末收口），已 done 不动', () => {
    const w = run([
      { tool_call: { name: 'a', spanId: 'sp-a', startAt: 1000 }, nodeId: 'n1' },
      { tool_call_update: { name: 'a', phase: 'running', spanId: 'sp-a' }, nodeId: 'n1' },
      { tool_call: { name: 'b', spanId: 'sp-b', startAt: 2000 }, nodeId: 'n1' },
      { tool_result: { name: 'b', result: 'r', durationMs: 500, success: true, spanId: 'sp-b', startAt: 2000, endAt: 2500 }, nodeId: 'n1' },
      { tool_call: { name: 'c', spanId: 'sp-c' }, nodeId: 'n1' },
    ]);
    // 收口前：a=running、b=done、c=pending
    const finished = finishWindow(w);
    expect(finished.spans).toHaveLength(3);
    const byId = Object.fromEntries(finished.spans.map((s) => [s.spanId, s]));
    expect(byId['sp-a'].phase).toBe('done');
    expect(byId['sp-a'].endAt).toBeGreaterThanOrEqual(0);
    expect(byId['sp-b'].phase).toBe('done');
    expect(byId['sp-b'].endAt).toBe(2500); // 已结算的不被改动
    expect(byId['sp-c'].phase).toBe('done');
    // 原窗口不被修改（纯函数返回新 state）
    expect(w.spans.find((s) => s.spanId === 'sp-a')!.phase).toBe('running');
    expect(w.spans.find((s) => s.spanId === 'sp-c')!.phase).toBe('pending');
    // 无待收口时原样返回（引用不变）
    const clean = run([{ tool_result: { name: 'x', result: 'r', success: true } }, { error: 'e' }]);
    expect(finishWindow(clean)).toBe(clean);
  });

  it('pushWindowFrame 空事件安全忽略且不改 state', () => {
    expect(pushWindowFrame(win, null)).toBe(win);
    expect(pushWindowFrame(win, { seq: 0, type: '', ts: 0, payload: {} })).toBe(win);
  });

  it('createTraceWindow 初始形态', () => {
    const w0 = createTraceWindow();
    expect(w0.spans).toEqual([]);
    expect(w0.meta).toEqual({});
    expect(w0.currentRound).toBe(0);
    expect(w0.frameCount).toBe(0);
    expect(w0.reasoningAccum).toBeUndefined();
    expect(w0.contentAccum).toBeUndefined();
  });
});

/* ==================== P5b-1 历史 replay（core 结算事件 → 窗口） ==================== */

/** 构造 TrajectoryEvent 同构事件（与落盘 JSONL 一致：seq/type/ts/payload） */
function coreEv(seq: number, type: string, payload: Record<string, unknown>) {
  return { seq, type, ts: 1_700_000_000_000 + seq, payload };
}

describe('P5b-1 eventsToTraceWindow：core 结算事件吸收（用户/终答/工具 round 链）', () => {
  it('纯 core 事件链（user→step→attempt→tool/result→assistant/message→turn/end）→ finish 态 span/文本/meta 正确且不重复建 span', () => {
    const events = [
      coreEv(0, 'turn/start', { nodeId: 'n1', identity: 'chat', userInput: '用户提问' }),
      coreEv(1, 'user/message', { role: 'user', content: '用户提问' }),
      coreEv(2, 'step/start', { round: 0 }),
      coreEv(3, 'assistant/attempt', {
        round: 0,
        role: 'assistant',
        content: '（搜索中）',
        reasoning: '需要检索法条',
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{"query":"民法典 第584条"}' }],
      }),
      coreEv(4, 'tool/result', { round: 0, role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: '完整检索结果全文…' }),
      coreEv(5, 'assistant/message', { round: 0, role: 'assistant', content: '最终答复。', reasoning: '', toolCalls: [] }),
      coreEv(6, 'turn/end', { rounds: 1 }),
    ];
    const win = eventsToTraceWindow(events);

    // meta：userText 来自 user/message（覆盖 turn/start.userInput 兜底）
    expect(win.meta.userText).toBe('用户提问');
    expect(win.currentRound).toBe(0);
    // 文本累积：attempt reasoning + content；终答 content 收口
    expect(win.reasoningAccum).toBe('需要检索法条');
    expect(win.contentAccum).toBe('（搜索中）最终答复。');
    // span：core attempt 以 tool_call_id 为 spanId 建 pending → tool/result 结算 done + 全文
    expect(win.spans).toHaveLength(1);
    const s = win.spans[0];
    expect(s.toolName).toBe('web_search');
    expect(s.spanId).toBe('call_1');
    expect(s.toolCallId).toBe('call_1');
    expect(s.phase).toBe('done');
    expect(s.success).toBe(true);
    expect(s.result).toBe('完整检索结果全文…');
    expect(s.arguments).toEqual({ query: '民法典 第584条' });
    // turn/end 已触发 finish 语义（无残留 pending/running）
    expect(win.spans.some((x) => x.phase === 'pending' || x.phase === 'running')).toBe(false);
  });

  it('SSE 帧 + core 混合不双建（真实 record 顺序：core attempt 先、SSE tool_call 帧后到并入 uuid）', () => {
    const events = [
      coreEv(0, 'user/message', { role: 'user', content: '帮我查资料' }),
      coreEv(1, 'step/start', { round: 0 }),
      coreEv(2, 'assistant/attempt', {
        round: 0,
        role: 'assistant',
        reasoning: '先搜索',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' }],
      }),
      // SSE 帧（eventLog.record 落盘形态：整帧 = payload，tool_call 嵌套在内）
      coreEv(3, 'tool_call', { tool_call: { name: 'web_search', arguments: { query: 'x' }, phase: 'pending', spanId: 'sp-uuid', startAt: 1000, purpose: '检索' }, nodeId: 'n1' }),
      coreEv(4, 'tool_call_update', { tool_call_update: { name: 'web_search', phase: 'running', spanId: 'sp-uuid', startAt: 1000 }, nodeId: 'n1' }),
      coreEv(5, 'tool_result', { tool_result: { name: 'web_search', phase: 'done', success: true, durationMs: 500, kind: 'tool', summary: '命中 3 条', spanId: 'sp-uuid', startAt: 1000, endAt: 1500, result: '（截断）' }, nodeId: 'n1' }),
      coreEv(6, 'tool/result', { round: 0, role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: '完整结果全文（SSE 截断被回补）' }),
      coreEv(7, 'assistant/message', { round: 0, role: 'assistant', content: '查好了。', toolCalls: [] }),
      coreEv(8, 'turn/end', { rounds: 1 }),
    ];
    const win = eventsToTraceWindow(events);
    // 幂等：core 建 span 与 SSE tool_call 帧合并为 1 条，不双建
    expect(win.spans).toHaveLength(1);
    const s = win.spans[0];
    expect(s.spanId).toBe('sp-uuid'); // 吸收 SSE 真实 spanId
    expect(s.toolCallId).toBe('call_1'); // core 别名保留（core tool/result 可精确命中）
    expect(s.phase).toBe('done');
    expect(s.success).toBe(true);
    expect(s.result).toBe('完整结果全文（SSE 截断被回补）'); // core 全文回补 SSE 截断
    expect(s.durationMs).toBe(500);
    expect(s.startAt).toBe(1000);
    expect(s.endAt).toBe(1500);
    expect(s.summary).toBe('命中 3 条');
    expect(s.arguments).toEqual({ query: 'x' });
    expect(win.reasoningAccum).toBe('先搜索');
  });

  it('SSE 帧先、core attempt 后（倒序防御）：别名绑定并入同一 span，仍不双建', () => {
    const events = [
      coreEv(0, 'user/message', { role: 'user', content: '问' }),
      coreEv(1, 'step/start', { round: 0 }),
      coreEv(2, 'tool_call', { tool_call: { name: 'read_file', arguments: { path: 'a.md' }, phase: 'pending', spanId: 'sp-uuid', startAt: 2000, purpose: '读文件' }, nodeId: 'n1' }),
      coreEv(3, 'tool_call_update', { tool_call_update: { name: 'read_file', phase: 'running', spanId: 'sp-uuid', startAt: 2000 }, nodeId: 'n1' }),
      coreEv(4, 'assistant/attempt', { round: 0, role: 'assistant', reasoning: '读文件确认', toolCalls: [{ id: 'call_9', name: 'read_file', arguments: '{"path":"a.md"}' }] }),
      coreEv(5, 'tool_result', { tool_result: { name: 'read_file', phase: 'done', success: true, durationMs: 100, spanId: 'sp-uuid', startAt: 2000, endAt: 2100, result: '短' }, nodeId: 'n1' }),
      coreEv(6, 'tool/result', { round: 0, role: 'tool', tool_call_id: 'call_9', name: 'read_file', content: '文件全文内容（较长）' }),
      coreEv(7, 'assistant/message', { round: 0, role: 'assistant', content: '读完了。' }),
      coreEv(8, 'turn/end', { rounds: 1 }),
    ];
    const win = eventsToTraceWindow(events);
    expect(win.spans).toHaveLength(1);
    const s = win.spans[0];
    expect(s.spanId).toBe('sp-uuid');
    expect(s.toolCallId).toBe('call_9'); // attempt 后到 → 绑别名，不新建
    expect(s.phase).toBe('done');
    expect(s.result).toBe('文件全文内容（较长）');
    expect(s.durationMs).toBe(100);
  });

  it('compaction / done / context_meter / matchedSkills 进 meta；未知 core 形态安全忽略', () => {
    const events = [
      coreEv(0, 'user/message', { role: 'user', content: '长会话' }),
      coreEv(1, 'compaction', { summaryGoal: '压缩', shadowedTurns: { from: 1, to: 3 }, reason: '超长' }),
      coreEv(2, 'matchedSkills', { matchedSkills: ['a'], skillDetails: [], nodeId: 'n1' }),
      coreEv(3, 'context_meter', { context_meter: { system: 1, capacity: 1_000_000 } }),
      coreEv(4, 'step/end', { round: 0 }), // 窗口不建模 → 忽略
      coreEv(5, 'done', { done: true, taskId: 'task-1', usage: { calls: 1 }, contextMeter: { system: 1 } }),
      coreEv(6, 'turn/end', { rounds: 1 }),
    ];
    const win = eventsToTraceWindow(events);
    expect(win.meta.userText).toBe('长会话');
    expect(win.meta.compactions).toHaveLength(1);
    expect(win.meta.compactions![0]).toMatchObject({ summaryGoal: '压缩', reason: '超长' });
    expect(win.meta.matchedSkills).toEqual(['a']);
    expect(win.meta.taskId).toBe('task-1');
    expect(win.spans).toHaveLength(0);
    expect(win.meta.compactions![0]).toHaveProperty('shadowedTurns');
  });

  it('真实 fixture（纯问答 mtr7mweq）→ eventsToTraceWindow → windowToTrajectoryItems：userText + thinkText + 零工具（等价 .md 渲染）', () => {
    const events = readEventLog(FIXTURE);
    expect(events.length).toBeGreaterThanOrEqual(6);
    const win = eventsToTraceWindow(events);
    // 纯问答：无 span、done 收 taskId、user/message 记 userText
    expect(win.spans).toHaveLength(0);
    expect(win.meta.taskId).toBe('mtr7mweq-5c9e5e79');
    expect(win.meta.userText).toBe('P1 事件溯源验证：请只回复“OK”两字，不要调用任何工具。');
    const items = windowToTrajectoryItems(win);
    expect(items).not.toBeNull();
    expect(items).toHaveLength(1);
    const item = items![0];
    // 与 .md 渲染等价：user 原文 + reasoning 思考 + 无工具/无技能
    expect(item.userText).toBe('P1 事件溯源验证：请只回复“OK”两字，不要调用任何工具。');
    expect(item.thinkText).toBeDefined();
    expect(item.thinkText!.length).toBeGreaterThan(20);
    expect(item.thinkText!).toContain("The user's instruction is a test");
    expect(item.toolCalls).toHaveLength(0);
    expect(item.matchedSkills).toHaveLength(0);
    expect(item.skillDetails).toHaveLength(0);
  });
});

describe('P5d 读端：tool_compact / 纠偏帧 / output_files 纳入窗口', () => {
  it('tool_compact → 命中同名未结算 span 标记 compacted（不新建 span）', () => {
    let win = feedFrame(createTraceWindow(), {
      tool_call: { name: 'read_file', spanId: 's1', phase: 'pending', startAt: 10 },
    });
    win = feedFrame(win, { tool_compact: { name: 'read_file' }, nodeId: 'n' });
    expect(win.spans).toHaveLength(1);
    expect(win.spans[0].compacted).toBe(true);
    expect(win.spans[0].phase).toBe('pending'); // 不结算、只打标
    // 已结算 span 不再标记
    win = feedFrame(createTraceWindow(), {
      tool_call: { name: 'read_file', spanId: 's1', phase: 'pending', startAt: 10 },
    });
    win = feedFrame(win, { tool_result: { name: 'read_file', spanId: 's1', phase: 'done', success: true } });
    win = feedFrame(win, { tool_compact: { name: 'read_file' } });
    expect(win.spans[0].compacted).toBeUndefined();
  });

  it('completion_check / claim_mismatch → meta.corrections 累积（含 type 标记）', () => {
    let win = createTraceWindow();
    win = feedFrame(win, { completion_check: { pass: false, reason: 'x' } });
    win = feedFrame(win, { claim_mismatch: { field: 'y' } });
    expect(win.meta.corrections).toHaveLength(2);
    expect(win.meta.corrections![0]).toMatchObject({ type: 'completion_check', pass: false });
    expect(win.meta.corrections![1]).toMatchObject({ type: 'claim_mismatch', field: 'y' });
  });

  it('output_files → meta.outputFiles 取 files（最终一次覆盖）', () => {
    let win = createTraceWindow();
    win = feedFrame(win, { output_files: { files: [{ path: 'a.md', name: 'a.md', size: 1, kind: 'doc' }] } });
    win = feedFrame(win, { output_files: { files: [{ path: 'b.md', name: 'b.md', size: 2, kind: 'doc' }] } });
    expect(win.meta.outputFiles).toHaveLength(1);
    expect(win.meta.outputFiles![0]).toMatchObject({ path: 'b.md' });
    // 无 files 数组的帧不覆盖
    win = feedFrame(win, { output_files: { ok: true } });
    expect(win.meta.outputFiles).toHaveLength(1);
  });
});
