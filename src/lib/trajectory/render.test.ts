/**
 * P5a-2 Trace 面板窗口派生（可回退），行为不变 —— 渲染等价验证门单测
 *
 * 覆盖：同一 SSE 帧序列下，「事件窗口派生」（windowToTrajectoryItems）与
 * 「消息快照人工派生」（按 ChatNodeKernel tool_call/tool_result/matchedSkills/done
 * 的 upsert 语义从 messages 字段派生）字段等价：
 *   toolCalls 条数/名/phase/success/durationMs/result/kind/summary/arguments/systemChange、
 *   thinkText 非空且等于 reasoning 累积、matchedSkills/skillDetails 命中。
 * 纯函数对照（不强求 UI 级）；另覆盖 null/空窗口回退与 content 剥 think 兜底。
 */

import { describe, expect, it } from 'vitest';
import { createTraceWindow, normalizeSseFrame, pushWindowFrame, finishWindow, type TraceWindowState } from './present';
import { windowToTrajectoryItems } from './render';

/** 状态机驱动：feed 一条原始 SSE 帧（走 normalize → push 全链路） */
function feedFrame(win: TraceWindowState, raw: Record<string, unknown>): TraceWindowState {
  const ev = normalizeSseFrame(raw);
  return ev ? pushWindowFrame(win, ev) : win;
}

/** 从空窗口喂完整帧序列并 finishWindow */
function runFinished(frames: Array<Record<string, unknown>>): TraceWindowState {
  let w = createTraceWindow();
  for (const f of frames) w = feedFrame(w, f);
  return finishWindow(w);
}

describe('windowToTrajectoryItems：窗口派生 ≡ 消息快照派生的渲染等价门', () => {
  it('含 1 成功 + 1 失败工具、reasoning/content、matchedSkills 的帧序列 → 字段对照等价', () => {
    const frames: Array<Record<string, unknown>> = [
      // 技能命中（matchedSkills + skillDetails 同帧）
      { matchedSkills: ['intern_search'], skillDetails: [{ name: 'intern_search', score: 0.92, matchedKeywords: ['法条'], bodyLength: 1200, forced: false }], nodeId: 'n1' },
      { reasoning: '用户需要检索法条。', nodeId: 'n1' },
      { reasoning: '先查现行有效版本。', nodeId: 'n1' },
      // 工具1（成功）：intern_search
      { tool_call: { name: 'intern_search', arguments: { query: '民法典 第584条' }, phase: 'pending', spanId: 'sp-1', startAt: 1000, purpose: '检索法条' }, nodeId: 'n1' },
      { tool_call_update: { name: 'intern_search', phase: 'running', spanId: 'sp-1', startAt: 1000 }, nodeId: 'n1' },
      { content: '正在核对法条时效。', nodeId: 'n1' },
      { tool_result: { name: 'intern_search', result: '检索到 2 条', durationMs: 800, success: true, phase: 'done', spanId: 'sp-1', kind: 'tool', summary: '命中 2 条法条', cardHtml: '<b>卡片</b>', startAt: 1000, endAt: 1800 }, nodeId: 'n1' },
      // 工具2（失败）：write_file
      { tool_call: { name: 'write_file', arguments: { path: 'homework/x.md' }, phase: 'pending', spanId: 'sp-2', startAt: 2000, purpose: '落盘' }, nodeId: 'n1' },
      { tool_call_update: { name: 'write_file', phase: 'running', spanId: 'sp-2', startAt: 2000 }, nodeId: 'n1' },
      { tool_result: { name: 'write_file', result: '目录不可写', durationMs: 120, success: false, phase: 'error', spanId: 'sp-2', kind: 'tool', systemChange: true, changeSummary: 'Write file homework/x.md', startAt: 2000, endAt: 2120 }, nodeId: 'n1' },
      { content: '检索完成。', nodeId: 'n1' },
      { done: true, nodeId: 'n1', taskId: 'task-1', matchedSkills: ['intern_search'], usage: { promptTokens: 100, completionTokens: 50 }, stats: { durationMs: 5000 }, contextMeter: { system: 1, capacity: 1_000_000 } },
    ];
    const win = runFinished(frames);
    const items = windowToTrajectoryItems(win);
    expect(items).not.toBeNull();
    expect(items).toHaveLength(1);
    const derived = items![0];

    /* ---- 消息快照人工派生（ChatNodeKernel 语义：toolCallRecords push/update/result + m.reasoning） ---- */
    // m.reasoning = reasoning 帧累积；m.content = content 帧累积
    const reasoning = '用户需要检索法条。先查现行有效版本。';
    const skills = ['intern_search'];
    const details = [{ name: 'intern_search', score: 0.92, matchedKeywords: ['法条'], bodyLength: 1200, forced: false }];
    // 手动模拟 ChatNodeKernel tool_call → update → tool_result 的 upsert 终态
    const msgToolCalls = [
      {
        toolName: 'intern_search',
        arguments: { query: '民法典 第584条' },
        result: '检索到 2 条',
        durationMs: 800,
        success: true,
        phase: 'done',
        cardHtml: '<b>卡片</b>',
        kind: 'tool',
        purpose: '检索法条',
        summary: '命中 2 条法条',
        spanId: 'sp-1',
        startAt: 1000,
        endAt: 1800,
      },
      {
        toolName: 'write_file',
        arguments: { path: 'homework/x.md' },
        result: '目录不可写',
        durationMs: 120,
        success: false,
        phase: 'error',
        kind: 'tool',
        purpose: '落盘',
        systemChange: true,
        changeSummary: 'Write file homework/x.md',
        spanId: 'sp-2',
        startAt: 2000,
        endAt: 2120,
      },
    ];

    /* ---- 等价断言：字段对照 ---- */
    expect(derived.toolCalls).toHaveLength(msgToolCalls.length); // 条数
    expect(derived.toolCalls.map((t) => t.toolName)).toEqual(msgToolCalls.map((t) => t.toolName)); // 名
    msgToolCalls.forEach((expected, i) => {
      const actual = derived.toolCalls[i];
      expect(actual.phase).toBe(expected.phase);
      expect(actual.success).toBe(expected.success);
      expect(actual.durationMs).toBe(expected.durationMs);
      expect(actual.result).toBe(expected.result);
      expect(actual.kind).toBe(expected.kind);
      expect(actual.summary).toBe(expected.summary);
      expect(actual.spanId).toBe(expected.spanId);
      expect(actual.startAt).toBe(expected.startAt);
      expect(actual.endAt).toBe(expected.endAt);
      expect(actual.arguments).toEqual(expected.arguments);
      expect(actual.purpose).toBe(expected.purpose);
      expect(actual.systemChange).toBe(expected.systemChange);
      expect(actual.changeSummary).toBe(expected.changeSummary);
    });
    // think 文本非空且等于 reasoning 累积
    expect(derived.thinkText).toBe(reasoning);
    expect(derived.thinkText!.trim().length).toBeGreaterThan(0);
    // skills 命中（matchedSkills 名 + skillDetails 详情）
    expect(derived.matchedSkills).toEqual(skills);
    expect(derived.skillDetails).toEqual(details);
  });

  it('null / 空窗口（无事件）→ null（宿主回退现状路径）', () => {
    expect(windowToTrajectoryItems(null)).toBeNull();
    expect(windowToTrajectoryItems(createTraceWindow())).toBeNull();
    // 仅普通正文 content、无工具/无思考/无技能 → 非轨迹，返回 null
    const plain = runFinished([{ content: '普通回答文本', nodeId: 'n1' }]);
    expect(windowToTrajectoryItems(plain)).toBeNull();
  });

  it('无 reasoning 帧时：contentAccum 剥 think 标签兜底（等价 parseThink(m.content).think）', () => {
    const win = runFinished([
      { content: '<thinking>先拆解需求。', nodeId: 'n1' },
      { content: '再验证可行性。</thinking>正文答复。', nodeId: 'n1' },
    ]);
    const items = windowToTrajectoryItems(win);
    expect(items).not.toBeNull();
    // 跨帧 content 累积成单个闭合 think 标签后整段提取（与 ChatNodeKernel parseThink 同规则）
    expect(items![0].thinkText).toBe('先拆解需求。再验证可行性。');
    expect(items![0].toolCalls).toHaveLength(0);
  });

  it('reasoning 与 content 均含思考时：reasoningAccum 优先（等价 m.reasoning 优先）', () => {
    const win = runFinished([
      { reasoning: '推理一', nodeId: 'n1' },
      { content: '<think>内容里的思考</think>正文', nodeId: 'n1' },
    ]);
    const items = windowToTrajectoryItems(win);
    expect(items![0].thinkText).toBe('推理一');
  });

  it('skillDetails 畸形条目容错：字符串直通、缺 name 对象丢弃、字段缺省归一', () => {
    const win = runFinished([
      { matchedSkills: ['a'], skillDetails: ['legacy-name', { name: 'b', score: 0.5 }, { bogus: 1 }], nodeId: 'n1' },
    ]);
    const items = windowToTrajectoryItems(win);
    expect(items![0].skillDetails).toEqual([
      'legacy-name',
      { name: 'b', score: 0.5, matchedKeywords: [], bodyLength: 0, forced: false },
    ]);
    expect(items![0].matchedSkills).toEqual(['a']);
  });
});
