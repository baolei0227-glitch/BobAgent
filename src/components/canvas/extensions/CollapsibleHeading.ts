'use client';

// 自定义标题扩展：继承 @tiptap/extension-heading，用 NodeView 渲染标题 wrapper，
// data-pos 记录标题位置（目录滚动定位依赖此属性），命令行为与内置 Heading 一致。
// （标题折叠功能已按需求移除，此处不再渲染折叠箭头）

import { Heading } from '@tiptap/extension-heading';

export const CollapsibleHeading = Heading.extend({
  addNodeView() {
    return ({ node, getPos }) => {
      const level = node.attrs.level as number;
      const wrapper = document.createElement('div');
      wrapper.className = 'doc-heading';
      // 记录标题位置：目录滚动时据此定位
      wrapper.setAttribute('data-pos', String(getPos()));

      const content = document.createElement(`h${Math.min(Math.max(level, 1), 6)}`);
      content.className = 'doc-heading-content';

      wrapper.appendChild(content);

      return {
        dom: wrapper,
        contentDOM: content,
        // 保持 NodeView 不重建（返回 true）：标题文本变化时 contentDOM 由 ProseMirror
        // 自动同步；仅标题层级变化时重建
        update(updatedNode) {
          if (updatedNode.attrs.level !== level) return false;
          return true;
        },
      };
    };
  },
});
