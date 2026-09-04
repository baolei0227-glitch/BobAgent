'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpCircle, X, HelpCircle } from 'lucide-react';

/** 单个问题定义 */
export interface QuestionItem {
  id: string;
  question: string;
  options: string[];
  allowCustom: boolean;
}

/** 用户对单个问题的回答 */
export interface AnswerEntry {
  questionId: string;
  selected: string | null;
  custom: string;
}

interface QuestionPopupProps {
  questions: QuestionItem[];
  onSubmit: (answers: AnswerEntry[]) => void;
  onClose: () => void;
}

/** 按顶层括号深度把可能拼接的多个 JSON 数组拆分为独立片段（正确处理嵌套数组的 ] 不截断） */
function splitTopLevelArrays(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[' || ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) { parts.push(raw.slice(start, i + 1)); start = -1; }
    }
  }
  return parts;
}

/**
 * 容错修复：模型偶发在选项文本内使用「未转义的英文双引号」（如 涉及"浮桥"纠纷），
 * 导致整个 JSON 非法、JSON.parse 抛错 → 弹窗不出现、原文裸露。
 * 逐字符扫描：字符串内部的裸引号（后随字符而非 , } ] :）判定为文本引号，
 * 交替替换为中文弯引号 ""（合法字符，无需转义）；字符串边界引号保持不变。
 * 对合法 JSON 无副作用（合法 JSON 中字符串内部引号必为 \" 转义形式，此处已跳过）。
 */
function repairUnescapedQuotes(raw: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  let textQuoteCount = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    // inStr 状态
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') {
      // 向后看一个非空白字符：结构字符 → 字符串边界；否则 → 文本引号
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      const next = raw[j];
      if (next === ',' || next === '}' || next === ']' || next === ':' || j >= raw.length) {
        inStr = false;
        out += ch;
      } else {
        textQuoteCount++;
        out += textQuoteCount % 2 === 1 ? '\u201c' : '\u201d';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** 从 AI 回复文本中提取 QUESTIONS 块，返回问题和去除块后的纯文本 */
export function extractQuestions(content: string): { questions: QuestionItem[]; cleanContent: string } {
  if (!content) return { questions: [], cleanContent: content };

  // 尝试多种包裹格式（兼容模型偶发的 <-- / --!> 变体与注释缺失）
  const toQuestions = (parsed: unknown): QuestionItem[] | null =>
    Array.isArray(parsed)
      ? (parsed as QuestionItem[])
      : parsed && typeof parsed === 'object' && 'question' in (parsed as Record<string, unknown>)
        ? [{
            id: (parsed as Record<string, unknown>).id as string ?? 'q1',
            question: String((parsed as Record<string, unknown>).question ?? ''),
            options: Array.isArray((parsed as Record<string, unknown>).options)
              ? ((parsed as Record<string, unknown>).options as string[])
              : [],
            allowCustom: (parsed as Record<string, unknown>).allowCustom !== false,
          } satisfies QuestionItem]
        : null;

  const tryParse = (raw: string): QuestionItem[] | null => {
    // 1) 原样解析（数组或单个对象）
    try {
      const parsed = JSON.parse(raw);
      const qs = toQuestions(parsed);
      if (qs) return qs;
    } catch { /* 单数组解析失败，继续尝试拼接解析 */ }
    // 2) 容错：修复选项文本内未转义英文引号（如 "浮桥"）后再解析
    try {
      const repaired = repairUnescapedQuotes(raw);
      const parsed = JSON.parse(repaired);
      const qs = toQuestions(parsed);
      if (qs) return qs;
    } catch { /* 仍失败，继续拼接解析 */ }
    // 3) 容错：模型偶发把多题拆成多个数组用空格拼接（[...] [...] [...]），逐个解析后合并
    try {
      const segments = splitTopLevelArrays(raw);
      const merged: QuestionItem[] = [];
      for (const seg of segments) {
        if (!seg.startsWith('[')) continue;
        try {
          const arr = JSON.parse(seg);
          if (Array.isArray(arr)) merged.push(...(arr as QuestionItem[]));
          continue;
        } catch { /* 片段也可能含未转义引号 */ }
        try {
          const arr = JSON.parse(repairUnescapedQuotes(seg));
          if (Array.isArray(arr)) merged.push(...(arr as QuestionItem[]));
        } catch { /* ignore */ }
      }
      if (merged.length > 0) return merged;
    } catch { /* ignore */ }
    return null;
  };

  // 1) 标准包裹：<!-- QUESTIONS --> ... <!-- /QUESTIONS -->
  const regex = /<!--\s*QUESTIONS\s*-->([\s\S]*?)<!--\s*\/QUESTIONS\s*-->/;
  const match = content.match(regex);
  if (match) {
    const questions = tryParse(match[1].trim());
    if (questions && questions.length > 0) {
      return { questions, cleanContent: content.replace(regex, '').replace(/\n{3,}/g, '\n\n').trim() };
    }
  }

  // 2) 变体包裹：<-- / -->（模型偶发的注释闭合符号错误）
  const regexVariant = /<!--\s*QUESTIONS\s*-->([\s\S]*?)<--\s*\/QUESTIONS\s*-->/;
  const matchV = content.match(regexVariant);
  if (matchV) {
    const questions = tryParse(matchV[1].trim());
    if (questions && questions.length > 0) {
      return { questions, cleanContent: content.replace(regexVariant, '').replace(/\n{3,}/g, '\n\n').trim() };
    }
  }

  // 3) 无包裹：正文中出现 JSON 数组且含 question 键 → 视为问卷。
  //    兼容模型偶发把多题拆成多个数组用空格拼接（[...] [...] [...]）的情况。
  const bareArray = content.match(/(?:\[\s*\{[\s\S]*?\}\s*\](?:\s*\[\s*\{[\s\S]*?\}\s*\])*)/);
  if (bareArray) {
    const questions = tryParse(bareArray[0]);
    if (questions && questions.length > 0) {
      return { questions, cleanContent: content.replace(bareArray[0], '').replace(/\n{3,}/g, '\n\n').trim() };
    }
  }

  return { questions: [], cleanContent: content };
}

export default function QuestionPopup({ questions, onSubmit, onClose }: QuestionPopupProps) {
  const [answers, setAnswers] = useState<AnswerEntry[]>(() =>
    questions.map((q) => ({
      questionId: q.id,
      selected: null,
      custom: '',
    })),
  );

  const [submitted, setSubmitted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // 入场动画用 rAF（前台即时触发）；后台标签页 rAF 会被浏览器节流/暂停，
    // 若此时弹窗挂载会一直 opacity:0 不可见（"弹不出"）——加 setTimeout 兜底，无论前后台都最终可见。
    const raf = requestAnimationFrame(() => setVisible(true));
    const t = setTimeout(() => setVisible(true), 400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, []);

  /** 阻止画布操作穿透到弹窗 */
  const stopCanvasEvent = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  /** 阻止滚轮事件（防止画布缩放） */
  const stopWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
  }, []);

  /** 阻止触控板 touch 事件穿透到 React Flow（节点拖拽监听 onTouchStart，双指滑动会误拖节点） */
  const stopTouch = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
  }, []);

  const handleSelect = (questionIdx: number, option: string) => {
    setAnswers((prev) =>
      prev.map((a, i) =>
        i === questionIdx ? { ...a, selected: option } : a,
      ),
    );
  };

  const handleCustomChange = (questionIdx: number, value: string) => {
    setAnswers((prev) =>
      prev.map((a, i) =>
        i === questionIdx ? { ...a, custom: value } : a,
      ),
    );
  };

  const handleSubmit = () => {
    const allAnswered = answers.every((a) => a.selected || a.custom.trim());
    if (!allAnswered) return;

    setSubmitted(true);
    onSubmit(answers);
  };

  const allAnswered = answers.every((a) => a.selected || a.custom.trim());

  if (submitted) return null;

  // 蓝紫色系，与对话窗口暖色区分
  const accent = 'var(--info)';
  const accentLight = 'color-mix(in oklab, var(--info) 8%, transparent)';
  const accentBorder = 'color-mix(in oklab, var(--info) 20%, transparent)';
  const accentHover = 'var(--info)';
  const surfaceBg = 'var(--popover)';
  const cardBg = 'var(--popover)';

  // 通过 portal 渲染到 body：脱离 React Flow 节点 DOM（节点带 transform，会导致 fixed 遮罩
  // 只覆盖节点区域，且事件冒泡链经过画布 pane/节点，双指滑动/拖拽会误触发节点拖拽或画布平移）
  return createPortal(
    <div
      data-canvas-ui="overlay"
      className="fixed inset-0 z-[2000] flex items-center justify-center transition-opacity duration-200"
      style={{
        backgroundColor: 'rgba(15, 23, 42, 0.45)',
        backdropFilter: 'blur(2px)',
        opacity: visible ? 1 : 0,
        // 未可见（后台标签 rAF 未触发期间）时不拦截画布事件，避免"隐形遮罩冻住画布"
        pointerEvents: visible ? 'auto' : 'none',
      }}
      onWheel={stopWheel}
      onMouseDown={stopCanvasEvent}
      onMouseUp={stopCanvasEvent}
      onMouseMove={stopCanvasEvent}
      onPointerDown={stopCanvasEvent}
      onPointerMove={stopCanvasEvent}
      onTouchStart={stopTouch}
      onTouchMove={stopTouch}
      onTouchEnd={stopTouch}
      onClick={stopCanvasEvent}
    >
      <div
        className="relative mx-4 w-full max-w-md overflow-hidden transition-all duration-300"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0) scale(1)' : 'translateY(16px) scale(0.96)',
        }}
        onWheel={stopWheel}
        onMouseDown={stopCanvasEvent}
        onMouseUp={stopCanvasEvent}
        onMouseMove={stopCanvasEvent}
        onPointerDown={stopCanvasEvent}
        onPointerMove={stopCanvasEvent}
      >
        {/* 顶部渐变装饰条 */}
        <div
          className="h-1.5 w-full rounded-t-2xl"
          style={{
            background: `linear-gradient(135deg, ${accent}, var(--info), var(--purple))`,
          }}
        />

        {/* 主体卡片 */}
        <div
          className="rounded-b-2xl shadow-[0_20px_60px_-12px_rgba(0,0,0,0.25)]"
          style={{ backgroundColor: cardBg }}
        >
          {/* 头部 */}
          <div
            className="flex items-center gap-3 border-b px-6 py-4"
            style={{ borderColor: 'var(--paper-soft)' }}
          >
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              style={{ backgroundColor: accentLight }}
            >
              <HelpCircle className="h-4 w-4" style={{ color: accent }} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
                AI 想确认以下信息
              </p>
              <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                请选择或输入你的答案
              </p>
            </div>
            <button
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
              style={{ backgroundColor: 'var(--paper-soft)' }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--paper-soft)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--paper-soft)'; }}
            >
              <X className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            </button>
          </div>

          {/* 问题列表 */}
          <div
            className="max-h-[50vh] overflow-y-auto px-6 py-5 space-y-6"
            style={{ backgroundColor: surfaceBg }}
          >
            {questions.map((q, idx) => (
              <div key={q.id}>
                {/* 问题编号 + 文字 */}
                <div className="flex items-start gap-2.5 mb-3">
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    style={{ backgroundColor: accent, color: '#fff' }}
                  >
                    {idx + 1}
                  </span>
                  <p className="text-sm font-medium leading-snug pt-px" style={{ color: 'var(--ink)' }}>
                    {q.question}
                  </p>
                </div>

                {/* 选项按钮 */}
                <div className="flex flex-wrap gap-2 ml-7">
                  {q.options.map((opt) => {
                    const isSelected = answers[idx]?.selected === opt;
                    return (
                      <button
                        key={opt}
                        onClick={() => handleSelect(idx, opt)}
                        className="rounded-lg px-3.5 py-2 text-xs font-medium transition-all duration-150"
                        style={{
                          backgroundColor: isSelected ? accent : cardBg,
                          color: isSelected ? '#fff' : 'var(--ink)',
                          border: `1.5px solid ${isSelected ? accent : 'var(--paper-soft)'}`,
                          boxShadow: isSelected ? '0 2px 8px color-mix(in oklab, var(--info) 25%, transparent)' : 'none',
                          transform: isSelected ? 'scale(1.02)' : 'scale(1)',
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) {
                            e.currentTarget.style.borderColor = accentBorder;
                            e.currentTarget.style.backgroundColor = accentLight;
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) {
                            e.currentTarget.style.borderColor = 'var(--paper-soft)';
                            e.currentTarget.style.backgroundColor = cardBg;
                          }
                        }}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>

                {/* 自定义输入 */}
                {q.allowCustom !== false && (
                  <div className="ml-7 mt-2">
                    <div className="relative">
                      <textarea
                        value={answers[idx]?.custom || ''}
                        onChange={(e) => handleCustomChange(idx, e.target.value)}
                        placeholder="或输入你自己的答案..."
                        rows={2}
                        className="w-full resize-none rounded-lg border px-3.5 py-2.5 text-xs transition-all duration-150 focus:outline-none"
                        style={{
                          borderColor: answers[idx]?.custom?.trim()
                            ? accentBorder
                            : 'var(--paper-soft)',
                          backgroundColor: answers[idx]?.custom?.trim()
                            ? 'color-mix(in oklab, var(--info) 2%, transparent)'
                            : cardBg,
                          color: 'var(--ink)',
                          fontFamily: 'inherit',
                        }}
                        onFocus={(e) => {
                          e.currentTarget.style.borderColor = accent;
                          e.currentTarget.style.boxShadow = `0 0 0 3px ${accentLight}`;
                        }}
                        onBlur={(e) => {
                          e.currentTarget.style.borderColor = answers[idx]?.custom?.trim()
                            ? accentBorder
                            : 'var(--paper-soft)';
                          e.currentTarget.style.boxShadow = 'none';
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 底部按钮 */}
          <div
            className="flex items-center justify-between gap-2 border-t px-6 py-4"
            style={{ borderColor: 'var(--paper-soft)', backgroundColor: cardBg }}
          >
            <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              {allAnswered ? '已全部回答，可以提交' : `还有 ${answers.filter(a => !a.selected && !a.custom.trim()).length} 题待回答`}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="rounded-lg px-3.5 py-2 text-xs font-medium transition-colors"
                style={{ color: 'var(--ink-muted)' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--paper-soft)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                跳过
              </button>
              <button
                onClick={handleSubmit}
                disabled={!allAnswered}
                className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-xs font-semibold transition-all duration-150"
                style={{
                  backgroundColor: allAnswered ? accent : 'var(--paper-soft)',
                  color: allAnswered ? '#fff' : 'var(--ink-muted)',
                  boxShadow: allAnswered ? '0 2px 8px color-mix(in oklab, var(--info) 25%, transparent)' : 'none',
                  cursor: allAnswered ? 'pointer' : 'not-allowed',
                  transform: allAnswered ? 'scale(1)' : 'scale(0.98)',
                }}
              >
                <ArrowUpCircle className="h-3.5 w-3.5" />
                Confirm
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
