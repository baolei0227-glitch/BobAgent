'use client';

/**
 * AnnotationNode — 批注框节点（画布级分组批注）
 *
 * 定位（2026-08-28 用户确认）：
 *   - 画布级分组批注框：圆角矩形虚线框包裹所选卡片（存量数据；新建入口已于 2026-09-05
 *     随画布便签移除停用），自动跟随包围盒。
 *   - 仅作视觉分组批注：零 AI、无连线 Handle、不参与排版/NodeMap/簇联动（CanvasFlow 侧过滤）。
 *   - 顶部批注栏：双击编辑文字（update_annotation 持久化）、删除按钮（不影响卡片）。
 *   - 交互边界：框体视觉层 pointer-events:none（不挡下方卡片点击/拖拽），
 *     仅顶部批注栏可交互（拖动节点 = 联动移动内部卡片，由 CanvasFlow onNodeDrag 处理）。
 */
import { memo, useCallback, useState } from 'react';
import { NodeProps, useReactFlow } from '@xyflow/react';
import { X, PenLine } from 'lucide-react';
import type { AiChatNodeData } from '@/lib/types';

function AnnotationNodeInner({ id, data, selected }: NodeProps) {
  const nodeData = data as AiChatNodeData;
  const nodeMdId = nodeData.nodeMdId || id;
  const text = typeof nodeData.annotationText === 'string' ? nodeData.annotationText : '';
  const w = typeof nodeData.annotationWidth === 'number' ? nodeData.annotationWidth : 200;
  const h = typeof nodeData.annotationHeight === 'number' ? nodeData.annotationHeight : 120;
  const { deleteElements } = useReactFlow();

  const [displayText, setDisplayText] = useState(text);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // 保存批注文字：空文字保持原标题？空则清空展示（仍可后续补写）
  const saveText = useCallback(
    (value: string) => {
      const cleaned = value.trim();
      setEditing(false);
      setDisplayText(cleaned);
      fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_annotation', node_id: nodeMdId, text: cleaned }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (!res.success) console.warn('[annotation] 保存失败:', res.error);
        })
        .catch((e) => console.warn('[annotation] 保存失败:', String(e)));
    },
    [nodeMdId],
  );

  // 删除批注框：仅删框节点，不影响被包裹的卡片
  const handleDelete = useCallback(() => {
    fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', node_id: nodeMdId }),
    }).catch((e) => console.warn('[annotation] 删除后端失败:', String(e)));
    deleteElements({ nodes: [{ id }] });
  }, [id, nodeMdId, deleteElements]);

  return (
    <div
      className="annotation-node"
      style={{
        width: Math.max(w, 160),
        height: Math.max(h, 90),
        position: 'relative',
      }}
    >
      {/* 视觉层：圆角矩形虚线框 + 淡黄玻璃底，不拦截卡片交互 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 12,
          border: '1.5px dashed rgba(255, 205, 80, 0.55)',
          background: 'rgba(255, 244, 196, 0.16)',
          pointerEvents: 'none',
          boxShadow: selected
            ? '0 0 0 1px rgba(255,205,80,0.35), 0 0 20px 5px rgba(255,196,60,0.28)'
            : undefined,
        }}
      />

      {/* 顶部批注栏：双击编辑文字 + 删除；拖动点（联动内部卡片） */}
      <div
        className="annotation-node__bar"
        style={{
          position: 'absolute',
          top: 6,
          left: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          maxWidth: 'calc(100% - 44px)',
          padding: '2px 8px',
          borderRadius: 8,
          background: 'rgba(255, 244, 196, 0.92)',
          border: '1px solid rgba(255, 205, 80, 0.5)',
          color: '#5A4612',
          fontSize: '0.8rem',
          cursor: 'move',
        }}
      >
        <PenLine size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
        {editing ? (
          <input
            autoFocus
            className="nodrag"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => saveText(draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); saveText(draft); }
              if (e.key === 'Escape') { setEditing(false); }
            }}
            placeholder="批注…"
            spellCheck={false}
            style={{
              border: 'none', background: 'transparent', color: 'inherit',
              outline: 'none', fontSize: '0.8rem', minWidth: 60,
            }}
          />
        ) : (
          <span
            onDoubleClick={() => { setDraft(displayText); setEditing(true); }}
            title={displayText ? `${displayText}（双击编辑）` : '双击添加批注'}
            style={{
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              cursor: 'pointer', maxWidth: 170,
            }}
          >
            {displayText || '批注'}
          </span>
        )}
        <button
          type="button"
          onClick={handleDelete}
          className="nodrag"
          title="删除批注框（不影响卡片）"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 14, height: 14, borderRadius: 3, border: 'none',
            background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.55,
          }}
        >
          <X size={10} />
        </button>
      </div>
    </div>
  );
}

export const AnnotationNode = memo(AnnotationNodeInner);
