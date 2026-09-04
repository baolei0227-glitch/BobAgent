'use client';

// 文档嵌入扩展：`![[路径]]` → 嵌入卡片 NodeView
//
// 编辑器内把 `![[homework/report.md]]` 渲染为一张可点击的嵌入卡片（标题 + 来源），
// 点击跳转到目标文档分享页 / 编辑器打开；阅读/分享时由服务端 expandEmbeds 展开为完整内容。
// markdown 序列化：卡片 → `![[路径]]`（保持源文本可移植）。

import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { FileText, ExternalLink } from 'lucide-react';

/** 嵌入卡片 NodeView 组件：显示文档名，点击在应用内打开目标文档（由宿主监听事件处理） */
function MdEmbedView({ node }: NodeViewProps) {
  const path = (node.attrs.path as string) || '';
  const label = path.split('/').pop()?.replace(/\.md$/i, '') || path;

  return (
    <NodeViewWrapper
      as="div"
      className="md-embed-card"
      data-path={path}
      onClick={(e: React.MouseEvent) => {
        // 交给宿主处理（DocEditor 监听 md-embed-open 事件打开目标文档）
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('md-embed-open', { detail: { path } }));
      }}
      title={`嵌入文档：${path}（点击打开）`}
    >
      <span className="md-embed-icon-wrap">
        <FileText className="md-embed-icon" />
      </span>
      <span className="md-embed-text">
        <span className="md-embed-label">{label}</span>
        <span className="md-embed-sub">嵌入文档</span>
      </span>
      <ExternalLink className="md-embed-open" />
    </NodeViewWrapper>
  );
}

/** 文档嵌入节点（block atom：独占一行，卡片整体不可编辑内部文本，只能删除/替换） */
export const MdEmbed = Node.create({
  name: 'mdEmbed',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: { default: '' },
    };
  },

  parseHTML() {
    return [
      { tag: 'div[data-md-embed]', getAttrs: (el) => ({ path: (el as HTMLElement).getAttribute('data-path') || '' }) },
      // 兼容旧的 inline span 序列化（历史文档升级后仍可反解）
      { tag: 'span[data-md-embed]', getAttrs: (el) => ({ path: (el as HTMLElement).getAttribute('data-path') || '' }) },
    ];
  },

  renderHTML({ node }) {
    return ['div', { 'data-md-embed': 'true', 'data-path': node.attrs.path as string }, node.attrs.path as string];
  },

  renderText({ node }) {
    return `![[${node.attrs.path as string}]]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MdEmbedView);
  },

  // tiptap-markdown 双向序列化：卡片 ↔ `![[路径]]`
  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (text: string) => void }, node: { attrs: { path: string } }) {
          state.write(`![[${node.attrs.path}]]`);
        },
        parse: {
          setup(markdownit: {
            renderer: { rules: Record<string, unknown> };
          }) {
            // 让 markdown-it 把 `![[path]]` 文本渲染为嵌入占位 span，
            // 随后由本扩展的 parseHTML 反解为嵌入节点
            const defaultRule = markdownit.renderer.rules.text;
            markdownit.renderer.rules.text = (tokens: Array<{ content: string }>, idx: number, options: unknown, env: unknown, self: unknown) => {
              const content = tokens[idx]?.content ?? '';
              if (!content.includes('![[')) {
                return typeof defaultRule === 'function' ? defaultRule(tokens, idx, options, env, self) : content;
              }
              return content.replace(/!\[\[([^\]\n]+)\]\]/g, (_m, p: string) => `<span data-md-embed="true" data-path="${p.replace(/"/g, '&quot;')}">![[${p}]]</span>`);
            };
          },
        },
      },
    };
  },
});
