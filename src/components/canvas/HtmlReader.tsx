'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, FileText, Lightbulb, ChevronDown, ChevronRight, AlertCircle, RefreshCw, ChevronsRight, ChevronsLeft } from 'lucide-react';
import { HtmlRenderer } from './HtmlRenderer';

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) return { frontmatter: `---\n${match[1]}\n---\n`, body: match[2] };
  return { frontmatter: '', body: content };
}

interface NodeData {
  node_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  sources: string[];
  model?: string;
  mood?: {
    vibe?: string[];
    sparks?: string[];
    reflections?: string[];
    will?: string[];
  };
  tags?: string[];
  summary: string;
  conversations: Array<{ question: string; answer: string; questionTime: string; answerTime: string }>;
  annotations: string;
  stickies: string[];
}

interface HtmlReaderProps {
  nodeMdId?: string | null;
  filePath?: string;
  projectId?: string;
  fileName?: string;
  onClose: (id: string) => void;
  zIndex?: number;
  onClickToFront?: (id: string) => void;
  onToggleCollapse?: () => void;
  mode?: 'standalone' | 'tabbed' | 'floating';
}

const MOOD_COLORS: Record<string, string> = {
  vibe: '#c0392b',
  sparks: '#d4a017',
  reflections: '#537D96',
  will: '#27ae60',
};

const MOOD_LABELS: Record<string, string> = {
  vibe: 'Vibe',
  sparks: 'Sparks',
  reflections: 'Reflections',
  will: 'Will',
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function HtmlReader({ nodeMdId, filePath, projectId, fileName, onClose, zIndex = 50, onClickToFront, onToggleCollapse, mode = 'standalone' }: HtmlReaderProps) {
  const [nodeData, setNodeData] = useState<NodeData | null>(null);
  const [content, setContent] = useState(''); // .md body（去掉 frontmatter）
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [moodExpanded, setMoodExpanded] = useState(false);

  // 选中文字引用
  const [selectedText, setSelectedText] = useState('');
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fetchKeyRef = useRef(0);

  // 当前显示用的 id（node 模式用 nodeMdId，通用模式用 filePath）
  const displayId = nodeMdId || filePath || '';
  const displayName = nodeMdId ? (nodeData?.title || 'Loading...') : (fileName || filePath?.split('/').pop() || 'Document');

  // =========== 加载逻辑 ===========

  const loadNodeDocument = useCallback(async (retryCount = 0) => {
    if (!nodeMdId) return;
    const key = ++fetchKeyRef.current;
    setError(null);
    setLoading(true);

    const MAX_RETRIES = 2;

    try {
      const [nodeResp, rawResp] = await Promise.all([
        fetch(`/api/nodes?id=${nodeMdId}`).then(r => r.json()),
        fetch(`/api/nodes?id=${nodeMdId}&action=raw`).then(r => r.json()),
      ]);

      if (key !== fetchKeyRef.current) return;

      if (nodeResp.success) {
        setNodeData(nodeResp.node);
      }

      if (rawResp.success && rawResp.content) {
        const { body } = splitFrontmatter(rawResp.content);
        setContent(body);
        setError(null);
      } else {
        const errMsg = rawResp.error || 'Failed to load document';
        if (retryCount < MAX_RETRIES) {
          console.warn(`[HtmlReader] 加载失败，${500 * (retryCount + 1)}ms 后重试 (${retryCount + 1}/${MAX_RETRIES}):`, errMsg);
          await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
          if (key !== fetchKeyRef.current) return;
          return loadNodeDocument(retryCount + 1);
        }
        setError(errMsg);
      }
    } catch (e) {
      if (key !== fetchKeyRef.current) return;
      const errMsg = e instanceof Error ? e.message : 'Network request failed';
      if (retryCount < MAX_RETRIES) {
        console.warn(`[HtmlReader] 网络错误，${500 * (retryCount + 1)}ms 后重试 (${retryCount + 1}/${MAX_RETRIES}):`, errMsg);
        await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
        if (key !== fetchKeyRef.current) return;
        return loadNodeDocument(retryCount + 1);
      }
      setError(errMsg);
    } finally {
      if (key === fetchKeyRef.current) {
        setLoading(false);
      }
    }
  }, [nodeMdId]);

  // 节点 .md 模式：加载文档
  useEffect(() => {
    if (!nodeMdId) {
      setNodeData(null);
      setContent('');
      setError(null);
      return;
    }
    loadNodeDocument();
  }, [nodeMdId, loadNodeDocument]);

  // 通用 .md 模式：从项目文件系统加载
  useEffect(() => {
    if (!filePath || !projectId) {
      setContent('');
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read_file', project_id: projectId, file_path: filePath }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.content) {
          const match = data.content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
          setContent(match ? match[2] : data.content);
        } else {
          setError(data.error || 'Failed to read file');
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Network error');
      })
      .finally(() => setLoading(false));
  }, [filePath, projectId]);

  // 监听外部文档更新（AiChatNode 完成对话后），自动刷新
  useEffect(() => {
    if (!nodeMdId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { node_id?: string };
      if (detail?.node_id === nodeMdId) {
        loadNodeDocument();
      }
    };
    window.addEventListener('node-document-updated', handler);
    return () => window.removeEventListener('node-document-updated', handler);
  }, [nodeMdId, loadNodeDocument]);

  // 监听文字选中
  const handleContentMouseUp = useCallback(() => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setSelectedText('');
        setSelectionPos(null);
        window.dispatchEvent(new CustomEvent('text-selection-changed', {
          detail: { selectedText: '', nodeMdId: '', selectionPos: null, popupPos: null },
        }));
        return;
      }
      if (contentRef.current && !contentRef.current.contains(sel.anchorNode)) {
        setSelectedText('');
        setSelectionPos(null);
        window.dispatchEvent(new CustomEvent('text-selection-changed', {
          detail: { selectedText: '', nodeMdId: '', selectionPos: null, popupPos: null },
        }));
        return;
      }
      const text = sel.toString().trim();
      if (text.length > 0) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        setSelectedText(text);
        const selPos = { x: rect.right + 8, y: rect.top - 4 };
        const popupPos = { x: rect.left - 540, y: rect.top - 12 };
        setSelectionPos(selPos);
        window.dispatchEvent(new CustomEvent('text-selection-changed', {
          detail: {
            selectedText: text,
            nodeMdId: nodeMdId || '',
            selectionPos: selPos,
            popupPos,
          },
        }));
      }
    }, 10);
  }, [nodeMdId]);

  // 清除选中
  useEffect(() => {
    const handler = () => {
      setSelectedText('');
      setSelectionPos(null);
    };
    window.addEventListener('clear-text-selection', handler);
    return () => window.removeEventListener('clear-text-selection', handler);
  }, []);

  useEffect(() => {
    const handleDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pumpkin-ref-btn') || target.closest('.pumpkin-ask-btn') || target.closest('.text-edit-popup') || target.closest('.text-selection-actions')) return;
      setSelectedText('');
      setSelectionPos(null);
      window.getSelection()?.removeAllRanges();
      window.dispatchEvent(new CustomEvent('text-selection-changed', {
        detail: { selectedText: '', nodeMdId: '', selectionPos: null, popupPos: null },
      }));
    };
    document.addEventListener('mousedown', handleDocClick);
    return () => document.removeEventListener('mousedown', handleDocClick);
  }, []);

  if (!nodeMdId && !filePath) return null;

  // =========== Mood ===========
  const mood = nodeData?.mood;
  const hasMood = mood && Object.values(mood).some(arr => arr && arr.length > 0);

  // =========== 折叠侧边栏（standalone 模式） ===========
  if (collapsed && mode === 'standalone') {
    return (
      <div
        className="fixed right-0 top-0 flex flex-col items-center justify-center"
        style={{
          width: '44px',
          height: '100%',
          backgroundColor: '#faf8f3',
          borderLeft: '1px solid rgba(0, 0, 0, 0.07)',
          boxShadow: '-4px 0 16px rgba(0, 0, 0, 0.04)',
          zIndex,
        }}
      >
        <button
          onClick={() => setCollapsed(false)}
          className="flex flex-col items-center gap-1.5 rounded-lg px-2 py-3 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
          style={{ color: '#537D96' }}
          title="展开"
        >
          <ChevronsLeft className="h-5 w-5" />
          <span
            className="text-[10px] font-medium max-h-[120px] overflow-hidden"
            style={{
              writingMode: 'vertical-rl',
              color: '#537D96',
              letterSpacing: '0.05em',
            }}
          >
            {nodeData?.title?.slice(0, 6) || '...'}
          </span>
        </button>
      </div>
    );
  }

  // =========== 主渲染 ===========
  return (
    <div
      className={mode === 'standalone' ? 'fixed right-0 top-0 flex h-full flex-col' : 'flex h-full flex-col'}
      style={{
        width: mode === 'standalone' ? '48%' : '100%',
        minWidth: mode === 'standalone' ? '480px' : undefined,
        maxWidth: mode === 'standalone' ? '780px' : undefined,
        backgroundColor: '#faf8f3',
        borderLeft: mode === 'standalone' ? '1px solid rgba(0, 0, 0, 0.07)' : undefined,
        boxShadow: mode === 'standalone' ? '-12px 0 32px rgba(0, 0, 0, 0.06)' : undefined,
        zIndex: mode === 'standalone' ? zIndex : undefined,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
      onClick={() => onClickToFront?.(displayId)}
    >
      {/* Header */}
      <div
        className="flex shrink-0 items-center gap-3 px-5 py-3"
        style={{ borderBottom: '1px solid rgba(0, 0, 0, 0.05)', backgroundColor: '#faf8f3' }}
        {...(mode === 'floating' ? { 'data-drag-handle': '' } as Record<string, string> : {})}
      >
        {(mode === 'tabbed' || mode === 'floating') && onToggleCollapse && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
            className="rounded-md p-1.5 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
            style={{ color: '#7a7260' }}
            title="折叠"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        )}
        {!onToggleCollapse && mode === 'standalone' && (
          <button
            onClick={(e) => { e.stopPropagation(); setCollapsed(true); }}
            className="rounded-md p-1.5 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
            style={{ color: '#7a7260' }}
            title="折叠到右侧"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        )}
        <FileText className="h-4 w-4 shrink-0" style={{ color: '#537D96' }} />
        <span className="flex-1 truncate text-[14px] font-semibold" style={{ color: '#2c2416' }}>
          {displayName}
        </span>
        <button
          onClick={() => onClose(displayId)}
          className="rounded-md p-1.5 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
          style={{ color: '#7a7260' }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Metadata + Mood（仅节点模式且有数据时） */}
      {nodeData && (
        <>
          <div
            className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2 text-[11px]"
            style={{ borderBottom: '1px solid rgba(0, 0, 0, 0.04)', color: '#8a8270' }}
          >
            <span>Created {formatTime(nodeData.created_at)}</span>
            <span>Updated {formatTime(nodeData.updated_at)}</span>
            {nodeData.model && (
              <span style={{ color: '#537D96' }}>{nodeData.model}</span>
            )}
            {nodeData.tags && nodeData.tags.length > 0 && (
              <span className="flex items-center gap-1">
                {nodeData.tags.map(t => (
                  <span key={t} className="rounded-full px-2 py-0.5" style={{ backgroundColor: 'rgba(83, 125, 150, 0.08)', color: '#537D96' }}>
                    {t}
                  </span>
                ))}
              </span>
            )}
            {hasMood && (
              <button
                onClick={() => setMoodExpanded(v => !v)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
                style={{ color: '#8a8270' }}
              >
                <Lightbulb className={`h-3 w-3 ${moodExpanded ? '' : 'opacity-50'}`}
                  style={{ color: moodExpanded ? '#d4a017' : 'inherit' }} />
                <span className="text-[10px] font-medium">Mood</span>
                {moodExpanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
              </button>
            )}
          </div>

          {/* Mood 面板 */}
          {moodExpanded && hasMood && (
            <div
              className="shrink-0 px-5 py-3"
              style={{
                borderBottom: '1px solid rgba(0, 0, 0, 0.04)',
                backgroundColor: 'oklch(0.97 0.008 70 / 0.6)',
              }}
            >
              <div className="grid grid-cols-4 gap-2">
                {(['vibe', 'sparks', 'reflections', 'will'] as const).map(pool => {
                  const items = mood![pool];
                  if (!items || items.length === 0) {
                    return (
                      <div key={pool} className="rounded-lg border px-2 py-2"
                        style={{
                          borderColor: 'oklch(0.88 0.01 70)',
                          backgroundColor: 'oklch(0.98 0.005 80)',
                        }}
                      >
                        <div className="text-[10px] font-semibold uppercase tracking-wide mb-1"
                          style={{ color: 'oklch(0.55 0.02 50 / 0.4)' }}>
                          {MOOD_LABELS[pool]}
                        </div>
                        <span className="text-[10px]" style={{ color: 'oklch(0.55 0.02 50 / 0.3)' }}>—</span>
                      </div>
                    );
                  }
                  return (
                    <div key={pool}
                      className="rounded-lg border px-2 py-2 transition-colors"
                      style={{
                        borderColor: `${MOOD_COLORS[pool]}30`,
                        backgroundColor: `${MOOD_COLORS[pool]}08`,
                      }}
                    >
                      <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5"
                        style={{ color: MOOD_COLORS[pool] }}>
                        {MOOD_LABELS[pool]}
                      </div>
                      <ul className="space-y-0.5">
                        {items.map((item, i) => (
                          <li key={i} className="flex items-start gap-1 text-[11px] leading-snug"
                            style={{ color: 'oklch(0.40 0.02 50)' }}>
                            <span className="mt-0.5 shrink-0" style={{ color: `${MOOD_COLORS[pool]}60` }}>·</span>
                            <span className="whitespace-pre-wrap break-words">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" style={{ color: '#537D96' }} />
          <span className="text-[12px]" style={{ color: '#8a8270' }}>Loading...</span>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
          <AlertCircle className="h-8 w-8" style={{ color: '#c0392b' }} />
          <p className="text-center text-[13px]" style={{ color: '#5c5342' }}>{error}</p>
          <button
            onClick={() => nodeMdId ? loadNodeDocument() : window.location.reload()}
            className="flex items-center gap-1.5 rounded-md px-4 py-2 text-[12px] font-medium transition-colors"
            style={{ backgroundColor: '#537D96', color: '#fff' }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      ) : (
        <div
          className="flex-1 overflow-y-auto ai-canvas-scroll"
          ref={contentRef}
          onMouseUp={handleContentMouseUp}
          data-reader-content
        >
          <div className="px-6 py-5">
            <HtmlRenderer content={content} />
          </div>
        </div>
      )}
    </div>
  );
}
