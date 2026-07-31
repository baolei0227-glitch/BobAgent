'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { Pencil, Send, Search, Copy, Check } from 'lucide-react';

export interface NodeItem {
  id: string;
  title: string;
}

interface TextSelectionActionsProps {
  selectedText: string;
  selectionPos: { x: number; y: number };
  nodes: NodeItem[];
  onEdit: () => void;
  onSendToNode: (targetNodeId: string) => void;
  onDismiss: () => void;
}

const BUTTON_WIDTH = 80;
const BUTTON_HEIGHT = 36;

function clampPos(x: number, y: number) {
  const pad = 8;
  return {
    left: Math.min(Math.max(x, pad), window.innerWidth - BUTTON_WIDTH - pad),
    top: Math.min(Math.max(y, pad), window.innerHeight - BUTTON_HEIGHT - pad),
  };
}

export function TextSelectionActions({
  selectedText,
  selectionPos,
  nodes,
  onEdit,
  onSendToNode,
  onDismiss,
}: TextSelectionActionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const [clamped] = useState(() => clampPos(selectionPos.x, selectionPos.y));
  const [visible, setVisible] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(timer);
  }, []);

  useEffect(() => {
    // 优先从当前选区获取 Range，如果已丢失则从 mouseup 时同步保存的 Range 恢复
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    } else if ((window as any).__textSelectionRange) {
      savedRangeRef.current = (window as any).__textSelectionRange;
      // 恢复浏览器原生高亮
      if (sel && savedRangeRef.current) {
        sel.removeAllRanges();
        sel.addRange(savedRangeRef.current);
      }
    }
  }, []);

  // 点击外部关闭
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onDismiss]);

  // Esc 关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pickerOpen) {
          setPickerOpen(false);
          setQuery('');
          return;
        }
        onDismiss();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onDismiss, pickerOpen]);

  // 打开 picker 时聚焦搜索框
  useEffect(() => {
    if (pickerOpen) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [pickerOpen]);

  const filteredNodes = useMemo(() => {
    if (!query) return nodes;
    const q = query.toLowerCase();
    return nodes.filter(n => n.title.toLowerCase().includes(q));
  }, [nodes, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [filteredNodes]);

  const handleEdit = () => {
    onEdit();
    requestAnimationFrame(() => {
      if (savedRangeRef.current) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(savedRangeRef.current);
      }
    });
  };

  const handleCopy = () => {
    if (!selectedText) return;
    navigator.clipboard.writeText(selectedText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // clipboard API failed, ignore
    });
  };

  const handleSend = (nodeId: string) => {
    onSendToNode(nodeId);
    setPickerOpen(false);
    setQuery('');
  };

  const handlePickerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, filteredNodes.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredNodes[activeIndex]) {
        handleSend(filteredNodes[activeIndex].id);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className="text-selection-actions fixed z-[200]"
      data-canvas-ui="overlay"
      style={{
        left: clamped.left,
        top: clamped.top,
        opacity: visible ? 1 : 0,
        transform: `translateY(${visible ? '0' : '4px'})`,
        transition: 'opacity 0.15s ease, transform 0.15s ease',
        userSelect: 'none',
      }}
      onMouseDownCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* 节点选择器 */}
      {pickerOpen && (
        <div
          className="absolute bottom-full left-0 mb-2 w-64 rounded-lg shadow-xl overflow-hidden"
          style={{
            backgroundColor: '#faf8f3',
            border: '1px solid oklch(0.80 0.03 60 / 0.4)',
          }}
        >
          <div className="flex items-center gap-1.5 px-2.5 py-2 border-b" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
            <Search className="h-3 w-3 shrink-0" style={{ color: '#8a8270' }} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handlePickerKey}
              placeholder="搜索节点..."
              className="flex-1 bg-transparent outline-none text-[12px]"
              style={{ color: '#2c2416' }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto ai-canvas-scroll py-1">
            {filteredNodes.length === 0 ? (
              <div className="px-3 py-2 text-[11px]" style={{ color: '#8a8270' }}>无匹配节点</div>
            ) : (
              filteredNodes.map((n, i) => (
                <button
                  key={n.id}
                  onClick={() => handleSend(n.id)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors"
                  style={{
                    backgroundColor: i === activeIndex ? 'oklch(0.95 0.01 80)' : 'transparent',
                    color: '#2c2416',
                  }}
                >
                  <Send className="h-2.5 w-2.5 shrink-0" style={{ color: 'oklch(0.50 0.12 180)' }} />
                  <span className="truncate">{n.title || n.id.slice(0, 8)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* 按钮组 */}
      <div
        className="flex items-center rounded-full shadow-lg"
        style={{
          backgroundColor: 'oklch(0.97 0.015 80)',
          border: '1.5px solid oklch(0.80 0.03 60 / 0.4)',
          boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
          padding: '3px',
        }}
      >
        <button
          onClick={handleCopy}
          onMouseDown={(e) => e.preventDefault()}
          className="flex items-center justify-center rounded-full transition-colors hover:bg-[oklch(0.90_0.02_85)]"
          style={{ width: '28px', height: '28px', userSelect: 'none' }}
          title="复制"
        >
          {copied
            ? <Check className="h-3.5 w-3.5 pointer-events-none" style={{ color: 'oklch(0.55 0.15 145)' }} />
            : <Copy className="h-3.5 w-3.5 pointer-events-none" style={{ color: 'oklch(0.42 0.02 45)' }} />}
        </button>

        <span style={{ width: '1px', height: '16px', backgroundColor: 'oklch(0.75 0.02 60 / 0.4)', margin: '0 3px' }} />

        <button
          onClick={handleEdit}
          onMouseDown={(e) => e.preventDefault()}
          className="flex items-center justify-center rounded-full transition-colors hover:bg-[oklch(0.90_0.02_85)]"
          style={{ width: '28px', height: '28px', userSelect: 'none' }}
          title="编辑选中文字"
        >
          <Pencil className="h-3.5 w-3.5 pointer-events-none" style={{ color: 'oklch(0.42 0.02 45)' }} />
        </button>

        <span style={{ width: '1px', height: '16px', backgroundColor: 'oklch(0.75 0.02 60 / 0.4)', margin: '0 3px' }} />

        <button
          onClick={() => setPickerOpen(!pickerOpen)}
          onMouseDown={(e) => e.preventDefault()}
          className="flex items-center justify-center rounded-full transition-colors hover:bg-[oklch(0.90_0.02_85)]"
          style={{ width: '28px', height: '28px', userSelect: 'none' }}
          title="发送到节点"
        >
          <Send className="h-3.5 w-3.5 pointer-events-none" style={{ color: 'oklch(0.42 0.12 180)' }} />
        </button>
      </div>
    </div>
  );
}
