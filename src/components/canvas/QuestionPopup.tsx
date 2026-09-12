'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpCircle, X, HelpCircle, ChevronLeft, ChevronRight, Minus, MessageSquare } from 'lucide-react';

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
  /** 服务端回答窗口（秒）：倒计时归零后服务端按未回答继续生成，弹窗随之收起 */
  timeoutSec?: number;
  /** 提交全部答案与末页补充说明（supplement 可为空串，服务端截断至 4000 字） */
  onSubmit: (answers: AnswerEntry[], supplement: string) => void;
  /** 关闭 = 最小化为悬浮胶囊（不放弃，可点开继续作答） */
  onClose: () => void;
  /** 显式跳过 = 放弃回答，服务端立即按未回答继续 */
  onSkip: () => void;
  /** 点击悬浮胶囊恢复弹窗 */
  onRestore: () => void;
  /** 倒计时归零回调（服务端已继续，前端据此清理挂起状态） */
  onExpire?: () => void;
  /** 胶囊模式：只渲染右下角悬浮胶囊 */
  minimized?: boolean;
  /** 停靠模式：无遮罩、不 portal，卡片占满容器宽度；由宿主在输入框位置渲染以替代输入框（不遮挡正文） */
  docked?: boolean;
}

/**
 * 漂移清洗兜底：结构化提问统一走 ask_user_questions 工具，若模型偶发无视约定
 * 在正文输出旧版 QUESTIONS 注释块（含 JSON），此处剥掉整块防 JSON 裸露（不解析、不弹窗）。
 */
export function stripQuestionsBlock(content: string): string {
  if (!content || !content.includes('QUESTIONS')) return content;
  return content
    .replace(/<!--\s*QUESTIONS\s*-->[\s\S]*?(?:<!--\s*\/QUESTIONS\s*-->|<--\s*\/QUESTIONS\s*-->)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SUPPLEMENT_MAX = 4000;

export default function QuestionPopup({
  questions,
  timeoutSec,
  onSubmit,
  onClose,
  onSkip,
  onRestore,
  onExpire,
  minimized = false,
  docked = false,
}: QuestionPopupProps) {
  const total = questions.length; // step === total 即末页「补充说明」
  const [answers, setAnswers] = useState<AnswerEntry[]>(() =>
    questions.map((q) => ({
      questionId: q.id,
      selected: null,
      custom: '',
    })),
  );
  const [supplement, setSupplement] = useState('');
  const [step, setStep] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pageIn, setPageIn] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(timeoutSec ?? null);
  const expiredRef = useRef(false);
  const advanceTimer = useRef<number | null>(null);

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

  // 翻页过渡：先隐藏再经双重 rAF 显示，保证每次换页都重放滑入动画
  useEffect(() => {
    setPageIn(false);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPageIn(true)));
    return () => cancelAnimationFrame(raf);
  }, [step]);

  // 回答窗口倒计时（与服务端 QUESTIONS_TIMEOUT_MS 对齐，超时后服务端按未回答继续）
  useEffect(() => {
    if (timeoutSec == null || timeoutSec <= 0) return;
    const t = setInterval(() => setCountdown((c) => (c != null && c > 0 ? c - 1 : c)), 1000);
    return () => clearInterval(t);
  }, [timeoutSec]);

  // 倒计时归零：通知宿主清理挂起状态（仅触发一次；胶囊模式下同样生效）
  useEffect(() => {
    if (countdown == null || countdown > 0 || expiredRef.current) return;
    expiredRef.current = true;
    onExpire?.();
  }, [countdown, onExpire]);

  // 卸载时清理未触发的自动前进定时器
  useEffect(
    () => () => {
      if (advanceTimer.current != null) clearTimeout(advanceTimer.current);
    },
    [],
  );

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

  const answered = (i: number) => !!(answers[i]?.selected || answers[i]?.custom?.trim());
  const answeredCount = answers.filter((a) => a.selected || a.custom.trim()).length;
  const allAnswered = answeredCount === total;

  const goTo = (next: number) => {
    if (advanceTimer.current != null) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    setStep(Math.max(0, Math.min(total, next)));
  };

  /** 选中即自动前进：短暂高亮当前选项后滑入下一题（最后一题滑入补充说明页） */
  const handleSelect = (idx: number, option: string) => {
    setAnswers((prev) => prev.map((a, i) => (i === idx ? { ...a, selected: option } : a)));
    if (advanceTimer.current != null) clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null;
      // 仅当用户仍停留在本题时才前进，避免与手动翻页抢跳
      setStep((s) => (s === idx ? Math.min(total, idx + 1) : s));
    }, 220);
  };

  const handleCustomChange = (idx: number, value: string) => {
    setAnswers((prev) =>
      prev.map((a, i) =>
        i === idx ? { ...a, custom: value } : a,
      ),
    );
  };

  const handleSubmit = () => {
    if (!allAnswered) return;
    setSubmitted(true);
    onSubmit(answers, supplement.trim());
  };

  const formatCountdown = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  if (submitted) return null;

  // 蓝紫色系，与对话窗口暖色区分
  const accent = 'var(--info)';
  const accentLight = 'color-mix(in oklab, var(--info) 8%, transparent)';
  const accentBorder = 'color-mix(in oklab, var(--info) 20%, transparent)';
  const surfaceBg = 'var(--popover)';
  const cardBg = 'var(--popover)';

  const countdownText = countdown != null && countdown > 0 ? ` · ${formatCountdown(countdown)} left` : '';

  // 胶囊模式：弹窗被最小化，右下角常驻提醒；点击胶囊继续作答，× 为显式跳过
  if (minimized) {
    const unanswered = total - answeredCount;
    return createPortal(
      <div
        data-canvas-ui="overlay"
        className="fixed bottom-6 right-6 z-[2000] flex items-center gap-1 rounded-full py-2 pl-4 pr-2 shadow-[0_8px_28px_-6px_rgba(0,0,0,0.35)]"
        style={{ backgroundColor: accent }}
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
        <button
          onClick={onRestore}
          title="Continue answering"
          className="flex items-center gap-2 text-xs font-semibold text-white"
        >
          <span className="relative flex h-2 w-2">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
              style={{ backgroundColor: '#fff' }}
            />
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: '#fff' }} />
          </span>
          <MessageSquare className="h-3.5 w-3.5" />
          {unanswered > 0 ? `${unanswered} question${unanswered > 1 ? 's' : ''} to answer` : 'Ready to submit'}
          {countdownText && <span className="font-normal opacity-80">{countdownText.replace(' · ', '')}</span>}
        </button>
        <button
          onClick={onSkip}
          title="Skip and continue without answers"
          className="flex h-6 w-6 items-center justify-center rounded-full transition-colors"
          style={{ backgroundColor: 'rgba(255,255,255,0.18)' }}
        >
          <X className="h-3 w-3 text-white" />
        </button>
      </div>,
      document.body,
    );
  }

  // 卡片主体（渐变条 + 内容卡片）：全屏遮罩版与停靠版共享，避免双份维护
  const cardBody = (
    <>
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
                AI needs to confirm the following
              </p>
              <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                {step < total
                  ? `Question ${step + 1} of ${total}${countdownText}`
                  : `Last step: Additional details${countdownText}`}
              </p>
            </div>
            <button
              onClick={onClose}
              title="Minimize to a floating pill and continue later"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
              style={{ backgroundColor: 'var(--paper-soft)' }}
            >
              <Minus className="h-3.5 w-3.5" style={{ color: 'var(--ink-muted)' }} />
            </button>
          </div>

          {/* 进度指示：题目点 + 补充说明点，可点击直达 */}
          <div className="flex items-center gap-1.5 px-6 pt-4">
            {questions.map((q, i) => (
              <button
                key={q.id}
                onClick={() => goTo(i)}
                title={`Question ${i + 1}`}
                className="h-1.5 rounded-full transition-all duration-200"
                style={{
                  width: i === step ? 18 : 6,
                  backgroundColor: i === step ? accent : answered(i) ? accentBorder : 'var(--paper-soft)',
                }}
              />
            ))}
            <button
              onClick={() => goTo(total)}
              title="Additional details"
              className="h-1.5 rounded-full transition-all duration-200"
              style={{
                width: step === total ? 18 : 6,
                backgroundColor: step === total ? 'var(--purple)' : 'var(--paper-soft)',
              }}
            />
          </div>

          {/* 当前页内容（翻页滑入过渡） */}
          <div className="px-6 py-5" style={{ backgroundColor: surfaceBg }}>
            <div
              className="transition-all duration-200"
              style={{ opacity: pageIn ? 1 : 0, transform: pageIn ? 'translateX(0)' : 'translateX(28px)' }}
            >
              {step < total ? (
                <div key={questions[step].id}>
                  {/* 问题编号 + 文字 */}
                  <div className="flex items-start gap-2.5 mb-3">
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                      style={{ backgroundColor: accent, color: '#fff' }}
                    >
                      {step + 1}
                    </span>
                    <p className="text-sm font-medium leading-snug pt-px" style={{ color: 'var(--ink)' }}>
                      {questions[step].question}
                    </p>
                  </div>

                  {/* 选项按钮 */}
                  <div className="flex flex-wrap gap-2 ml-7">
                    {questions[step].options.map((opt) => {
                      const isSelected = answers[step]?.selected === opt;
                      return (
                        <button
                          key={opt}
                          onClick={() => handleSelect(step, opt)}
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
                  {questions[step].allowCustom !== false && (
                    <div className="ml-7 mt-2">
                      <textarea
                        value={answers[step]?.custom || ''}
                        onChange={(e) => handleCustomChange(step, e.target.value)}
                        placeholder="Or type your own answer..."
                        rows={2}
                        className="w-full resize-none rounded-lg border px-3.5 py-2.5 text-xs transition-all duration-150 focus:outline-none"
                        style={{
                          borderColor: answers[step]?.custom?.trim()
                            ? accentBorder
                            : 'var(--paper-soft)',
                          backgroundColor: answers[step]?.custom?.trim()
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
                          e.currentTarget.style.borderColor = answers[step]?.custom?.trim()
                            ? accentBorder
                            : 'var(--paper-soft)';
                          e.currentTarget.style.boxShadow = 'none';
                        }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  {/* 末页：补充说明 */}
                  <div className="flex items-start gap-2.5 mb-2">
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                      style={{ backgroundColor: 'var(--purple)', color: '#fff' }}
                    >
                      +
                    </span>
                    <p className="text-sm font-medium leading-snug pt-px" style={{ color: 'var(--ink)' }}>
                      Additional details (optional)
                    </p>
                  </div>
                  <p className="ml-7 mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    Anything else to add — background, constraints, or preferences? Leave blank if not.
                  </p>
                  <div className="ml-7">
                    <textarea
                      value={supplement}
                      maxLength={SUPPLEMENT_MAX}
                      onChange={(e) => setSupplement(e.target.value)}
                      placeholder="e.g. Prioritize cost; don't touch production data; postpone to next week..."
                      rows={4}
                      className="w-full resize-none rounded-lg border px-3.5 py-2.5 text-xs transition-all duration-150 focus:outline-none"
                      style={{
                        borderColor: supplement.trim() ? accentBorder : 'var(--paper-soft)',
                        backgroundColor: supplement.trim()
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
                        e.currentTarget.style.borderColor = supplement.trim() ? accentBorder : 'var(--paper-soft)';
                        e.currentTarget.style.boxShadow = 'none';
                      }}
                    />
                    <p className="mt-1 text-right text-[10px]" style={{ color: 'var(--ink-muted)' }}>
                      {supplement.length}/{SUPPLEMENT_MAX}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 底部按钮 */}
          <div
            className="flex items-center justify-between gap-2 border-t px-6 py-4"
            style={{ borderColor: 'var(--paper-soft)', backgroundColor: cardBg }}
          >
            <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              {step < total
                ? allAnswered
                  ? 'All answered, ready to submit'
                  : `${total - answeredCount} question${total - answeredCount === 1 ? '' : 's'} to go`
                : allAnswered
                  ? 'All answered, ready to submit'
                  : `${total - answeredCount} question${total - answeredCount === 1 ? '' : 's'} unanswered`}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={onSkip}
                title="Discard answers; AI will continue without them"
                className="rounded-lg px-3.5 py-2 text-xs font-medium transition-colors"
                style={{ color: 'var(--ink-muted)' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--paper-soft)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                Skip
              </button>
              {step > 0 && (
                <button
                  onClick={() => goTo(step - 1)}
                  className="inline-flex items-center gap-1 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors"
                  style={{ color: 'var(--ink)', border: '1.5px solid var(--paper-soft)' }}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Previous
                </button>
              )}
              {step < total ? (
                <button
                  onClick={() => goTo(step + 1)}
                  className="inline-flex items-center gap-1 rounded-lg px-4 py-2 text-xs font-semibold transition-all duration-150"
                  style={{
                    backgroundColor: cardBg,
                    color: accent,
                    border: `1.5px solid ${accentBorder}`,
                  }}
                >
                  {step === total - 1 ? 'Next step' : 'Next question'}
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              ) : (
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
                  Submit
                </button>
              )}
            </div>
          </div>
        </div>
    </>
  );

  // 停靠模式：无遮罩、不 portal，渲染在文档流中——宿主在输入框位置条件渲染以替代输入框，
  // 不遮挡正文。卡片位于 React Flow 节点内，仍需阻止滚轮/拖拽/触摸事件冒泡到画布。
  if (docked) {
    return (
      <div
        data-canvas-ui="overlay"
        className="relative max-h-[60vh] w-full overflow-y-auto overflow-x-hidden rounded-2xl shadow-[0_12px_36px_-14px_rgba(0,0,0,0.22)] transition-all duration-300"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(10px)',
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
        {cardBody}
      </div>
    );
  }

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
        {cardBody}
      </div>
    </div>,
    document.body,
  );
}
