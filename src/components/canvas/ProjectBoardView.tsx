'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Search, LayoutGrid, List, X, ExternalLink, Clock, ArchiveRestore, Archive, Trash, ListTodo, Plus, Check, Loader2, Save, Undo2, CalendarDays, AlarmClock, AlertCircle, MessageSquareText } from 'lucide-react';
import { PROJECT_CATEGORIES, PROJECT_TAG_LIMIT, PROJECT_NOTE_MAX } from '@/lib/types';
import { showImageAiEditToast } from '@/lib/image-ai-edit-runtime';
import { localDateTimeToIso } from '@/lib/utils';

/** 看板项目条目（/api/projects GET 返回，含后端附加的 node_count） */
interface BoardProject {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_accessed_at?: string;
  category?: string;
  tags?: string[];
  note?: string;
  archived?: boolean;
  trashed?: boolean;
  node_count?: number;
  /** 该项目 Sticky 便签未完成待办数（todo-index.json 统计） */
  todo_count?: number;
  /** 该项目未来最近的开庭日期（YYYY-MM-DD，从 todo 固定格式文本解析） */
  hearing_date?: string;
}

type BoardFilter = 'active' | 'archived' | 'trash';

/** 元信息自动保存的落盘载荷 */
interface MetaPayload {
  projectId: string;
  category: string;
  tags: string[];
  note: string;
}

/**
 * 备注落盘前清洗：仅由空编号行（如 "1. "）/空行组成的备注视为空（不落盘）；
 * 去掉结尾的空行与空编号行，避免聚焦空备注时自动插入的 "1. " 前缀被当作内容保存。
 */
function cleanProjectNote(value: string): string {
  const hasText = value
    .split('\n')
    .some((line) => line.replace(/^\s*\d+\.\s*$/, '').trim().length > 0);
  if (!hasText) return '';
  const lines = value.split('\n');
  while (lines.length > 0 && /^\s*(\d+\.\s*)?$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

/** 单条待办行（done = 是否已勾选） */
interface TodoLine {
  done: boolean;
  text: string;
}

/** 待办页（解析后的完整行列表，含已完成和未完成） */
interface TodoPageData {
  pageId: string;
  pageTitle: string;
  lines: TodoLine[];
  /** 行级日历标记（与 CanvasStickyNotes 页面元数据对齐）：各行的日历事件 id 列表，空/缺失 = 未入日历 */
  lineEventIds?: string[][];
  /** 行级日历布尔标记（旧字段兼容） */
  lineCalendared?: boolean[];
}

/** 待办便签（从 /api/sticky-notes GET 全量解析） */
interface TodoNoteData {
  noteId: string;
  title: string;
  color: string;
  pages: TodoPageData[];
  activePageId: string;
}

/** 将便签页 content 解析为 TodoLine[]（与 CanvasStickyNotes.parseTodoLines 一致） */
function parseTodoLines(content: string): TodoLine[] {
  const lines = content
    .split('\n')
    .map((l) => {
      const m = l.match(/^-\s*\[( |x)\]\s*(.*)$/);
      if (m) return { done: m[1] === 'x', text: m[2] };
      return { done: false, text: l.trim() };
    });
  if (lines.length === 0) return [{ done: false, text: '' }];
  return lines;
}

/** 将 TodoLine[] 序列化回 content 字符串（与 CanvasStickyNotes.serializeTodoLines 一致） */
function serializeTodoLines(lines: TodoLine[]): string {
  return lines.map((l) => `- [${l.done ? 'x' : ' '}] ${l.text}`).join('\n');
}

/** 该行是否已入日历（与 CanvasStickyNotes.isLineCalendared 一致） */
function isLineCalendared(page: TodoPageData, index: number): boolean {
  return (page.lineEventIds?.[index]?.length ?? 0) > 0 || page.lineCalendared?.[index] === true;
}

/** 排序方式 */
type SortKey = 'recent' | 'created' | 'nodes' | 'name';

/** 分组方式 */
type GroupMode = 'none' | 'category' | 'tag';

/** 视图模式：网格卡片（默认）/ 列表 */
type BoardViewMode = 'grid' | 'list';

interface ProjectBoardViewProps {
  open: boolean;
  onClose: () => void;
}

/** 便签颜色映射（对齐 CanvasStickyNotes NOTE_COLOR_SWATCH） */
const TODO_NOTE_COLORS: Record<string, string> = {
  yellow: '#FDE68A',
  blue: '#BFDBFE',
  green: '#BBF7D0',
  pink: '#FBCFE8',
};

/** 相对时间（分钟/小时/天/月） */
function relTime(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** 绝对日期（YYYY-MM-DD） */
function absDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** 开庭日期标签：YYYY-MM-DD → M/D（如 2026-08-30 → 8/30） */
function hearingLabel(date: string): string {
  const m = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return date;
  return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
}

/** 呼吸灯各档位动画周期（秒），档0=开庭当天（最快）… 档3=前3天（最慢） */
const BREATH_DUR = [1.2, 1.8, 2.4, 3.0];

/** 距开庭剩余天数（0=当天）；无效/已过/超过3天返回 -1（不开呼吸灯） */
function hearingDaysLeft(iso: string): number {
  const m = iso.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return -1;
  const hearing = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(hearing)) return -1;
  const today = Date.parse(`${new Date().toLocaleDateString('en-CA')}T00:00:00Z`);
  const days = Math.round((hearing - today) / 86400000);
  return days >= 0 && days <= 3 ? days : -1;
}

/* ────────────────────────────────────────────────────────────
 * TodoPopup — 便签待办完整管理弹窗
 *
 * 展示已完成 + 未完成待办，支持勾选、编辑、添加、删除，
 * 每次操作后由调用方通过 saveTodoPage 广播 sticky-notes-changed 事件，
 * 画布便签实时同步刷新。
 * ──────────────────────────────────────────────────────────── */

type TodoPopupProps = {
  project: BoardProject;
  data: TodoNoteData[] | null;
  loading: boolean;
  error: string;
  saving: boolean;
  noteColors: Record<string, string>;
  onClose: () => void;
  onToggle: (noteId: string, pageId: string, lineIndex: number) => void;
  onEdit: (noteId: string, pageId: string, lineIndex: number, text: string) => void;
  onAdd: (noteId: string, pageId: string, text: string) => void | Promise<void>;
  onDelete: (noteId: string, pageId: string, lineIndex: number) => void;
  /** 标记某条待办已入日历：把日历事件 id 持久化到该行（写回 sticky note 的 lineEventIds） */
  onMarkCalendared: (noteId: string, pageId: string, lineIndex: number, eventIds: string[]) => void;
  onCreateNote: () => void;
  /** 显式保存（自动保存已即时落盘，此处作确认兜底） */
  onSave: () => void;
  /** 回撤：回退最近一次已保存操作 */
  onUndo: () => void;
  /** 是否有可回撤的历史 */
  canUndo: boolean;
};

function TodoPopup({
  project,
  data,
  loading,
  error,
  saving,
  noteColors,
  onClose,
  onToggle,
  onEdit,
  onAdd,
  onDelete,
  onMarkCalendared,
  onCreateNote,
  onSave,
  onUndo,
  canUndo,
}: TodoPopupProps) {
  // 每页的添加输入框文本
  const [addInputs, setAddInputs] = useState<Record<string, string>>({});
  // 正在编辑的行 {noteId:pageId:lineIndex: true} + 编辑缓冲
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const editRef = useRef<HTMLInputElement | null>(null);
  // 显式保存后的"已保存 ✓"短暂反馈
  const [savedFlash, setSavedFlash] = useState(false);
  // Court 开庭录入表单（C 按钮弹出，全英文）
  const [courtOpen, setCourtOpen] = useState(false);
  const [courtMatter, setCourtMatter] = useState(''); // 事项（待办主题）
  const [courtDate, setCourtDate] = useState('');     // YYYY-MM-DD（date picker）
  const [courtTime, setCourtTime] = useState('');     // HH:MM（time picker，可空）
  const [courtName, setCourtName] = useState('');
  const [courtRoom, setCourtRoom] = useState('');
  const [courtAddr, setCourtAddr] = useState('');
  const [courtSaving, setCourtSaving] = useState(false);

  /** 提交某页的新增待办输入框内容（非空才提交），返回是否已提交 */
  const commitPendingAdd = (noteId: string, pageId: string, pageKey: string) => {
    const v = (addInputs[pageKey] || '').trim();
    if (!v) return false;
    onAdd(noteId, pageId, v);
    setAddInputs((prev) => ({ ...prev, [pageKey]: '' }));
    return true;
  };

  /** 显式保存：先提交所有未提交的新增待办输入，再确认落盘并短暂显示"已保存" */
  const handleSave = () => {
    if (saving) return;
    // 遍历所有页的新增输入框，未按 Enter 的内容一并提交（点击 Save 也自动保存）
    for (const note of data ?? []) {
      for (const pg of note.pages) {
        commitPendingAdd(note.noteId, pg.pageId, `${note.noteId}:${pg.pageId}`);
      }
    }
    onSave();
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1600);
  };

  /** 各行的"发送到日历"临时状态（key = noteId:pageId:lineIndex；busy/done/error） */
  const [addStates, setAddStates] = useState<Record<string, 'busy' | 'done' | 'error'>>({});

  /** 手动发送到日历（StickyTodo 不自动入日历，2026-09-08 起，行只在用户显式操作时入日历）：
   *  取待办文本走 /api/wanted/execute 的 /todo 命令写入日历默认时段；
   *  成功后回调 onMarkCalendared 持久化 eventIds → 该行图标由加号变闹钟 */
  const handleAddToCalendar = (noteId: string, pageId: string, lineIndex: number, text: string) => {
    const page = data?.find((n) => n.noteId === noteId)?.pages.find((pg) => pg.pageId === pageId);
    if (!page || isLineCalendared(page, lineIndex) || !text.trim()) return;
    const key = `${noteId}:${pageId}:${lineIndex}`;
    setAddStates((prev) => ({ ...prev, [key]: 'busy' }));
    const settle = (state: 'done' | 'error', ms: number) => {
      setAddStates((prev) => ({ ...prev, [key]: state }));
      setTimeout(() => {
        setAddStates((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, ms);
    };
    fetch('/api/wanted/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `/todo ${text.trim()}`, project_id: project.id }),
    })
      .then((r) => r.json().catch(() => ({ success: false })))
      .then((d) => {
        if (d?.success) {
          onMarkCalendared(noteId, pageId, lineIndex, d.eventIds ?? []);
          settle('done', 1600);
        } else {
          settle('error', 2600);
        }
      })
      .catch(() => settle('error', 2600));
  };

  // 进入编辑模式
  const startEdit = (key: string, text: string) => {
    setEditingKey(key);
    setEditText(text);
    setTimeout(() => editRef.current?.focus(), 0);
  };
  // 提交编辑
  const commitEdit = (noteId: string, pageId: string, lineIndex: number) => {
    onEdit(noteId, pageId, lineIndex, editText);
    setEditingKey(null);
    setEditText('');
  };

  const resetCourt = () => {
    setCourtMatter('');
    setCourtDate('');
    setCourtTime('');
    setCourtName('');
    setCourtRoom('');
    setCourtAddr('');
  };

  /** 提交 Court 开庭表单：追加一行待办（事项/法院信息，**不含日期**——日期时间只作为该行日历事件的开始时间），
   *  并按所选日期/时间建日历事件绑定该行（StickyTodo 手动入日历语义，不再走旧 /todo 自动） */
  const submitCourt = async () => {
    const dateStr = courtDate.trim();
    const name = courtName.trim();
    if (!dateStr || !name) return;
    const matter = courtMatter.trim();
    const room = courtRoom.trim();
    const addr = courtAddr.trim();
    const timeStr = courtTime.trim();
    const text = `${matter ? `${matter} ` : ''}在${name}${room ? `的第${room}法庭` : ''}开庭${addr ? `。地址：${addr}` : ''}`;
    const startTime = localDateTimeToIso(dateStr, timeStr);
    if (!startTime) {
      showImageAiEditToast('Invalid hearing date/time.', 'error');
      return;
    }
    const first = data?.[0];
    const page = first?.pages?.[0];
    if (!first || !page) {
      showImageAiEditToast('No todo note to attach the hearing to.', 'error');
      return;
    }
    const lineIndex = page.lines.length;
    setCourtSaving(true);
    try {
      // 1) 先在便签追加该行并等待落盘
      await onAdd(first.noteId, page.pageId, text);
      // 2) 按所选时间建日历事件并绑定该行（幂等；事件标题=行文本，source_ref 锚点）
      const resp = await fetch('/api/sticky-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add_to_calendar',
          project_id: project.id,
          note_id: first.noteId,
          page_id: page.pageId,
          line_index: lineIndex,
          text,
          start_time: startTime,
          reminder_minutes: [30],
        }),
      });
      const d = await resp.json().catch(() => ({ success: false }));
      if (d?.success) {
        // 3) 把 event ids 同步进本地弹窗数据（行变闹钟）
        onMarkCalendared(first.noteId, page.pageId, lineIndex, d.event_ids ?? []);
        resetCourt();
        setCourtOpen(false);
      } else {
        showImageAiEditToast('Added to todos, but calendar sync failed.', 'error');
        resetCourt();
        setCourtOpen(false);
      }
    } catch {
      showImageAiEditToast('Failed to add court hearing.', 'error');
      resetCourt();
      setCourtOpen(false);
    } finally {
      setCourtSaving(false);
    }
  };

  const unfinishedCount = data?.reduce(
    (s, n) => s + n.pages.reduce((s2, pg) => s2 + pg.lines.filter((l) => !l.done && l.text.trim()).length, 0),
    0,
  ) ?? 0;
  const doneCount = data?.reduce(
    (s, n) => s + n.pages.reduce((s2, pg) => s2 + pg.lines.filter((l) => l.done && l.text.trim()).length, 0),
    0,
  ) ?? 0;

  return (
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[75vh] w-[480px] max-w-full flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: 'var(--paper, #ffffff)', borderColor: 'var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          <ListTodo className="h-4 w-4 shrink-0" style={{ color: 'var(--primary-strong, #5b48d8)' }} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              {project.name}
            </div>
            <div className="text-11" style={{ color: 'var(--ink-muted)' }}>
              {unfinishedCount} unfinished · {doneCount} done{saving ? ' · saving…' : ''}
            </div>
          </div>
          {saving && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: 'var(--ink-muted)' }} />}
          <button
            type="button"
            onClick={() => {
              if (!courtOpen) resetCourt();
              setCourtOpen(!courtOpen);
            }}
            title="Court hearing (C)"
            className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink-muted)', border: '1px solid var(--border)' }}
          >
            C
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="shrink-0 rounded-lg p-1 transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink-muted)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Court 开庭录入表单（C 按钮展开，全英文） */}
        {courtOpen && (
          <div className="space-y-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <div className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>Court hearing</div>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <span className="w-16 shrink-0">Todo</span>
              <input value={courtMatter} onChange={(e) => setCourtMatter(e.target.value)} placeholder="What to do (e.g. 合同纠纷一审开庭)" autoFocus className="min-w-0 flex-1 rounded border px-2 py-1 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <span className="w-16 shrink-0">Date</span>
              <input type="date" value={courtDate} onChange={(e) => setCourtDate(e.target.value)} className="min-w-0 flex-1 rounded border px-2 py-1 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <span className="w-16 shrink-0">Time</span>
              <input type="time" value={courtTime} onChange={(e) => setCourtTime(e.target.value)} className="min-w-0 flex-1 rounded border px-2 py-1 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <span className="w-16 shrink-0">Court</span>
              <input value={courtName} onChange={(e) => setCourtName(e.target.value)} placeholder="Court name" className="min-w-0 flex-1 rounded border px-2 py-1 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <span className="w-16 shrink-0">Courtroom</span>
              <input value={courtRoom} onChange={(e) => setCourtRoom(e.target.value)} placeholder="No." className="min-w-0 flex-1 rounded border px-2 py-1 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <span className="w-16 shrink-0">Address</span>
              <input value={courtAddr} onChange={(e) => setCourtAddr(e.target.value)} placeholder="Address" className="min-w-0 flex-1 rounded border px-2 py-1 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { resetCourt(); setCourtOpen(false); }} className="rounded-lg px-3 py-1 text-xs font-medium" style={{ color: 'var(--ink-muted)', background: 'var(--paper-hover)' }}>Cancel</button>
              <button type="button" onClick={() => void submitCourt()} disabled={courtSaving || !courtDate.trim() || !courtName.trim()} className="rounded-lg px-3 py-1 text-xs font-semibold disabled:opacity-50" style={{ color: '#fff', background: 'var(--primary-strong, #5b48d8)' }}>{courtSaving ? 'Saving…' : 'OK'}</button>
            </div>
          </div>
        )}

        {/* 内容 */}
        <div className="min-h-[120px] flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="py-8 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
              Loading todos…
            </div>
          ) : error ? (
            <div className="py-8 text-center text-xs" style={{ color: 'var(--danger, #e8463a)' }}>
              {error}
            </div>
          ) : !data || data.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                No sticky todos yet
              </div>
              <button
                type="button"
                onClick={onCreateNote}
                disabled={saving}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ color: '#fff', background: 'var(--primary-strong, #5b48d8)' }}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                New sticky todo
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {data.map((n) => (
                <div key={n.noteId}>
                  {/* 便签标题 */}
                  <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: noteColors[n.color] || noteColors.yellow }}
                    />
                    <span className="truncate">{n.title || n.noteId}</span>
                  </div>

                  {n.pages.map((pg) => {
                    const pageKey = `${n.noteId}:${pg.pageId}`;
                    const pending = pg.lines.filter((l) => !l.done && l.text.trim());
                    const done = pg.lines.filter((l) => l.done && l.text.trim());
                    return (
                      <div key={pg.pageId} className="mt-1 pl-3">
                        <div className="text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>
                          {pg.pageTitle || 'P1'}
                        </div>

                        {/* 未完成项 */}
                        {pending.length > 0 && (
                          <ul className="mt-1 space-y-0.5">
                            {pg.lines.map((line, i) => {
                              if (line.done || !line.text.trim()) return null;
                              const rowCalendared = isLineCalendared(pg, i);
                              const addState = addStates[`${n.noteId}:${pg.pageId}:${i}`];
                              return (
                                <li
                                  key={i}
                                  className="group flex items-start gap-1.5 text-xs"
                                  style={{ color: 'var(--ink)' }}
                                >
                                  <button
                                    type="button"
                                    onClick={() => onToggle(n.noteId, pg.pageId, i)}
                                    className="mt-[3px] flex h-[15px] w-[15px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border transition-colors hover:border-[var(--primary-strong)]"
                                    style={{ borderColor: 'var(--ink-faint)', background: 'transparent' }}
                                    title="Mark as done"
                                  />
                                  {editingKey === `${pageKey}:${i}` ? (
                                    <input
                                      ref={editRef}
                                      value={editText}
                                      onChange={(e) => setEditText(e.target.value)}
                                      onBlur={() => commitEdit(n.noteId, pg.pageId, i)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') { e.preventDefault(); commitEdit(n.noteId, pg.pageId, i); }
                                        if (e.key === 'Escape') { setEditingKey(null); setEditText(''); }
                                      }}
                                      className="min-w-0 flex-1 rounded border px-1 py-0.5 text-xs outline-none"
                                      style={{ borderColor: 'var(--primary)', color: 'var(--ink)' }}
                                    />
                                  ) : (
                                    <span
                                      className="flex-1 break-words"
                                      onDoubleClick={() => startEdit(`${pageKey}:${i}`, line.text)}
                                    >
                                      {line.text}
                                    </span>
                                  )}
                                  {/* 行尾操作：一键发送到日历 + 删除（hover 显示；busy/已入日历常显）。
                                      双击文本可编辑，不再显示 Edit 按钮 */}
                                  {editingKey !== `${pageKey}:${i}` && (
                                    <div className="flex shrink-0 items-center gap-0.5">
                                      <button
                                        type="button"
                                        title={rowCalendared ? 'Added to calendar' : addState === 'error' ? 'Failed — click to retry' : addState === 'busy' ? 'Adding…' : 'Send to calendar'}
                                        onClick={() => {
                                          if (addState !== 'busy' && !rowCalendared) handleAddToCalendar(n.noteId, pg.pageId, i, line.text);
                                        }}
                                        className={`mt-[3px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] transition-opacity hover:bg-black/10 ${addState === 'busy' || rowCalendared ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${rowCalendared ? 'cursor-default' : 'cursor-pointer'}`}
                                        style={{
                                          color:
                                            rowCalendared || addState === 'done' ? '#1e7d34'
                                            : addState === 'error' ? '#c62828'
                                            : 'var(--ink-faint)',
                                        }}
                                      >
                                        {addState === 'busy' ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : rowCalendared ? (
                                          <AlarmClock className="h-3 w-3" />
                                        ) : addState === 'done' ? (
                                          <Check className="h-3 w-3" />
                                        ) : addState === 'error' ? (
                                          <AlertCircle className="h-3 w-3" />
                                        ) : (
                                          <Plus className="h-3 w-3" />
                                        )}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => onDelete(n.noteId, pg.pageId, i)}
                                        className="rounded p-0.5 text-10 transition-colors hover:bg-[var(--paper-hover)]"
                                        style={{ color: 'var(--danger, #e8463a)' }}
                                        title="Delete"
                                      >
                                        Del
                                      </button>
                                    </div>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}

                        {/* 已完成项（折叠展示） */}
                        {done.length > 0 && (
                          <details className="mt-1">
                            <summary
                              className="cursor-pointer text-11 select-none"
                              style={{ color: 'var(--ink-faint)' }}
                            >
                              {done.length} completed
                            </summary>
                            <ul className="mt-0.5 space-y-0.5">
                              {pg.lines.map((line, i) =>
                                !line.done || !line.text.trim() ? null : (
                                  <li
                                    key={i}
                                    className="group flex items-start gap-1.5 text-xs"
                                    style={{ color: 'var(--ink-faint)' }}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => onToggle(n.noteId, pg.pageId, i)}
                                      className="mt-[3px] flex h-[15px] w-[15px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border text-10 leading-none transition-colors"
                                      style={{
                                        borderColor: 'var(--ink-faint)',
                                        background: 'color-mix(in oklab, var(--ink-faint) 10%, transparent)',
                                        color: 'var(--ink-faint)',
                                      }}
                                      title="Mark as todo"
                                    >
                                      <Check className="h-2.5 w-2.5" />
                                    </button>
                                    <span className="flex-1 break-words line-through" style={{ opacity: 0.6 }}>
                                      {line.text}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => onDelete(n.noteId, pg.pageId, i)}
                                      className="shrink-0 rounded p-0.5 text-10 opacity-0 transition-opacity group-hover:opacity-100"
                                      style={{ color: 'var(--danger, #e8463a)' }}
                                      title="Delete"
                                    >
                                      Del
                                    </button>
                                  </li>
                                ),
                              )}
                            </ul>
                          </details>
                        )}

                        {/* 添加新待办 */}
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <Plus className="h-3 w-3 shrink-0" style={{ color: 'var(--ink-faint)' }} />
                          <input
                            value={addInputs[pageKey] || ''}
                            onChange={(e) => setAddInputs((prev) => ({ ...prev, [pageKey]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitPendingAdd(n.noteId, pg.pageId, pageKey);
                              }
                            }}
                            onBlur={() => commitPendingAdd(n.noteId, pg.pageId, pageKey)}
                            placeholder="Add todo…"
                            className="min-w-0 flex-1 border-b py-0.5 text-xs outline-none transition-colors"
                            style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        {/* 底部操作：保存（显式确认）+ 回撤（回退最近一次已保存操作） */}
        {data && data.length > 0 && (
          <div className="flex items-center gap-2 border-t px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              title="Save all changes"
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ color: '#fff', background: 'var(--primary-strong, #5b48d8)' }}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              title={canUndo ? 'Undo last change' : 'Nothing to undo'}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
              style={{ color: 'var(--ink)', background: 'var(--paper-hover, #f0f0f3)' }}
            >
              <Undo2 className="h-3.5 w-3.5" />
              回撤
            </button>
            {savedFlash && (
              <span className="ml-auto text-xs font-medium" style={{ color: 'var(--success, #1e7d34)' }}>
                ✓ 已保存
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 项目看板：全屏大视图，卡片网格总览所有项目（含归档/垃圾桶），支持搜索与状态筛选 */
/** 启动时是否自动打开项目面板（Projects 看板）的持久化开关；默认开启（保留历史启动行为） */
export const LAUNCH_BOARD_KEY = 'bobwork.board-open-on-launch';
/** 视图模式（网格/列表）持久化键：属于用户偏好，不随面板每次打开重置 */
const BOARD_VIEW_KEY = 'bobwork.board-view';

export function ProjectBoardView({ open, onClose }: ProjectBoardViewProps) {
  // “Open on launch”开关：开 = 每次打开 BobWork 从项目面板进入；关 = 直接进入上次关闭时的项目
  const [openOnLaunch, setOpenOnLaunch] = useState<boolean>(() => {
    try { return localStorage.getItem(LAUNCH_BOARD_KEY) !== '0'; } catch { return true; }
  });
  const setOpenOnLaunchPersist = (v: boolean) => {
    setOpenOnLaunch(v);
    try { localStorage.setItem(LAUNCH_BOARD_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };
  const [projects, setProjects] = useState<BoardProject[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BoardFilter>('active');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('created');
  const [groupBy, setGroupBy] = useState<GroupMode>('none');
  // 视图模式：网格卡片 / 列表（读写 localStorage；打开面板时重置筛选与排序，但保留视图偏好）
  const [viewMode, setViewMode] = useState<BoardViewMode>(() => {
    try { return localStorage.getItem(BOARD_VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  });
  const setViewModePersist = (v: BoardViewMode) => {
    setViewMode(v);
    try { localStorage.setItem(BOARD_VIEW_KEY, v); } catch { /* ignore */ }
  };
  const [selected, setSelected] = useState<BoardProject | null>(null);
  const [editCategory, setEditCategory] = useState('');
  // 编辑项目：两个独立标签输入框（最多 2 个）
  const [editTag1, setEditTag1] = useState('');
  const [editTag2, setEditTag2] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editName, setEditName] = useState('');
  // ── 元信息自动保存（Metadata autosave）──
  // 保存请求在飞标记 + 期间新产生的待保存内容（完成后补发，避免丢最后一次改动）
  const metaSavingRef = useRef(false);
  const metaQueuedRef = useRef<MetaPayload | null>(null);
  // 上次成功落盘的内容（按项目区分），用于跳过无变化的重复保存
  const lastMetaSavedRef = useRef<MetaPayload | null>(null);
  // 防抖定时器 + 已调度待保存快照（跨项目切换时先把旧项目快照落盘）
  const metaPendingRef = useRef<{ timer: ReturnType<typeof setTimeout>; payload: MetaPayload } | null>(null);
  // 编辑草稿镜像：与 edit* state 同步，保证定时器/异步回调能读到最新值
  const metaDraftRef = useRef({ category: '', tag1: '', tag2: '', note: '' });
  const [switching, setSwitching] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState('');
  // 卡片交互：单击立即打开右侧详情；点击卡片内按钮/划选文字时不触发。
  // “打开/进入项目”由卡片右下角的显式 Open 按钮承担——不再使用双击判定（双击已移除，
  // 也省去了“单击延迟/双击窗口”带来的响应滞后与误判）。
  // 划选文字判定：拖选时 selection 非空，单击不打开详情，保证文字可正常拖选复制
  const hasTextSelection = () => {
    const sel = window.getSelection();
    return !!sel && sel.toString().trim().length > 0;
  };
  // 记录当前项目 id（load 时同步），供打开面板时默认选中当前项目
  const currentIdRef = useRef('');
  // 点击状态筛选（Active/Archived/Trash）后置位：待列表按新视图重算完成，把右侧详情切到该视图首张卡片
  const viewSelectPendingRef = useRef(false);
  // 切换项目后等待画布重载完成（CanvasFlow 加载完毕广播 project-canvas-ready）；
  // 期间看板全屏展示"Opening…"过渡层，避免看板关闭后用户盯着旧项目画布干等
  const waitCanvasReady = useCallback(
    (projectId: string) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          window.removeEventListener('bobagent:project-canvas-ready', onReady);
          resolve();
        }, 3000);
        function onReady(ev: Event) {
          const d = (ev as CustomEvent).detail as { projectId?: string } | undefined;
          if (settled || !d || d.projectId !== projectId) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('bobagent:project-canvas-ready', onReady);
          resolve();
        }
        window.addEventListener('bobagent:project-canvas-ready', onReady);
      }),
    [],
  );

  // 卡片 TODO 弹窗：目标项目 + 待办明细（notes → pages → lines 三级，含已完成和未完成）
  const [todoProject, setTodoProject] = useState<BoardProject | null>(null);
  const [todoData, setTodoData] = useState<TodoNoteData[] | null>(null);
  const [todoLoading, setTodoLoading] = useState(false);
  const [todoError, setTodoError] = useState('');
  const [todoSaving, setTodoSaving] = useState(false);
  // 撤销栈：记录每次操作的上一页状态（noteId/pageId/prevLines），"回撤"回退最近一次已保存操作
  const [todoUndoStack, setTodoUndoStack] = useState<Array<{ noteId: string; pageId: string; prevLines: TodoLine[] }>>([]);

  // 新建项目弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createCategory, setCreateCategory] = useState('');
  const [createNote, setCreateNote] = useState('');
  // 备注撤销/重做快照栈：接管编辑历史，阻止浏览器原生 undo 把自动编号（'1. ' 前缀）一并撤销
  const createNoteUndoRef = useRef<string[]>([]);
  const createNoteRedoRef = useRef<string[]>([]);
  // 两个独立标签输入框（新建项目最多 2 个标签）
  const [createTag1, setCreateTag1] = useState('');
  const [createTag2, setCreateTag2] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(async (): Promise<BoardProject[] | null> => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (!data?.success) return null;
      const merged: BoardProject[] = [
        ...(data.active_projects || []),
        ...(data.archived_projects || []),
        ...(data.trashed_projects || []),
      ];
      setProjects(merged);
      setCurrentId(data.current_id || '');
      currentIdRef.current = data.current_id || '';
      return merged;
    } catch {
      setError('Failed to load projects');
      return null;
    }
  }, []);

  /** 打开详情侧栏并初始化编辑表单 */
  const openDetail = useCallback((p: BoardProject) => {
    setSelected(p);
    setEditName(p.name || '');
    setEditCategory(p.category || '');
    setEditTag1(p.tags?.[0] || '');
    setEditTag2(p.tags?.[1] || '');
    setEditNote(p.note || '');
    // 同步自动保存的草稿镜像与“已落盘基线”，供防抖/差异判断使用
    metaDraftRef.current = { category: p.category || '', tag1: p.tags?.[0] || '', tag2: p.tags?.[1] || '', note: p.note || '' };
    lastMetaSavedRef.current = {
      projectId: p.id,
      category: p.category || '',
      tags: p.tags || [],
      note: cleanProjectNote(p.note || ''),
    };
  }, []);

  // 当前选中项目镜像（供防抖定时器/异步回调读取最新选中，避免闭包过期）
  const selectedRef = useRef<BoardProject | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  /** 组装元信息保存载荷（分类/标签 trim，备注清洗） */
  const buildMetaPayload = (): MetaPayload => {
    const sel = selectedRef.current;
    const d = metaDraftRef.current;
    return {
      projectId: sel?.id ?? '',
      category: d.category.trim(),
      tags: [d.tag1, d.tag2].map((t) => t.trim()).filter(Boolean).slice(0, PROJECT_TAG_LIMIT),
      note: cleanProjectNote(d.note),
    };
  };

  /** 与上次成功落盘内容比较：一致则跳过，避免无变化重复保存 */
  const metaEqualsLast = (payload: MetaPayload): boolean => {
    const last = lastMetaSavedRef.current;
    return (
      !!last &&
      last.projectId === payload.projectId &&
      last.category === payload.category &&
      last.tags.length === payload.tags.length &&
      last.tags.every((t, i) => t === payload.tags[i]) &&
      last.note === payload.note
    );
  };

  /** 元信息落盘（update_meta）。防重入：请求在飞时挂到队列，完成后补发最新内容，不丢最后一次改动 */
  const persistMeta = async (payload: MetaPayload) => {
    if (!payload.projectId || metaEqualsLast(payload)) return;
    if (metaSavingRef.current) {
      metaQueuedRef.current = payload;
      return;
    }
    metaSavingRef.current = true;
    try {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_meta', project_id: payload.projectId, category: payload.category, tags: payload.tags, note: payload.note }),
      });
      const data = await resp.json();
      if (data.success && data.project) {
        const proj = data.project as BoardProject;
        // 仅当仍是当前选中项目时才更新“已落盘基线”，避免迟到的旧项目回执覆盖新项目基线
        const cur = selectedRef.current;
        if (!cur || cur.id === payload.projectId) lastMetaSavedRef.current = payload;
        // 就地刷新列表卡片与详情（不整页重拉，避免打断正在编辑的输入）
        setProjects((prev) => prev.map((p) => (p.id === proj.id ? proj : p)));
        setSelected((prev) => (prev && prev.id === proj.id ? proj : prev));
      } else {
        setError(data.error || 'Failed to save');
      }
    } catch {
      setError('Failed to save');
    } finally {
      metaSavingRef.current = false;
      const queued = metaQueuedRef.current;
      metaQueuedRef.current = null;
      if (queued) void persistMeta(queued);
    }
  };

  /** 编辑字段变更后调度自动保存：600ms 防抖；跨项目切换时先把旧项目的待保存内容立刻落盘 */
  const scheduleMetaSave = () => {
    const payload = buildMetaPayload();
    if (!payload.projectId || metaEqualsLast(payload)) return;
    const prev = metaPendingRef.current;
    if (prev) {
      clearTimeout(prev.timer);
      metaPendingRef.current = null;
      // 待保存快照属于上一个项目：立即落盘，避免被新项目的调度覆盖而丢失
      if (prev.payload.projectId !== payload.projectId) void persistMeta(prev.payload);
    }
    metaPendingRef.current = {
      timer: setTimeout(() => {
        metaPendingRef.current = null;
        void persistMeta(payload);
      }, 600),
      payload,
    };
  };

  /** 分类变更：同步 state + 草稿镜像后调度保存 */
  const updateMetaCategory = (v: string) => {
    setEditCategory(v);
    metaDraftRef.current.category = v;
    scheduleMetaSave();
  };

  /** 标签变更（两个输入框）：同步 state + 草稿镜像后调度保存 */
  const updateMetaTag = (idx: 1 | 2, v: string) => {
    if (idx === 1) {
      setEditTag1(v);
      metaDraftRef.current.tag1 = v;
    } else {
      setEditTag2(v);
      metaDraftRef.current.tag2 = v;
    }
    scheduleMetaSave();
  };

  /** 备注变更：同步 state + 草稿镜像后调度保存 */
  const updateMetaNote = (v: string) => {
    setEditNote(v);
    metaDraftRef.current.note = v;
    scheduleMetaSave();
  };

  /** 默认选中：优先当前项目，否则第一个活跃项目，否则第一个项目 */
  const pickDefaultProject = useCallback((list: BoardProject[]): BoardProject | undefined => {
    if (!list || list.length === 0) return undefined;
    return (
      list.find((p) => p.id === currentIdRef.current) ||
      list.find((p) => !p.archived && !p.trashed) ||
      list[0]
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFilter('active');
    setTagFilter(null);
    setCatFilter(null);
    setSortKey('created');
    setGroupBy('none');
    setSelected(null);
    load().then((merged) => {
      // 详情侧栏默认打开（常驻）：优先当前项目，否则第一个活跃项目，否则第一个项目
      const target = pickDefaultProject(merged || []);
      if (target) openDetail(target);
    });
  }, [open, load, openDetail, pickDefaultProject]);

  // 联动：任意入口（项目面板弹窗 / AI 工具）增删改待办后，刷新项目列表的待办数与呼吸灯
  useEffect(() => {
    if (!open) return;
    const onStickyChanged = () => { void load(); };
    window.addEventListener('sticky-notes-changed', onStickyChanged);
    return () => window.removeEventListener('sticky-notes-changed', onStickyChanged);
  }, [open, load]);

  // Esc 关闭（项目打开过渡期间不响应，避免等待画布重载的半途关掉看板）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !switching) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, switching]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (filter === 'active' && (p.archived || p.trashed)) return false;
      if (filter === 'archived' && !p.archived) return false;
      if (filter === 'trash' && !p.trashed) return false;
      if (catFilter && (p.category || '') !== catFilter) return false;
      if (tagFilter && !(p.tags || []).includes(tagFilter)) return false;
      if (!q) return true;
      const haystack = [p.name, p.category || '', ...(p.tags || []), p.note || '', p.path].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [projects, query, filter, tagFilter, catFilter]);

  // 当前视图下的项目（仅按 active/archived/trash 状态过滤，不含搜索/标签筛选）：
  // 标签/分类统计跟随当前视图，切换视图时标签栏数字同步变化
  const viewProjects = useMemo(() => {
    return projects.filter((p) => {
      if (filter === 'active' && (p.archived || p.trashed)) return false;
      if (filter === 'archived' && !p.archived) return false;
      if (filter === 'trash' && !p.trashed) return false;
      return true;
    });
  }, [projects, filter]);

  // 默认标签（分类）：从项目分类动态聚合，仅显示有项目在用的分类；点击按分类筛选
  const catTags = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of viewProjects) {
      const c = p.category;
      if (c) map.set(c, (map.get(c) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        const ia = PROJECT_CATEGORIES.indexOf(a.name as (typeof PROJECT_CATEGORIES)[number]);
        const ib = PROJECT_CATEGORIES.indexOf(b.name as (typeof PROJECT_CATEGORIES)[number]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.count - a.count;
      });
  }, [viewProjects]);

  // 所有出现过的自定义标签 + 计数（用于标签分类筛选）
  // 联动：选中分类（catFilter）后仅统计该分类下项目的标签，标签栏跟随分类过滤
  const allTags = useMemo(() => {
    const map = new Map<string, number>();
    const base = catFilter ? viewProjects.filter((p) => (p.category || '') === catFilter) : viewProjects;
    for (const p of base) {
      for (const t of p.tags || []) map.set(t, (map.get(t) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [viewProjects, catFilter]);

  // 项目列表变化后，自动清除已失效的分类/标签筛选（如对应项目被删除）
  useEffect(() => {
    if (catFilter && !projects.some((p) => (p.category || '') === catFilter)) setCatFilter(null);
    if (tagFilter) {
      // 标签联动：选中分类时，标签必须属于该分类下的项目；否则自动清空，避免空结果
      const valid = catFilter
        ? projects.some((p) => (p.category || '') === catFilter && (p.tags || []).includes(tagFilter))
        : projects.some((p) => (p.tags || []).includes(tagFilter));
      if (!valid) setTagFilter(null);
    }
  }, [projects, catFilter, tagFilter]);

  // 排序后的列表
  const sorted = useMemo(() => {
    const arr = [...filtered];
    const ts = (p: BoardProject) => new Date(p.last_accessed_at || p.created_at).getTime() || 0;
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'created':
          // 按创建时间升序：最早创建排最前（左上角），从左到右、从上到下
          return (new Date(a.created_at).getTime() || 0) - (new Date(b.created_at).getTime() || 0);
        case 'nodes':
          return (b.node_count ?? 0) - (a.node_count ?? 0);
        default:
          return ts(b) - ts(a);
      }
    });
    return arr;
  }, [filtered, sortKey]);

  // 切换状态视图（Active/Archived/Trash）后，右侧详情跟随该视图：
  // 选中项目仍在新视图内则保持不动，否则自动选中新视图的第一张卡片（按当前排序）
  useEffect(() => {
    if (!viewSelectPendingRef.current) return;
    viewSelectPendingRef.current = false;
    if (selected && sorted.some((p) => p.id === selected.id)) return;
    if (sorted[0]) openDetail(sorted[0]);
    else setSelected(null);
  }, [filter, sorted, selected, openDetail]);

  // 分组后的列表（none → 单组全量）
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: '__all__', label: '', items: sorted }];
    const map = new Map<string, BoardProject[]>();
    if (groupBy === 'category') {
      for (const p of sorted) {
        const key = p.category || 'Uncategorized';
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(p);
      }
    } else {
      // tag：项目归入每个匹配标签组；无标签归入 Untagged
      for (const p of sorted) {
        const tags = p.tags && p.tags.length ? p.tags : ['Untagged'];
        for (const t of tags) {
          if (!map.has(t)) map.set(t, []);
          map.get(t)!.push(p);
        }
      }
    }
    return Array.from(map.entries()).map(([key, items]) => ({ key, label: key, items }));
  }, [sorted, groupBy]);

  const switchTo = useCallback(
    async (projectId: string) => {
      if (projectId === currentId || switching) return;
      setSwitching(projectId);
      setError('');
      try {
        const resp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'switch', project_id: projectId }),
        });
        const data = await resp.json();
        if (data.success) {
          setCurrentId(projectId);
          currentIdRef.current = projectId;
          // 与 Sidebar.handleSwitch 一致：广播事件由 CanvasFlow 重载画布
          window.dispatchEvent(new CustomEvent('bobagent:project-switched', { detail: { projectId } }));
          // 等待目标项目画布就绪后再关闭看板（期间展示 Opening 过渡层），
          // 避免看板关闭后旧项目画布滞留，看起来像"点了没反应 / 很久才有反应"
          await waitCanvasReady(projectId);
          onClose();
        } else {
          setError(data.error || 'Failed to switch project');
        }
      } catch {
        setError('Failed to switch project');
      } finally {
        setSwitching(null);
      }
    },
    [currentId, switching, onClose, waitCanvasReady],
  );

  /** 保存项目名称（rename）：失焦/回车时提交；名称不变或为空时恢复原值 */
  const saveName = useCallback(async () => {
    if (!selected) return;
    const newName = editName.trim();
    if (!newName || newName === selected.name) {
      setEditName(selected.name);
      return;
    }
    try {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', project_id: selected.id, new_name: newName }),
      });
      const data = await resp.json();
      if (data.success) {
        const refreshed = await load();
        if (refreshed) {
          const next = refreshed.find((p) => p.id === selected.id);
          if (next) {
            setSelected(next);
            setEditName(next.name || '');
          }
        }
      } else {
        setError(data.error || 'Failed to rename');
        setEditName(selected.name);
      }
    } catch {
      setError('Failed to rename');
      setEditName(selected.name);
    }
  }, [selected, editName, load]);

  /** 通用项目状态操作（archive / unarchive / delete / restore / purge），成功后刷新列表并关闭详情 */
  const mutateProject = useCallback(
    async (projectId: string, action: 'archive' | 'unarchive' | 'delete' | 'restore' | 'purge', confirmMsg?: string) => {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      setMutating(true);
      setError('');
      try {
        const resp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, project_id: projectId }),
        });
        const data = await resp.json();
        if (data.success) {
          const refreshed = await load();
          // 详情侧栏常驻：操作成功后选中默认项目（列表为空才置空）
          const next = pickDefaultProject(refreshed || []);
          if (next) openDetail(next);
          else setSelected(null);
          // 取消归档后若看板仍处于 archived 筛选，重拉的数据里该项目的筛选态由 load() 保持
          return refreshed;
        }
        setError(data.error || `Failed to ${action} project`);
      } catch {
        setError(`Failed to ${action} project`);
      } finally {
        setMutating(false);
      }
    },
     [load, pickDefaultProject, openDetail],
   );

  /** 打开 TODO 弹窗：加载该项目全部便签（含已完成和未完成待办） */
  const openTodos = useCallback(async (p: BoardProject) => {
    setTodoProject(p);
    setTodoData(null);
    setTodoError('');
    setTodoLoading(true);
    // 切换项目打开弹窗时清空撤销栈，避免跨项目残留（回撤只作用于当前项目）
    setTodoUndoStack([]);
    try {
      const res = await fetch(`/api/sticky-notes?project_id=${encodeURIComponent(p.id)}`);
      const data = await res.json();
      if (data?.success && Array.isArray(data.notes)) {
        const parsed: TodoNoteData[] = (data.notes as Array<Record<string, unknown>>)
          .map((n) => {
            const noteId = typeof n.id === 'string' ? n.id : '';
            if (!noteId) return null;
            const title = typeof n.title === 'string' ? n.title : '';
            const color = typeof n.color === 'string' ? n.color : 'yellow';
            const activePageId = typeof n.activePageId === 'string' ? n.activePageId : '';
            const rawPages = Array.isArray(n.pages) ? n.pages : [];
            const pages: TodoPageData[] = [];
            for (const pg of rawPages as Array<Record<string, unknown>>) {
              if (pg.kind === 'note') continue; // 跳过已停用的 note 模式页
              const pageId = typeof pg.id === 'string' ? pg.id : '';
              const pageTitle = typeof pg.title === 'string' && pg.title.trim() ? pg.title.trim() : 'P1';
              const content = typeof pg.content === 'string' ? pg.content : '';
              let lines = parseTodoLines(content);
              // 保留行级日历元数据（画布便签发送到日历后在此显示闹钟；不写回则下次打开丢失标记）
              let lineEventIds = Array.isArray(pg.lineEventIds)
                ? (pg.lineEventIds as unknown[][]).map((x) => (Array.isArray(x) ? x.map(String) : []))
                : undefined;
              let lineCalendared = Array.isArray(pg.lineCalendared) ? pg.lineCalendared.map(Boolean) : undefined;
              // 空行不是待办：解析即剔除空待办行，并同步对齐行级日历元数据，
              // 避免脏空行进入本地数据 / 撤销栈（回撤后"冒出空白待办"的根源）
              if (lines.some((l) => !l.text.trim())) {
                const keptLines: TodoLine[] = [];
                const keptEv: string[][] = [];
                const keptCal: boolean[] = [];
                for (let i = 0; i < lines.length; i++) {
                  if (!lines[i].text.trim()) continue;
                  keptLines.push(lines[i]);
                  if (lineEventIds) keptEv.push(lineEventIds[i] ?? []);
                  if (lineCalendared) keptCal.push(lineCalendared[i] ?? false);
                }
                lines = keptLines;
                if (lineEventIds) lineEventIds = keptEv;
                if (lineCalendared) lineCalendared = keptCal;
              }
              // 空待办页也保留在弹窗里（新建后无事项 / 事项被清空时仍可在此添加、编辑）
              if (pageId) {
                pages.push({ pageId, pageTitle, lines, ...(lineEventIds ? { lineEventIds } : {}), ...(lineCalendared ? { lineCalendared } : {}) });
              }
            }
            // 兼容老数据 content → P1（同样保留空内容页以便继续编辑；剔除空行，语义同上）
            if (pages.length === 0 && typeof n.content === 'string' && n.content.trim()) {
              pages.push({ pageId: 'pg-legacy', pageTitle: 'P1', lines: parseTodoLines(n.content).filter((l) => l.text.trim()) });
            }
            if (pages.length === 0) return null;
            return { noteId, title, color, pages, activePageId } as TodoNoteData;
          })
          .filter((x): x is TodoNoteData => x !== null);
        setTodoData(parsed);
      } else {
        setTodoError(data?.error || 'Failed to load todos');
      }
    } catch {
      setTodoError('Failed to load todos');
    } finally {
      setTodoLoading(false);
    }
  }, []);

  /** 关闭 TODO 弹窗 */
  const closeTodos = useCallback(() => {
    setTodoProject(null);
    setTodoData(null);
    setTodoError('');
    setTodoSaving(false);
  }, []);

  /**
   * 保存便签页 content 到后端并同步画布。
   * projectId/noteId/pageId 定位目标页；newLines 为修改后的完整行列表。
   * newMeta.lineEventIds 可选：行数变化（增/删）时同步写回行级日历标记，避免错位。
   * 写盘成功后广播 sticky-notes-changed 事件 → 画布便签实时刷新。
   */
  const saveTodoPage = useCallback(
    async (projectId: string, noteId: string, pageId: string, newLines: TodoLine[], newMeta?: { lineEventIds?: string[][] }) => {
      setTodoSaving(true);
      try {
        // 先读取该便签完整数据以获取 pages 数组（避免覆盖其他页）
        const res = await fetch(`/api/sticky-notes?project_id=${encodeURIComponent(projectId)}`);
        const data = await res.json();
        if (!data?.success || !Array.isArray(data.notes)) return;
        const note = (data.notes as Array<Record<string, unknown>>).find((n) => n.id === noteId);
        if (!note) return;
        const rawPages = Array.isArray(note.pages) ? note.pages : [];
        const pages = rawPages.map((pg: Record<string, unknown>) =>
          pg.id === pageId
            ? { ...pg, content: serializeTodoLines(newLines), ...(newMeta?.lineEventIds ? { lineEventIds: newMeta.lineEventIds } : {}) }
            : pg,
        );
        await fetch('/api/sticky-notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', project_id: projectId, note: { id: noteId, pages } }),
        });
        // 广播事件 → 画布便签重新加载
        window.dispatchEvent(new CustomEvent('sticky-notes-changed'));
        // 本地更新弹窗数据
        setTodoData((prev) =>
          prev
            ? prev.map((n) =>
                n.noteId === noteId
                  ? {
                      ...n,
                      pages: n.pages.map((pg) =>
                        pg.pageId === pageId
                          ? { ...pg, lines: newLines, ...(newMeta?.lineEventIds ? { lineEventIds: newMeta.lineEventIds } : {}) }
                          : pg,
                      ),
                    }
                  : n,
              )
            : prev,
        );
      } catch {
        // 静默失败：不阻断用户后续操作
      } finally {
        setTodoSaving(false);
      }
    },
    [],
  );

  /** 入撤销栈：记录操作前该页的 lines（最多保留最近 20 步） */
  const pushTodoUndo = useCallback((noteId: string, pageId: string, prevLines: TodoLine[]) => {
    setTodoUndoStack((prev) => [...prev.slice(-19), { noteId, pageId, prevLines }]);
  }, []);

  /** 勾选/取消勾选某条待办 */
  const toggleTodo = useCallback(
    (projectId: string, noteId: string, pageId: string, lineIndex: number) => {
      if (!todoData) return;
      const note = todoData.find((n) => n.noteId === noteId);
      const page = note?.pages.find((pg) => pg.pageId === pageId);
      if (!page) return;
      pushTodoUndo(noteId, pageId, page.lines);
      const newLines = page.lines.map((l, i) =>
        i === lineIndex ? { ...l, done: !l.done } : l,
      );
      void saveTodoPage(projectId, noteId, pageId, newLines);
    },
    [todoData, saveTodoPage, pushTodoUndo],
  );

  /** 编辑某条待办文本 */
  const editTodo = useCallback(
    (projectId: string, noteId: string, pageId: string, lineIndex: number, text: string) => {
      if (!todoData) return;
      const note = todoData.find((n) => n.noteId === noteId);
      const page = note?.pages.find((pg) => pg.pageId === pageId);
      if (!page) return;
      pushTodoUndo(noteId, pageId, page.lines);
      const newLines = page.lines.map((l, i) =>
        i === lineIndex ? { ...l, text } : l,
      );
      void saveTodoPage(projectId, noteId, pageId, newLines);
    },
    [todoData, saveTodoPage, pushTodoUndo],
  );

  /** 添加新待办（追加到指定页末尾）；返回落盘 Promise（开庭 C 需先落行再建日历事件） */
  const addTodo = useCallback(
    (projectId: string, noteId: string, pageId: string, text: string) => {
      if (!todoData || !text.trim()) return Promise.resolve();
      const note = todoData.find((n) => n.noteId === noteId);
      const page = note?.pages.find((pg) => pg.pageId === pageId);
      if (!page) return Promise.resolve();
      pushTodoUndo(noteId, pageId, page.lines);
      const newLines = [...page.lines, { done: false, text: text.trim() }];
      // 新行无日历标记，补齐数组长度保持与行对齐
      const newEventIds = page.lineEventIds ? [...page.lineEventIds.map((x) => [...x]), []] : undefined;
      return saveTodoPage(projectId, noteId, pageId, newLines, newEventIds ? { lineEventIds: newEventIds } : undefined);
    },
    [todoData, saveTodoPage, pushTodoUndo],
  );

  /** 删除某条待办 */
  const deleteTodo = useCallback(
    (projectId: string, noteId: string, pageId: string, lineIndex: number) => {
      if (!todoData) return;
      const note = todoData.find((n) => n.noteId === noteId);
      const page = note?.pages.find((pg) => pg.pageId === pageId);
      if (!page) return;
      pushTodoUndo(noteId, pageId, page.lines);
      const newLines = page.lines.filter((_, i) => i !== lineIndex);
      // 同步删掉对应行的日历标记，避免后续行错位
      const newEventIds = page.lineEventIds ? page.lineEventIds.filter((_, i) => i !== lineIndex) : undefined;
      void saveTodoPage(projectId, noteId, pageId, newLines, newEventIds ? { lineEventIds: newEventIds } : undefined);
    },
    [todoData, saveTodoPage, pushTodoUndo],
  );

  /** 标记某条待办已入日历：把日历事件 id 写入 sticky note 页面的 lineEventIds，
   *  持久化 + 广播（画布便签同步显示闹钟）+ 更新本地弹窗数据 */
  const markTodoCalendared = useCallback(
    async (projectId: string, noteId: string, pageId: string, lineIndex: number, eventIds: string[]) => {
      try {
        const res = await fetch(`/api/sticky-notes?project_id=${encodeURIComponent(projectId)}`);
        const data = await res.json();
        if (!data?.success || !Array.isArray(data.notes)) return;
        const note = (data.notes as Array<Record<string, unknown>>).find((n) => n.id === noteId);
        if (!note) return;
        const rawPages = Array.isArray(note.pages) ? note.pages : [];
        const pages = rawPages.map((pg: Record<string, unknown>) => {
          if (pg.id !== pageId) return pg;
          const evIds = Array.isArray(pg.lineEventIds)
            ? (pg.lineEventIds as unknown[][]).map((x) => (Array.isArray(x) ? x.map(String) : []))
            : [];
          while (evIds.length <= lineIndex) evIds.push([]);
          evIds[lineIndex] = eventIds;
          return { ...pg, lineEventIds: evIds };
        });
        await fetch('/api/sticky-notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', project_id: projectId, note: { id: noteId, pages } }),
        });
        // 广播 → 画布便签重新加载（该行变闹钟）
        window.dispatchEvent(new CustomEvent('sticky-notes-changed'));
        // 本地更新弹窗数据
        setTodoData((prev) =>
          prev
            ? prev.map((n) =>
                n.noteId === noteId
                  ? {
                      ...n,
                      pages: n.pages.map((pg) => {
                        if (pg.pageId !== pageId) return pg;
                        const evIds = pg.lineEventIds ? pg.lineEventIds.map((x) => [...x]) : [];
                        while (evIds.length <= lineIndex) evIds.push([]);
                        evIds[lineIndex] = eventIds;
                        return { ...pg, lineEventIds: evIds };
                      }),
                    }
                  : n,
              )
            : prev,
        );
      } catch {
        // 持久化失败仅影响下次打开的闹钟标记；本次已发送成功，无需打扰用户
      }
    },
    [],
  );

  /** 回撤：回退最近一次已保存操作（恢复该页操作前的 lines 并重新落盘） */
  const undoLastTodo = useCallback(() => {
    const last = todoUndoStack[todoUndoStack.length - 1];
    if (!last || !todoProject) return;
    setTodoUndoStack((prev) => prev.slice(0, -1));
    void saveTodoPage(todoProject.id, last.noteId, last.pageId, last.prevLines);
  }, [todoUndoStack, todoProject, saveTodoPage]);

  /** 显式保存：把当前所有页内容重新落盘（自动保存已即时写入，此处作显式确认兜底） */
  const saveAllTodos = useCallback(async () => {
    if (!todoProject || !todoData) return;
    for (const n of todoData) {
      for (const pg of n.pages) {
        await saveTodoPage(todoProject.id, n.noteId, pg.pageId, pg.lines);
      }
    }
  }, [todoProject, todoData, saveTodoPage]);

  /** 在项目里新建一张便签（todo 弹窗空态入口）：颜色自动与已有便签区分，含一条空待办 */
  const createStickyTodo = useCallback(async () => {
    if (!todoProject || todoSaving) return;
    setTodoSaving(true);
    setTodoError('');
    try {
      const resp = await fetch('/api/sticky-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          project_id: todoProject.id,
          note: { color: 'green', content: '', kind: 'todo' },
        }),
      });
      const data = await resp.json();
      if (data?.success) {
        if (data.limited) {
          showImageAiEditToast('该项目已有三张待办便签，一个项目最多三张', 'error');
        }
        window.dispatchEvent(new CustomEvent('sticky-notes-changed'));
        await openTodos(todoProject);
      } else {
        setTodoError(data?.error || 'Failed to create todo');
      }
    } catch {
      setTodoError('Failed to create todo');
    } finally {
      setTodoSaving(false);
    }
  }, [todoProject, todoSaving, openTodos]);

  // TODO 弹窗 Esc 关闭
  useEffect(() => {
    if (!todoProject) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTodos();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [todoProject, closeTodos]);

  /** 关闭新建项目弹窗（重置表单） */
  const closeCreate = useCallback(() => {
    setCreateOpen(false);
    setCreateName('');
    setCreateCategory('');
    setCreateNote('');
    setCreateTag1('');
    setCreateTag2('');
    createNoteUndoRef.current = [];
    createNoteRedoRef.current = [];
  }, []);

  /** 在系统文件管理器中打开项目文件夹（Electron 环境；浏览器环境静默跳过） */
  const revealInSystem = useCallback((projectPath: string) => {
    if (!projectPath) return;
    try {
      const w = window as unknown as { api?: { openFile?: (p: string) => Promise<unknown> } };
      if (w.api?.openFile) {
        void w.api.openFile(projectPath);
      }
    } catch (e) {
      console.error('Open folder error:', e);
    }
  }, []);

  /** 新建项目：调用 /api/projects POST create，成功后刷新列表并关闭 */
  const handleCreateProject = useCallback(async () => {
    const name = createName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError('');
    try {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name,
          category: createCategory || undefined,
          note: createNote.trim() || undefined,
          tags: [createTag1, createTag2].map((t) => t.trim()).filter(Boolean).slice(0, PROJECT_TAG_LIMIT),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        closeCreate();
        await load();
      } else {
        setError(data.error || 'Failed to create project');
      }
    } catch {
      setError('Failed to create project');
    } finally {
      setCreating(false);
    }
  }, [createName, createCategory, createNote, createTag1, createTag2, creating, closeCreate, load]);

  // 新建项目弹窗 Esc 关闭
  useEffect(() => {
    if (!createOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating) closeCreate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createOpen, creating, closeCreate]);

  const filterChips: Array<{ key: BoardFilter; label: string; count: number }> = [
    { key: 'active', label: 'Active', count: projects.filter((p) => !p.archived && !p.trashed).length },
    { key: 'archived', label: 'Archived', count: projects.filter((p) => p.archived).length },
    { key: 'trash', label: 'Trash', count: projects.filter((p) => p.trashed).length },
  ];

  if (!open) return null;

  return (
    <div
      data-project-board
      className="fixed inset-0 z-[1500] flex flex-col"
      style={{
        backgroundColor: 'var(--bg-secondary, #f7f7f8)',
        // 内联兜底：确保看板内文字可划选复制（不依赖外部 CSS，打包/缓存异常也生效）
        WebkitUserSelect: 'text',
        userSelect: 'text',
      }}
    >
      {/* 打开项目过渡层：等待目标项目画布重载完成期间全屏提示，切换即刻有反馈 */}
      {switching && (
        <div
          className="absolute inset-0 z-[999] flex flex-col items-center justify-center gap-3"
          style={{ backgroundColor: 'color-mix(in oklab, var(--bg-secondary, #f7f7f8) 55%, transparent)', backdropFilter: 'blur(2px)' }}
        >
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--primary-strong, #5b48d8)' }} />
          <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
            Opening {projects.find((p) => p.id === switching)?.name || 'project'}…
          </div>
        </div>
      )}
      {/* 顶部工具栏 */}
      <div
        className="flex items-center gap-3 border-b px-5 py-3"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--paper, #ffffff)' }}
      >
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-4 w-4" style={{ color: 'var(--primary-strong, #5b48d8)' }} />
          <span className="text-15 font-semibold" style={{ color: 'var(--ink)' }}>
            Projects
          </span>
          {/* 标题栏开关：打开 BobWork 时自动进入项目面板（每次启动一次）；关闭则直接进入上次项目 */}
          <div
            className="ml-3 flex shrink-0 items-center gap-1.5"
            title="Open this panel every time BobWork launches"
          >
            <button
              type="button"
              role="switch"
              aria-checked={openOnLaunch}
              onClick={() => setOpenOnLaunchPersist(!openOnLaunch)}
              className="relative h-4 w-7 shrink-0 rounded-full transition-colors"
              style={{ background: openOnLaunch ? 'var(--primary-strong, #5b48d8)' : 'var(--border)' }}
            >
              <span
                className="absolute top-0.5 h-3 w-3 rounded-full transition-all"
                style={{ left: openOnLaunch ? 14 : 2, background: '#fff' }}
              />
            </button>
            <span className="text-xs whitespace-nowrap" style={{ color: 'var(--ink-muted)' }}>
              Open on launch
            </span>
          </div>
        </div>
        <div className="ml-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs" style={{ background: 'var(--paper-hover, #f0f0f3)', color: 'var(--ink-muted)' }}>
          {filtered.length}/{projects.length}
        </div>
        {/* 搜索 */}
        <div
          className="ml-auto flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-1.5 max-w-[360px]"
          style={{ border: '1px solid var(--border)', background: 'var(--paper-hover, #f6f6f8)' }}
        >
          <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-faint)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, tag, category…"
            className="w-full bg-transparent text-sm outline-none"
            style={{ color: 'var(--ink)' }}
          />
        </div>
        {/* 新建项目 */}
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          title="New project"
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90"
          style={{ color: '#fff', background: 'var(--primary-strong, #5b48d8)' }}
        >
          <Plus className="h-3.5 w-3.5" />
          New project
        </button>
        {/* 关闭（标题栏最右侧） */}
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--ink-muted)' }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 第二行：状态筛选 + 排序/分组 */}
      <div
        className="flex flex-wrap items-center gap-2 border-b px-5 py-2"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--paper, #ffffff)' }}
      >
        <div className="flex shrink-0 items-center gap-1">
          {filterChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                if (c.key === filter) return;
                // 标记：视图切换后由 effect 把右侧详情切到新视图首张卡片
                viewSelectPendingRef.current = true;
                setFilter(c.key);
              }}
              className="rounded-full px-2.5 py-1 text-xs font-medium transition-colors"
              style={
                filter === c.key
                  ? { color: 'var(--primary-strong, #5b48d8)', background: 'color-mix(in oklab, var(--primary, #7c5cff) 12%, transparent)' }
                  : { color: 'var(--ink-muted)', background: 'transparent' }
              }
            >
              {c.label} {c.count}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* 视图切换：网格卡片 / 列表（偏好持久化） */}
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-lg p-0.5"
            style={{ border: '1px solid var(--border)' }}
          >
            {([
              { key: 'grid' as const, label: 'Grid view', Icon: LayoutGrid },
              { key: 'list' as const, label: 'List view', Icon: List },
            ]).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setViewModePersist(key)}
                title={label}
                aria-label={label}
                aria-pressed={viewMode === key}
                className="rounded-md p-1 transition-colors"
                style={
                  viewMode === key
                    ? { color: 'var(--primary-strong, #5b48d8)', background: 'color-mix(in oklab, var(--primary, #7c5cff) 12%, transparent)' }
                    : { color: 'var(--ink-faint)' }
                }
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
            <span>Sort</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="rounded-lg border bg-transparent px-2 py-1 text-xs font-medium outline-none"
              style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
            >
              <option value="recent">Recently used</option>
              <option value="created">Created date</option>
              <option value="nodes">Most nodes</option>
              <option value="name">Name A–Z</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-faint)' }}>
            <span>Group</span>
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupMode)}
              className="rounded-lg border bg-transparent px-2 py-1 text-xs font-medium outline-none"
              style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
            >
              <option value="none">No group</option>
              <option value="category">By category</option>
              <option value="tag">By tag</option>
            </select>
          </label>
        </div>
      </div>

      {/* 标签分类筛选：默认标签（分类）在前 + 自定义标签在后（均动态聚合） */}
      {(catTags.length > 0 || allTags.length > 0) && (
        <div
          className="flex flex-wrap items-center gap-1 border-b px-5 py-2"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--paper, #ffffff)' }}
        >
          <span className="mr-1 shrink-0 text-xs font-medium" style={{ color: 'var(--ink-faint)' }}>
            Tags
          </span>
          {/* 默认标签（分类） */}
          {catTags.map((t) => {
            const active = catFilter === t.name;
            return (
              <button
                key={t.name}
                type="button"
                onClick={() => setCatFilter(active ? null : t.name)}
                className="rounded-full px-2.5 py-1 text-xs font-medium transition-colors"
                style={
                  active
                    ? { color: '#fff', background: 'var(--primary-strong, #5b48d8)', border: '1px solid var(--primary-strong, #5b48d8)' }
                    : { color: 'var(--primary-strong, #5b48d8)', background: 'transparent', border: '1px dashed var(--primary, #7c5cff)' }
                }
                title="Default tag (category)"
              >
                {t.name} {t.count}
              </button>
            );
          })}
          {/* 自定义标签 */}
          {allTags.map((t) => {
            const active = tagFilter === t.name;
            return (
              <button
                key={t.name}
                type="button"
                onClick={() => setTagFilter(active ? null : t.name)}
                className="rounded-full px-2.5 py-1 text-xs font-medium transition-colors"
                style={
                  active
                    ? { color: 'var(--primary-strong, #5b48d8)', background: 'color-mix(in oklab, var(--primary, #7c5cff) 12%, transparent)', border: '1px solid var(--primary, #7c5cff)' }
                    : { color: 'var(--ink-muted)', background: 'transparent', border: '1px solid var(--border)' }
                }
              >
                {t.name} {t.count}
              </button>
            );
          })}
          {(catFilter || tagFilter) && (
            <button
              type="button"
              onClick={() => {
                setCatFilter(null);
                setTagFilter(null);
              }}
              className="ml-auto rounded-full px-2 py-1 text-xs font-medium transition-colors"
              style={{ color: 'var(--primary-strong, #5b48d8)' }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* 主体：分组卡片网格 + 详情侧栏（单击卡片即打开详情；打开/进入项目用卡片右下角 Open 按钮，
          无双击判定，交互直接无延迟） */}
      <div className="flex min-h-0 flex-1">
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-lg px-3 py-2 text-xs" style={{ background: 'color-mix(in oklab, var(--danger, #e8463a) 10%, transparent)', color: 'var(--danger, #e8463a)' }}>
              {error}
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2" style={{ color: 'var(--ink-faint)' }}>
              <FolderOpen className="h-8 w-8 opacity-40" />
              <span className="text-sm">No projects match{query ? ' your search' : ''}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {groups.map((g) => {
                // 每项的展示态：网格与列表两种视图共用同一份推导，避免两处逻辑漂移
                const items = g.items.map((p) => ({
                  p,
                  isCurrent: p.id === currentId,
                  isArchived: !!p.archived,
                  isTrashed: !!p.trashed,
                  isSelected: selected?.id === p.id,
                  breath: !p.archived && !p.trashed && p.hearing_date ? hearingDaysLeft(p.hearing_date) : -1,
                }));
                return (
                <section key={g.key}>
                  {groupBy !== 'none' && (
                    <div
                      className="sticky top-0 z-10 mb-2 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold"
                      style={{
                        color: 'var(--ink-muted)',
                        background: 'color-mix(in oklab, var(--bg-secondary, #f7f7f8) 92%, transparent)',
                        border: '1px solid var(--border)',
                        backdropFilter: 'blur(4px)',
                      }}
                    >
                      <span>{g.label}</span>
                      <span className="rounded-full px-1.5 text-10" style={{ background: 'var(--paper-hover, #f0f0f3)' }}>
                        {g.items.length}
                      </span>
                    </div>
                  )}
                  {viewMode === 'grid' ? (
                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
                    {items.map(({ p, isCurrent, isArchived, isTrashed, isSelected, breath }) => (
                        <div
                          key={p.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            // 拖选文字时不打开详情，保证文字可正常复制（卡片内按钮已 stopPropagation）
                            if (hasTextSelection()) return;
                            openDetail(p);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              openDetail(p);
                            }
                          }}
                          title="Open details"
                          className="board-card group flex cursor-pointer flex-col rounded-xl p-3 text-left transition-all"
                          data-current={isCurrent}
                          data-selected={isSelected}
                          style={{
                            position: 'relative',
                            // 当前项目始终绿色（即使被单击选中也不变色），与其他项目区分；
                            // 非当前项目被选中时显示紫色选中态
                            border: isCurrent
                              ? '2px solid #2fa97a'
                              : isSelected
                                ? '2px solid var(--primary-strong, #5b48d8)'
                                : '1px solid var(--border)',
                            background: isCurrent
                              ? 'color-mix(in oklab, #2fa97a 8%, var(--paper, #ffffff))'
                              : isSelected
                                ? 'color-mix(in oklab, var(--primary, #7c5cff) 6%, var(--paper, #ffffff))'
                                : 'var(--paper, #ffffff)',
                            // 卡片阴影（默认/hover/当前/选中）统一在 globals.css 的
                            // [data-project-board] .board-card 中定义，避免内联样式覆盖 :hover
                            opacity: isTrashed ? 0.6 : 1,
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                              {p.name}
                            </span>
                            {!isArchived && !isTrashed && p.hearing_date && (
                              <span
                                title={`开庭：${p.hearing_date}`}
                                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-10 font-semibold"
                                style={{
                                  color: 'var(--danger, #e8463a)',
                                  border: '1px dashed var(--danger, #e8463a)',
                                  // 开庭前3天起徽标呼吸灯（紫色），档位越高越临近、越快越亮
                                  ...(breath >= 0
                                    ? { animation: `court-breathe-${breath} var(--court-dur, ${BREATH_DUR[breath]}s) ease-in-out infinite` }
                                    : {}),
                                }}
                              >
                                <CalendarDays className="h-3 w-3 shrink-0" />
                                {hearingLabel(p.hearing_date)} 开庭
                              </span>
                            )}
                            {(isArchived || isTrashed) && (
                              <span
                                className="shrink-0 rounded-full px-2 py-0.5 text-10 font-medium"
                                style={{
                                  color: isTrashed ? 'var(--danger, #e8463a)' : 'var(--ink-muted)',
                                  background: isTrashed
                                    ? 'color-mix(in oklab, var(--danger, #e8463a) 10%, transparent)'
                                    : 'var(--paper-hover, #f0f0f3)',
                                }}
                              >
                                {isTrashed ? 'Trash' : 'Archived'}
                              </span>
                            )}
                            {/* 恢复操作（hover 显示；归档/删除已移至底部 todo 按钮右侧） */}
                            {(isArchived || isTrashed) && (
                              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                {isArchived && !isTrashed && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      mutateProject(p.id, 'unarchive');
                                    }}
                                    title="Unarchive project"
                                    className="rounded p-1 transition-colors hover:bg-[var(--paper-hover)]"
                                    style={{ color: 'var(--ink-muted)' }}
                                  >
                                    <ArchiveRestore className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                {isTrashed && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      mutateProject(p.id, 'restore');
                                    }}
                                    title="Restore project"
                                    className="rounded p-1 transition-colors hover:bg-[var(--paper-hover)]"
                                    style={{ color: 'var(--ink-muted)' }}
                                  >
                                    <ArchiveRestore className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <span
                              className="rounded px-1.5 py-px text-11 font-medium"
                              style={{ color: 'var(--ink-muted)', background: 'var(--paper-hover, #f0f0f3)' }}
                            >
                              {p.category || 'Uncategorized'}
                            </span>
                            {(p.tags || []).map((t) => (
                              <span key={t} className="rounded-full px-1.5 py-px text-10" style={{ color: 'var(--ink-faint)', border: '1px solid var(--border)' }}>
                                {t}
                              </span>
                            ))}
                          </div>
                          <div className="flex-1" />
                          <div className="mt-2 flex items-center justify-between border-t pt-2 text-11" style={{ borderColor: 'var(--border)', color: 'var(--ink-faint)' }}>
                            <span className="flex items-center gap-2.5">
                              <span className="flex items-center gap-1">
                                <MessageSquareText className="h-3 w-3" />
                                ×{p.node_count ?? 0}
                              </span>
                              {/* Sticky 未完成待办按钮：数量 + 点击弹窗查看明细；有待办时红色呼吸灯，>=3 时节奏加快 */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openTodos(p);
                                }}
                                title="View sticky todos"
                                className={`flex items-center gap-1 rounded px-1 py-px transition-colors hover:bg-[var(--paper-hover)]${(p.todo_count ?? 0) > 0 ? ' todo-breathing' : ''}`}
                                style={{
                                  color: (p.todo_count ?? 0) > 0 ? 'var(--danger, #e8463a)' : 'var(--ink-faint)',
                                  ...((p.todo_count ?? 0) >= 3 ? { animationDuration: '1.1s' } : {}),
                                }}
                              >
                                <ListTodo className="h-3 w-3" />
                                {p.todo_count ?? 0}
                              </button>
                            </span>
                            {/* 打开/进入项目（唯一入口，替代原双击）：当前项目点击返回画布 */}
                            <button
                              type="button"
                              disabled={isArchived || isTrashed}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isArchived || isTrashed) return;
                                if (isCurrent) onClose();
                                else void switchTo(p.id);
                              }}
                              title={isArchived || isTrashed ? 'Restore to open' : 'Open project'}
                              className="shrink-0 rounded-md px-2.5 py-0.5 text-11 font-semibold transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
                              style={
                                /* 不选中：透明底 + 无边框 + 淡灰字（与左侧统计/时间同色）；卡片被选中时改为浅灰底深色文字 + 黑色描边 */
                                isSelected
                                  ? { color: 'var(--ink)', background: 'var(--paper-hover, #e8e8ec)', border: '1px solid #000' }
                                  : { color: 'var(--ink-faint)' }
                              }
                            >
                              Open
                            </button>
                          </div>
                        </div>
                    ))}
                  </div>
                  ) : (
                  /* 列表视图：一行一项目，列信息与卡片对齐（筛选/排序/分组与网格共用同一份数据） */
                  <div className="flex flex-col gap-1.5">
                    {items.map(({ p, isCurrent, isArchived, isTrashed, isSelected, breath }) => (
                      <div
                        key={p.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          // 与卡片一致：拖选文字时不打开详情，保证文字可正常复制
                          if (hasTextSelection()) return;
                          openDetail(p);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openDetail(p);
                          }
                        }}
                        title="Open details"
                        className="board-row group flex items-center gap-3 rounded-lg px-3 py-2 text-left"
                        data-current={isCurrent}
                        data-selected={isSelected}
                        style={{
                          // 状态以左侧色条表达（列表行不使用卡片阴影/上移）
                          borderWidth: '1px',
                          borderStyle: 'solid',
                          borderColor: 'var(--border)',
                          borderLeftWidth: '3px',
                          borderLeftColor: isCurrent
                            ? '#2fa97a'
                            : isSelected
                              ? 'var(--primary-strong, #5b48d8)'
                              : isTrashed
                                ? 'var(--danger, #e8463a)'
                                : isArchived
                                  ? 'var(--ink-faint)'
                                  : 'transparent',
                          // 仅当前/选中态写内联底色（普通行底色交给 CSS，保证 :hover 生效）
                          ...(isCurrent
                            ? { background: 'color-mix(in oklab, #2fa97a 8%, var(--paper, #ffffff))' }
                            : isSelected
                              ? { background: 'color-mix(in oklab, var(--primary, #7c5cff) 6%, var(--paper, #ffffff))' }
                              : {}),
                          opacity: isTrashed ? 0.6 : 1,
                        }}
                      >
                        {/* 名称 + 当前/归档/回收站徽标 + 开庭徽标 + 恢复操作 */}
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="min-w-0 truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                            {p.name}
                          </span>
                          {isCurrent && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-px text-10 font-semibold"
                              style={{ color: 'var(--primary-strong, #5b48d8)', background: 'color-mix(in oklab, var(--primary, #7c5cff) 12%, transparent)' }}
                            >
                              Current
                            </span>
                          )}
                          {!isArchived && !isTrashed && p.hearing_date && (
                            <span
                              title={`开庭：${p.hearing_date}`}
                              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-10 font-semibold"
                              style={{
                                color: 'var(--danger, #e8463a)',
                                border: '1px dashed var(--danger, #e8463a)',
                                ...(breath >= 0
                                  ? { animation: `court-breathe-${breath} var(--court-dur, ${BREATH_DUR[breath]}s) ease-in-out infinite` }
                                  : {}),
                              }}
                            >
                              <CalendarDays className="h-3 w-3 shrink-0" />
                              {hearingLabel(p.hearing_date)} 开庭
                            </span>
                          )}
                          {(isArchived || isTrashed) && (
                            <span
                              className="shrink-0 rounded-full px-2 py-0.5 text-10 font-medium"
                              style={{
                                color: isTrashed ? 'var(--danger, #e8463a)' : 'var(--ink-muted)',
                                background: isTrashed
                                  ? 'color-mix(in oklab, var(--danger, #e8463a) 10%, transparent)'
                                  : 'var(--paper-hover, #f0f0f3)',
                              }}
                            >
                              {isTrashed ? 'Trash' : 'Archived'}
                            </span>
                          )}
                          {(isArchived || isTrashed) && (
                            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  mutateProject(p.id, isTrashed ? 'restore' : 'unarchive');
                                }}
                                title={isTrashed ? 'Restore project' : 'Unarchive project'}
                                className="rounded p-1 transition-colors hover:bg-[var(--paper-hover)]"
                                style={{ color: 'var(--ink-muted)' }}
                              >
                                <ArchiveRestore className="h-3.5 w-3.5" />
                              </button>
                            </span>
                          )}
                        </span>
                        {/* 分类 + 标签（窄屏隐藏；详情侧栏仍可查看与编辑） */}
                        <span className="hidden shrink-0 items-center gap-1.5 lg:flex">
                          <span
                            className="rounded px-1.5 py-px text-11 font-medium"
                            style={{ color: 'var(--ink-muted)', background: 'var(--paper-hover, #f0f0f3)' }}
                          >
                            {p.category || 'Uncategorized'}
                          </span>
                          {(p.tags || []).map((t) => (
                            <span key={t} className="rounded-full px-1.5 py-px text-10" style={{ color: 'var(--ink-faint)', border: '1px solid var(--border)' }}>
                              {t}
                            </span>
                          ))}
                        </span>
                        {/* 节点数 + Sticky 未完成待办 */}
                        <span className="flex shrink-0 items-center gap-2.5 text-11" style={{ color: 'var(--ink-faint)' }}>
                          <span className="flex items-center gap-1">
                            <MessageSquareText className="h-3 w-3" />
                            ×{p.node_count ?? 0}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openTodos(p);
                            }}
                            title="View sticky todos"
                            className={`flex items-center gap-1 rounded px-1 py-px transition-colors hover:bg-[var(--paper-hover)]${(p.todo_count ?? 0) > 0 ? ' todo-breathing' : ''}`}
                            style={{
                              color: (p.todo_count ?? 0) > 0 ? 'var(--danger, #e8463a)' : 'var(--ink-faint)',
                              ...((p.todo_count ?? 0) >= 3 ? { animationDuration: '1.1s' } : {}),
                            }}
                          >
                            <ListTodo className="h-3 w-3" />
                            {p.todo_count ?? 0}
                          </button>
                        </span>
                        {/* 最近使用（窄屏隐藏） */}
                        <span className="hidden w-[96px] shrink-0 text-right text-11 md:block" style={{ color: 'var(--ink-faint)' }}>
                          {relTime(p.last_accessed_at || p.created_at)}
                        </span>
                        {/* 打开/进入项目（当前项目点击返回画布） */}
                        <button
                          type="button"
                          disabled={isArchived || isTrashed}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isArchived || isTrashed) return;
                            if (isCurrent) onClose();
                            else void switchTo(p.id);
                          }}
                          title={isArchived || isTrashed ? 'Restore to open' : 'Open project'}
                          className="shrink-0 rounded-md px-2.5 py-0.5 text-11 font-semibold transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
                          style={
                            /* 不选中：透明底 + 无边框 + 淡灰字（与左侧统计/时间同色）；行被选中时改为浅灰底深色文字 + 黑色描边 */
                            isSelected
                              ? { color: 'var(--ink)', background: 'var(--paper-hover, #e8e8ec)', border: '1px solid #000' }
                              : { color: 'var(--ink-faint)' }
                          }
                        >
                          Open
                        </button>
                      </div>
                    ))}
                  </div>
                  )}
                </section>
                );
              })}
            </div>
          )}
        </div>

        {/* 详情侧栏 */}
        {selected && (
          <aside
            className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l px-4 py-4"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary, #f7f7f8)' }}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                      setEditName(selected.name);
                      e.currentTarget.blur();
                    }
                  }}
                  disabled={selected.trashed}
                  title="Edit project name"
                  className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold outline-none transition-colors hover:border-[var(--border)] focus:border-amber-400"
                  style={{ color: 'var(--ink)' }}
                />
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {selected.id === currentId && (
                    <span className="rounded-full px-2 py-0.5 text-10 font-semibold" style={{ color: 'var(--primary-strong, #5b48d8)', background: 'color-mix(in oklab, var(--primary, #7c5cff) 12%, transparent)' }}>
                      Current
                    </span>
                  )}
                  {selected.archived && (
                    <span className="rounded-full px-2 py-0.5 text-10 font-medium" style={{ color: 'var(--ink-muted)', background: 'var(--paper-hover, #f0f0f3)' }}>
                      Archived
                    </span>
                  )}
                  {selected.trashed && (
                    <span className="rounded-full px-2 py-0.5 text-10 font-medium" style={{ color: 'var(--danger, #e8463a)', background: 'color-mix(in oklab, var(--danger, #e8463a) 10%, transparent)' }}>
                      Trash
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {/* 打开文件夹（所有项目） */}
                <button
                  type="button"
                  onClick={() => revealInSystem(selected.path)}
                  title="Open folder in system"
                  className="rounded-lg p-1 transition-colors hover:bg-[var(--paper-hover)]"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  <FolderOpen className="h-4 w-4" />
                </button>
                {/* 活跃项目：归档 + 删除（移到垃圾桶） */}
                {!selected.archived && !selected.trashed && (
                  <>
                    <button
                      type="button"
                      onClick={() => mutateProject(selected.id, 'archive')}
                      disabled={mutating}
                      title="Archive project"
                      className="rounded-lg p-1 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
                      style={{ color: 'var(--ink-muted)' }}
                    >
                      <Archive className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        mutateProject(
                          selected.id,
                          'delete',
                          `Move "${selected.name}" to trash?\n\nYou can restore it later from the trash.`,
                        )
                      }
                      disabled={mutating}
                      title="Delete (move to trash)"
                      className="rounded-lg p-1 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
                      style={{ color: 'var(--danger, #e8463a)' }}
                    >
                      <Trash className="h-4 w-4" />
                    </button>
                  </>
                )}
                {/* 归档项目：恢复 */}
                {selected.archived && !selected.trashed && (
                  <button
                    type="button"
                    onClick={() => mutateProject(selected.id, 'unarchive')}
                    disabled={mutating}
                    title="Unarchive project"
                    className="rounded-lg p-1 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    <ArchiveRestore className="h-4 w-4" />
                  </button>
                )}
                {/* 垃圾桶项目：恢复 */}
                {selected.trashed && (
                  <button
                    type="button"
                    onClick={() => mutateProject(selected.id, 'restore')}
                    disabled={mutating}
                    title="Restore project"
                    className="rounded-lg p-1 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    <ArchiveRestore className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {/* 元信息 */}
            <div className="mt-4 flex flex-col gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <div className="flex items-center gap-1.5">
                <MessageSquareText className="h-3.5 w-3.5 shrink-0" />
                <span>×{selected.node_count ?? 0}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span>Created {absDate(selected.created_at)} ({relTime(selected.created_at)})</span>
              </div>
              {selected.last_accessed_at && (
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  <span>Last used {relTime(selected.last_accessed_at)}</span>
                </div>
              )}
              <div className="flex items-start gap-1.5">
                <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-all font-mono text-11 leading-relaxed">{selected.path}</span>
              </div>
            </div>

            {/* 分类 / 标签编辑 */}
            <div className="mt-4 flex flex-col gap-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
              <div className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>
                Metadata
              </div>
              <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                Category
                <select
                  value={editCategory}
                  onChange={(e) => updateMetaCategory(e.target.value)}
                  className="rounded-lg border bg-transparent px-2 py-1.5 text-xs font-medium outline-none"
                  style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
                >
                  <option value="">None</option>
                  {PROJECT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                <span>Tags (up to {PROJECT_TAG_LIMIT})</span>
                <div className="flex gap-2">
                  <input
                    value={editTag1}
                    onChange={(e) => updateMetaTag(1, e.target.value)}
                    placeholder="Tag 1"
                    className="w-full rounded-lg border bg-transparent px-2 py-1.5 text-xs font-medium outline-none"
                    style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
                  />
                  <input
                    value={editTag2}
                    onChange={(e) => updateMetaTag(2, e.target.value)}
                    placeholder="Tag 2"
                    className="w-full rounded-lg border bg-transparent px-2 py-1.5 text-xs font-medium outline-none"
                    style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
                  />
                </div>
              </div>
              <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                <span className="flex items-center justify-between">
                  <span>Note (up to {PROJECT_NOTE_MAX} characters, empty to clear)</span>
                  <span style={{ color: editNote.length >= PROJECT_NOTE_MAX ? 'var(--danger, #e8463a)' : 'var(--ink-faint)' }}>
                    {editNote.length}/{PROJECT_NOTE_MAX}
                  </span>
                </span>
                <textarea
                  value={editNote}
                  onChange={(e) => updateMetaNote(e.target.value)}
                  onFocus={(e) => {
                    const el = e.currentTarget;
                    if (el.value === '') {
                      updateMetaNote('1. ');
                      requestAnimationFrame(() => {
                        el.selectionStart = el.selectionEnd = el.value.length;
                      });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.shiftKey) return;
                    e.preventDefault();
                    const el = e.currentTarget;
                    const start = el.selectionStart ?? el.value.length;
                    const end = el.selectionEnd ?? start;
                    const value = el.value;
                    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                    const m = value.slice(lineStart, start).match(/^(\d+)\.\s*(.*)$/);
                    let next: string;
                    let cursor: number;
                    if (m) {
                      const num = parseInt(m[1], 10);
                      if (m[2].trim() === '') {
                        next = value.slice(0, lineStart) + value.slice(end);
                        cursor = lineStart;
                      } else {
                        const suffix = `${num + 1}. `;
                        next = value.slice(0, start) + '\n' + suffix + value.slice(end);
                        cursor = start + 1 + suffix.length;
                      }
                    } else {
                      next = value.slice(0, start) + '\n' + value.slice(end);
                      cursor = start + 1;
                    }
                    updateMetaNote(next);
                    requestAnimationFrame(() => {
                      el.selectionStart = el.selectionEnd = cursor;
                    });
                  }}
                  rows={3}
                  maxLength={PROJECT_NOTE_MAX}
                  placeholder="No note yet"
                  className="w-full resize-none rounded-lg border bg-transparent px-2 py-1.5 text-xs font-medium leading-relaxed outline-none"
                  style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
                />
              </label>
            </div>

            {/* 打开项目 */}
            <div className="mt-auto border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              {error && (
                <p className="mb-2 text-11" style={{ color: 'var(--danger, #e8463a)' }}>
                  {error}
                </p>
              )}
              {selected.archived && (
                <button
                  type="button"
                  onClick={() => mutateProject(selected.id, 'unarchive')}
                  disabled={mutating}
                  className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-opacity disabled:opacity-50"
                  style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
                >
                  <ArchiveRestore className="h-3.5 w-3.5" />
                  {mutating ? 'Unarchiving…' : 'Unarchive project'}
                </button>
              )}
              {selected.trashed && (
                <>
                  <button
                    type="button"
                    onClick={() => mutateProject(selected.id, 'restore')}
                    disabled={mutating}
                    className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-opacity disabled:opacity-50"
                    style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    {mutating ? 'Restoring…' : 'Restore from Trash'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      mutateProject(
                        selected.id,
                        'purge',
                        `Permanently delete "${selected.name}"?\n\nThis deletes the project folder and ALL its data (nodes, files, edges). This action CANNOT be undone.`,
                      )
                    }
                    disabled={mutating}
                    className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-opacity disabled:opacity-50"
                    style={{ color: '#fff', background: 'var(--danger, #e8463a)' }}
                  >
                    <Trash className="h-3.5 w-3.5" />
                    {mutating ? 'Deleting…' : 'Delete permanently'}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => switchTo(selected.id)}
                disabled={selected.id === currentId || selected.trashed || switching === selected.id}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-opacity disabled:opacity-50"
                style={{ color: 'var(--primary-strong, #5b48d8)', background: 'color-mix(in oklab, var(--primary, #7c5cff) 10%, transparent)' }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {selected.trashed
                  ? 'Restore from Trash to open'
                  : selected.id === currentId
                    ? 'Current project'
                    : 'Open project'}
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* TODO 弹窗：Sticky 待办完整管理（已完成 + 未完成，支持增删改查与画布同步） */}
      {todoProject && (
        <TodoPopup
          project={todoProject}
          data={todoData}
          loading={todoLoading}
          error={todoError}
          saving={todoSaving}
          noteColors={TODO_NOTE_COLORS}
          onClose={closeTodos}
          onToggle={(noteId, pageId, lineIndex) => toggleTodo(todoProject.id, noteId, pageId, lineIndex)}
          onEdit={(noteId, pageId, lineIndex, text) => editTodo(todoProject.id, noteId, pageId, lineIndex, text)}
          onAdd={(noteId, pageId, text) => addTodo(todoProject.id, noteId, pageId, text)}
          onDelete={(noteId, pageId, lineIndex) => deleteTodo(todoProject.id, noteId, pageId, lineIndex)}
          onMarkCalendared={(noteId, pageId, lineIndex, eventIds) => void markTodoCalendared(todoProject.id, noteId, pageId, lineIndex, eventIds)}
          onCreateNote={createStickyTodo}
          onSave={() => void saveAllTodos()}
          onUndo={undoLastTodo}
          canUndo={todoUndoStack.length > 0}
        />
      )}

      {/* 新建项目弹窗 */}
      {createOpen && (
        <div
          className="fixed inset-0 z-[600] flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={() => !creating && closeCreate()}
        >
          <div
            className="w-[400px] max-w-full rounded-2xl p-6 shadow-2xl"
            style={{
              border: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
              backgroundColor: 'var(--popover, #ffffff)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-base font-medium" style={{ color: 'var(--ink)' }}>
              New Project
            </h3>
            <p className="mb-4 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Name will get <code>_YYYYMMDD</code> suffix automatically.
            </p>
            <input
              type="text"
              autoFocus
              placeholder="Project name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !creating) handleCreateProject();
              }}
              disabled={creating}
              className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
              style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink)' }}
            />
            {/* 分类选择 */}
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Category
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PROJECT_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={creating}
                    onClick={() => setCreateCategory(createCategory === c ? '' : c)}
                    className="rounded-lg px-2.5 py-1 text-xs transition-colors"
                    style={
                      createCategory === c
                        ? { backgroundColor: 'var(--primary)', color: 'var(--paper)' }
                        : { backgroundColor: 'var(--paper)', color: 'var(--ink-muted)', border: '1px solid var(--line)' }
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            {/* 标签（两个独立输入框，并排显示，最多 2 个） */}
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Tags (up to {PROJECT_TAG_LIMIT})
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={createTag1}
                  onChange={(e) => setCreateTag1(e.target.value)}
                  disabled={creating}
                  placeholder="Tag 1"
                  className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
                  style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink)' }}
                />
                <input
                  type="text"
                  value={createTag2}
                  onChange={(e) => setCreateTag2(e.target.value)}
                  disabled={creating}
                  placeholder="Tag 2"
                  className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
                  style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink)' }}
                />
              </div>
            </div>
            {/* 备注（自动字数计数，最多 100 字） */}
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                <span>Note (optional)</span>
                <span style={{ color: createNote.length >= PROJECT_NOTE_MAX ? 'var(--danger, #e8463a)' : 'var(--ink-faint)' }}>
                  {createNote.length}/{PROJECT_NOTE_MAX}
                </span>
              </div>
              <textarea
                value={createNote}
                onChange={(e) => {
                  const v = e.target.value;
                  // 兜底：原生撤销/粘贴把编号行整体抹掉时，自动补回编号（备注的本意即编号列表）
                  const lines = v.split('\n');
                  const noneNumbered = lines.every((l) => !/^\d+\.\s*/.test(l));
                  const normalized =
                    !v || !noneNumbered || lines[0].trim() === ''
                      ? v
                      : lines.map((l, i) => `${i + 1}. ${l.replace(/^\d+\.\s*/, '')}`).join('\n');
                  createNoteUndoRef.current.push(createNote);
                  if (createNoteUndoRef.current.length > 80) createNoteUndoRef.current.shift();
                  createNoteRedoRef.current = [];
                  setCreateNote(normalized);
                }}
                onFocus={(e) => {
                  const el = e.currentTarget;
                  if (!creating && el.value === '') {
                    createNoteUndoRef.current = [];
                    createNoteRedoRef.current = [];
                    setCreateNote('1. ');
                    requestAnimationFrame(() => {
                      el.selectionStart = el.selectionEnd = el.value.length;
                    });
                  }
                }}
                onKeyDown={(e) => {
                  const mod = e.metaKey || e.ctrlKey;
                  const key = e.key.toLowerCase();
                  // undo / redo：走自定义快照栈，拒绝浏览器原生 undo 撤销自动编号
                  if (mod && (key === 'z' || key === 'y')) {
                    e.preventDefault();
                    const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
                    const src = isRedo ? createNoteRedoRef.current : createNoteUndoRef.current;
                    const dst = isRedo ? createNoteUndoRef.current : createNoteRedoRef.current;
                    const snap = src.pop();
                    if (snap !== undefined) {
                      const el = e.currentTarget;
                      const cursor = el.selectionStart ?? snap.length;
                      dst.push(createNote);
                      setCreateNote(snap);
                      requestAnimationFrame(() => {
                        if (document.activeElement === el) {
                          const pos = Math.min(cursor, snap.length);
                          el.selectionStart = el.selectionEnd = pos;
                        }
                      });
                    }
                    return;
                  }
                  if (e.key !== 'Enter' || e.shiftKey || creating) return;
                  e.preventDefault();
                  createNoteUndoRef.current.push(createNote);
                  if (createNoteUndoRef.current.length > 80) createNoteUndoRef.current.shift();
                  createNoteRedoRef.current = [];
                  const el = e.currentTarget;
                  const start = el.selectionStart ?? el.value.length;
                  const end = el.selectionEnd ?? start;
                  const value = el.value;
                  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                  const m = value.slice(lineStart, start).match(/^(\d+)\.\s*(.*)$/);
                  let next: string;
                  let cursor: number;
                  if (m) {
                    const num = parseInt(m[1], 10);
                    if (m[2].trim() === '') {
                      // 空编号行：回车时移除编号，避免残留空编号行
                      next = value.slice(0, lineStart) + value.slice(end);
                      cursor = lineStart;
                    } else {
                      const suffix = `${num + 1}. `;
                      next = value.slice(0, start) + '\n' + suffix + value.slice(end);
                      cursor = start + 1 + suffix.length;
                    }
                  } else {
                    next = value.slice(0, start) + '\n' + value.slice(end);
                    cursor = start + 1;
                  }
                  setCreateNote(next);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = cursor;
                  });
                }}
                disabled={creating}
                maxLength={PROJECT_NOTE_MAX}
                rows={3}
                placeholder="What is this project about?"
                className="w-full resize-none rounded-xl border px-3 py-2 text-sm outline-none focus:border-amber-400"
                style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)', color: 'var(--ink)' }}
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={closeCreate} disabled={creating} className="btn btn-ghost btn-sm">
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={creating || !createName.trim()}
                className="btn btn-primary btn-sm"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
