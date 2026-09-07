/**
 * StickyTodoDock — 会话标题栏右侧的 Todo 便签 Dock（2026-09 布局重构后的便签主界面）
 *
 * 产品口径（用户拍板）：
 *  - 色块显示在会话标题栏右侧操作组、成果块（FileCheck）旁；每个色块 = 一张便签
 *  - 点击色块在标题栏下方展开"完整便签卡"（分页/模板/开庭/颜色全功能，见 NoteCardEditor）
 *  - 色块旁的图钉 = 固定：点亮后展开卡不随"点击别处"自动收起；熄灭则点击空白即收
 *  - 数据仍走 /api/sticky-notes（项目私有、每项目 ≤3、行级自动入日历 + lineEventIds 回填）
 *
 * 布局层说明：色块簇作为 fragment 渲染在 NodeCardHeader 的 rightActions 内；
 * 展开的便签卡以 portal（document.body + fixed）挂在标题栏正下方，避开节点 overflow 裁剪。
 *
 * AI 不可读语义保持不变：正文只经宿主工具/IPC 间接读写，本项目仅做 UI 呈现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, Pin, Check, Layers, ClipboardList } from 'lucide-react';
import type { StickyNote, StickyNotePage } from '@/app/api/sticky-notes/route';
import { Button } from '@/components/ui/button';
import { loadSettings, saveSettings, type StickyTodoTemplate } from '@/lib/settings';
import { showImageAiEditToast } from '@/lib/image-ai-edit-runtime';
import { useCurrentProjectId } from '@/lib/current-project';
import {
  NOTE_COLORS,
  NOTE_COLOR_SWATCH,
  COLOR_BG,
  COLOR_TEXT,
  COLOR_BORDER,
  COLOR_ACCENT,
  parseTodoLines,
  serializeTodoLines,
  hydratePages,
  getSidebarCollapsed,
  newPageId,
  isLineCalendared,
  TodoLineItem,
  cleanTodoPages,
  type NoteSaveState,
} from './CanvasStickyNotes';

const CARD_W = 372; // 展开卡宽度（含留白）；展开侧边栏时整体仍保持此宽度，内部左右分区
const SIDEBAR_W = 104;

/** 颜色 tooltip 英文名（全局 UI 文案英文约定） */
const COLOR_LABELS_EN: Record<string, string> = {
  yellow: 'Yellow',
  blue: 'Blue',
  green: 'Green',
  pink: 'Pink',
};

function isAllDone(content: string): boolean {
  const lines = parseTodoLines(content);
  return lines.length > 0 && lines.every((l) => l.done);
}

/** 父级暴露给便签卡的编辑操作集（state 全部上提，卡内不保存正文草稿，保证光标安全） */
export type StickyTodoOps = {
  onTodoText: (noteId: string, index: number, newText: string) => void;
  /** 返回新增行的下标（用于 Enter 后聚焦） */
  addLine: (noteId: string, afterIndex: number) => number;
  removeLine: (noteId: string, index: number) => boolean;
  toggle: (noteId: string, index: number) => void;
  switchPage: (noteId: string, targetPageId: string) => void;
  addPage: (noteId: string) => void;
  deletePage: (noteId: string, pageId: string) => void;
  renamePage: (noteId: string, pageId: string, value: string) => void;
  changeColor: (noteId: string, color: string) => void;
  toggleSidebar: (noteId: string) => void;
  onTitleInput: (noteId: string, value: string) => void;
  commitTitle: (noteId: string) => void;
  deleteNote: (noteId: string) => void;
  submitCourt: (noteId: string, text: string) => void;
  saveTemplate: (noteId: string, name: string) => Promise<void>;
  applyTemplate: (noteId: string, tpl: StickyTodoTemplate) => void;
  deleteTemplate: (tpl: StickyTodoTemplate) => void;
};

/** 单张便签的完整卡片编辑器（无拖拽/缩放/坐标，其余与旧画布便签卡功能一致） */
function NoteCardEditor({
  note,
  rev,
  saveState,
  ops,
}: {
  note: StickyNote;
  rev: number;
  saveState?: NoteSaveState;
  ops: StickyTodoOps;
}) {
  const { pages, activePageId } = hydratePages(note);
  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0];
  const content = activePage?.content ?? '';
  const allDone = isAllDone(content);
  const todoLines = parseTodoLines(content);
  const sidebarCollapsed = getSidebarCollapsed(note);

  const textColor = COLOR_TEXT[note.color] || COLOR_TEXT.yellow;
  const accent = COLOR_ACCENT[note.color] || COLOR_ACCENT.yellow;
  const borderColor = COLOR_BORDER[note.color] || COLOR_BORDER.yellow;

  const [editingTitle, setEditingTitle] = useState(false);
  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);
  const [pageRenameDraft, setPageRenameDraft] = useState('');
  const [courtOpen, setCourtOpen] = useState(false);
  const [courtDate, setCourtDate] = useState('');
  const [courtName, setCourtName] = useState('');
  const [courtRoom, setCourtRoom] = useState('');
  const [courtAddr, setCourtAddr] = useState('');
  const [tplOpen, setTplOpen] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [tplName, setTplName] = useState('');
  const [templates, setTemplates] = useState<StickyTodoTemplate[]>([]);

  const linesContainerRef = useRef<HTMLDivElement | null>(null);

  const focusLine = (index: number) => {
    requestAnimationFrame(() => {
      const els = linesContainerRef.current?.querySelectorAll<HTMLElement>('[contenteditable="true"]');
      const target = els?.[index];
      if (!target) return;
      target.focus();
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
  };

  const handleEnter = (i: number) => {
    const next = ops.addLine(note.id, i);
    focusLine(next);
  };
  const handleBackspace = (i: number): boolean => {
    const removed = ops.removeLine(note.id, i);
    if (removed) focusLine(Math.max(0, i - 1));
    return removed;
  };

  const openApplyTemplate = () => {
    void loadSettings().then((s) => setTemplates(s.stickyTemplates ?? []));
    setTplOpen((v) => !v);
    setSavingMode(false);
  };
  const toggleSaveTemplateInput = () => setSavingMode((v) => !v);

  const handleSaveTemplate = () => {
    void ops.saveTemplate(note.id, tplName).then(() => {
      setTplOpen(false);
      setSavingMode(false);
      setTplName('');
      void loadSettings().then((s) => setTemplates(s.stickyTemplates ?? []));
    });
  };

  const confirmDeleteNote = () => {
    if (!window.confirm('Delete this todo note?')) return;
    ops.deleteNote(note.id);
  };

  const submitCourt = () => {
    const date = courtDate.trim();
    const name = courtName.trim();
    if (!date || !name) return;
    ops.submitCourt(note.id, `${date} 在${name}的第${courtRoom.trim()}法庭开庭。地址：${courtAddr.trim()}`);
    setCourtOpen(false);
    setCourtDate('');
    setCourtName('');
    setCourtRoom('');
    setCourtAddr('');
  };

  return (
    <>
      <div
        className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border"
        style={{
          width: CARD_W,
          background: COLOR_BG[note.color] || COLOR_BG.yellow,
          borderColor: borderColor,
          boxShadow:
            '0 2px 6px rgba(23,23,23,.10), 0 16px 40px rgba(23,23,23,.18), 0 32px 72px rgba(75,63,227,.08)',
          opacity: allDone ? 0.78 : 1,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* 顶部受光高光 */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            borderRadius: 12,
            background: 'linear-gradient(180deg, rgba(255,255,255,.5) 0%, rgba(255,255,255,0) 42%)',
          }}
        />
        <div className="relative flex min-h-0 flex-1">
          {/* Pages sidebar — collapsible（默认折叠，可持久化） */}
          {!sidebarCollapsed && (
            <div
              className="flex shrink-0 flex-col border-r py-2"
              style={{ width: SIDEBAR_W, borderColor: 'rgba(23,23,23,.1)', background: 'rgba(0,0,0,.02)' }}
            >
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="px-0.5 text-[11px] font-semibold tracking-tight" style={{ color: textColor, opacity: 0.7 }}>
                  Pages
                </span>
                <button
                  type="button"
                  title="New page"
                  onClick={(e) => {
                    e.stopPropagation();
                    ops.addPage(note.id);
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded transition-colors hover:bg-black/10"
                  style={{ color: textColor, opacity: 0.7 }}
                >
                  <Plus size={11} strokeWidth={2.2} />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto pr-0.5" style={{ scrollbarWidth: 'thin' }}>
                {pages.map((p, idx) => {
                  const active = p.id === activePageId;
                  const isRenaming = renamingPageId === p.id;
                  return (
                    <div
                      key={p.id}
                      className="group relative cursor-pointer rounded-md transition-colors"
                      style={{ background: active ? `${accent}22` : 'transparent' }}
                      onClick={() => ops.switchPage(note.id, p.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setRenamingPageId(p.id);
                        setPageRenameDraft(p.title || '');
                      }}
                    >
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={pageRenameDraft}
                          onChange={(e) => setPageRenameDraft(e.target.value)}
                          onBlur={() => {
                            ops.renamePage(note.id, p.id, pageRenameDraft);
                            setRenamingPageId(null);
                          }}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') {
                              ops.renamePage(note.id, p.id, pageRenameDraft);
                              setRenamingPageId(null);
                            }
                            if (e.key === 'Escape') setRenamingPageId(null);
                          }}
                          className="w-full rounded bg-white/60 px-[5px] py-[3px] text-[11.5px] font-semibold leading-[1.3] outline-none"
                          style={{ color: textColor }}
                        />
                      ) : (
                        <span
                          className="block w-full truncate px-[5px] py-[3px] text-[11.5px] leading-[1.3]"
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
                          onClick={(e) => {
                            e.stopPropagation();
                            ops.deletePage(note.id, p.id);
                          }}
                          className="absolute right-[3px] top-1/2 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded opacity-0 transition-opacity hover:bg-black/10 group-hover:opacity-100"
                          style={{ color: textColor }}
                        >
                          <X size={10.5} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* 颜色色块 */}
              <div className="mt-1 flex items-center gap-1 border-t px-0.5 pt-1.5" style={{ borderColor: 'rgba(23,23,23,.1)' }}>
                {NOTE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={COLOR_LABELS_EN[c] || c}
                    onClick={(e) => {
                      e.stopPropagation();
                      ops.changeColor(note.id, c);
                    }}
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
          <div className="relative flex min-w-0 flex-1 flex-col" style={{ padding: '10px 12px 12px' }}>
            {/* Title bar */}
            <div
              className="mb-2 flex items-center gap-1 rounded-md border-b px-1 py-1"
              style={{ borderColor: 'rgba(23,23,23,.08)', background: `color-mix(in srgb, ${accent} 9%, transparent)` }}
            >
              <button
                type="button"
                title={sidebarCollapsed ? 'Show pages' : 'Hide pages'}
                onClick={() => ops.toggleSidebar(note.id)}
                className="flex shrink-0 cursor-pointer items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide transition-opacity hover:opacity-80"
                style={{ backgroundColor: 'rgba(13,88,46,.16)', color: 'rgba(13,88,46,.92)' }}
              >
                TODO
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {editingTitle ? (
                  <input
                    autoFocus
                    value={note.title || ''}
                    onChange={(e) => ops.onTitleInput(note.id, e.target.value)}
                    onBlur={() => {
                      ops.commitTitle(note.id);
                      setEditingTitle(false);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        ops.commitTitle(note.id);
                        setEditingTitle(false);
                      }
                      if (e.key === 'Escape') setEditingTitle(false);
                    }}
                    className="min-w-0 flex-1 rounded bg-transparent px-0.5 outline-none"
                    style={{ color: textColor, fontSize: '0.866667rem', fontWeight: 600, letterSpacing: '-0.01em' }}
                  />
                ) : (
                  <span
                    className="min-w-0 flex-1 truncate"
                    style={{ color: textColor, fontSize: '0.866667rem', fontWeight: 600, letterSpacing: '-0.01em', cursor: 'text' }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingTitle(true);
                    }}
                  >
                    {note.title || 'Untitled'}
                  </span>
                )}
                {saveState && (
                  <span
                    className="shrink-0 select-none"
                    title={saveState === 'error' ? 'Save failed — changes may not be persisted' : undefined}
                    style={{
                      fontSize: '0.6rem',
                      lineHeight: 1.2,
                      fontStyle: saveState === 'syncing' ? 'italic' : 'normal',
                      color: saveState === 'error' ? '#c62828' : saveState === 'saved' ? '#1e7d34' : textColor,
                      opacity: saveState === 'syncing' ? 0.6 : 0.9,
                    }}
                  >
                    {saveState === 'syncing' ? 'saving' : saveState === 'saved' ? 'saved' : 'Save failed'}
                  </span>
                )}
              </div>
              <div className="ml-1 flex items-center gap-1">
                {/* Court 开庭录入 */}
                <button
                  type="button"
                  title="Court hearing"
                  onClick={() => {
                    setCourtOpen(true);
                  }}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px] font-bold transition-colors hover:bg-black/10"
                  style={{ color: 'rgba(23,23,23,.55)', borderColor: 'rgba(23,23,23,.25)' }}
                >
                  C
                </button>
                {/* 模板：存为模板 / 应用模板 */}
                <div className="relative">
                  <button
                    type="button"
                    title="Save as template / apply template"
                    onClick={() => {
                      void loadSettings().then((s) => setTemplates(s.stickyTemplates ?? []));
                      setTplOpen((v) => !v);
                      setSavingMode(false);
                    }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-black/10"
                    style={{ color: 'rgba(23,23,23,.55)' }}
                  >
                    <ClipboardList size={12} strokeWidth={2} />
                  </button>
                  {tplOpen && (
                    <div
                      className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border bg-white shadow-xl"
                      style={{ borderColor: 'rgba(23,23,23,.15)' }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-1 border-b p-1" style={{ borderColor: 'rgba(23,23,23,.1)' }}>
                        <button
                          type="button"
                          onClick={toggleSaveTemplateInput}
                          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-black/5"
                          style={{ color: '#333' }}
                        >
                          {savingMode ? '◂ back' : '＋ save as'}
                        </button>
                      </div>
                      {savingMode ? (
                        <div className="space-y-1 p-2">
                          <input
                            autoFocus
                            value={tplName}
                            onChange={(e) => setTplName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveTemplate();
                              if (e.key === 'Escape') setTplOpen(false);
                            }}
                            placeholder="Template name"
                            className="w-full rounded border px-2 py-1 text-xs outline-none"
                            style={{ borderColor: 'rgba(23,23,23,.2)', color: '#333' }}
                          />
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              onClick={handleSaveTemplate}
                              disabled={!tplName.trim()}
                              variant="solid"
                              tone="brand"
                              size="xs"
                            >
                              <Check size={11} />
                              Save
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="max-h-56 overflow-y-auto p-1">
                          {templates.length === 0 ? (
                            <p className="px-2 py-3 text-center text-[11px] leading-relaxed" style={{ color: '#999' }}>
                              No templates yet
                            </p>
                          ) : (
                            templates.map((tpl) => (
                              <div
                                key={tpl.id}
                                className="group flex w-full items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors hover:bg-black/5"
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    ops.applyTemplate(note.id, tpl);
                                    setTplOpen(false);
                                  }}
                                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                  style={{ color: '#333' }}
                                >
                                  <Layers size={11} className="shrink-0" style={{ color: '#888' }} />
                                  <span className="min-w-0 flex-1 truncate font-medium">{tpl.name}</span>
                                  <span className="shrink-0 text-[10px]" style={{ color: '#999' }}>
                                    {tpl.lines.length} items
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => ops.deleteTemplate(tpl)}
                                  title="Delete template"
                                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-black/10 group-hover:opacity-100"
                                  style={{ color: '#999' }}
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {/* 删除便签 */}
                <button
                  type="button"
                  title="Delete note"
                  onClick={confirmDeleteNote}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-black/10"
                  style={{ color: 'rgba(23,23,23,.55)' }}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            </div>

            {/* Lines — todo checklist */}
            <div
              ref={(el) => {
                linesContainerRef.current = el;
              }}
              data-note-lines={note.id}
              className="flex min-h-0 flex-1 flex-col gap-[7px] overflow-y-auto pr-0.5"
              style={{ scrollbarWidth: 'thin' }}
            >
              {todoLines.map((line, i) => (
                <TodoLineItem
                  key={`${note.id}:${activePageId}:${i}`}
                  text={line.text}
                  done={line.done}
                  color={textColor}
                  accent={accent}
                  rev={rev}
                  onInputText={(text) => ops.onTodoText(note.id, i, text)}
                  onEnter={() => handleEnter(i)}
                  onBackspaceEmpty={() => handleBackspace(i)}
                  onToggle={() => ops.toggle(note.id, i)}
                  calendared={isLineCalendared(activePage, i)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Court 开庭录入弹窗（全英文 UI） */}
      {courtOpen && (
        <div
          className="fixed inset-0 z-[4000] flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={() => setCourtOpen(false)}
        >
          <div
            className="w-[360px] max-w-full space-y-3 rounded-xl border p-4 shadow-2xl"
            style={{ background: 'var(--paper, #fff)', borderColor: 'var(--border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              Court hearing
            </div>
            {(
              [
                ['Date', courtDate, setCourtDate, '2026/8/30 9:00'],
                ['Court', courtName, setCourtName, 'Court name'],
                ['Courtroom', courtRoom, setCourtRoom, 'No.'],
                ['Address', courtAddr, setCourtAddr, 'Address'],
              ] as const
            ).map(([label, value, setter, placeholder]) => (
              <label key={label} className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                <span className="w-20 shrink-0">{label}</span>
                <input
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  placeholder={placeholder}
                  className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
                />
              </label>
            ))}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="soft" tone="neutral" size="md" onClick={() => setCourtOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="solid"
                tone="brand"
                size="md"
                onClick={submitCourt}
                disabled={!courtDate.trim() || !courtName.trim()}
              >
                OK
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function StickyTodoDock() {
  const projectId = useCurrentProjectId();
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [saveStates, setSaveStates] = useState<Record<string, NoteSaveState>>({});
  const [contentRev, setContentRev] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [cardPos, setCardPos] = useState<{ top: number; right: number } | null>(null);

  const notesRef = useRef(notes);
  notesRef.current = notes;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFlashRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useRef(expandedId);
  expandedRef.current = expandedId;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const clearSaveTimer = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  };

  const reload = useCallback(() => {
    const pid = projectIdRef.current;
    if (!pid) return;
    fetch(`/api/sticky-notes?project_id=${encodeURIComponent(pid)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.success) setNotes(Array.isArray(d.notes) ? d.notes : []);
      })
      .catch(() => {});
  }, []);

  // 项目切换 / 首次进入：加载
  useEffect(() => {
    setNotes([]);
    setSaveStates({});
    setContentRev(0);
    setExpandedId(null);
    savedFlashRef.current.forEach((t) => clearTimeout(t));
    savedFlashRef.current.clear();
    clearSaveTimer();
    if (!projectId) return;
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 外部变更（AI create_sticky_note / create_scheduled_todo、日历反向、看板编辑）后刷新
  useEffect(() => {
    if (!projectId) return;
    const onChanged = () => reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onCalendar = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 250);
    };
    window.addEventListener('sticky-notes-changed', onChanged);
    window.addEventListener('calendar-events-changed', onCalendar);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('sticky-notes-changed', onChanged);
      window.removeEventListener('calendar-events-changed', onCalendar);
    };
  }, [projectId, reload]);

  // 展开卡测量 + 尺寸变化跟随；非固定态点击外部自动收起
  useEffect(() => {
    if (!expandedId) {
      setCardPos(null);
      return;
    }
    const measure = () => {
      const el = chipsRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setCardPos({ top: Math.max(8, Math.round(r.bottom + 6)), right: Math.round(window.innerWidth - r.right) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [expandedId]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (pinnedRef.current) return;
      if (!expandedRef.current) return;
      const t = e.target as Node;
      if (cardRef.current?.contains(t)) return;
      if (chipsRef.current?.contains(t)) return;
      setExpandedId(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  useEffect(() => {
    return () => {
      clearSaveTimer();
      savedFlashRef.current.forEach((t) => clearTimeout(t));
      savedFlashRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 落盘（update）：服务端 reconcile 会回写带 lineEventIds 的 note → 仅按 pageId 回填锚点，不整体覆盖 */
  const saveNote = useCallback((id: string, patch: Partial<StickyNote>) => {
    const pid = projectIdRef.current;
    if (!pid) return;
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
    // 空行不是待办：落盘前统一剔除空待办行并重排行级锚点（与服务端 writeNotes 归一化一致）
    const notePatch: Partial<StickyNote> = { ...patch };
    if (Array.isArray(notePatch.pages)) notePatch.pages = cleanTodoPages(notePatch.pages);
    setSaveStates((prev) => ({ ...prev, [id]: 'syncing' }));
    fetch('/api/sticky-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', project_id: pid, note: { id, ...notePatch } }),
    })
      .then((r) => r.json().catch(() => ({ success: false })))
      .then((d) => {
        if (d?.success) {
          adopt(d);
          setSaveStates((prev) => ({ ...prev, [id]: 'saved' }));
          const prevT = savedFlashRef.current.get(id);
          if (prevT) clearTimeout(prevT);
          savedFlashRef.current.set(
            id,
            setTimeout(() => {
              setSaveStates((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
              savedFlashRef.current.delete(id);
            }, 1600),
          );
        } else {
          setSaveStates((prev) => ({ ...prev, [id]: 'error' }));
        }
      })
      .catch(() => setSaveStates((prev) => ({ ...prev, [id]: 'error' })));
  }, []);

  const applyNote = useCallback(
    (noteId: string, builder: (note: StickyNote) => Partial<StickyNote>) => {
      const note = notesRef.current.find((n) => n.id === noteId);
      if (!note) return;
      const patch = builder(note);
      setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, ...patch } : n)));
      return patch;
    },
    [],
  );

  /** 结构变更：本地即时更新 + rev bump + 立即落盘 */
  const flushNote = useCallback(
    (noteId: string, builder: (note: StickyNote) => Partial<StickyNote>) => {
      const patch = applyNote(noteId, builder);
      if (!patch || Object.keys(patch).length === 0) return;
      clearSaveTimer();
      setContentRev((r) => r + 1);
      saveNote(noteId, patch);
    },
    [applyNote, saveNote],
  );

  /** 行文本编辑：本地即时更新 + 700ms 防抖落盘（不加 rev，保光标） */
  const debounceNote = useCallback(
    (noteId: string, builder: (note: StickyNote) => Partial<StickyNote>) => {
      applyNote(noteId, builder);
      clearSaveTimer();
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        const latest = notesRef.current.find((n) => n.id === noteId);
        if (latest) saveNote(noteId, builder(latest));
      }, 700);
    },
    [applyNote, saveNote],
  );

  /* ---- 行/页/标题/颜色等编辑操作（语义与旧画布便签一致） ---- */

  const onTodoText = useCallback(
    (noteId: string, index: number, newText: string) => {
      debounceNote(noteId, (note) => {
        const { pages, activePageId } = hydratePages(note);
        const p = pages.find((x) => x.id === activePageId)!;
        const lines = parseTodoLines(p.content);
        while (lines.length <= index) lines.push({ done: false, text: '' });
        lines[index].text = newText;
        return {
          pages: pages.map((x) => (x.id === activePageId ? { ...x, content: serializeTodoLines(lines) } : x)),
          activePageId,
        };
      });
    },
    [debounceNote],
  );

  /** Enter 新建一行：仅在本地插入空行（不落盘），待用户输入文字后由防抖/后续保存统一落盘。
   *  这样"空行不是待办"——空输入行只是编辑占位，不会作为空待办持久化。 */
  const addLine = useCallback(
    (noteId: string, afterIndex: number): number => {
      const note = notesRef.current.find((n) => n.id === noteId);
      if (!note) return afterIndex + 1;
      const { pages, activePageId } = hydratePages(note);
      const p = pages.find((x) => x.id === activePageId)!;
      const lines = parseTodoLines(p.content);
      lines.splice(afterIndex + 1, 0, { done: false, text: '' });
      const cal = Array.isArray(p.lineCalendared) ? [...p.lineCalendared] : undefined;
      if (cal) cal.splice(afterIndex + 1, 0, false);
      const evIds = Array.isArray(p.lineEventIds) ? p.lineEventIds.map((x) => [...x]) : undefined;
      if (evIds) evIds.splice(afterIndex + 1, 0, []);
      clearSaveTimer();
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId
            ? {
                ...n,
                pages: pages.map((x) =>
                  x.id === activePageId
                    ? {
                        ...x,
                        content: serializeTodoLines(lines),
                        ...(cal ? { lineCalendared: cal } : {}),
                        ...(evIds ? { lineEventIds: evIds } : {}),
                      }
                    : x,
                ),
                activePageId,
              }
            : n,
        ),
      );
      setContentRev((r) => r + 1);
      return afterIndex + 1;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const removeLine = useCallback(
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
      clearSaveTimer();
      setNotes((prev) =>
        prev.map((n) => {
          if (n.id !== noteId) return n;
          return {
            ...n,
            pages: pages.map((x) =>
              x.id === activePageId
                ? {
                    ...x,
                    content: serializeTodoLines(lines),
                    ...(cal ? { lineCalendared: cal } : {}),
                    ...(evIds ? { lineEventIds: evIds } : {}),
                  }
                : x,
            ),
            activePageId,
          };
        }),
      );
      setContentRev((r) => r + 1);
      saveNote(noteId, {
        pages: pages.map((x) =>
          x.id === activePageId
            ? {
                ...x,
                content: serializeTodoLines(lines),
                ...(cal ? { lineCalendared: cal } : {}),
                ...(evIds ? { lineEventIds: evIds } : {}),
              }
            : x,
        ),
        activePageId,
      });
      return true;
    },
    [saveNote],
  );

  const toggle = useCallback(
    (noteId: string, index: number) => {
      flushNote(noteId, (note) => {
        const { pages, activePageId } = hydratePages(note);
        const p = pages.find((x) => x.id === activePageId)!;
        const lines = parseTodoLines(p.content);
        if (index >= lines.length) return {};
        const nowDone = !lines[index].done;
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
        return {
          pages: pages.map((x) =>
            x.id === activePageId
              ? {
                  ...x,
                  content: serializeTodoLines(lines),
                  ...(cal ? { lineCalendared: cal } : {}),
                  ...(evIds ? { lineEventIds: evIds } : {}),
                }
              : x,
          ),
          activePageId,
        };
      });
    },
    [flushNote],
  );

  const switchPage = useCallback(
    (noteId: string, targetPageId: string) => {
      const note = notesRef.current.find((n) => n.id === noteId);
      if (!note) return;
      const { pages } = hydratePages(note);
      if (!pages.some((p) => p.id === targetPageId) || note.activePageId === targetPageId) return;
      flushNote(noteId, () => ({ activePageId: targetPageId }));
    },
    [flushNote],
  );

  const addPage = useCallback(
    (noteId: string) => {
      flushNote(noteId, (note) => {
        const { pages } = hydratePages(note);
        const newP: StickyNotePage = { id: newPageId(), title: `P${pages.length + 1}`, content: '', kind: 'todo' };
        return { pages: [...pages, newP], activePageId: newP.id };
      });
    },
    [flushNote],
  );

  const deletePage = useCallback(
    (noteId: string, pageId: string) => {
      const note = notesRef.current.find((n) => n.id === noteId);
      if (!note) return;
      const { pages, activePageId } = hydratePages(note);
      if (pages.length <= 1) return;
      const cur = pages.find((p) => p.id === pageId);
      if (!cur) return;
      if (!window.confirm(`Delete page "${cur.title}"?`)) return;
      const pages2 = pages.filter((p) => p.id !== pageId);
      const nextActive = pageId === activePageId ? pages2[0].id : activePageId;
      flushNote(noteId, () => ({ pages: pages2, activePageId: nextActive }));
    },
    [flushNote],
  );

  const renamePage = useCallback(
    (noteId: string, pageId: string, value: string) => {
      flushNote(noteId, (note) => {
        const { pages } = hydratePages(note);
        const idx = pages.findIndex((p) => p.id === pageId);
        const finalTitle = value.trim() || `P${idx + 1}`;
        return { pages: pages.map((p) => (p.id === pageId ? { ...p, title: finalTitle } : p)) };
      });
    },
    [flushNote],
  );

  const changeColor = useCallback(
    (noteId: string, color: string) => {
      flushNote(noteId, () => ({ color }));
    },
    [flushNote],
  );

  const toggleSidebar = useCallback(
    (noteId: string) => {
      const note = notesRef.current.find((n) => n.id === noteId);
      if (!note) return;
      flushNote(noteId, () => ({ sidebarCollapsed: !getSidebarCollapsed(note) }));
    },
    [flushNote],
  );

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
      clearSaveTimer();
      saveNote(noteId, { title: value });
    },
    [saveNote],
  );

  const deleteNote = useCallback((noteId: string) => {
    const pid = projectIdRef.current;
    if (!pid) return;
    fetch('/api/sticky-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', project_id: pid, id: noteId }),
    }).catch(() => {});
    clearSaveTimer();
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    setSaveStates((prev) => {
      const next = { ...prev };
      delete next[noteId];
      return next;
    });
    setExpandedId((cur) => (cur === noteId ? null : cur));
  }, []);

  const submitCourt = useCallback(
    (noteId: string, text: string) => {
      flushNote(noteId, (note) => {
        const { pages, activePageId } = hydratePages(note);
        const p = pages.find((x) => x.id === activePageId);
        if (!p) return {};
        const lines = parseTodoLines(p.content);
        while (lines.length > 0 && !lines[lines.length - 1].text.trim()) lines.pop();
        lines.push({ done: false, text });
        const cal = Array.isArray(p.lineCalendared) ? [...p.lineCalendared] : [];
        while (cal.length < lines.length) cal.push(false);
        const evIds = Array.isArray(p.lineEventIds) ? p.lineEventIds.map((x) => [...x]) : [];
        while (evIds.length < lines.length) evIds.push([]);
        return {
          pages: pages.map((x) =>
            x.id === activePageId ? { ...x, content: serializeTodoLines(lines), lineCalendared: cal, lineEventIds: evIds } : x,
          ),
          activePageId,
        };
      });
    },
    [flushNote],
  );

  const saveTemplate = useCallback(
    async (noteId: string, name: string) => {
      const trimmed = name.trim();
      const note = notesRef.current.find((n) => n.id === noteId);
      if (!trimmed || !note) return;
      const { pages, activePageId } = hydratePages(note);
      const p = pages.find((x) => x.id === activePageId);
      if (!p) return;
      const lines = parseTodoLines(p.content)
        .map((l) => l.text.trim())
        .filter((t) => t.length > 0);
      if (lines.length === 0) return;
      const tpl: StickyTodoTemplate = {
        id: `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: trimmed,
        lines,
        updatedAt: new Date().toISOString(),
      };
      const s = await loadSettings();
      const list = [...(s.stickyTemplates ?? [])].filter((t) => t.name !== trimmed);
      list.push(tpl);
      await saveSettings({ ...s, stickyTemplates: list });
    },
    [],
  );

  const applyTemplate = useCallback(
    (noteId: string, tpl: StickyTodoTemplate) => {
      flushNote(noteId, (note) => {
        const { pages, activePageId } = hydratePages(note);
        const content = tpl.lines.length > 0 ? tpl.lines.map((t) => `- [ ] ${t}`).join('\n') : '- [ ] ';
        return {
          pages: pages.map((x) => (x.id === activePageId ? { ...x, content } : x)),
          activePageId,
        };
      });
    },
    [flushNote],
  );

  const deleteTemplate = useCallback(async (tpl: StickyTodoTemplate) => {
    if (!window.confirm(`Delete template "${tpl.name}"?`)) return;
    const s = await loadSettings();
    const list = (s.stickyTemplates ?? []).filter((t) => t.id !== tpl.id);
    await saveSettings({ ...s, stickyTemplates: list });
  }, []);

  const ops: StickyTodoOps = useMemo(
    () => ({
      onTodoText,
      addLine,
      removeLine,
      toggle,
      switchPage,
      addPage,
      deletePage,
      renamePage,
      changeColor,
      toggleSidebar,
      onTitleInput,
      commitTitle,
      deleteNote,
      submitCourt,
      saveTemplate,
      applyTemplate,
      deleteTemplate,
    }),
    [
      onTodoText,
      addLine,
      removeLine,
      toggle,
      switchPage,
      addPage,
      deletePage,
      renamePage,
      changeColor,
      toggleSidebar,
      onTitleInput,
      commitTitle,
      deleteNote,
      submitCourt,
      saveTemplate,
      applyTemplate,
      deleteTemplate,
    ],
  );

  // 展示顺序：未完成在前、全部完成沉底（与旧便签层一致）
  const sortedNotes = useMemo(() => {
    const activeContentOf = (n: StickyNote) => hydratePages(n).pages.find((p) => p.id === hydratePages(n).activePageId)?.content ?? '';
    return [...notes].sort((a, b) => {
      const aDone = isAllDone(activeContentOf(a));
      const bDone = isAllDone(activeContentOf(b));
      if (aDone !== bDone) return aDone ? 1 : -1;
      return 0;
    });
  }, [notes]);

  if (!projectId) return null;
  const expandedNote = expandedId ? notes.find((n) => n.id === expandedId) ?? null : null;

  return (
    <>
      {/* 标题栏色块簇：点开色块=展开对应便签卡；＋=新建、图钉=固定展开不自动收起（两者默认隐藏，点击色块展开后显示） */}
      <div
        ref={chipsRef}
        className="flex h-5 shrink-0 items-center gap-1 rounded-md px-1 transition-colors hover:bg-[var(--paper-hover)]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {sortedNotes.map((n) => {
          const active = expandedId === n.id;
          const done = isAllDone(hydratePages(n).pages.find((p) => p.id === hydratePages(n).activePageId)?.content ?? '');
          return (
            <button
              key={n.id}
              type="button"
              title={`${n.title || 'Untitled'}${done ? ' (all done)' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setExpandedId((cur) => (cur === n.id ? null : n.id));
              }}
              className="h-[13px] w-[13px] shrink-0 rounded-full border transition-transform hover:scale-125"
              style={{
                background: NOTE_COLOR_SWATCH[n.color] || NOTE_COLOR_SWATCH.yellow,
                borderColor: active ? 'var(--primary-strong)' : 'rgba(23,23,23,.25)',
                boxShadow: active ? '0 0 0 2px color-mix(in oklab, var(--primary) 35%, transparent)' : undefined,
                opacity: done ? 0.55 : 1,
              }}
            />
          );
        })}
        {(expandedId !== null || sortedNotes.length === 0) && (
          <button
            type="button"
            title="New todo note"
            onClick={(e) => {
              e.stopPropagation();
              const pid = projectIdRef.current;
              if (!pid) return;
              fetch('/api/sticky-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create', project_id: pid, note: { color: 'green', content: '', kind: 'todo' } }),
              })
                .then((r) => r.json())
                .then((d) => {
                  if (d?.success) {
                    if (d.limited) {
                      showImageAiEditToast('A project can hold up to 3 todo notes.', 'error');
                      setNotes((prev) =>
                        prev.some((x) => x.id === d.note?.id) ? prev : [...prev, d.note],
                      );
                      setExpandedId(d.note?.id ?? null);
                    } else {
                      setNotes((prev) => (prev.some((x) => x.id === d.note?.id) ? prev : [...prev, d.note]));
                      setExpandedId(d.note?.id ?? null);
                    }
                  }
                })
                .catch(() => {});
            }}
            className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_80%,transparent)]"
            style={{ color: 'var(--ink-muted)' }}
          >
            <Plus size={11} strokeWidth={2.4} />
          </button>
        )}
        {expandedId !== null && (
          <button
            type="button"
            title={pinned ? 'Unpin (collapse when clicking elsewhere)' : 'Pin (keep expanded when clicking elsewhere)'}
            onClick={(e) => {
              e.stopPropagation();
              setPinned((v) => !v);
            }}
            className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded transition-colors hover:bg-[color:color-mix(in_oklab,var(--paper-hover)_80%,transparent)] ${pinned ? '' : 'opacity-70'}`}
            style={pinned ? { color: 'var(--primary-strong)' } : { color: 'var(--ink-muted)' }}
          >
            <Pin size={11} strokeWidth={2.2} />
          </button>
        )}
      </div>

      {/* 展开的完整便签卡：portal 到 body，fixed 锚在标题栏色块正下方 */}
      {expandedNote && cardPos &&
        createPortal(
          <div
            ref={cardRef}
            className="relative z-[9000]"
            style={{ position: 'fixed', top: cardPos.top, right: cardPos.right, maxHeight: 'calc(100vh - 24px)' }}
          >
            <NoteCardEditor note={expandedNote} rev={contentRev} saveState={saveStates[expandedNote.id]} ops={ops} />
          </div>,
          document.body,
        )}
    </>
  );
}
