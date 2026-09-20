'use client';

// 可拖拽调整大小的正文图片：原生 @tiptap/extension-image + resize NodeView（左右手柄等比缩放），
// 并把尺寸写进 Markdown，供分享卡就地编辑器与文档编辑器共用。

import Image from '@tiptap/extension-image';

/** prosemirror-markdown 序列化状态（只需这几个方法；不直接引 prosemirror-markdown，避免幽灵依赖） */
interface MdSerializeState {
  write: (content: string) => void;
  esc: (text: string) => string;
  closeBlock: (node: unknown) => void;
}

/** 序列化所需的最小节点形状（只读 attrs + isBlock） */
interface MdImageNode {
  attrs: { src?: string | null; alt?: string | null; title?: string | null; width?: number | string | null };
  isBlock: boolean;
}

/** HTML 属性转义：附件路径带 ? & = ，alt 可能带引号 */
function escapeHtmlAttr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 尺寸为什么必须落进 Markdown：两处都不读编辑器 DOM，而是拿 Markdown 重新渲染
 * （分享卡：BrandCard → ShareContent → HtmlRenderer；文档：读回 md → setContent），
 * 尺寸不进 Markdown 就会在导出/重开后丢失。
 * 为什么用 HTML 形式：Markdown 图片语法 ![alt](src) 不携带尺寸，带尺寸时改写为
 * <img src alt width>（Markdown 配置已开 html: true，原文不丢；编辑器再解析时
 * img[src] 规则会把 width 读回节点属性）。
 * 样式还原：sanitize 白名单放行 img[width]（见 lib/sanitize-whitelist.ts），
 * globals.css 对分享卡/文档编辑器取消「压制内联宽高」，居中与拖拽手柄外观也在那里。
 */
export const ResizableImage = Image.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MdSerializeState, node: MdImageNode) {
          const width = Math.round(Number(node.attrs.width) || 0);
          if (!width) {
            // 未调整尺寸：与原生序列化行为一致（标准 Markdown 图片语法，title 可选）
            const src = String(node.attrs.src ?? '').replace(/[()]/g, '\\$&');
            const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
            state.write(`![${state.esc(node.attrs.alt || '')}](${src}${title})`);
            return;
          }
          state.write(
            `<img src="${escapeHtmlAttr(node.attrs.src)}" alt="${escapeHtmlAttr(node.attrs.alt)}" width="${width}">`,
          );
          // 块级节点：写入后闭合块，否则会与后一段落黏在同一行（HTML 块需空行分隔）
          if (node.isBlock) state.closeBlock(node);
        },
      },
    };
  },
});

/** 拖拽配置：左右手柄 + 等比缩放 + 最小宽度；多个编辑器各取一份实例（扩展实例不可复用） */
export function createResizableImage() {
  return ResizableImage.configure({
    resize: {
      enabled: true,
      directions: ['left', 'right'],
      minWidth: 60,
      alwaysPreserveAspectRatio: true,
    },
  });
}