'use client';

/**
 * docx 编辑器的 React NodeView 组件（完整 Word 视觉保真）
 *
 * 把 `docx-tiptap-extensions.ts` 中定义的 table / image / listItem 节点渲染成
 * 真实 WYSIWYG 外观：
 *   - 表格：原生 <table>/<tr>/<td> + 列宽 <colgroup> + 单元格底纹/合并；
 *   - 图片：<img> 直接加载 block.imageDataUrl（data URL）；
 *   - 列表：项目符号/编号前缀 + 可编辑正文。
 *
 * 仅依赖 `@tiptap/react` 的 NodeViewWrapper / NodeViewContent。节点 schema 与
 * `lib/docx-editor/docx-schema.ts` 严格同名同形（见该文件头注释）。
 */

import React from 'react';
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

/* ---------------- 图片 ---------------- */

export function ImageNodeView({ node }: NodeViewProps) {
  const src = node.attrs.imageDataUrl as string | null;
  const w = node.attrs.imageWidthPx as number | null;
  const h = node.attrs.imageHeightPx as number | null;
  const align = (node.attrs.imageAlign as string | null) ?? 'left';
  const label = (node.attrs.label as string | null) ?? '';

  const wrap: React.CSSProperties = {
    textAlign: align === 'center' ? 'center' : align === 'right' ? 'right' : 'left',
    margin: '8px 0',
  };

  if (!src) {
    return (
      <NodeViewWrapper as="div" className="docx-image docx-image-missing" data-docx-image="1" style={wrap} contentEditable={false}>
        <div className="docx-image-frame">图片（无法显示{label ? `：${label}` : ''}）</div>
      </NodeViewWrapper>
    );
  }

  const imgStyle: React.CSSProperties = { maxWidth: '100%', height: 'auto', display: 'inline-block' };
  if (w && h) {
    imgStyle.width = `${w}px`;
    imgStyle.height = `${h}px`;
  }

  return (
    <NodeViewWrapper as="div" className="docx-image" data-docx-image="1" style={wrap} contentEditable={false}>
      <img className="docx-image-frame" src={src} style={imgStyle} alt={label} draggable={false} />
    </NodeViewWrapper>
  );
}

/* ---------------- 列表项 ---------------- */

export function ListItemNodeView({ node }: NodeViewProps) {
  const ilvl = (node.attrs.ilvl as number) ?? 0
  const marker = (node.attrs.marker as string) ?? '•';
  return (
    <NodeViewWrapper as="div" className="docx-li" data-docx-listitem="1" style={{ marginLeft: `${ilvl * 1.4}em` }}>
      <span className="docx-li-marker" contentEditable={false}>
        {marker}
      </span>
      <span className="docx-li-body">
        <NodeViewContent />
      </span>
    </NodeViewWrapper>
  );
}

/* ---------------- 表格单元格 ---------------- */

export function TableCellNodeView({ node }: NodeViewProps) {
  const colSpan = (node.attrs.colSpan as number) ?? 1;
  const rowSpan = (node.attrs.rowSpan as number) ?? 1;
  const fill = node.attrs.fill as string | null;
  const vMerge = node.attrs.vMerge as string | null;
  const align = node.attrs.align as string | null;
  const vAlign = node.attrs.vAlign as string | null;

  const style: React.CSSProperties = {};
  if (fill) style.background = `#${fill}`;
  if (align === 'center') style.textAlign = 'center';
  else if (align === 'right') style.textAlign = 'right';
  if (vAlign === 'center') style.verticalAlign = 'middle';
  else if (vAlign === 'bottom') style.verticalAlign = 'bottom';
  else style.verticalAlign = 'top';

  // 垂直合并的延续格：在 HTML 布局中隐藏（display:none 使其不占列），
  // 由起始格的 rowSpan 覆盖；内容仍保留供 ProseMirror 管理，仅不可见。
  if (vMerge === 'continue') {
    return (
      <NodeViewWrapper
        as="td"
        className="docx-tcell docx-tcell-continue"
        colSpan={colSpan}
        rowSpan={rowSpan}
        style={{ ...style, display: 'none' }}
        contentEditable={false}
      >
        <NodeViewContent />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="td" className="docx-tcell" colSpan={colSpan} rowSpan={rowSpan} style={style}>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

/* ---------------- 表格行 ---------------- */

export function TableRowNodeView() {
  return (
    <NodeViewWrapper as="tr" className="docx-trow" data-docx-trow="1">
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

/* ---------------- 表格 ---------------- */

export function TableNodeView({ node }: NodeViewProps) {
  const meta = (node.attrs.tableMeta as Record<string, unknown> | null) ?? null;
  const widths = Array.isArray(meta?.colWidthsPct) ? (meta!.colWidthsPct as number[]) : null;

  return (
    <NodeViewWrapper as="table" className="docx-table" data-docx-table="1" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
      {widths && widths.length > 0 ? (
        <colgroup>
          {widths.map((w, i) => (
            <col key={i} style={{ width: `${w}%` }} />
          ))}
        </colgroup>
      ) : null}
      <NodeViewContent<'tbody'> as="tbody" />
    </NodeViewWrapper>
  );
}
