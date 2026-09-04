'use client';

/**
 * StickyThoughtNode — 思路便签节点（零 AI，仅作思路上游）
 *
 * 定位（2026-08-27 用户确认）：
 *   - 研究时用 ChatNode 深度思考，思路易绕；在画布上新建轻量「便签」节点随手记思路、
 *     散开摆放、并以连线把便签内容作为下游 ChatNode 的「研究对象」（思路上游）。
 *   - 与 CanvasStickyNotes 的区别：CanvasStickyNotes 是固定屏幕坐标、AI 完全不可见的待办便签；
 *     本节点是画布坐标系内的真实节点，可缩放平移、可连线、文本随项目持久化（.md frontmatter）。
 *   - 连线语义：便签只作为 source（思路上游）发出，禁止被其它节点连入为子节点。
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, NodeProps, useReactFlow } from '@xyflow/react';
import { X, Target, Save, Check, Star } from 'lucide-react';
import type { AiChatNodeData } from '@/lib/types';

/** 系统无衬线字体栈：中文优先 PingFang SC / Microsoft YaHei / Noto Sans SC，干净中性易读 */
const NOTE_FONT = `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', 'Microsoft YaHei', 'Noto Sans SC', sans-serif`;

/** 便签底色（经典便签黄：液态玻璃半透明，配合 backdrop-filter 呈 Apple 通透质感） */
const NOTE_COLORS = [
  'rgba(255, 244, 196, 0.30)',
  'rgba(255, 238, 172, 0.30)',
  'rgba(255, 248, 216, 0.30)',
  'rgba(250, 232, 150, 0.28)',
] as const;
const NOTE_TEXT = ['#5A4612', '#4E3D10', '#6B5419', '#453708'] as const;

function StickyThoughtNodeInner({ id, data, selected }: NodeProps) {
  const nodeData = data as AiChatNodeData;
  const title = typeof nodeData.title === 'string' ? nodeData.title : '';
  const stickyText = typeof nodeData.stickyText === 'string' ? nodeData.stickyText : '';
  const nodeMdId = nodeData.nodeMdId || id;
  const { deleteElements } = useReactFlow();

  // 本地编辑态：聚焦时先改内存，失焦时一次性落盘（避免每次击键都请求）
  const [text, setText] = useState(stickyText);
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 一键保存成功反馈：短暂显示「已保存」勾标后自动复位
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 笔记系统条目绑定：首次保存新建条目后回写 entry_id（并持久化到 .md frontmatter），后续保存走更新模式
  const [entryId, setEntryId] = useState<string | undefined>(nodeData.notebookEntryId);
  // 星标：画布重要性标记（仅提示，不影响 AI/排版）
  const [starred, setStarred] = useState<boolean>(!!nodeData.starred);
  // 星标切换：本地即时更新 + 后端持久化（失败不阻断交互）
  const toggleStar = useCallback(() => {
    setStarred((prev) => {
      const next = !prev;
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_star', node_id: nodeMdId, starred: next }),
      }).catch((e) => console.warn('[note] 星标保存失败:', String(e)));
      return next;
    });
  }, [nodeMdId]);
  // 标题编辑态：双击标题进入编辑，回车/失焦保存（复用 rename_title，可重命名 .md 文件）
  const [displayTitle, setDisplayTitle] = useState(title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // 正文自动增高 + 超出折叠：内容少时卡片按内容撑高；超过 MAX_TEXT_H 折叠，
  // 显示「展开」按钮；展开态上限 MAX_EXPAND_H（再超则内部滚动）
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const MAX_TEXT_H = 240;
  const MAX_EXPAND_H = 480;

  // 便签配色：按 nodeMdId 稳定哈希取色，同一便签重启后颜色不变
  const colorIndex = hashColorIndex(nodeMdId);
  const bg = NOTE_COLORS[colorIndex];
  const fg = NOTE_TEXT[colorIndex];

  const persist = useCallback(
    (value: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        setSaving(true);
        fetch('/api/nodes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update_sticky', node_id: nodeMdId, text: value }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (!res.success) console.warn('[sticky] 保存失败:', res.error);
          })
          .catch((e) => console.warn('[sticky] 保存失败:', String(e)))
          .finally(() => setSaving(false));
      }, 400);
    },
    [nodeMdId],
  );

  const handleChange = useCallback(
    (value: string) => {
      setText(value);
      persist(value);
    },
    [persist],
  );

  // 一键保存：落盘 .md + 同步入库笔记系统（等效执行 /note 命令）。
  // 同一张便签只建一条笔记条目：首次保存新建并回写 entry_id，后续保存走 entry_id 更新模式（覆盖为最新全文、保留原分类）。
  // 内容为空时仅落盘、跳过入库；条目已被外部删除（404）时解除绑定、降级为新建。
  const saveNow = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaving(true);
    // 入库内容去除自动编号前缀（1. / 2. ...），保持纯文本存储；落盘 .md 保留原文
    const cleanText = text
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s*/, ''))
      .join('\n');
    const writeMd = (eid?: string) =>
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_sticky',
          node_id: nodeMdId,
          text,
          ...(eid ? { notebook_entry_id: eid } : {}),
        }),
      }).then((r) => r.json());
    const markSaved = () => {
      setJustSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), 1600);
    };
    // 首次入库：新建条目 → 回写 entry_id 并落盘绑定
    const saveNotebookNew = async (): Promise<boolean> => {
      const resp = await fetch('/api/notebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText }),
      });
      const nbRes = await resp.json();
      if (!nbRes.success) {
        console.warn('[sticky] 笔记系统入库失败:', nbRes.error);
        return false;
      }
      const saved = nbRes.entry ?? nbRes.entries?.[0];
      if (!saved?.id) {
        console.warn('[sticky] 笔记系统返回无条目 id');
        return false;
      }
      setEntryId(saved.id);
      const mdRes = await writeMd(saved.id);
      if (!mdRes.success) console.warn('[sticky] 保存失败:', mdRes.error);
      return true;
    };
    try {
      if (!text.trim()) {
        // 空内容：仅落盘，不入笔记库
        const mdRes = await writeMd(entryId);
        if (!mdRes.success) console.warn('[sticky] 保存失败:', mdRes.error);
        markSaved();
        return;
      }
      if (!entryId) {
        if (await saveNotebookNew()) markSaved();
        return;
      }
      // 已有绑定：更新条目内容（覆盖为最新全文）
      const nbResp = await fetch('/api/notebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_id: entryId, content: cleanText }),
      });
      const nbRes = await nbResp.json();
      if (nbResp.status === 404) {
        // 条目已被外部删除：解除绑定，降级为新建
        setEntryId(undefined);
        if (await saveNotebookNew()) markSaved();
        return;
      }
      if (!nbRes.success) {
        console.warn('[sticky] 笔记系统更新失败:', nbRes.error);
        return;
      }
      const mdRes = await writeMd(entryId);
      if (!mdRes.success) console.warn('[sticky] 保存失败:', mdRes.error);
      markSaved();
    } catch (e) {
      console.warn('[sticky] 保存失败:', String(e));
    } finally {
      setSaving(false);
    }
  }, [nodeMdId, text, entryId]);

  // 回车自动编号：在光标处插入换行 + 下一序号（行首编号最大 + 1，无编号则从 1 起）
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart, selectionEnd, value } = el;
      const nums: number[] = [];
      const re = /^\s*(\d+)\./gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(value)) !== null) nums.push(parseInt(m[1], 10));
      const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      const insert = `\n${next}. `;
      const newValue = value.slice(0, selectionStart) + insert + value.slice(selectionEnd);
      handleChange(newValue);
      const caret = selectionStart + insert.length;
      requestAnimationFrame(() => {
        el.setSelectionRange(caret, caret);
      });
    },
    [handleChange],
  );

  const handleDelete = useCallback(() => {
    // 后端删除 .md 文件 + 数据库中的关联边（nodeMdId 为持久化 UUID）
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', node_id: nodeMdId }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (!res.success) console.warn('[sticky] 删除后端失败:', res.error);
      })
      .catch((e) => console.warn('[sticky] 删除后端失败:', String(e)));
    // deleteElements 从 ReactFlow store 移除画布节点及其出/入边
    deleteElements({ nodes: [{ id }] });
  }, [id, nodeMdId, deleteElements]);

  // 正文自动增高 + 溢出检测：textarea 高度先置 auto 再按内容撑高，
  // 折叠态限制在 MAX_TEXT_H、展开态限制在 MAX_EXPAND_H（超出内部滚动）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const sh = el.scrollHeight;
    setOverflow(sh > MAX_TEXT_H);
    el.style.height = `${Math.min(sh, expanded ? MAX_EXPAND_H : MAX_TEXT_H)}px`;
  }, [text, expanded]);

  // 保存标题：空标题保持原标题；成功更新本地显示（重命名 .md 文件失败不阻断）
  const saveTitle = useCallback(
    (value: string) => {
      const cleaned = value.trim();
      setEditingTitle(false);
      if (!cleaned) return;
      setDisplayTitle(cleaned);
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename_title', node_id: nodeMdId, new_title: cleaned }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (!res.success) console.warn('[sticky] 标题保存失败:', res.error);
        })
        .catch((e) => console.warn('[sticky] 标题保存失败:', String(e)));
    },
    [nodeMdId],
  );

  return (
    <div
      className="sticky-thought-node"
      style={{
        width: 220,
        borderRadius: 10,
        background: bg,
        // Apple 液态玻璃：背景模糊 + 饱和度提升，通透可透出画布点阵
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        // 顶部高光描边 + 内顶高光，模拟玻璃打磨感
        border: '1px solid rgba(255,255,255,0.55)',
        color: fg,
        boxShadow: selected
          // 选中态：淡黄色发光光晕（非实线框），贴合便签黄液态玻璃
          ? '0 0 0 1px rgba(255, 205, 80, 0.22), 0 0 22px 6px rgba(255, 196, 60, 0.30)'
          : '0 10px 30px rgba(0,0,0,.16), inset 0 1px 0 rgba(255,255,255,.7)',
        fontFamily: NOTE_FONT,
      }}
    >
      {/* 便签头部：子弹图标（按钮，点击联动链导航）+ 标题（双击编辑） + 保存态 + 删除 */}
      <div className="sticky-thought__head" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px 2px' }}>
        {/* 子弹图标：默认即视觉锚点，不再显示文字标签；点击定位到卡片所属链路（链导航圆点联动） */}
        <button
          type="button"
          className="nodrag sticky-thought__nav"
          title="定位到所属链路"
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('note-chain-nav-request', {
              detail: { nodeId: id, mdAnchor: nodeData.mdAnchor },
            }));
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, padding: 0,
            borderRadius: 3, border: 'none', background: 'transparent',
            color: 'inherit', opacity: 0.7, flexShrink: 0, cursor: 'pointer',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
        >
          <Target size={12} />
        </button>
        {editingTitle ? (
          <input
            autoFocus
            className="nodrag"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => saveTitle(titleDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); saveTitle(titleDraft); }
              if (e.key === 'Escape') { setEditingTitle(false); }
            }}
            placeholder="便签标题"
            spellCheck={false}
            style={{
              flex: 1, minWidth: 0, fontSize: '0.8rem', fontWeight: 600,
              border: 'none', background: 'transparent', color: 'inherit',
              outline: 'none', opacity: 0.9,
            }}
          />
        ) : (
          <span
            className="sticky-thought__title"
            onDoubleClick={() => { setTitleDraft(displayTitle); setEditingTitle(true); }}
            style={{
              flex: 1, fontSize: '0.8rem', fontWeight: 600, opacity: 0.85, cursor: 'pointer',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {displayTitle || '便签'}
          </span>
        )}
        <span style={{ fontSize: '0.666667rem', opacity: 0.45 }}>{saving ? '●' : ''}</span>
        {/* 星标：标记节点重要性（仅画布提示）；标星后黄色实心常显 */}
        <button
          type="button"
          onClick={toggleStar}
          className="nodrag sticky-thought__star"
          title={starred ? '取消星标' : '标记为重要'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, borderRadius: 3, border: 'none', cursor: 'pointer',
            background: 'transparent', color: 'inherit',
            opacity: starred ? 1 : 0.4,
          }}
        >
          <Star
            className="h-3 w-3"
            style={{
              fill: starred ? '#F5B301' : 'none',
              color: starred ? '#F5B301' : 'currentColor',
            }}
          />
        </button>
        {/* 一键保存：落盘 .md + 同步入库笔记系统（等效 /note），成功后短暂显示「已保存」勾标 */}
        <button
          type="button"
          onClick={saveNow}
          className="sticky-thought__save"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, borderRadius: 3, border: 'none', cursor: 'pointer',
            background: 'transparent', color: 'inherit', opacity: justSaved ? 1 : 0.5,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = justSaved ? '1' : '0.5')}
        >
          {justSaved ? <Check className="h-3 w-3" style={{ color: '#1e9e5a' }} /> : <Save className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          className="sticky-thought__del"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, borderRadius: 3, border: 'none', cursor: 'pointer',
            background: 'transparent', color: 'inherit', opacity: 0.5,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* 便签正文：textarea 就地编辑，nodrag 避免输入时误拖画布；回车自动编号下一行；
          高度随内容自动增高（聚焦自动展开，失焦且溢出时自动收回折叠态） */}
      <textarea
        ref={textareaRef}
        className="sticky-thought__text nodrag nowheel"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setExpanded(true)}
        onBlur={() => setExpanded(false)}
        placeholder="记录一条笔记…"
        spellCheck={false}
        style={{
          display: 'block',
          width: '100%',
          minHeight: 80,
          padding: '5px 8px 6px',
          // 无边框悬浮感：半透明白色浮层 + 柔和投影，像一片薄玻璃浮在便签上
          border: 'none',
          borderRadius: 6,
          background: 'rgba(255,255,255,0.35)',
          boxShadow: '0 1px 6px rgba(18, 66, 74, 0.10)',
          color: 'inherit',
          fontSize: '0.933333rem',
          lineHeight: 1.6,
          outline: 'none',
          resize: 'none',
        }}
      />

      {/* 溢出折叠控制：内容超过折叠阈值时，折叠态显示「展开」，展开态显示「收起」。
          onMouseDown preventDefault 防止点击按钮时 textarea 失焦导致立即回折叠 */}
      {overflow && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setExpanded((v) => !v)}
          className="sticky-thought__toggle nodrag"
          style={{
            display: 'block',
            margin: '2px 0 4px auto',
            padding: '1px 8px',
            border: 'none',
            borderRadius: 4,
            background: 'transparent',
            color: 'inherit',
            fontSize: '0.733333rem',
            opacity: 0.6,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.6')}
        >
          {expanded ? '收起 ▴' : '展开 ▾'}
        </button>
      )}

      {/* source 手柄：悬停时在便签面板右侧外部浮现「单向 →」纯箭头（无外框无背景），
          可拖出连线，作为思路上游 child。 */}
      <Handle
        id="note-arrow-single"
        type="source"
        position={Position.Right}
        className="sticky-thought__handle"
        style={{
          // 移出面板外：right 负值凸出到面板右侧，transform 置 none 避免被 translateY 偏移
          right: -22,
          top: 40,
          width: 18,
          height: 18,
          background: 'transparent',
          border: 'none',
          color: '#1e8a9a',
          fontSize: '1rem',
          lineHeight: '18px',
          textAlign: 'center',
          transform: 'none',
        }}
      >
        →
      </Handle>
    </div>
  );
}

/** 稳定哈希 → 便签颜色索引（0-3） */
function hashColorIndex(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return h % NOTE_COLORS.length;
}

export const StickyThoughtNode = memo(StickyThoughtNodeInner);