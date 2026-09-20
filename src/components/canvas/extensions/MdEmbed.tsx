'use client';

// 文档嵌入扩展：`![[路径]]` → 嵌入卡片 NodeView
//
// 编辑器内把 `![[homework/report.md]]` 渲染为一张可折叠的嵌入卡片：
// - 折叠态只显示文档名（标题 + 来源）；
// - 点击卡片展开，向宿主（DocEditor）请求目标文档内容并预览部分内容；
// - 右上角打开按钮跳转到目标文档分享页 / 编辑器打开；
// 阅读/分享时由服务端 expandEmbeds 展开为完整内容。
// markdown 序列化：卡片 → `![[路径]]`（保持源文本可移植）。

import { useEffect, useRef, useState } from 'react';
import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { FileText, ExternalLink, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

/** 预览请求序号：NodeView 与宿主通过 rid 对账，避免旧响应串卡 */
let previewSeq = 0;

/** 嵌入卡片 NodeView 组件：折叠显示文档名；展开拉取目标文档内容预览 */
function MdEmbedView({ node }: NodeViewProps) {
  const path = (node.attrs.path as string) || '';
  const label = path.split('/').pop()?.replace(/\.md$/i, '') || path;
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const ridRef = useRef<number>(0);

  // 监听宿主返回的预览内容（按 rid 匹配当前卡片）
  useEffect(() => {
    const onResult = (e: Event) => {
      const d = (e as CustomEvent<{ rid: number; ok: boolean; text?: string }>).detail;
      if (!d || d.rid !== ridRef.current) return;
      setLoading(false);
      if (d.ok && d.text) {
        setPreview(d.text);
        setFailed(false);
      } else {
        setFailed(true);
      }
    };
    window.addEventListener('md-embed-preview-result', onResult);
    return () => window.removeEventListener('md-embed-preview-result', onResult);
  }, []);

  const toggleExpand = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    // 首次展开且无缓存 → 向宿主请求内容预览（超时降级为「无法预览」）
    if (preview === null && !failed) {
      setLoading(true);
      const rid = ++previewSeq;
      ridRef.current = rid;
      window.dispatchEvent(new CustomEvent('md-embed-preview-request', { detail: { path, rid } }));
      window.setTimeout(() => {
        if (ridRef.current === rid) {
          setLoading(false);
          setFailed(true);
        }
      }, 1500);
    }
  };

  const openDoc = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('md-embed-open', { detail: { path } }));
  };

  return (
    <NodeViewWrapper
      as="div"
      className="md-embed-card"
      data-path={path}
      title={`Embedded document: ${path}`}
      contentEditable={false}
    >
      <div className="md-embed-head" onClick={toggleExpand}>
        <span className="md-embed-icon-wrap">
          <FileText className="md-embed-icon" />
        </span>
        <span className="md-embed-text">
          <span className="md-embed-label">{label}</span>
          <span className="md-embed-sub">嵌入文档 · 点击展开预览</span>
        </span>
        <span className="md-embed-tools">
          <span className="md-embed-open" role="button" title="Open document" onClick={openDoc}>
            <ExternalLink className="md-embed-open-icon" />
          </span>
          <span className="md-embed-chevron">
            {expanded ? <ChevronUp className="md-embed-open-icon" /> : <ChevronDown className="md-embed-open-icon" />}
          </span>
        </span>
      </div>
      {expanded && (
        <div className="md-embed-preview">
          {loading ? (
            <span className="md-embed-preview-state">
              <Loader2 className="md-embed-spin" size={12} /> 加载预览…
            </span>
          ) : preview ? (
            <pre className="md-embed-preview-text">{preview}</pre>
          ) : (
            <span className="md-embed-preview-state">
              {failed ? '无法预览（文档不可读），点击右上角打开' : ''}
            </span>
          )}
        </div>
      )}
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
