'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Send, X, HelpCircle } from 'lucide-react';

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

/** 从 AI 回复文本中提取 QUESTIONS 块，返回问题和去除块后的纯文本 */
export function extractQuestions(content: string): { questions: QuestionItem[]; cleanContent: string } {
  const regex = /<!--\s*QUESTIONS\s*-->([\s\S]*?)<!--\s*\/QUESTURES\s*-->/;
  const match = content.match(regex);
  if (!match) {
    const regex2 = /<!--\s*QUESTIONS\s*-->([\s\S]*?)<!--\s*\/QUESTIONS\s*-->/;
    const match2 = content.match(regex2);
    if (!match2) return { questions: [], cleanContent: content };

    const clean = content.replace(regex2, '').replace(/\n{3,}/g, '\n\n').trim();
    try {
      const questions: QuestionItem[] = JSON.parse(match2[1].trim());
      if (Array.isArray(questions) && questions.length > 0) {
        return { questions, cleanContent: clean };
      }
    } catch { /* ignore */ }
    return { questions: [], cleanContent: content };
  }

  const clean = content.replace(regex, '').replace(/\n{3,}/g, '\n\n').trim();
  try {
    const questions: QuestionItem[] = JSON.parse(match[1].trim());
    if (Array.isArray(questions) && questions.length > 0) {
      return { questions, cleanContent: clean };
    }
  } catch { /* ignore */ }
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
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  /** 阻止画布操作穿透到弹窗 */
  const stopCanvasEvent = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  /** 阻止滚轮事件（防止画布缩放） */
  const stopWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
  }, []);

  /** 点击外部关闭 */
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

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
  const accent = 'oklch(0.52 0.17 255)';
  const accentLight = 'oklch(0.52 0.17 255 / 0.08)';
  const accentBorder = 'oklch(0.52 0.17 255 / 0.2)';
  const accentHover = 'oklch(0.48 0.18 255)';
  const surfaceBg = 'oklch(0.985 0.002 260)';
  const cardBg = '#ffffff';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-200"
      style={{
        backgroundColor: 'rgba(15, 23, 42, 0.45)',
        backdropFilter: 'blur(2px)',
        opacity: visible ? 1 : 0,
      }}
      onWheel={stopWheel}
      onMouseDown={stopCanvasEvent}
      onMouseUp={stopCanvasEvent}
      onMouseMove={stopCanvasEvent}
      onPointerDown={stopCanvasEvent}
      onPointerMove={stopCanvasEvent}
      onClick={stopCanvasEvent}
    >
      <div
        ref={popupRef}
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
            background: `linear-gradient(135deg, ${accent}, oklch(0.58 0.18 280), oklch(0.50 0.16 230))`,
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
            style={{ borderColor: 'oklch(0.93 0.005 260)' }}
          >
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              style={{ backgroundColor: accentLight }}
            >
              <HelpCircle className="h-4 w-4" style={{ color: accent }} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold tracking-tight" style={{ color: 'oklch(0.20 0.01 260)' }}>
                AI 想确认以下信息
              </p>
              <p className="text-[11px]" style={{ color: 'oklch(0.50 0.01 260)' }}>
                请选择或输入你的答案
              </p>
            </div>
            <button
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
              style={{ backgroundColor: 'oklch(0.94 0.005 260)' }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'oklch(0.90 0.01 260)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'oklch(0.94 0.005 260)'; }}
            >
              <X className="h-3.5 w-3.5" style={{ color: 'oklch(0.45 0.01 260)' }} />
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
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                    style={{ backgroundColor: accent, color: '#fff' }}
                  >
                    {idx + 1}
                  </span>
                  <p className="text-[13px] font-medium leading-snug pt-px" style={{ color: 'oklch(0.20 0.01 260)' }}>
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
                          color: isSelected ? '#fff' : 'oklch(0.35 0.01 260)',
                          border: `1.5px solid ${isSelected ? accent : 'oklch(0.90 0.005 260)'}`,
                          boxShadow: isSelected ? `0 2px 8px ${accent}40` : 'none',
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
                            e.currentTarget.style.borderColor = 'oklch(0.90 0.005 260)';
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
                            : 'oklch(0.90 0.005 260)',
                          backgroundColor: answers[idx]?.custom?.trim()
                            ? 'oklch(0.52 0.17 255 / 0.02)'
                            : cardBg,
                          color: 'oklch(0.30 0.01 260)',
                          fontFamily: 'inherit',
                        }}
                        onFocus={(e) => {
                          e.currentTarget.style.borderColor = accent;
                          e.currentTarget.style.boxShadow = `0 0 0 3px ${accentLight}`;
                        }}
                        onBlur={(e) => {
                          e.currentTarget.style.borderColor = answers[idx]?.custom?.trim()
                            ? accentBorder
                            : 'oklch(0.90 0.005 260)';
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
            style={{ borderColor: 'oklch(0.93 0.005 260)', backgroundColor: cardBg }}
          >
            <span className="text-[10px]" style={{ color: 'oklch(0.50 0.01 260)' }}>
              {allAnswered ? '已全部回答，可以提交' : `还有 ${answers.filter(a => !a.selected && !a.custom.trim()).length} 题待回答`}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="rounded-lg px-3.5 py-2 text-xs font-medium transition-colors"
                style={{ color: 'oklch(0.45 0.01 260)' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'oklch(0.94 0.005 260)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                跳过
              </button>
              <button
                onClick={handleSubmit}
                disabled={!allAnswered}
                className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-xs font-semibold transition-all duration-150"
                style={{
                  backgroundColor: allAnswered ? accent : 'oklch(0.94 0.005 260)',
                  color: allAnswered ? '#fff' : 'oklch(0.55 0.01 260)',
                  boxShadow: allAnswered ? `0 2px 8px ${accent}40` : 'none',
                  cursor: allAnswered ? 'pointer' : 'not-allowed',
                  transform: allAnswered ? 'scale(1)' : 'scale(0.98)',
                }}
              >
                <Send className="h-3.5 w-3.5" />
                确认
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
