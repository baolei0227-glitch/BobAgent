'use client';

// Mermaid 代码块扩展：在 DocEditor 中把 ```mermaid 代码块渲染为图表
// 基于 @ktrysmt/beautiful-mermaid（同步渲染 SVG，零闪屏，暖纸感配色映射）
//
// 说明：
// - 仅覆盖 NodeView；代码块语法高亮由 CodeBlockLowlight 的 LowlightPlugin（ProseMirror decorations）提供，不受影响
// - beautiful-mermaid 支持 flowchart / state / sequence / class / ER / xychart 六类；
//   其他类型（gantt / pie / mindmap 等）渲染失败时回退为可编辑源码块
// - 非 mermaid 代码块保持原样渲染

import { useMemo } from 'react';
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { renderMermaidSVG } from '@ktrysmt/beautiful-mermaid';
import { useWidgetTheme, fixTimelineTextOverflow, applyAppleSemanticTints } from '../WidgetRenderer';
import { getMermaidRenderColors, getWidgetTokens } from '@/lib/widget-theme';

// Mermaid 图表类型关键词：用于自动识别没有显式 mermaid 语言标签的代码块
const MERMAID_TYPE_PATTERN = /^(flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie\b|gitGraph|mindmap|timeline|xychart|block\b|quadrantChart|sankey|journey|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/;

function MermaidCodeBlockView({ node }: NodeViewProps) {
  const language = (node.attrs.language as string) || '';
  const code = node.textContent;
  const dark = useWidgetTheme();
  // 显式标记 mermaid（含 BobWork widget 格式 ```widget:mermaid），或自动检测 mermaid 图表语法
  const isMermaid =
    language === 'mermaid' ||
    language === 'widget:mermaid' ||
    (!language && MERMAID_TYPE_PATTERN.test(code.trim()));

  // 同步渲染 SVG（useMemo 避免重复渲染）— 配色跟随宿主主题
  const svg = useMemo(() => {
    if (!isMermaid || !code.trim()) return '';
    try {
      const raw = renderMermaidSVG(code, {
        ...getMermaidRenderColors(getWidgetTokens(dark)),
        transparent: true,
        padding: 16,
      });
      return applyAppleSemanticTints(fixTimelineTextOverflow(raw), dark);
    } catch {
      return '';
    }
  }, [isMermaid, code, dark]);

  // Mermaid 块：渲染为图表；渲染失败时回退为可编辑源码块
  if (isMermaid) {
    return (
      <NodeViewWrapper as="div" className="mermaid-code-block" data-widget-theme={dark ? 'dark' : 'light'}>
        {svg ? (
          <>
            <div
              className="mermaid-svg"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            {/* 内容保留在隐藏 contentDOM 中，保证节点可序列化、不丢失源码 */}
            <NodeViewContent
              className="mermaid-source"
              style={{ display: 'none' }}
            />
          </>
        ) : (
          <pre className="code-block">
            <NodeViewContent className="code-block-content" />
          </pre>
        )}
      </NodeViewWrapper>
    );
  }

  // 普通代码块：保持原样（低亮由 LowlightPlugin decorations 提供）
  return (
    <NodeViewWrapper as="pre" className="code-block">
      <NodeViewContent className={`code-block-content language-${language}`} />
    </NodeViewWrapper>
  );
}

export const MermaidCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockView);
  },
});
