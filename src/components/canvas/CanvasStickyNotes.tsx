import { memo } from 'react';
import type { StickyNote, StickyNotePage } from '@/app/api/sticky-notes/route';
import { AlarmClock, Plus, Loader2, Check, AlertCircle } from 'lucide-react';

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

export const COLOR_BG: Record<string, string> = {
  yellow: '#FFF7D6',
  blue: '#DCEBFF',
  green: '#DFF3E7',
  pink: '#FFE4EF',
};
export const COLOR_TEXT: Record<string, string> = {
  yellow: '#43391C',
  blue: '#1E3458',
  green: '#1B4234',
  pink: '#4E2137',
};
// 同色系淡边框（0.5px 发丝级层次，替代"纯色纸面无边界"）
export const COLOR_BORDER: Record<string, string> = {
  yellow: 'rgba(168,132,32,.24)',
  blue: 'rgba(62,116,190,.24)',
  green: 'rgba(52,132,88,.24)',
  pink: 'rgba(196,96,138,.24)',
};
// 同色系强调色（勾选态 / active 高亮 / 圆点选中，8 位 hex 便于拼接透明度）
export const COLOR_ACCENT: Record<string, string> = {
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

/** 解析内容为待办行（不过滤空行，保留空行以便编辑） */
export type TodoLine = { done: boolean; text: string };

/** 该行是否已添加到日历（新数据 lineEventIds 非空；兼容旧 lineCalendared 布尔标记） */
export function isLineCalendared(page: StickyNotePage, index: number): boolean {
  return Boolean(page.lineEventIds?.[index]?.length) || page.lineCalendared?.[index] === true;
}
/** 便签落盘同步状态：syncing = 保存中 / saved = 已保存（短暂显示后复位）/ error = 保存失败（保留提示） */
export type NoteSaveState = 'syncing' | 'saved' | 'error';
export function parseTodoLines(content: string): TodoLine[] {
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
export function serializeTodoLines(lines: TodoLine[]): string {
  return lines.map((l) => `- [${l.done ? 'x' : ' '}] ${l.text}`).join('\n');
}

export function newPageId(): string {
  return `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 前端兼容升级：老数据 content → pages[0]，保证 pages、activePageId、kind 始终存在 */
export function hydratePages(note: StickyNote): { pages: StickyNotePage[]; activePageId: string } {
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
  const content = raw.trim().length === 0 ? '' : raw;
  const p: StickyNotePage = norm({
    id: newPageId(),
    title: 'P1',
    content,
  });
  return { pages: [p], activePageId: p.id };
}

/* ────────────────────────────────────────────────────────────
 * 空行归一化（客户端版，语义与 lib/sticky-todo 服务端版本一致）
 * 空行（纯空白 / `- [ ] `/`- [x] `）不是待办：保存前剔除并同步对齐行级日历元数据。
 * ──────────────────────────────────────────────────────────── */
const CLIENT_BLANK_ROW_RE = /^-\s*\[( |x)\]\s*$/;

/** 判定一行是否为"空待办行" */
export function isBlankTodoLine(raw: string): boolean {
  const t = raw.trim();
  return t.length === 0 || CLIENT_BLANK_ROW_RE.test(t);
}

/** 剔除全部页的空待办行，保持 lineCalendared / lineEventIds 与行序对齐 */
export function cleanTodoPages(pages: StickyNotePage[]): StickyNotePage[] {
  return pages.map((p) => {
    const rows = String(p.content ?? '').split('\n');
    const hasCal = Array.isArray(p.lineCalendared);
    const hasEv = Array.isArray(p.lineEventIds);
    const cal = hasCal ? p.lineCalendared!.map(Boolean) : [];
    const ev = hasEv
      ? p.lineEventIds!.map((x) => (Array.isArray(x) ? x.slice() : []))
      : [];
    const kept: string[] = [];
    const keptCal: boolean[] = [];
    const keptEv: string[][] = [];
    for (let i = 0; i < rows.length; i++) {
      if (isBlankTodoLine(rows[i])) continue;
      kept.push(rows[i]);
      if (hasCal) keptCal.push(cal[i] ?? false);
      if (hasEv) keptEv.push(ev[i] ?? []);
    }
    const out: StickyNotePage = { ...p, content: kept.join('\n') };
    if (hasCal) out.lineCalendared = keptCal;
    if (hasEv) out.lineEventIds = keptEv;
    return out;
  });
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
  /** 输入框失焦：宿主据此立即落盘并结算自动入日历 */
  onBlur?: () => void;
  onEnter: () => void;
  onBackspaceEmpty: () => boolean;
  onToggle: () => void;
  /** 该行是否已加入日历（与日历事件双向联动）→ 行尾显示只读闹钟标识 */
  calendared?: boolean;
  /** 手动「Add to calendar」：仅未入日历且未完成、宿主提供该能力时显示行尾按钮 */
  onAddToCalendar?: () => void;
  /** 手动加入日历的瞬时状态：busy=进行中 / done=成功 / error=失败（失败保留可重试） */
  addState?: 'busy' | 'done' | 'error' | null;
};

export const TodoLineItem = memo(
  function TodoLineItem({
    text,
    done,
    color,
    accent,
    onInputText,
    onBlur,
    onEnter,
    onBackspaceEmpty,
    onToggle,
    calendared,
    onAddToCalendar,
    addState,
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
          onBlur={onBlur}
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
        {/* 行尾：已入日历 → 只读闹钟；未入日历且有宿主支持 → 手动「Add to calendar」按钮 */}
        {calendared && addState !== 'busy' && (
          <span
            title="Added to calendar"
            className="mt-[3px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px]"
            style={{ color: '#1e7d34', opacity: 0.75 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <AlarmClock size={11} strokeWidth={2} />
          </span>
        )}
        {!calendared && !done && onAddToCalendar && (
          <button
            type="button"
            title={
              addState === 'error'
                ? 'Failed — click to retry'
                : addState === 'busy'
                  ? 'Adding…'
                  : 'Add to calendar'
            }
            disabled={addState === 'busy'}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (addState !== 'busy') onAddToCalendar();
            }}
            className={`mt-[3px] flex h-[15px] w-[15px] shrink-0 cursor-pointer items-center justify-center rounded-[4px] transition-colors hover:bg-black/10 ${
              addState === 'busy' || addState === 'error' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
            style={{
              color:
                addState === 'done'
                  ? '#1e7d34'
                  : addState === 'error'
                    ? '#c62828'
                    : 'rgba(23,23,23,.45)',
            }}
          >
            {addState === 'busy' ? (
              <Loader2 size={11} strokeWidth={2} className="animate-spin" />
            ) : addState === 'done' ? (
              <Check size={11} strokeWidth={2.4} />
            ) : addState === 'error' ? (
              <AlertCircle size={11} strokeWidth={2} />
            ) : (
              <Plus size={11} strokeWidth={2.4} />
            )}
          </button>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.rev === next.rev &&
    prev.done === next.done &&
    prev.color === next.color &&
    prev.accent === next.accent &&
    prev.calendared === next.calendared &&
    prev.addState === next.addState,
);
