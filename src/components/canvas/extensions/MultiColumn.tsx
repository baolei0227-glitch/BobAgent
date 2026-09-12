'use client';

// 多栏容器 MVP：bobColumns（容器，flex 并排）+ bobColumn（单栏，内含 block+ 序列）。
// - 编辑：React NodeView 提供栏头工具（左右互换 / 移除整块），栏内为真实 PM block 序列，可正常输入与块内排序。
// - Markdown 往返：序列化为自定义 fence ```bob-columns + JSON（每栏 md 字符串）；解析时把 fence 渲染回
//   双/三栏 HTML，经 tiptap-markdown 的 parse.setup/ serialize 钩子接入（对齐问卷块先例，Markdown 文件保持合法）。

import { mergeAttributes, Node, type CommandProps } from '@tiptap/core';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    bobColumns: {
      /** 在光标处插入两栏/三栏容器（每栏一个空段落） */
      insertBobColumns: (count?: 2 | 3) => ReturnType;
      /** 左右互换当前所在 bobColumns 容器的各栏顺序 */
      swapBobColumns: () => ReturnType;
      /** 移除当前所在 bobColumns 容器（退化为第一栏内容，保证文档合法） */
      removeBobColumns: () => ReturnType;
    };
  }
}

/** tiptap-markdown 运行时附带的 parser/serializer（类型声明未公开，这里按实际结构收窄） */
interface MarkdownRuntime {
  parser: { parse(text: string, opts?: { inline?: boolean }): string };
  serializer: { serialize(fragment: unknown): string };
}

function markdownRuntime(editor: { storage: Record<string, unknown> }): MarkdownRuntime | null {
  const store = editor.storage.markdown as { parser?: MarkdownRuntime['parser']; serializer?: MarkdownRuntime['serializer'] } | undefined;
  if (!store?.parser || !store?.serializer) return null;
  return { parser: store.parser, serializer: store.serializer };
}

export const BobColumn = Node.create({
  name: 'bobColumn',
  group: 'block',
  content: 'block+',
  parseHTML() {
    return [{ tag: 'div[data-bob-column]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-bob-column': '' })];
  },
});

export const BobColumns = Node.create({
  name: 'bobColumns',
  group: 'block',
  content: 'bobColumn+',
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-bob-columns]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-bob-columns': '' })];
  },
  addCommands() {
    return {
      insertBobColumns:
        (count = 2) =>
        ({ editor }: CommandProps) => {
          const { bobColumn, bobColumns, paragraph } = editor.schema.nodes;
          if (!bobColumn || !bobColumns || !paragraph) return false;
          const cols = Array.from({ length: count }, () => bobColumn.create(null, paragraph.create()));
          return editor.chain().focus().insertContent(bobColumns.create(null, cols)).run();
        },
      swapBobColumns:
        () =>
        ({ editor }: CommandProps) => {
          const { state } = editor;
          const $from = state.selection.$from;
          for (let d = $from.depth; d >= 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'bobColumns') {
              const start = $from.before(d);
              const end = start + node.nodeSize;
              const reversed = Array.from({ length: node.childCount }, (_v, i) => node.child(node.childCount - 1 - i).toJSON());
              const replacement = node.type.create(node.attrs, reversed.map((j) => state.schema.nodeFromJSON(j)));
              editor.chain().focus().insertContentAt({ from: start, to: end }, replacement).run();
              return true;
            }
          }
          return false;
        },
      removeBobColumns:
        () =>
        ({ editor }: CommandProps) => {
          const { state } = editor;
          const $from = state.selection.$from;
          for (let d = $from.depth; d >= 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'bobColumns') {
              const start = $from.before(d);
              const end = start + node.nodeSize;
              // 退化为第一栏内的块序列（解包单栏外壳），保证文档结构合法
              const firstCol = node.child(0);
              const tr = state.tr.replaceWith(start, end, firstCol.content);
              editor.view.dispatch(tr);
              editor.chain().focus().run();
              return true;
            }
          }
          return false;
        },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(BobColumnsView);
  },
  // tiptap-markdown 自定义往返：编辑器里仍用 PM 节点，保存/读取经 markdown fence
  addStorage() {
    return {
      markdown: {
        serialize(
          this: { editor: { storage: Record<string, unknown> } },
          state: { write(t: string): void; ensureNewLine?(): void },
          node: { childCount: number; child(i: number): { content: unknown } },
        ) {
          const rt = markdownRuntime(this.editor);
          const cols: string[] = [];
          for (let i = 0; i < node.childCount; i++) {
            cols.push(rt ? rt.serializer.serialize(node.child(i).content).trim() : '');
          }
          state.ensureNewLine?.();
          state.write('```bob-columns\n');
          state.write(JSON.stringify({ cols }));
          state.write('\n```\n');
          state.write('\n');
        },
        parse: {
          setup(md: {
            render(text: string, env?: unknown): string;
            renderer: { rules: { fence: (tokens: unknown[], idx: number, opts: unknown, env: unknown, self: unknown) => string } };
          }) {
            const originalFence = md.renderer.rules.fence.bind(md.renderer);
            md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
              const token = tokens[idx] as { info?: string };
              const info = (token.info || '').trim();
              if (info.startsWith('bob-columns')) {
                try {
                  const payload = JSON.parse((tokens[idx] as { content?: string }).content || '{}') as { cols?: string[] };
                  const cols = payload.cols || [];
                  const inner = cols
                    .map((colMd) => `<div data-bob-column>${md.render(colMd || '', env)}</div>`)
                    .join('\n');
                  return `<div data-bob-columns>${inner}</div>`;
                } catch {
                  // JSON 不合法：按普通代码块回退
                }
              }
              return originalFence(tokens, idx, opts, env, self);
            };
          },
        },
      },
    };
  },
});

/** 栏头操作条：左右互换 / 移除多栏（contentEditable=false，不进入正文） */
function BobColumnsView({ node, editor }: NodeViewProps) {
  const count = node.childCount;
  return (
    <NodeViewWrapper className="bob-columns-wrap" data-cols={count}>
      <div className="bob-columns-bar" contentEditable={false}>
        <span className="bob-columns-label">{count === 2 ? 'Two Columns' : 'Three Columns'}</span>
        <button type="button" title="Swap columns left-right" onClick={() => editor.chain().swapBobColumns().run()}>
          ⇄
        </button>
        <button type="button" title="Remove columns block" onClick={() => editor.chain().removeBobColumns().run()}>
          ×
        </button>
      </div>
      {/* NodeViewContent 自身即 .bob-columns-body（默认渲染为 div）：
          直接作为各栏的父容器，保证 `.bob-columns-body > [data-bob-column]` 样式命中 */}
      <NodeViewContent className="bob-columns-body" />
    </NodeViewWrapper>
  );
}
