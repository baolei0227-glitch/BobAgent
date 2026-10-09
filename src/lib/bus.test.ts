import { describe, expect, it } from 'vitest';
import { stripThinkTags, unwrapUnclosedThinkTags } from '@/lib/bus';

/**
 * think 标签剥离的**无损口径**回归（2026-10-09）。
 *
 * 事故：管家 18:23 回答「我在哪里可以看到计划」时，模型在正文通道里又起了一个 `<think>`
 * 且忘记闭合，正式回答写在它后面。落库内容里出现「2 个开标签 / 1 个闭标签」；
 * 旧实现 `.replace(/<think>[\s\S]*$/i, '')` 把「开标签 → 结尾」整段剥掉——
 * 连正式回答一起吞了，气泡正文变成空串，UI 落进「三个跳动点」的空态；
 * 消息已落库，刷新也永远转圈（同一函数还供会话预览 / 微信·飞书回执 / 轨迹导出，全都是空串）。
 *
 * 这里锁两条：① 完成态永远不把回答吞成空串（未配对的开标签只脱标签、保文字）；
 * ② 逐帧渲染（streaming）仍保持"未闭合的思考先不显示"，不把思考漏进流式气泡。
 */
const INCIDENT =
  '<think>先想一下要不要建项目……</think>\n' +
  '<think>The Workspace section came back empty. Let me read "Workspace 浮层".\n' +
  'I\'ll do both in parallel.' +
  'Bro，计划我给你核实过了：**5 个里程碑、17 步，现在 0/17** ✅';

describe('stripThinkTags：完成态无损、流式不泄思考', () => {
  it('正常闭合的 think → 剥掉，正文保留', () => {
    expect(stripThinkTags('<think>想一下</think>明天只有一场会。')).toBe('明天只有一场会。');
  });

  it('完成态：未闭合 think 把回答吞掉 → 不吞，回答必须还在（本次事故原文）', () => {
    const out = stripThinkTags(INCIDENT);
    expect(out).toContain('Bro，计划我给你核实过了');
    expect(out).toContain('5 个里程碑、17 步');
    // 未配对的开标签本身不能裸露在正文里
    expect(out).not.toMatch(/<\/?think>/i);
    // 已配对的思考块照旧剥掉
    expect(out).not.toContain('先想一下要不要建项目');
  });

  it('流式（streaming: true）：未闭合的 think 视为正在思考，其中内容先不显示', () => {
    expect(stripThinkTags('<think>正在思考……', { streaming: true })).toBe('');
    expect(stripThinkTags('<think>想完了</think>正文', { streaming: true })).toBe('正文');
  });

  it('完成态只有思考没有正文 → 仍不伪造正文（保持空串，不引入噪声）', () => {
    expect(stripThinkTags('<think>想完了</think>')).toBe('');
  });

  it('空输入原样返回（调用方据此判空，不受影响）', () => {
    expect(stripThinkTags('')).toBe('');
    expect(stripThinkTags(undefined as unknown as string)).toBeUndefined();
  });
});

describe('unwrapUnclosedThinkTags：只脱未配对的开标签', () => {
  it('配对块原样不动，只去掉没闭合的那个开标签', () => {
    const input = '<think>a</think>mid<think>b</think>tail';
    expect(unwrapUnclosedThinkTags(input)).toBe(input);
  });

  it('未配对的开标签被脱掉、其中文字保留', () => {
    expect(unwrapUnclosedThinkTags('前<think>后')).toBe('前后');
  });

  it('两个未配对的开标签都脱掉', () => {
    expect(unwrapUnclosedThinkTags('<think>a<think>b')).toBe('ab');
  });

  it('多余闭标签不误伤正文', () => {
    expect(unwrapUnclosedThinkTags('a</think>b')).toBe('a</think>b');
  });
});
