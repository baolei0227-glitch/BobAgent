'use client';

import { useState } from 'react';
import { Sparkles, Loader2, ChevronDown, ChevronRight, CalendarPlus, AlertCircle, Check, Trash2 } from 'lucide-react';

interface SummarizedTask {
  title: string;
  start_time: string;
  end_time?: string | null;
  all_day: boolean;
  priority: 'high' | 'normal' | 'low';
  description?: string;
  source_raw?: string;
}

interface TaskPanelProps {
  projectId: string;
  onEventsCreated: () => void; // 创建成功后刷新日历
}

export function TaskPanel({ projectId, onEventsCreated }: TaskPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [rawText, setRawText] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState('');
  const [tasks, setTasks] = useState<SummarizedTask[]>([]);
  const [ambiguous, setAmbiguous] = useState<string[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importDone, setImportDone] = useState(false);

  const handleSummarize = async () => {
    const text = rawText.trim();
    if (!text) return;
    setSummarizing(true);
    setSummarizeError('');
    setTasks([]);
    setAmbiguous([]);
    setSelectedIndices(new Set());
    setImportDone(false);
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
      setTasks(data.tasks || []);
      setAmbiguous(data.ambiguous_items || []);
      // 默认全选
      setSelectedIndices(new Set((data.tasks || []).map((_: any, i: number) => i)));
    } catch (err: any) {
      setSummarizeError(err?.message || '网络错误');
    } finally {
      setSummarizing(false);
    }
  };

  const toggleTask = (i: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const handleImport = async () => {
    if (selectedIndices.size === 0) return;
    setImporting(true);
    try {
      const selected = tasks.filter((_, i) => selectedIndices.has(i));
      const payload = selected.map((t) => ({
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
      setImportDone(true);
      onEventsCreated();
    } catch (err: any) {
      setSummarizeError(err?.message || '网络错误');
    } finally {
      setImporting(false);
    }
  };

  const PRIORITY_COLORS: Record<string, string> = {
    high: '#ef4444',
    normal: '#8a8270',
    low: '#9ca3af',
  };

  return (
    <div style={{ borderTop: '1px solid oklch(0.85 0.01 70)', borderBottom: '1px solid oklch(0.85 0.01 70)' }}>
      {/* 折叠头部 */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-[oklch(0.92_0.015_75)]"
        style={{ color: 'oklch(0.40 0.02 50)', backgroundColor: 'oklch(0.96 0.012 80)' }}
      >
        <Sparkles className="h-3.5 w-3.5" style={{ color: 'oklch(0.55 0.15 220)' }} />
        <span className="flex-1 text-left font-semibold text-[11px]">Task Summarizer</span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" style={{ color: 'oklch(0.50 0.02 50)' }} />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" style={{ color: 'oklch(0.50 0.02 50)' }} />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3" onWheel={(e) => e.stopPropagation()}>
          {/* 文本输入 */}
          <textarea
            placeholder="Paste meeting notes, tasks, emails...&#10;e.g. 明天下午3点开产品评审会，后天提交周报"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-md border px-2 py-1.5 text-[11px] outline-none"
            style={{
              backgroundColor: 'oklch(0.97 0.008 80)',
              borderColor: 'oklch(0.80 0.03 60 / 0.4)',
              color: 'oklch(0.35 0.02 50)',
              fontFamily: "'Noto Serif SC', serif",
            }}
          />

          {/* 归纳按钮 */}
          <button
            onClick={handleSummarize}
            disabled={summarizing || !rawText.trim()}
            className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50"
            style={{
              backgroundColor: 'oklch(0.55 0.15 220 / 0.12)',
              color: 'oklch(0.50 0.12 220)',
            }}
          >
            {summarizing ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" />
                Summarize
              </>
            )}
          </button>

          {/* 错误 */}
          {summarizeError && (
            <div
              className="mt-1.5 flex items-start gap-1 rounded-md px-2 py-1 text-[10px]"
              style={{ backgroundColor: 'oklch(0.55 0.18 35 / 0.08)', color: 'oklch(0.55 0.18 35)' }}
            >
              <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
              {summarizeError}
            </div>
          )}

          {/* 解析结果 */}
          {tasks.length > 0 && (
            <div className="mt-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-medium" style={{ color: 'oklch(0.50 0.02 50)' }}>
                  {tasks.length} task{tasks.length > 1 ? 's' : ''} found
                </span>
                <span className="text-[9px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  {selectedIndices.size} selected
                </span>
              </div>

              <div className="max-h-[200px] space-y-1 overflow-y-auto">
                {tasks.map((task, i) => (
                  <label
                    key={i}
                    className="flex cursor-pointer items-start gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-[oklch(0.95_0.008_80)]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIndices.has(i)}
                      onChange={() => toggleTask(i)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span
                          className="truncate text-[10px] font-medium"
                          style={{ color: 'oklch(0.30 0.015 50)' }}
                        >
                          {task.title}
                        </span>
                        <span
                          className="shrink-0 rounded px-1 py-px text-[8px]"
                          style={{
                            backgroundColor: `${PRIORITY_COLORS[task.priority]}18`,
                            color: PRIORITY_COLORS[task.priority],
                          }}
                        >
                          {task.priority === 'high' ? 'High' : task.priority === 'low' ? 'Low' : 'Norm'}
                        </span>
                      </div>
                      <div className="text-[9px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                        {task.all_day ? (
                          new Date(task.start_time).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
                        ) : (
                          <>
                            {new Date(task.start_time).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            {task.end_time && ` - ${new Date(task.end_time).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}
                          </>
                        )}
                      </div>
                      {task.source_raw && (
                        <div
                          className="mt-0.5 truncate text-[9px]"
                          style={{ color: 'oklch(0.55 0.02 50)', opacity: 0.7 }}
                        >
                          "{task.source_raw.slice(0, 60)}{task.source_raw.length > 60 ? '...' : ''}"
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>

              {/* 无法解析的条目 */}
              {ambiguous.length > 0 && (
                <div className="mt-2 rounded-md border px-2 py-1.5" style={{ borderColor: 'oklch(0.80 0.03 60 / 0.3)' }}>
                  <span className="text-[9px] font-medium" style={{ color: 'oklch(0.55 0.02 50)' }}>
                    Can't parse ({ambiguous.length}):
                  </span>
                  <ul className="mt-0.5 list-disc pl-3">
                    {ambiguous.map((item, i) => (
                      <li key={i} className="text-[9px]" style={{ color: 'oklch(0.55 0.02 50)' }}>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 导入按钮 */}
              {!importDone ? (
                <button
                  onClick={handleImport}
                  disabled={importing || selectedIndices.size === 0}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    backgroundColor: 'oklch(0.62 0.17 45 / 0.12)',
                    color: 'oklch(0.50 0.12 45)',
                  }}
                >
                  {importing ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    <>
                      <CalendarPlus className="h-3 w-3" />
                      Add to Calendar ({selectedIndices.size})
                    </>
                  )}
                </button>
              ) : (
                <div
                  className="mt-2 flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px]"
                  style={{ backgroundColor: 'oklch(0.50 0.12 45 / 0.08)', color: 'oklch(0.50 0.12 45)' }}
                >
                  <Check className="h-3 w-3" />
                  {selectedIndices.size} event{selectedIndices.size > 1 ? 's' : ''} added
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
