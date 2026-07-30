'use client';

import { useEffect, useRef, useState } from 'react';

interface MermaidRendererProps {
  content: string;
}

/** 将文本中的 mermaid 代码块渲染为 SVG 图表，其他内容保持原样 */
export function MermaidRenderer({ content }: MermaidRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mermaidLoaded, setMermaidLoaded] = useState(false);

  // 动态加载 mermaid
  useEffect(() => {
    if ((window as any).mermaid) {
      setMermaidLoaded(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
    script.onload = () => {
      (window as any).mermaid?.initialize?.({ startOnLoad: false, theme: 'default' });
      setMermaidLoaded(true);
    };
    document.head.appendChild(script);
    return () => {
      // 不卸载，全局复用
    };
  }, []);

  useEffect(() => {
    if (!mermaidLoaded || !containerRef.current) return;

    // 找到所有 mermaid 代码块并渲染
    const blocks = containerRef.current.querySelectorAll('.mermaid-block');
    blocks.forEach(async (block, idx) => {
      const code = block.getAttribute('data-code') || '';
      if (!code) return;
      try {
        const mermaid = (window as any).mermaid;
        if (!mermaid) return;
        const id = `mermaid-svg-${Date.now()}-${idx}`;
        const { svg } = await mermaid.render(id, code);
        block.innerHTML = svg;
      } catch {
        // 渲染失败则显示原始代码
        block.textContent = code;
      }
    });
  }, [mermaidLoaded, content]);

  if (!content) return null;

  // 解析内容：分离 mermaid 代码块和普通文本
  const parts: { type: 'text' | 'mermaid'; content: string }[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'mermaid', content: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) });
  }

  return (
    <div ref={containerRef}>
      {parts.map((part, i) =>
        part.type === 'mermaid' ? (
          <div
            key={i}
            className="mermaid-block my-3 flex justify-center overflow-x-auto rounded-lg border p-3"
            data-code={part.content}
            style={{
              borderColor: 'oklch(0.80 0.03 60 / 0.3)',
              backgroundColor: 'oklch(0.98 0.005 90)',
            }}
          >
            <div className="flex items-center gap-2 text-[11px]" style={{ color: '#8a8270' }}>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
              图表加载中...
            </div>
          </div>
        ) : (
          <span key={i} className="whitespace-pre-wrap break-words">{part.content}</span>
        ),
      )}
    </div>
  );
}
