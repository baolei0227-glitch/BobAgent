import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { StickyNote, StickyNotePage } from '@/app/api/sticky-notes/route';
import { Plus, X, ClipboardList, Check, Layers, ChevronDown, AlarmClock } from 'lucide-react';
import { loadSettings, saveSettings, type StickyTodoTemplate } from '@/lib/settings';
import { showImageAiEditToast } from '@/lib/image-ai-edit-runtime';

/**
 * 画布便签层（Canvas Sticky Notes）
 *
 * 设计（与产品确认）：
 *  - 项目级纯私有便利贴，存 <项目根>/sticky-notes/sticky-notes.json
 *  - 不写入节点 .md、不接入 intern_search（AI 完全不可见）
 *  - 屏幕坐标存储（相对画布视口），不随画布缩放/平移/fit 移动，大小固定
 *  - 右键便签 → 置顶（持久化 z 层级），盖过其他便签
 *  - 内容 = 待办清单：每行 `- [ ] 文本`（勾选 `- [x]`），所有行字号一致
 *  - 勾选：行级切换 done，全部完成 → 便签整体沉底排到队尾
 *  - 侧边栏 page 名称默认 PX，右键进入重命名 input
 *  - 标题栏 = 拖拽手柄（移动阈值 4px，纯点击不触发拖拽）
 *  - contenteditable 就地编辑，React.memo 防止输入时重渲染导致光标重置
 *  - 2026-08：note 模式（带编号笔记页）已停用，存量 note 页由后端 GET 惰性迁移到 notebook.json；
 *    便签仅保留 todo 待办清单
 */

export const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

const COLOR_BG: Record<string, string> = {
  yellow: '#FFF7D6',
  blue: '#DCEBFF',
  green: '#DFF3E7',
  pink: '#FFE4EF',
};
const COLOR_TEXT: Record<string, string> = {
  yellow: '#43391C',
  blue: '#1E3458',
  green: '#1B4234',
  pink: '#4E2137',
};
// 同色系淡边框（0.5px 发丝级层次，替代"纯色纸面无边界"）
const COLOR_BORDER: Record<string, string> = {
  yellow: 'rgba(168,132,32,.24)',
  blue: 'rgba(62,116,190,.24)',
  green: 'rgba(52,132,88,.24)',
  pink: 'rgba(196,96,138,.24)',
};
// 同色系强调色（勾选态 / active 高亮 / 圆点选中，8 位 hex 便于拼接透明度）
const COLOR_ACCENT: Record<string, string> = {
  yellow: '#8A6D1D',
  blue: '#2F5FA8',
  green: '#1E7D34',
  pink: '#B0476E',
};
// 顶部色块坞使用的饱和色板：一眼可辨的便签颜色（深色/浅色画布背景均清晰）
export const NOTE_COLOR_SWATCH: Record<string, string> = {
  yellow: '#E0A825',
  blue: '#4E8BE6',
  green: '#2FA97A',
  pink: '#E06A9A',
};

// 颜色中文名（标题栏颜色下拉菜单显示）
const COLOR_LABELS: Record<string, string> = {
  yellow: '黄色',
  blue: '蓝色',
  green: '绿色',
  pink: '粉色',
};

// 默认尺寸继续缩小到经典像素 4:3（320×240）
const NOTE_WIDTH = 320;
const NOTE_HEIGHT = 240;
const MIN_W = 240;
const MIN_H = 180; // 240/4*3 = 180，保持 4:3
const SIDEBAR_W = 100;
const DRAG_THRESHOLD = 4;

/** 解析内容为待办行（不过滤空行，保留空行以便编辑） */
type TodoLine = { done: boolean; text: string };

/** 该行是否已添加到日历（新数据 lineEventIds 非空；兼容旧 lineCalendared 布尔标记） */
function isLineCalendared(page: StickyNotePage, index: number): boolean {
  return Boolean(page.lineEventIds?.[index]?.length) || page.lineCalendared?.[index] === true;
}
/** 便签落盘同步状态：syncing = 保存中 / saved = 已保存（短暂显示后复位）/ error = 保存失败（保留提示） */
type NoteSaveState = 'syncing' | 'saved' | 'error';
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

/** 序列化 todo 行 */
function serializeTodoLines(lines: TodoLine[]): string {
  return lines.map((l) => `- [${l.done ? 'x' : ' '}] ${l.text}`).join('\n');
}

/** 便签是否全部完成（全部勾选 → 沉底排序） */
function isAllDone(content: string): boolean {
  const lines = parseTodoLines(content);
  return lines.length > 0 && lines.every((l) => l.done);
}

function newPageId(): string {
  return `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 前端兼容升级：老数据 content → pages[0]，保证 pages、activePageId、kind 始终存在 */
function hydratePages(note: StickyNote): { pages: StickyNotePage[]; activePageId: string } {
  const norm = (p: StickyNotePage): StickyNotePage => ({
    ...p,
    kind: 'todo',
  });
  if (Array.isArray(note.pages) && note.pages.length > 0) {
    const pages = note.pages.map(norm);
    const valid = note.activePageId && pages.some((p) => p.id === note.activePageId);
    return { pages, activePageId: valid ? note.activePageId! : pages[0].id };
  }
  const raw = (note as StickyNote & { content?: string }).content ?? '';
  const content = raw.trim().length === 0 ? '- [ ] ' : raw;
  const p: StickyNotePage = norm({
    id: newPageId(),
    title: 'P1',
    content,
  });
  return { pages: [p], activePageId: p.id };
}

/** 获取当前 active page */
function getActivePage(note: StickyNote): StickyNotePage {
  const { pages, activePageId } = hydratePages(note);
  const p = pages.find((x) => x.id === activePageId) ?? pages[0];
  return p;
}

/** 获取当前 active page 的 content（向后兼容用函数，后续只在 hydratePages 完成时用 p.content） */
function getActiveContent(note: StickyNote): string {
  return getActivePage(note).content;
}

/** 侧栏折叠状态（默认折叠） */
function getSidebarCollapsed(note: StickyNote): boolean {
  return typeof note.sidebarCollapsed === 'boolean' ? note.sidebarCollapsed : true;
}

/* ────────────────────────────────────────────────────────────
 * TodoLineItem — memoized 行组件
 *
 * 核心：contenteditable 的 children 由 React 管理，但用户输入后
 * 如果 React 因 state 变化重渲染会重置 DOM textContent → 光标跳回开头。
 *
 * 解决：用 memo + 自定义 comparator，当仅 text 变化（rev/done/color/isFirst
 * 不变）时跳过重渲染。text 只在组件首次 mount 或结构性变更（rev bump）
 * 时才写入 DOM。
 * ──────────────────────────────────────────────────────────── */

type TodoLineItemProps = {
  text: string;
  done: boolean;
  color: string;
  accent: string;
  rev: number;
  onInputText: (text: string) => void;
  onEnter: () => void;
  onBackspaceEmpty: () => boolean;
  onToggle: () => void;
  /** 该行待办已自动入日历（与日历事件双向联动）→ 行尾显示只读闹钟标识 */
  calendared?: boolean;
};

const TodoLineItem = memo(
  function TodoLineItem({
    text,
    done,
    color,
    accent,
    onInputText,
    onEnter,
    onBackspaceEmpty,
    onToggle,
    calendared,
  }: TodoLineItemProps) {
    return (
      <div className="group flex items-start gap-2">
        <button
          type="button"
          title={done ? 'Mark as todo' : 'Done'}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="mt-[3px] flex h-[15px] w-[15px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border text-10 leading-none transition-colors"
          style={{
            borderColor: done ? `${accent}66` : 'rgba(23,23,23,.28)',
            background: done ? `${accent}22` : 'transparent',
            color: done ? accent : 'rgba(23,23,23,.6)',
          }}
        >
          {done ? '✓' : ''}
        </button>
        <div
          contentEditable
          suppressContentEditableWarning
          onInput={(e) => {
            const txt = (e.currentTarget.textContent ?? '').replace(/\n$/, '');
            onInputText(txt);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onEnter();
              return;
            }
            if (e.key === 'Backspace') {
              const txt = (e.currentTarget.textContent ?? '').replace(/\u200B/g, '');
              if (txt.length === 0) {
                const sel = window.getSelection();
                const atStart =
                  sel && sel.anchorOffset === 0 && sel.anchorNode === e.currentTarget;
                if (atStart || !sel || sel.isCollapsed) {
                  if (onBackspaceEmpty()) e.preventDefault();
                }
              }
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="select-text flex-1 min-w-0 whitespace-pre-wrap break-words outline-none focus:outline-none focus:ring-0 [&:empty::before]:content-[attr(data-placeholder)] [&:empty::before]:opacity-40"
          data-placeholder="Todo item..."
          style={{
            color,
            fontSize: '0.866667rem',
            fontWeight: 400,
            lineHeight: 1.45,
            textDecoration: done ? 'line-through' : 'none',
            opacity: done ? 0.55 : 1,
            cursor: 'text',
            outline: 'none',
            boxShadow: 'none',
          }}
        >
          {text}
        </div>
        {/* 行尾：已自动入日历的只读标识（非按钮，无手动操作） */}
        {calendared && (
          <span
            title="Synced to calendar"
            className="mt-[3px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px]"
            style={{ color: '#1e7d34', opacity: 0.75 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <AlarmClock size={11} strokeWidth={2} />
          </span>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.rev === next.rev &&
    prev.done === next.done &&
    prev.color === next.color &&
    prev.accent === next.accent &&
    prev.calendared === next.calendared,
);

/* ──────────────────────────────────────────────────────────── */

/** 顶部色块坞用的便签摘要 */
export type StickyNoteChip = {
  id: string;
  color: string;
  title: string;
};

export type CanvasStickyNotesHandle = {
  /** 静默创建 todo 便签（AI 工具等不需要交互的创建路径） */
  createNote: (screenX: number, screenY: number) => void;
  /** 一键找回：把任意便签重新定位到可视区并置顶（顶部色块坞点击触发） */
  focusNote: (noteId: string) => void;
  /** 一键排列全部便签：按创建时间正序堆叠在画布右侧（折叠侧边栏合并图标触发） */
  focusAllNotes: () => void;
  /** 点击画布空白时调用：使便签层从"临时置顶"回落到节点下方 */
  deactivateNote: () => void;
};

type Props = {
  projectId: string | null;
  /** 便签列表摘要变化时回调（CanvasFlow 顶部色块坞实时渲染用） */
  onChipsChange?: (chips: StickyNoteChip[]) => void;
};

export const CanvasStickyNotes = forwardRef<CanvasStickyNotesHandle, Props>(
  function CanvasStickyNotes({ projectId, onChipsChange }, ref) {
    const [notes, setNotes] = useState<StickyNote[]>([]);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [resizingId, setResizingId] = useState<string | null>(null);
    // 当前"激活"的便签：点击便签时容器临时上浮到节点上方（z-[40]），点击画布空白回落（z-[3]）
    const [activatedNoteId, setActivatedNoteId] = useState<string | null>(null);
    const [contentRev, setContentRev] = useState(0);
    const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
    const [renamingPageId, setRenamingPageId] = useState<string | null>(null);
    const [pageRenameDraft, setPageRenameDraft] = useState('');
    // 便签落盘同步状态（标题栏显示）：syncing = 请求中 / saved = 已保存（短暂显示）/ error = 保存失败
    const [saveStates, setSaveStates] = useState<Record<string, NoteSaveState>>({});
    // 便签 TODO 全局模板（settings.json，跨项目共享）
    const [templates, setTemplates] = useState<StickyTodoTemplate[]>([]);
    // 底部工具栏弹层：哪张便签 + 哪个模式打开（save = 存为模板输入 / apply = 选择模板列表）；null = 关闭
    const [templatePopover, setTemplatePopover] = useState<{ noteId: string; mode: 'save' | 'apply' } | null>(null);
    const [templateNameDraft, setTemplateNameDraft] = useState('');
    // Court 开庭录入表单（标题栏 C 按钮弹出，全英文）
    const [courtOpen, setCourtOpen] = useState(false);
    const [courtNoteId, setCourtNoteId] = useState<string | null>(null);
    const [courtDate, setCourtDate] = useState('');
    const [courtName, setCourtName] = useState('');
    const [courtRoom, setCourtRoom] = useState('');
    const [courtAddr, setCourtAddr] = useState('');

    // saved 状态短暂显示后的复位计时器（按便签 id 维护，连续保存时重置，避免提前消失）
    const savedFlashTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    const dragRef = useRef<{
      id: string;
      startClientX: number;
      startClientY: number;
      noteX: number;
      noteY: number;
      lastX: number;
      lastY: number;
      moved: boolean;
    } | null>(null);
    const resizeRef = useRef<{
      id: string;
      startClientX: number;
      startClientY: number;
      startW: number;
      startH: number;
      lastW: number;
      lastH: number;
    } | null>(null);
    // rAF 节流：拖拽/resize 的 pointermove 高频触发，每帧只合并提交一次 state，
    // 避免每次事件都 setNotes 触发整层重渲染导致卡顿
    const dragPendingRef = useRef<{ id: string; x: number; y: number } | null>(null);
    const dragRafRef = useRef<number | null>(null);
    const resizePendingRef = useRef<{ id: string; w: number; h: number } | null>(null);
    const resizeRafRef = useRef<number | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const titleSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;

    // notesRef: 让被 memo 跳过的旧闭包也能读到最新 state
    const notesRef = useRef(notes);
    notesRef.current = notes;

    // 顶部色块坞回调：ref 保持最新引用，effect 只在 notes 变化时触发
    const onChipsChangeRef = useRef(onChipsChange);
    onChipsChangeRef.current = onChipsChange;

    // 一键找回（色块坞）：级联步进防多张重叠 + 落地高亮闪烁
    const focusQueueRef = useRef<string[]>([]); // 右侧纵向排列队列（点击顺序，从上到下）
    const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [flashNoteId, setFlashNoteId] = useState<string | null>(null);
    // createNote 命中"每项目最多三张"时聚焦已有便签（focusNote 定义在其后，用 ref 桥接）
    const focusNoteRef = useRef<(noteId: string) => void>(() => {});

    // 每个便签的行容器 DOM ref（用于 Enter / Backspace 后定位光标）
    const linesContainerRef = useRef<Map<string, HTMLDivElement>>(new Map());

    // 项目切换时加载便签
    useEffect(() => {
      setNotes([]);
      setDraggingId(null);
      setResizingId(null);
      setContentRev(0);
      setSaveStates({});
      savedFlashTimerRef.current.forEach((t) => clearTimeout(t));
      savedFlashTimerRef.current.clear();
      dragRef.current = null;
      resizeRef.current = null;
      linesContainerRef.current.clear();
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      if (titleSaveTimerRef.current) { clearTimeout(titleSaveTimerRef.current); titleSaveTimerRef.current = null; }
      if (!projectId) return;
      let alive = true;
      fetch('/api/sticky-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'migrate', project_id: projectId }),
      })
        .then(() => fetch(`/api/sticky-notes?project_id=${encodeURIComponent(projectId)}`))
        .then((r) => r.json())
        .then((d) => {
          if (alive && d.success) setNotes(d.notes ?? []);
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [projectId]);

    // 外部变更后重载本项目便签：
    //  - AI 通过 create_sticky_note / create_scheduled_todo 工具静默创建便签（sticky-notes-changed）
    //  - 日历侧改动反向落回便签行（calendar-events-changed，如 CalendarPanel 勾选/改标题/删除）
    useEffect(() => {
      if (!projectId) return;
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const reload = () => {
        fetch(`/api/sticky-notes?project_id=${encodeURIComponent(projectId)}`)
          .then((r) => r.json())
          .then((d) => {
            if (alive && d.success) setNotes(d.notes ?? []);
          })
          .catch(() => {});
      };
      const reloadDebounced = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(reload, 250);
      };
      window.addEventListener('sticky-notes-changed', reload);
      window.addEventListener('calendar-events-changed', reloadDebounced);
      return () => {
        alive = false;
        if (timer) clearTimeout(timer);
        window.removeEventListener('sticky-notes-changed', reload);
        window.removeEventListener('calendar-events-changed', reloadDebounced);
      };
    }, [projectId]);

    // 便签摘要变化 → 通知 CanvasFlow 顶部色块坞实时刷新
    useEffect(() => {
      onChipsChangeRef.current?.(
        notes.map((n) => ({ id: n.id, color: n.color, title: n.title ?? '' })),
      );
    }, [notes]);

    useEffect(() => {
      return () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        if (titleSaveTimerRef.current) clearTimeout(titleSaveTimerRef.current);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        savedFlashTimerRef.current.forEach((t) => clearTimeout(t));
        savedFlashTimerRef.current.clear();
      };
    }, []);

    /** 落盘（update）：带同步状态跟踪——请求中标记 syncing，成功短暂显示 saved，失败保留 error 提示。
     *  silent=true 时仅静默落盘快照，不参与保存状态显示（由调用方统一管理 saving/saved）。 */
    const saveNote = useCallback((id: string, patch: Partial<StickyNote>, silent?: boolean) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      /** 服务端 update 会回写带 lineEventIds 的完整 note（自动入日历时生成）。
       *  只按 pageId 回填服务端生成的锚点数组（lineEventIds/lineCalendared），
       *  不整体替换 note —— 避免覆盖用户在两段保存间隙里继续输入的新内容。 */
      const adopt = (d: { success?: boolean; note?: StickyNote }) => {
        if (d?.success && d.note && Array.isArray(d.note.pages)) {
          const serverPages = d.note.pages;
          setNotes((prev) =>
            prev.map((n) => {
              if (n.id !== d.note!.id) return n;
              const localPages = Array.isArray(n.pages) ? n.pages : [];
              const mergedPages = localPages.map((p) => {
                const sp = serverPages.find((x) => x.id === p.id);
                if (!sp) return p;
                return { ...p, lineEventIds: sp.lineEventIds, lineCalendared: sp.lineCalendared };
              });
              const haveIds = new Set(mergedPages.map((p) => p.id));
              for (const sp of serverPages) {
                if (!haveIds.has(sp.id)) mergedPages.push(sp);
              }
              return { ...n, pages: mergedPages };
            }),
          );
        }
      };
      if (silent) {
        fetch('/api/sticky-notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', project_id: pid, note: { id, ...patch } }),
        })
          .then((r) => r.json().catch(() => ({ success: false })))
          .then(adopt)
          .catch(() => {});
        return;
      }
      setSaveStates((prev) => ({ ...prev, [id]: 'syncing' }));
      fetch('/api/sticky-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', project_id: pid, note: { id, ...patch } }),
      })
        .then((r) => r.json().catch(() => ({ success: false })))
        .then((d) => {
          if (d?.success) {
            adopt(d);
            setSaveStates((prev) => ({ ...prev, [id]: 'saved' }));
            // saved 状态短暂展示 1.6s 后复位（连续保存时重置计时器，避免提前消失）
            const prevT = savedFlashTimerRef.current.get(id);
            if (prevT) clearTimeout(prevT);
            savedFlashTimerRef.current.set(id, setTimeout(() => {
              setSaveStates((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
              savedFlashTimerRef.current.delete(id);
            }, 1600));
          } else {
            setSaveStates((prev) => ({ ...prev, [id]: 'error' }));
          }
        })
        .catch(() => setSaveStates((prev) => ({ ...prev, [id]: 'error' })));
    }, []);

    /** 新建便签（屏幕坐标）：静默创建 todo 清单；每项目最多三张，颜色自动与已有便签区分 */
    const createNote = useCallback((screenX: number, screenY: number) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      fetch('/api/sticky-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          project_id: pid,
          note: {
            x: screenX,
            y: screenY,
            color: 'green',
            content: '',
            kind: 'todo',
          },
        }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.success) {
            if (d.limited) {
              // 该项目已有三张待办便签：不重复创建，聚焦已有便签并提示
              showImageAiEditToast('该项目已有三张待办便签，一个项目最多三张', 'error');
              focusNoteRef.current(d.note.id);
            } else {
              setNotes((prev) => [...prev, d.note]);
            }
          }
        })
        .catch(() => {});
    }, []);

    /** 一键找回（侧边栏色块点击）：把便签排到画布右侧、从上到下按点击顺序依次排列（追加到队尾）。
     *  右侧贴边 24px、顶部对齐；队列放不下时整列上移保证最新点击的便签可见。置顶 + 短暂高亮。 */
    const focusNote = useCallback(
      (noteId: string) => {
        const note = notesRef.current.find((n) => n.id === noteId);
        if (!note) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = note.width || NOTE_WIDTH;
        const h = note.height || NOTE_HEIGHT;
        const RIGHT_MARGIN = 24;
        const TOP_MARGIN = 24;
        const GAP = 16;
        // 队列维护：已在队列则移到队尾（最近点击排最下），否则追加
        const q = focusQueueRef.current.filter((id) => id !== noteId);
        q.push(noteId);
        focusQueueRef.current = q;
        // 右侧纵向排列：x 贴右缘 24px；y 贴顶自上而下，列放不下时整列上移使最后一张底部可见
        const nx = Math.max(RIGHT_MARGIN, vw - RIGHT_MARGIN - w);
        const topY = Math.max(TOP_MARGIN, vh - TOP_MARGIN - h - (q.length - 1) * (h + GAP));
        const topZ = notesRef.current.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        const updates = q.map((id, index) => {
          const n = notesRef.current.find((x) => x.id === id);
          return n ? { id, x: nx, y: topY + index * (h + GAP), z: topZ + 1 } : null;
        }).filter((u): u is { id: string; x: number; y: number; z: number } => !!u);
        setNotes((prev) =>
          prev.map((n) => {
            const u = updates.find((x) => x.id === n.id);
            return u ? { ...n, ...u } : n;
          }),
        );
        for (const u of updates) saveNote(u.id, { x: u.x, y: u.y, z: u.z });
        // 落地高亮：品牌紫脉冲环，让用户一眼看到便签出现的位置
        setFlashNoteId(noteId);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          setFlashNoteId((cur) => (cur === noteId ? null : cur));
        }, 1250);
      },
      [saveNote],
    );
    useEffect(() => {
      focusNoteRef.current = focusNote;
    }, [focusNote]);

    /** 一键排列全部便签：按创建时间正序，从上到下堆叠在画布右侧。
     *  顶部/底部各留 24px 边距；竖向放不下时自动压缩行距（最小 2px），仍放不下则从顶部溢出。全部置顶。 */
    const focusAllNotes = useCallback(() => {
      const all = [...notesRef.current].sort((a, b) =>
        (a.createdAt || '').localeCompare(b.createdAt || ''),
      );
      if (all.length === 0) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const RIGHT_MARGIN = 24;
      const V_MARGIN = 24;
      const GAP = 16;
      const MIN_GAP = 2;
      const items = all.map((n) => ({
        id: n.id,
        w: n.width || NOTE_WIDTH,
        h: n.height || NOTE_HEIGHT,
      }));
      const availH = vh - V_MARGIN * 2;
      const sumH = items.reduce((s, it) => s + it.h, 0);
      // 放不下自动压缩行距（最小 2px）；仍放不下则按顶部对齐自然溢出
      let gap = GAP;
      if (items.length > 1) {
        const fitGap = (availH - sumH) / (items.length - 1);
        gap = Math.max(MIN_GAP, Math.min(GAP, fitGap));
      }
      const topZ = notesRef.current.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
      const updates: { id: string; x: number; y: number; z: number }[] = [];
      let y = V_MARGIN;
      for (const it of items) {
        const x = Math.max(RIGHT_MARGIN, vw - RIGHT_MARGIN - it.w);
        updates.push({ id: it.id, x, y, z: topZ + 1 });
        y += it.h + gap;
      }
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      setNotes((prev) =>
        prev.map((n) => {
          const u = updates.find((x) => x.id === n.id);
          return u ? { ...n, ...u } : n;
        }),
      );
      for (const u of updates) saveNote(u.id, { x: u.x, y: u.y, z: u.z });
    }, [saveNote]);

    useImperativeHandle(ref, () => ({
      createNote,
      focusNote,
      focusAllNotes,
      deactivateNote: () => setActivatedNoteId(null),
    }), [createNote, focusNote, focusAllNotes]);

    /** 删除便签 */
    const deleteNote = useCallback((id: string) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      fetch('/api/sticky-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', project_id: pid, id }),
      }).catch(() => {});
      setNotes((prev) => prev.filter((n) => n.id !== id));
    }, []);

    /* ── 拖拽（标题栏作为手柄，移动阈值 4px）── */

    const onTitleBarPointerDown = useCallback((e: React.PointerEvent, note: StickyNote) => {
      e.stopPropagation();
      dragRef.current = {
        id: note.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        noteX: note.x,
        noteY: note.y,
        lastX: note.x,
        lastY: note.y,
        moved: false,
      };
    }, []);

    const onTitleBarPointerMove = useCallback(
      (e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.startClientX;
        const dy = e.clientY - d.startClientY;
        if (!d.moved) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          d.moved = true;
          setDraggingId(d.id);
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        }
        const nx = d.noteX + dx;
        const ny = d.noteY + dy;
        d.lastX = nx;
        d.lastY = ny;
        // rAF 合并：拖拽期间每帧最多一次 setNotes，避免高频 pointermove 全量重渲染卡顿
        dragPendingRef.current = { id: d.id, x: nx, y: ny };
        if (dragRafRef.current == null) {
          dragRafRef.current = requestAnimationFrame(() => {
            dragRafRef.current = null;
            const p = dragPendingRef.current;
            dragPendingRef.current = null;
            if (!p) return;
            setNotes((prev) =>
              prev.map((n) => (n.id === p.id ? { ...n, x: p.x, y: p.y } : n)),
            );
          });
        }
      },
      [],
    );

    const onTitleBarPointerUp = useCallback(
      (e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        dragRef.current = null;
        if (dragRafRef.current != null) {
          cancelAnimationFrame(dragRafRef.current);
          dragRafRef.current = null;
          dragPendingRef.current = null;
        }
        if (d.moved) {
          setDraggingId(null);
          saveNote(d.id, { x: d.lastX, y: d.lastY });
        }
      },
      [saveNote],
    );

    /* ── Resize ── */

    const onResizePointerDown = useCallback((e: React.PointerEvent, note: StickyNote) => {
      e.preventDefault();
      e.stopPropagation();
      const w = note.width || NOTE_WIDTH;
      const h = note.height || NOTE_HEIGHT;
      resizeRef.current = {
        id: note.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startW: w,
        startH: h,
        lastW: w,
        lastH: h,
      };
      setResizingId(note.id);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }, []);

    const onResizePointerMove = useCallback(
      (e: React.PointerEvent) => {
        const r = resizeRef.current;
        if (!r) return;
        const nw = Math.max(MIN_W, r.startW + (e.clientX - r.startClientX));
        const nh = Math.max(MIN_H, r.startH + (e.clientY - r.startClientY));
        r.lastW = nw;
        r.lastH = nh;
        // rAF 合并：resize 期间每帧最多一次 setNotes
        resizePendingRef.current = { id: r.id, w: nw, h: nh };
        if (resizeRafRef.current == null) {
          resizeRafRef.current = requestAnimationFrame(() => {
            resizeRafRef.current = null;
            const p = resizePendingRef.current;
            resizePendingRef.current = null;
            if (!p) return;
            setNotes((prev) =>
              prev.map((n) => (n.id === p.id ? { ...n, width: p.w, height: p.h } : n)),
            );
          });
        }
      },
      [],
    );

    const onResizePointerUp = useCallback(() => {
      const r = resizeRef.current;
      if (!r) return;
      resizeRef.current = null;
      if (resizeRafRef.current != null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
        resizePendingRef.current = null;
      }
      setResizingId(null);
      saveNote(r.id, { width: r.lastW, height: r.lastH });
    }, [saveNote]);

    /* ── 主标题：默认只读 span，点击编辑按钮进入 input，失焦/Enter 提交 ── */

    const onTitleInput = useCallback(
      (noteId: string, value: string) => {
        setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, title: value } : n)));
      },
      [],
    );

    const commitTitle = useCallback(
      (noteId: string) => {
        const note = notesRef.current.find((n) => n.id === noteId);
        const value = (note?.title || '').trim() || 'Untitled';
        if (note && note.title !== value) {
          setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, title: value } : n)));
        }
        saveNote(noteId, { title: value });
        setEditingTitleId((cur) => (cur === noteId ? null : cur));
        if (titleSaveTimerRef.current) { clearTimeout(titleSaveTimerRef.current); titleSaveTimerRef.current = null; }
      },
      [saveNote],
    );

    /* ── 内容区统一防抖保存（buildPatch 接收最新 note，避免闭包过期）── */

    const debounceSaveContent = useCallback(
      (noteId: string, buildPatch: (note: StickyNote) => Partial<StickyNote>) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        setNotes((prev) =>
          prev.map((n) => (n.id === noteId ? { ...n, ...buildPatch(n) } : n)),
        );
        saveTimerRef.current = setTimeout(() => {
          const note = notesRef.current.find((n) => n.id === noteId);
          if (note) saveNote(noteId, buildPatch(note));
        }, 700);
      },
      [saveNote],
    );

    /** 行文本编辑 → 仅更新 content */
    const onTodoTextChange = useCallback(
      (noteId: string, index: number, newText: string) => {
        debounceSaveContent(noteId, (note) => {
          const { pages, activePageId } = hydratePages(note);
          const p = pages.find((x) => x.id === activePageId)!;
          const lines = parseTodoLines(p.content);
          while (lines.length <= index) lines.push({ done: false, text: '' });
          lines[index].text = newText;
          const content = serializeTodoLines(lines);
          const pages2 = pages.map((x) =>
            x.id === activePageId ? { ...x, content } : x,
          );
          return { pages: pages2, activePageId };
        });
      },
      [debounceSaveContent],
    );

    /** 新增一行（Enter） */
    const addTodoLine = useCallback(
      (noteId: string, afterIndex: number): number => {
        const note = notesRef.current.find((n) => n.id === noteId);
        if (!note) return afterIndex;
        const { pages, activePageId } = hydratePages(note);
        const p = pages.find((x) => x.id === activePageId)!;
        const lines = parseTodoLines(p.content);
        lines.splice(afterIndex + 1, 0, { done: false, text: '' });
        const content = serializeTodoLines(lines);
        const cal = Array.isArray(p.lineCalendared) ? [...p.lineCalendared] : undefined;
        if (cal) cal.splice(afterIndex + 1, 0, false);
        const evIds = Array.isArray(p.lineEventIds) ? p.lineEventIds.map((x) => [...x]) : undefined;
        if (evIds) evIds.splice(afterIndex + 1, 0, []);
        const pages2 = pages.map((x) =>
          x.id === activePageId
            ? { ...x, content, ...(cal ? { lineCalendared: cal } : {}), ...(evIds ? { lineEventIds: evIds } : {}) }
            : x,
        );
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, pages: pages2, activePageId } : n)));
        setContentRev((r) => r + 1);
        saveNote(noteId, { pages: pages2, activePageId });
        return afterIndex + 1;
      },
      [saveNote],
    );

    /** C 按钮提交：新增开庭待办行（自动入日历由服务端 reconcile 完成） */
    const submitCourt = useCallback(() => {
      const noteId = courtNoteId;
      const date = courtDate.trim();
      const name = courtName.trim();
      if (!noteId || !date || !name) return;
      const text = `${date} 在${name}的第${courtRoom.trim()}法庭开庭。地址：${courtAddr.trim()}`;
      const note = notesRef.current.find((n) => n.id === noteId);
      if (!note) return;
      const { pages, activePageId } = hydratePages(note);
      const p = pages.find((x) => x.id === activePageId);
      if (!p) return;
      const lines = parseTodoLines(p.content);
      while (lines.length > 0 && !lines[lines.length - 1].text.trim()) lines.pop();
      lines.push({ done: false, text });
      const content = serializeTodoLines(lines);
      const cal = Array.isArray(p.lineCalendared) ? [...p.lineCalendared] : [];
      while (cal.length < lines.length) cal.push(false);
      const evIds = Array.isArray(p.lineEventIds) ? p.lineEventIds.map((x) => [...x]) : [];
      while (evIds.length < lines.length) evIds.push([]);
      const pages2 = pages.map((x) =>
        x.id === activePageId ? { ...x, content, lineCalendared: cal, lineEventIds: evIds } : x,
      );
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, pages: pages2, activePageId } : n)));
      setContentRev((r) => r + 1);
      // 自动入日历：服务端 update reconcile 会为该新行建事件并回写 lineEventIds（见 saveNote adopt）
      saveNote(noteId, { pages: pages2, activePageId });
      setCourtOpen(false);
      setCourtDate(''); setCourtName(''); setCourtRoom(''); setCourtAddr('');
    }, [courtNoteId, courtDate, courtName, courtRoom, courtAddr, saveNote]);

    /** 删除空行（Backspace） */
    const removeTodoLine = useCallback(
      (noteId: string, index: number): boolean => {
        const note = notesRef.current.find((n) => n.id === noteId);
        if (!note) return false;
        const { pages, activePageId } = hydratePages(note);
        const p = pages.find((x) => x.id === activePageId)!;
        const lines = parseTodoLines(p.content);
        if (lines.length <= 1) return false;
        lines.splice(index, 1);
        const cal = Array.isArray(p.lineCalendared) ? [...p.lineCalendared] : undefined;
        if (cal) cal.splice(index, 1);
        const evIds = Array.isArray(p.lineEventIds) ? p.lineEventIds.map((x) => [...x]) : undefined;
        if (evIds) evIds.splice(index, 1);
        const pages2 = pages.map((x) =>
          x.id === activePageId
            ? { ...x, content: serializeTodoLines(lines), ...(cal ? { lineCalendared: cal } : {}), ...(evIds ? { lineEventIds: evIds } : {}) }
            : x,
        );
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, pages: pages2, activePageId } : n)));
        setContentRev((r) => r + 1);
        saveNote(noteId, { pages: pages2, activePageId });
        return true;
      },
      [saveNote],
    );

    /** 勾选：切换 done → 移到末尾；服务端 reconcile 会同步日历事件状态（status done/scheduled） */
    const toggleTodo = useCallback(
      (noteId: string, index: number) => {
        const note = notesRef.current.find((n) => n.id === noteId);
        if (!note) return;
        const { pages, activePageId } = hydratePages(note);
        const p = pages.find((x) => x.id === activePageId)!;
        const lines = parseTodoLines(p.content);
        if (index >= lines.length) return;
        const wasDone = lines[index].done;
        const nowDone = !wasDone;
        lines[index].done = nowDone;
        const [moved] = lines.splice(index, 1);
        lines.push(moved);
        const cal = Array.isArray(p.lineCalendared) ? [...p.lineCalendared] : undefined;
        if (cal && index < cal.length) {
          const [flag] = cal.splice(index, 1);
          cal.push(flag);
        }
        const evIds = Array.isArray(p.lineEventIds) ? p.lineEventIds.map((x) => [...x]) : undefined;
        if (evIds && index < evIds.length) {
          const [entry] = evIds.splice(index, 1);
          evIds.push(entry);
        }
        const content = serializeTodoLines(lines);
        const pages2 = pages.map((x) =>
          x.id === activePageId
            ? { ...x, content, ...(cal ? { lineCalendared: cal } : {}), ...(evIds ? { lineEventIds: evIds } : {}) }
            : x,
        );
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, pages: pages2, activePageId } : n)));
        setContentRev((r) => r + 1);
        saveNote(noteId, { pages: pages2, activePageId });
      },
      [saveNote],
    );

    /** Enter 后聚焦下一行 */
    const handleEnter = useCallback(
      (noteId: string, i: number) => {
        const newIndex = addTodoLine(noteId, i);
        requestAnimationFrame(() => {
          const container = linesContainerRef.current.get(noteId);
          if (!container) return;
          const els = container.querySelectorAll('[contenteditable="true"]');
          const target = els[newIndex] as HTMLElement | undefined;
          if (!target) return;
          target.focus();
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        });
      },
      [addTodoLine],
    );

    /** Backspace 删除空行后聚焦上一行 */
    const handleBackspace = useCallback(
      (noteId: string, i: number): boolean => {
        const removed = removeTodoLine(noteId, i);
        if (removed) {
          requestAnimationFrame(() => {
            const container = linesContainerRef.current.get(noteId);
            if (!container) return;
            const els = container.querySelectorAll('[contenteditable="true"]');
            const target = els[Math.max(0, i - 1)] as HTMLElement | undefined;
            if (!target) return;
            target.focus();
            const range = document.createRange();
            range.selectNodeContents(target);
            range.collapse(false);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          });
        }
        return removed;
      },
      [removeTodoLine],
    );

    /** 切换分页 */
    const switchPage = useCallback(
      (noteId: string, targetPageId: string) => {
        const note = notesRef.current.find((n) => n.id === noteId);
        if (!note) return;
        const { pages } = hydratePages(note);
        if (!pages.some((p) => p.id === targetPageId)) return;
        if (note.activePageId === targetPageId) return;
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        const patch: Partial<StickyNote> = { activePageId: targetPageId };
        setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, ...patch } : n)));
        setContentRev((r) => r + 1);
        saveNote(noteId, patch);
      },
      [saveNote],
    );

    /** 新建分页 */
    const addPage = useCallback(
      (noteId: string) => {
        const note = notesRef.current.find((n) => n.id === noteId);
        if (!note) return;
        const { pages } = hydratePages(note);
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        const newP: StickyNotePage = {
          id: newPageId(),
          title: `P${pages.length + 1}`,
          content: '- [ ] ',
          kind: 'todo',
        };
        const pages2 = [...pages, newP];
        const patch: Partial<StickyNote> = { pages: pages2, activePageId: newP.id };
        setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, ...patch } : n)));
        setContentRev((r) => r + 1);
        saveNote(noteId, patch);
      },
      [saveNote],
    );

    // 已废弃：kind 一旦创建不可切换；切换入口已移至新建时的选择器。保留函数占位防止调用链缺失。
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _togglePageKindUnused = (_noteId: string) => {};

    /** 删除分页 */
    const deletePage = useCallback(
      (note: StickyNote, pageId: string) => {
        const { pages, activePageId } = hydratePages(note);
        if (pages.length <= 1) return;
        const cur = pages.find((p) => p.id === pageId);
        if (!cur) return;
        if (!window.confirm(`Delete page "${cur.title}"?`)) return;
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        const pages2 = pages.filter((p) => p.id !== pageId);
        const nextActive = pageId === activePageId ? pages2[0].id : activePageId;
        const patch: Partial<StickyNote> = { pages: pages2, activePageId: nextActive };
        setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, ...patch } : n)));
        setContentRev((r) => r + 1);
        saveNote(note.id, patch);
      },
      [saveNote],
    );

    /** 右键侧边栏 page → 进入重命名 */
    const startRenamePage = useCallback((note: StickyNote, pageId: string) => {
      const { pages } = hydratePages(note);
      const p = pages.find((x) => x.id === pageId);
      setRenamingPageId(pageId);
      setPageRenameDraft(p?.title || '');
    }, []);

    /** 提交 page 重命名 */
    const commitRenamePage = useCallback(
      (note: StickyNote, pageId: string, value: string) => {
        const trimmed = value.trim();
        const { pages } = hydratePages(note);
        const idx = pages.findIndex((p) => p.id === pageId);
        const finalTitle = trimmed || `P${idx + 1}`;
        const pages2 = pages.map((p) => (p.id === pageId ? { ...p, title: finalTitle } : p));
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, pages: pages2 } : n)));
        saveNote(note.id, { pages: pages2 });
        setRenamingPageId(null);
      },
      [saveNote],
    );

    /** 改颜色 */
    const changeColor = useCallback(
      (note: StickyNote, color: string) => {
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, color } : n)));
        saveNote(note.id, { color });
      },
      [saveNote],
    );

    /** 切换侧栏折叠/展开 */
    const toggleSidebar = useCallback(
      (note: StickyNote) => {
        const next = !getSidebarCollapsed(note);
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        setNotes((prev) =>
          prev.map((n) => (n.id === note.id ? { ...n, sidebarCollapsed: next } : n)),
        );
        saveNote(note.id, { sidebarCollapsed: next });
      },
      [saveNote],
    );

    /** 删除便签（确认弹窗） */
    const confirmDeleteNote = useCallback(
      (noteId: string) => {
        if (!window.confirm('Delete this sticky note?')) return;
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        deleteNote(noteId);
      },
      [deleteNote],
    );

    /** 右键置顶：层级设为当前最高 + 1 并持久化 */
    const bringToFront = useCallback(
      (noteId: string) => {
        const topZ = notesRef.current.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
        const nextZ = topZ + 1;
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, z: nextZ } : n)));
        saveNote(noteId, { z: nextZ });
      },
      [saveNote],
    );

    /** 打开"选择模板"弹层时刷新一次全局模板列表 */
    const openApplyTemplate = useCallback((noteId: string) => {
      void loadSettings().then((s) => setTemplates(s.stickyTemplates ?? []));
      setTemplatePopover((prev) =>
        prev?.noteId === noteId && prev.mode === 'apply' ? null : { noteId, mode: 'apply' },
      );
    }, []);

    /** 保存当前页待办为全局模板：全部条目统一为未勾选；同名模板覆盖更新 */
    const handleSaveTemplate = useCallback(
      (noteId: string) => {
        const name = templateNameDraft.trim();
        if (!name) return;
        const note = notesRef.current.find((n) => n.id === noteId);
        if (!note) return;
        const { pages, activePageId } = hydratePages(note);
        const p = pages.find((x) => x.id === activePageId);
        if (!p) return;
        const lines = parseTodoLines(p.content)
          .map((l) => l.text.trim())
          .filter((t) => t.length > 0);
        if (lines.length === 0) return;
        const tpl: StickyTodoTemplate = {
          id: `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name,
          lines,
          updatedAt: new Date().toISOString(),
        };
        void (async () => {
          const s = await loadSettings();
          const list = [...(s.stickyTemplates ?? [])].filter((t) => t.name !== name);
          list.push(tpl);
          await saveSettings({ ...s, stickyTemplates: list });
          setTemplates(list);
          setTemplatePopover(null);
        })();
      },
      [templateNameDraft],
    );

    /** 应用全局模板：替换当前页内容（全部转为未勾选） */
    const handleApplyTemplate = useCallback(
      (noteId: string, tpl: StickyTodoTemplate) => {
        const note = notesRef.current.find((n) => n.id === noteId);
        if (!note) return;
        const { pages, activePageId } = hydratePages(note);
        const content = tpl.lines.length > 0 ? tpl.lines.map((t) => `- [ ] ${t}`).join('\n') : '- [ ] ';
        const pages2 = pages.map((x) => (x.id === activePageId ? { ...x, content } : x));
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
        setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, pages: pages2, activePageId } : n)));
        setContentRev((r) => r + 1);
        saveNote(noteId, { pages: pages2, activePageId });
        setTemplatePopover(null);
      },
      [saveNote],
    );

    /** 删除全局模板：从 settings.json 移除并同步本地列表 */
    const handleDeleteTemplate = useCallback((tpl: StickyTodoTemplate) => {
      if (!window.confirm(`删除模板「${tpl.name}」？`)) return;
      void (async () => {
        const s = await loadSettings();
        const list = (s.stickyTemplates ?? []).filter((t) => t.id !== tpl.id);
        await saveSettings({ ...s, stickyTemplates: list });
        setTemplates(list);
      })();
    }, []);

    // 渲染排序：未完成在前，全部完成的沉底
    const sortedNotes = useMemo(() => {
      return [...notes].sort((a, b) => {
        const aDone = isAllDone(getActiveContent(a));
        const bDone = isAllDone(getActiveContent(b));
        if (aDone !== bDone) return aDone ? 1 : -1;
        return 0;
      });
    }, [notes]);

    const topZ = notes.reduce((m, n) => Math.max(m, n.z ?? 0), 0);

    return (
      <>
        {/* 便签层容器：默认 z-[3]（低于节点 z-4），激活便签时临时上浮 z-[40]（高于节点，仅画布内） */}
        <div className={`pointer-events-none absolute inset-0 ${activatedNoteId ? 'z-[40]' : 'z-[3]'}`} data-canvas-ui="overlay">
        {sortedNotes.map((note) => {
          const sx = note.x;
          const sy = note.y;
          const isDragging = draggingId === note.id;
          const isResizing = resizingId === note.id;
          const { pages, activePageId } = hydratePages(note);
          const activePage = pages.find((x) => x.id === activePageId) ?? pages[0];
          const activeContent = activePage.content;
          const allDone = isAllDone(activeContent);
          const todoLines = parseTodoLines(activeContent);
          const nw = note.width || NOTE_WIDTH;
          const nh = note.height || NOTE_HEIGHT;
          const textColor = COLOR_TEXT[note.color] || COLOR_TEXT.yellow;
          const accent = COLOR_ACCENT[note.color] || COLOR_ACCENT.yellow;
          const borderColor = COLOR_BORDER[note.color] || COLOR_BORDER.yellow;
          const sidebarCollapsed = getSidebarCollapsed(note);
          return (
            <div
              key={note.id}
              data-sticky-note
              className="pointer-events-auto absolute select-none"
              onPointerDownCapture={() => setActivatedNoteId(note.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                bringToFront(note.id);
              }}
              style={{
                // 屏幕坐标固定：直接用 translate 定位，不乘 zoom、不加 viewport 偏移
                left: 0,
                top: 0,
                width: nw,
                transform: `translate(${sx}px, ${sy}px)`,
                transformOrigin: 'top left',
                zIndex: activatedNoteId === note.id || isDragging || isResizing ? topZ + 10 : (note.z ?? 0) + 1,
                // 一键找回落地高亮：品牌紫脉冲环
                ...(flashNoteId === note.id
                  ? { animation: 'sticky-note-flash 1.2s ease-out' }
                  : null),
              }}
            >
              <div
                className="relative flex rounded-[12px] transition-shadow"
                style={{
                  background: COLOR_BG[note.color] || COLOR_BG.yellow,
                  border: `0.5px solid ${borderColor}`,
                  boxShadow: isDragging
                    ? '0 2px 4px rgba(23,23,23,.08), 0 12px 28px rgba(23,23,23,.16), 0 28px 56px rgba(75,63,227,.10)'
                    : allDone
                      ? '0 1px 2px rgba(23,23,23,.04), 0 2px 8px rgba(23,23,23,.06)'
                      : '0 1px 2px rgba(23,23,23,.05), 0 6px 16px rgba(23,23,23,.08), 0 18px 36px rgba(75,63,227,.06)',
                  opacity: allDone ? 0.72 : 1,
                  height: nh,
                  overflow: 'hidden',
                }}
              >
                {/* 顶部受光高光（渲染在最底层：只提亮纸面底色，不覆盖文字，避免发白/模糊） */}
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    borderRadius: 12,
                    background:
                      'linear-gradient(180deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,0) 42%)',
                  }}
                />
                {/* Pages sidebar — collapsible, collapsed by default */}
                {!sidebarCollapsed && (
                <div
                  className="flex flex-col gap-[3px] border-r py-[8px] px-[6px]"
                  style={{
                    width: SIDEBAR_W,
                    flex: `0 0 ${SIDEBAR_W}px`,
                    borderColor: 'rgba(23,23,23,.1)',
                    background: 'rgba(0,0,0,.02)',
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between px-[2px] pb-[4px]">
                    <span
                      className="text-11 font-semibold tracking-tight"
                      style={{ color: textColor, opacity: 0.7 }}
                    >
                      Pages
                    </span>
                    <button
                      type="button"
                      title="New page"
                      onClick={(e) => { e.stopPropagation(); addPage(note.id); }}
                      className="flex h-4 w-4 items-center justify-center rounded transition-colors hover:bg-black/10"
                      style={{ color: textColor, opacity: 0.7 }}
                    >
                      <Plus size={11} strokeWidth={2.2} />
                    </button>
                  </div>
                  <div
                    className="flex flex-1 flex-col gap-[3px] overflow-y-auto pr-[1px]"
                    style={{ scrollbarWidth: 'thin' }}
                  >
                    {pages.map((p, idx) => {
                      const active = p.id === activePageId;
                      const isRenaming = renamingPageId === p.id;
                      return (
                        <div
                          key={p.id}
                          className="group relative cursor-pointer rounded-md transition-colors"
                          style={{
                            background: active ? `${accent}22` : 'transparent',
                          }}
                          onClick={(e) => { e.stopPropagation(); switchPage(note.id, p.id); }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            startRenamePage(note, p.id);
                          }}
                        >
                          {isRenaming ? (
                            <input
                              autoFocus
                              value={pageRenameDraft}
                              onChange={(e) => setPageRenameDraft(e.target.value)}
                              onBlur={() => commitRenamePage(note, p.id, pageRenameDraft)}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') commitRenamePage(note, p.id, pageRenameDraft);
                                if (e.key === 'Escape') setRenamingPageId(null);
                              }}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => e.stopPropagation()}
                              className="w-full bg-transparent px-[5px] py-[4px] text-11.5 leading-[1.3] outline-none"
                              style={{
                                color: textColor,
                                fontWeight: 600,
                                background: 'rgba(255,255,255,.6)',
                                borderRadius: 4,
                              }}
                            />
                          ) : (
                            <span
                              className="block w-full truncate px-[5px] py-[4px] text-11.5 leading-[1.3]"
                              style={{
                                color: textColor,
                                fontWeight: active ? 600 : 400,
                                opacity: active ? 1 : 0.8,
                                paddingRight: pages.length > 1 ? 20 : 5,
                              }}
                            >
                              {p.title?.trim() || `P${idx + 1}`}
                            </span>
                          )}
                          {!isRenaming && pages.length > 1 && (
                            <button
                              type="button"
                              title="Delete page"
                              onClick={(e) => { e.stopPropagation(); deletePage(note, p.id); }}
                              onPointerDown={(e) => e.stopPropagation()}
                              className="absolute right-[3px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded opacity-0 transition-opacity hover:bg-black/10 group-hover:opacity-100"
                              style={{ color: textColor }}
                            >
                              <X size={10.5} strokeWidth={2} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* 颜色色块：底部从左往右均匀平铺 */}
                  <div
                    className="mt-1 flex items-center gap-1 border-t px-[2px] pt-1.5"
                    style={{ borderColor: 'rgba(23,23,23,.1)' }}
                  >
                    {NOTE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={COLOR_LABELS[c] || c}
                        onClick={(e) => { e.stopPropagation(); changeColor(note, c); }}
                        className="aspect-square min-w-0 flex-1 rounded-full border transition-transform hover:scale-110"
                        style={{
                          background: NOTE_COLOR_SWATCH[c],
                          borderColor: note.color === c ? accent : 'rgba(23,23,23,.18)',
                          boxShadow: note.color === c ? `0 0 0 1.5px ${accent}` : undefined,
                        }}
                      />
                    ))}
                  </div>
                </div>
                )}

                {/* Content pane */}
                <div
                  className="relative flex flex-1 flex-col"
                  style={{ padding: '10px 12px 12px', minWidth: 0 }}
                >
                  {/* Title bar — drag handle */}
                  <div
                    className="group mb-[8px] flex items-center gap-1 rounded-md border-b px-1 py-[5px]"
                    style={{
                      borderColor: 'rgba(23,23,23,.08)',
                      background: `color-mix(in srgb, ${accent} 9%, transparent)`,
                      cursor: isDragging ? 'grabbing' : 'grab',
                    }}
                    onPointerDown={(e) => onTitleBarPointerDown(e, note)}
                    onPointerMove={onTitleBarPointerMove}
                    onPointerUp={onTitleBarPointerUp}
                  >
                    {/* 视图标签：待办便签 = TODO（点击切换侧边栏页列） */}
                    <button
                      type="button"
                      title={sidebarCollapsed ? 'Show pages' : 'Hide pages'}
                      onClick={() => toggleSidebar(note)}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="flex shrink-0 cursor-pointer items-center rounded-full px-[7px] py-[2px] text-10 font-semibold tracking-wide select-none transition-opacity hover:opacity-80"
                      style={{
                        backgroundColor: 'rgba(13,88,46,.16)',
                        color: 'rgba(13,88,46,.92)',
                      }}
                    >
                      TODO
                    </button>
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      {editingTitleId === note.id ? (
                        <input
                          autoFocus
                          value={note.title || ''}
                          onChange={(e) => onTitleInput(note.id, e.target.value)}
                          onBlur={() => commitTitle(note.id)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitTitle(note.id);
                            if (e.key === 'Escape') setEditingTitleId(null);
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="min-w-0 flex-1 bg-transparent outline-none"
                          style={{ color: textColor, fontSize: '0.866667rem', fontWeight: 600, letterSpacing: '-0.01em' }}
                        />
                      ) : (
                        <span
                          className="min-w-0 flex-1 truncate select-none"
                          style={{ color: textColor, fontSize: '0.866667rem', fontWeight: 600, letterSpacing: '-0.01em' }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditingTitleId(note.id);
                          }}
                        >
                          {note.title || 'Untitled'}
                        </span>
                      )}
                      {/* 同步状态：saving（保存中）/ saved（已保存，短暂显示后隐藏）/ Save failed（失败保留，挨着标题右侧） */}
                      {saveStates[note.id] && (
                        <span
                          className="shrink-0 select-none"
                          title={saveStates[note.id] === 'error' ? 'Save failed — changes may not be persisted' : undefined}
                          style={{
                            fontSize: '0.6rem',
                            lineHeight: 1.2,
                            fontStyle: saveStates[note.id] === 'syncing' ? 'italic' : 'normal',
                            color:
                              saveStates[note.id] === 'error'
                                ? '#c62828'
                                : saveStates[note.id] === 'saved'
                                  ? '#1e7d34'
                                  : textColor,
                            opacity: saveStates[note.id] === 'syncing' ? 0.6 : 0.9,
                          }}
                        >
                          {saveStates[note.id] === 'syncing'
                            ? 'saving'
                            : saveStates[note.id] === 'saved'
                              ? 'saved'
                              : 'Save failed'}
                        </span>
                      )}
                    </div>
                    <div
                      className="ml-1 flex items-center gap-1"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {/* Court 开庭录入 */}
                      <button
                        type="button"
                        title="Court hearing (C)"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCourtNoteId(note.id);
                          setCourtOpen(true);
                        }}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded border text-9 font-bold transition-colors hover:bg-black/10"
                        style={{ color: 'rgba(23,23,23,.55)', borderColor: 'rgba(23,23,23,.25)' }}
                      >
                        C
                      </button>
                      {/* 选择模板（仅图标，弹层向下展开，内含存为模板入口） */}
                      <>
                        <div className="relative">
                            <button
                              type="button"
                              title="从全局模板选择，替换当前待办清单"
                              onClick={(e) => {
                                e.stopPropagation();
                                openApplyTemplate(note.id);
                              }}
                              className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-black/10"
                              style={{ color: 'rgba(23,23,23,.55)' }}
                            >
                              <ClipboardList size={12} strokeWidth={2} />
                            </button>
                            {/* 选择模板弹层：全局模板列表（向下展开，替换应用） */}
                            {templatePopover?.noteId === note.id && templatePopover.mode === 'apply' && (
                              <div
                                className="absolute right-0 top-full z-20 mt-1 w-60 rounded-lg border bg-white shadow-xl"
                                style={{ borderColor: 'rgba(23,23,23,.15)' }}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {/* 存为模板入口 */}
                                <div className="border-b p-1.5" style={{ borderColor: 'rgba(23,23,23,.1)' }}>
                                  <input
                                    value={templateNameDraft}
                                    onChange={(e) => setTemplateNameDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') handleSaveTemplate(note.id);
                                      if (e.key === 'Escape') setTemplatePopover(null);
                                    }}
                                    placeholder="存为模板…"
                                    className="w-full rounded border px-2 py-1 text-xs outline-none"
                                    style={{ borderColor: 'rgba(23,23,23,.2)', color: '#333' }}
                                  />
                                  <div className="mt-1 flex justify-end">
                                    <button
                                      type="button"
                                      onClick={() => handleSaveTemplate(note.id)}
                                      disabled={!templateNameDraft.trim()}
                                      className="flex items-center gap-1 rounded px-2 py-1 text-11 font-medium transition-opacity disabled:opacity-40"
                                      style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
                                    >
                                      <Check size={11} />
                                      保存
                                    </button>
                                  </div>
                                </div>
                                <div className="max-h-52 overflow-y-auto p-1">
                                {templates.length === 0 ? (
                                  <p className="px-2 py-3 text-center text-11 leading-relaxed" style={{ color: '#999' }}>
                                    暂无模板
                                  </p>
                                ) : (
                                  templates.map((tpl) => (
                                    <div
                                      key={tpl.id}
                                      className="group flex w-full items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors hover:bg-black/5"
                                    >
                                      <button
                                        type="button"
                                        onClick={() => handleApplyTemplate(note.id, tpl)}
                                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                        style={{ color: '#333' }}
                                      >
                                        <Layers size={11} className="shrink-0" style={{ color: '#888' }} />
                                        <span className="min-w-0 flex-1 truncate font-medium">{tpl.name}</span>
                                        <span className="shrink-0 text-10" style={{ color: '#999' }}>
                                          {tpl.lines.length} 条
                                        </span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(tpl); }}
                                        title="删除模板"
                                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-black/10 group-hover:opacity-100"
                                        style={{ color: '#999' }}
                                      >
                                        <X size={11} />
                                      </button>
                                    </div>
                                  ))
                                )}
                                </div>
                              </div>
                            )}
                          </div>
                        </>
                      <button
                        type="button"
                        title="Delete note"
                        onClick={() => confirmDeleteNote(note.id)}
                        className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-black/10"
                        style={{ color: 'rgba(23,23,23,.55)' }}
                      >
                        <X size={12} strokeWidth={2} />
                      </button>
                    </div>
                  </div>

                  {/* Lines — todo checklist rows */}
                  <div
                    ref={(el) => {
                      if (el) linesContainerRef.current.set(note.id, el);
                    }}
                    data-note-lines={note.id}
                    className="flex flex-1 flex-col gap-[7px] overflow-y-auto pr-[2px]"
                    style={{ scrollbarWidth: 'thin' }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {todoLines.map((line, i) => (
                      <TodoLineItem
                        key={`${note.id}:${activePageId}:${i}`}
                        text={line.text}
                        done={line.done}
                        color={textColor}
                        accent={accent}
                        rev={contentRev}
                        onInputText={(text) => onTodoTextChange(note.id, i, text)}
                        onEnter={() => handleEnter(note.id, i)}
                        onBackspaceEmpty={() => handleBackspace(note.id, i)}
                        onToggle={() => toggleTodo(note.id, i)}
                        calendared={isLineCalendared(activePage, i)}
                      />
                    ))}
                  </div>
                </div>

                {/* Resize handle */}
                <div
                  onPointerDown={(e) => onResizePointerDown(e, note)}
                  onPointerMove={onResizePointerMove}
                  onPointerUp={onResizePointerUp}
                  className="absolute bottom-0 right-0 flex h-[16px] w-[16px] cursor-nwse-resize items-end justify-end"
                  style={{ touchAction: 'none' }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" style={{ opacity: 0.35 }}>
                    <path d="M8 0L0 8M8 4L4 8" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                </div>
              </div>
            </div>
          );
        })}
      </div>
        {/* Court 开庭录入弹窗（全英文） */}
        {courtOpen && (
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center p-6"
            style={{ background: 'rgba(0,0,0,0.4)' }}
            onClick={() => setCourtOpen(false)}
          >
            <div
              className="w-[360px] max-w-full rounded-xl border p-4 shadow-2xl space-y-3"
              style={{ background: 'var(--paper, #fff)', borderColor: 'var(--border)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Court hearing</div>
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                <span className="w-20 shrink-0">Date</span>
                <input value={courtDate} onChange={(e) => setCourtDate(e.target.value)} placeholder="2026/8/30 9:00" className="min-w-0 flex-1 rounded border px-2 py-1.5 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
              </label>
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                <span className="w-20 shrink-0">Court</span>
                <input value={courtName} onChange={(e) => setCourtName(e.target.value)} placeholder="Court name" className="min-w-0 flex-1 rounded border px-2 py-1.5 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
              </label>
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                <span className="w-20 shrink-0">Courtroom</span>
                <input value={courtRoom} onChange={(e) => setCourtRoom(e.target.value)} placeholder="No." className="min-w-0 flex-1 rounded border px-2 py-1.5 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
              </label>
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                <span className="w-20 shrink-0">Address</span>
                <input value={courtAddr} onChange={(e) => setCourtAddr(e.target.value)} placeholder="Address" className="min-w-0 flex-1 rounded border px-2 py-1.5 text-xs outline-none" style={{ borderColor: 'var(--border)', color: 'var(--ink)', background: 'transparent' }} />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setCourtOpen(false)} className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)', background: 'var(--paper-hover, #f0f0f3)' }}>Cancel</button>
                <button type="button" onClick={submitCourt} disabled={!courtDate.trim() || !courtName.trim()} className="rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50" style={{ color: '#fff', background: 'var(--primary-strong, #5b48d8)' }}>OK</button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  },
);
