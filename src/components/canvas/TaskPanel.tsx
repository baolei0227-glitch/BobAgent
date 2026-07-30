'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, Loader2, AlertCircle, CalendarDays } from 'lucide-react';

interface SummarizedTask {
  title: string;
  start_time: string;
  end_time?: string | null;
  all_day: boolean;
  priority: 'high' | 'normal' | 'low';
  category_path?: string[];
  description?: string;
  source_raw?: string;
}

interface TaskPanelProps {
  onEventsCreated: () => void;
  onOpenCalendar?: () => void;
}

export function TaskPanel({ onEventsCreated, onOpenCalendar }: TaskPanelProps) {
  const [rawText, setRawText] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState('');
  const [tasks, setTasks] = useState<SummarizedTask[]>([]);
  const [ambiguous, setAmbiguous] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);
  const [modelUsed, setModelUsed] = useState('');

  const AUTO_DELAY = 60000; // 1 分钟无操作自动触发
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoStartRef = useRef<number>(0);
  const rawTextRef = useRef(rawText);
  rawTextRef.current = rawText;
  const [autoCountdown, setAutoCountdown] = useState<number | null>(null);

  const clearAutoTimer = useCallback(() => {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    setAutoCountdown(null);
  }, []);

  const startAutoTimer = useCallback(() => {
    clearAutoTimer();
    if (rawTextRef.current.trim() && !summarizing && !uploading) {
      autoStartRef.current = Date.now();
      setAutoCountdown(60);
      autoTimerRef.current = setTimeout(() => {
        handleSummarize();
      }, AUTO_DELAY);
    }
  }, [clearAutoTimer]);

  // 倒计时更新
  useEffect(() => {
    if (autoCountdown === null || autoCountdown <= 0) return;
    const id = setInterval(() => {
      const elapsed = Date.now() - autoStartRef.current;
      const remaining = Math.max(0, Math.ceil((AUTO_DELAY - elapsed) / 1000));
      setAutoCountdown(remaining);
      if (remaining <= 0) {
        setAutoCountdown(null);
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [autoCountdown]);

  useEffect(() => {
    return () => clearAutoTimer();
  }, [clearAutoTimer]);

  const importToCalendar = async (taskList: SummarizedTask[]) => {
    if (taskList.length === 0) return;
    setUploading(true);
    try {
      const payload = taskList.map((t) => ({
        title: t.title,
        start_time: t.start_time,
        end_time: t.end_time ?? undefined,
        all_day: t.all_day,
        priority: t.priority,
        description: t.description,
        source_raw: t.source_raw,
        tags: [],
      }));
      const resp = await fetch('/api/calendar/events?bulk=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!data.success) {
        setSummarizeError(data.error || '导入失败');
        return;
      }
      // 同时保存到 wanted/todo.md
      try {
        await fetch('/api/todo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'append',
            tasks: taskList.map(t => ({
              title: t.title,
              start_time: t.start_time,
              end_time: t.end_time,
              all_day: t.all_day,
              priority: t.priority,
              category_path: t.category_path,
              description: t.description,
              source_raw: t.source_raw,
            })),
          }),
        });
      } catch { /* todo 保存失败不影响主流程 */ }
      setUploadDone(true);
      onEventsCreated();
    } catch (err: any) {
      setSummarizeError(err?.message || '网络错误');
    } finally {
      setUploading(false);
    }
  };

  // 输入变化：重置自动计时器
  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setRawText(e.target.value);
    // 用 setTimeout 让 rawTextRef 先更新
    setTimeout(() => startAutoTimer(), 0);
  }, [startAutoTimer]);

  // Enter 自动编号：已有文字自动编号，并创建下一个编号行
  const handleTextKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const currentText = rawTextRef.current;
      const lines = currentText.split('\n');

      // 找出已有编号中的最大值
      let lastNum = 0;
      const numbered: boolean[] = new Array(lines.length).fill(false);
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^\[(\d+)\]\s*/);
        if (match) {
          lastNum = Math.max(lastNum, parseInt(match[1], 10));
          numbered[i] = true;
        }
      }

      // 为未编号的非空行自动编号
      const resultLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue; // 跳过空行
        if (numbered[i]) {
          resultLines.push(lines[i]);
        } else {
          lastNum++;
          resultLines.push(`[${lastNum}] ${trimmed}`);
        }
      }

      // 添加下一个空行，准备输入第二个任务
      lastNum++;
      resultLines.push(`[${lastNum}] `);

      const newText = resultLines.join('\n');
      setRawText(newText);
      setTimeout(() => startAutoTimer(), 0);
    }
  }, [startAutoTimer]);

  const handleSummarize = async () => {
    const text = rawTextRef.current.trim();
    if (!text) return;
    clearAutoTimer();
    setSummarizing(true);
    setSummarizeError('');
    setTasks([]);
    setAmbiguous([]);
    setUploadDone(false);
    setModelUsed('');
    try {
      const resp = await fetch('/api/tasks/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await resp.json();
      if (!data.success) {
        setSummarizeError(data.error || '归纳失败');
        return;
      }
      const taskList: SummarizedTask[] = data.tasks || [];
      setTasks(taskList);
      setAmbiguous(data.ambiguous_items || []);
      setModelUsed(data.model_used || '');

      if (taskList.length > 0) {
        await importToCalendar(taskList);
      }
      setRawText('');
    } catch (err: any) {
      setSummarizeError(err?.message || '网络错误');
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <div style={{
      margin: '8px 8px 4px 8px',
      position: 'relative',
    }}>
      {/* 通缉令外层 — 做旧纸张 */}
      <div style={{
        position: 'relative',
        backgroundColor: 'oklch(0.88 0.06 75)',
        border: '2px solid oklch(0.65 0.06 55)',
        borderRadius: '1px',
        boxShadow: `
          inset 0 0 60px oklch(0.75 0.06 65 / 0.5),
          0 4px 16px rgba(0,0,0,0.3),
          2px 4px 0 oklch(0.55 0.06 45 / 0.3)
        `,
        overflow: 'hidden',
        fontFamily: "'Noto Serif SC', serif",
      }}>
        {/* 撕裂上边缘 */}
        <div style={{
          height: '8px',
          background: `
            repeating-linear-gradient(
              90deg,
              transparent,
              transparent 18px,
              oklch(0.65 0.06 55) 18px,
              oklch(0.65 0.06 55) 19px,
              transparent 19px,
              transparent 22px,
              oklch(0.80 0.05 65) 22px,
              oklch(0.80 0.05 65) 23px,
              transparent 23px,
              transparent 30px,
              oklch(0.65 0.06 55) 30px,
              oklch(0.65 0.06 55) 32px,
              transparent 32px
            )
          `,
        }} />

        {/* ====== 头部 ====== */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            padding: '8px 14px 4px',
            fontFamily: "'Noto Serif SC', serif",
          }}
        >
          {/* 日历按钮 */}
          {onOpenCalendar && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenCalendar(); }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 2,
                color: 'oklch(0.50 0.06 40)',
              }}
              title="Open Calendar"
            >
              <CalendarDays size={16} />
            </button>
          )}

          {/* WANTED 标题 */}
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{
              fontSize: '22px',
              fontWeight: 900,
              letterSpacing: '0.3em',
              color: 'oklch(0.25 0.03 35)',
              textShadow: '1px 1px 0 oklch(0.50 0.05 50 / 0.3)',
              lineHeight: 1,
              fontFamily: "'Georgia', 'Times New Roman', 'Noto Serif SC', serif",
            }}>
              WANTED
            </div>
            <div style={{
              fontSize: '9px',
              fontWeight: 700,
              letterSpacing: '0.25em',
              color: 'oklch(0.35 0.03 35)',
              marginTop: 1,
            }}>
              DEAD OR ALIVE
            </div>
            <div style={{
              fontSize: '12px',
              fontWeight: 900,
              color: 'oklch(0.28 0.04 35)',
              marginTop: 2,
              fontFamily: "'Georgia', 'Times New Roman', serif",
            }}>
              <span style={{ fontSize: '10px' }}>฿</span>100,000,000
            </div>
          </div>

          {/* 占位，保持布局对称 */}
          <div style={{ width: 18 }} />
        </div>

        {/* ====== 内容 ====== */}
        <div style={{ padding: '0 16px 12px' }}>
            {/* 通缉令中心区域 */}
            <div style={{
              margin: '4px 0 8px',
              borderTop: '1.5px solid oklch(0.60 0.05 50 / 0.4)',
              borderBottom: '1.5px solid oklch(0.60 0.05 50 / 0.4)',
              padding: '8px 0',
            }}>
              {/* 任务输入区 */}
              <textarea
                placeholder="输入任务，Enter 自动编号，60 秒无操作自动提交..."
                value={rawText}
                onChange={handleTextChange}
                onKeyDown={handleTextKeyDown}
                rows={6}
                style={{
                  width: '100%',
                  resize: 'vertical',
                  borderRadius: '2px',
                  border: '1.5px solid oklch(0.60 0.04 50 / 0.4)',
                  padding: '8px 10px',
                  fontSize: '11px',
                  outline: 'none',
                  backgroundColor: 'oklch(0.92 0.04 80 / 0.6)',
                  color: 'oklch(0.30 0.02 35)',
                  fontFamily: "'Noto Serif SC', serif",
                  lineHeight: 1.6,
                }}
                onWheel={(e) => e.stopPropagation()}
              />
              {/* 自动提交倒计时 */}
              {autoCountdown !== null && (
                <div style={{
                  fontSize: '9px',
                  color: 'oklch(0.45 0.04 40)',
                  marginTop: 3,
                  textAlign: 'right',
                  opacity: autoCountdown <= 10 ? 1 : 0.5,
                  transition: 'opacity 0.3s',
                }}>
                  {autoCountdown <= 10 ? (
                    <span style={{ color: 'oklch(0.50 0.18 30)', fontWeight: 600 }}>
                      {autoCountdown}s 后自动提交
                    </span>
                  ) : (
                    <span>{autoCountdown}s 后自动提交</span>
                  )}
                </div>
              )}
            </div>

            {/* 错误信息 */}
            {summarizeError && (
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '4px',
                borderRadius: '2px',
                padding: '6px 8px',
                fontSize: '10px',
                backgroundColor: 'oklch(0.50 0.18 30 / 0.1)',
                color: 'oklch(0.45 0.18 30)',
                marginTop: 4,
              }}>
                <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                {summarizeError}
              </div>
            )}
          </div>

        {/* 撕裂下边缘 */}
        <div style={{
          height: '6px',
          background: `
            repeating-linear-gradient(
              90deg,
              oklch(0.65 0.06 55),
              oklch(0.65 0.06 55) 16px,
              transparent 16px,
              transparent 18px,
              oklch(0.80 0.05 65) 18px,
              oklch(0.80 0.05 65) 19px,
              transparent 19px,
              transparent 26px,
              oklch(0.65 0.06 55) 26px,
              oklch(0.65 0.06 55) 28px,
              transparent 28px
            )
          `,
        }} />
      </div>

      {/* 铆钉装饰 — 四角 */}
      {[
        { top: '-6px', left: '10px' },
        { top: '-6px', right: '10px' },
        { bottom: '-2px', left: '10px' },
        { bottom: '-2px', right: '10px' },
      ].map((pos, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            ...pos,
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: 'oklch(0.55 0.08 40)',
            border: '1px solid oklch(0.40 0.06 30)',
            boxShadow: 'inset 0 1px 2px oklch(0.70 0.05 60 / 0.4)',
          }}
        />
      ))}
    </div>
  );
}
