'use client';

// 统一文件/文档查看器：预览调度平台，按文件类型分发到 viewers/ 下的独立渲染器插件
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { ComponentType } from 'react';
import {
  X, FileText, Image as ImageIcon, AlertCircle,
  ChevronsRight, ChevronsLeft, RefreshCw, ExternalLink,
  ZoomIn, ZoomOut,
} from 'lucide-react';
import type { ViewerRenderProps } from './viewers/types';
import type { FileInfo, FileSourceKind, IWritableSource } from '@/lib/files/types';
import { getSource } from '@/lib/files/registry';
import { registerFileSources } from '@/lib/files/sources';

/**
 * 注册统一文件来源（Step 2）。
 *
 * 放在这里而不是应用外壳（CanvasFlow）里：`getSource()` 的调用点只有本组件，
 * 把注册留在消费者自己身上，职责才闭环 —— 否则一旦有人在 CanvasFlow 之外
 * 挂载 UnifiedViewer（独立查看页、单测、Storybook…），就会拿到
 * `未注册的文件来源: local` 而整页 500。注册函数内部是 Map.set，幂等。
 */
registerFileSources();
import { matchRenderer } from './viewers/registry';
import { desktop } from '@/lib/desktop-adapter';
import { OutcomeEditor } from './OutcomeEditor';
import { Button } from '@/components/ui/button';
import { bus, BusEvents } from '@/lib/bus';
import type { TraceInspectPayload } from '@/lib/bus';
import type { TraceSpan } from '@/lib/types';
import { EventInspector } from './TraceTimeline';

// ======================= Helpers =======================

function splitFrontmatter(content: string): { body: string } {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return { body: match ? match[1] : content };
}

function extractNodeIdFromFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const idMatch = match[1].match(/^node_id:\s*(\S+)/m);
  return idMatch ? idMatch[1] : null;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// ======================= Types =======================

interface NodeData {
  node_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  sources: string[];
  model?: string;
  tags?: string[];
  outcome_status?: 'locked' | 'draft' | 'stale' | 'legacy';
  summary: string;
  conversations: Array<{ question: string; answer: string; questionTime: string; answerTime: string }>;
  annotations: string;
}

interface UnifiedViewerProps {
  nodeMdId?: string | null;
  filePath?: string;
  /** 文件来源（Step 2）：显式指定时优先；缺省时按 projectId 兼容推断 */
  source?: FileSourceKind;
  /** 兼容旧调用：有值且未传 source 时按项目来源处理 */
  projectId?: string;
  fileName?: string;
  /** 图片集模式：多张图片共用一个标签页浏览（paths 为全部图片路径，activePath 为当前激活图） */
  imageSet?: { paths: string[]; activePath: string };
  onClose: (id: string) => void;
  zIndex?: number;
  onClickToFront?: (id: string) => void;
  onToggleCollapse?: () => void;
  mode?: 'standalone' | 'tabbed' | 'floating';
  /** 默认打开成果块编辑模式（而非完整文档预览） */
  defaultOutcomeMode?: boolean;
}

// ======================= Component =======================

export function UnifiedViewer({
  nodeMdId, filePath, source, projectId, fileName, imageSet,
  onClose, zIndex = 50, onClickToFront, onToggleCollapse, mode = 'standalone',
  defaultOutcomeMode,
}: UnifiedViewerProps) {
  // --- Node document state ---
  const [nodeData, setNodeData] = useState<NodeData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // 预览缩放（CSS zoom 属性，Electron/Chromium 原生支持）
  const [zoom, setZoom] = useState(1);
  const ZOOM_STEP = 0.15;
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 3;
  const zoomIn = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
  const zoomOut = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)));
  const zoomReset = () => setZoom(1);

  // --- Outcome editor state ---
  // 成果块视图：defaultOutcomeMode 时默认打开（仅成果块，只读预览）；点击「编辑」才进入人工编辑
  const [outcomeViewActive, setOutcomeViewActive] = useState(false);
  const [outcomeEditMode, setOutcomeEditMode] = useState(false);
  const [outcomeStatus, setOutcomeStatus] = useState<'locked' | 'draft' | 'stale' | 'legacy' | null>(null);
  // 失效原因链（frontmatter outcome_stale_reason）：成果块面板展示「哪条前提已废」
  const [outcomeStaleReason, setOutcomeStaleReason] = useState<string | null>(null);
  /** 状态变更：离开 stale 即清掉原因链（重新锁定/重新生成后原因链作废） */
  const handleOutcomeStatusChange = useCallback((status: 'locked' | 'draft' | 'stale' | 'legacy' | null) => {
    setOutcomeStatus(status);
    if (status !== 'stale') setOutcomeStaleReason(null);
  }, []);

  // --- 轨迹事件检查器（TraceTimeline 选中事件 → 右侧检查器） ---
  const [inspectorSpan, setInspectorSpan] = useState<TraceSpan | null>(null);
  useEffect(() => {
    return bus.subscribe<TraceInspectPayload>(BusEvents.traceInspect, ({ nodeId, span }) => {
      if (nodeMdId && nodeId === nodeMdId) {
        setInspectorSpan(span);
      }
    });
  }, [nodeMdId]);

  // 应用 defaultOutcomeMode：打开成果块专用视图（只读预览）
  useEffect(() => {
    if (defaultOutcomeMode) {
      setOutcomeViewActive(true);
    }
  }, [defaultOutcomeMode]);

  // --- Discovered node data (from file frontmatter) ---
  const [discoveredNodeId, setDiscoveredNodeId] = useState<string | null>(null);
  const [discoveredNodeData, setDiscoveredNodeData] = useState<NodeData | null>(null);

  // --- File viewer state ---
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  // 图片集模式：一次读取全部图片 → slides（yarl 多图）+ 激活索引 + 激活图信息
  const [imageSlides, setImageSlides] = useState<Array<{ src: string; alt?: string }> | null>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [imageActiveInfo, setImageActiveInfo] = useState<FileInfo | null>(null);
  const [metaFooterHover, setMetaFooterHover] = useState(false);
  // 按文件类型匹配到的渲染器插件（懒加载，见下方调度 useEffect）
  const [viewerComp, setViewerComp] = useState<ComponentType<ViewerRenderProps> | null>(null);
  const [viewerLoadError, setViewerLoadError] = useState<string | null>(null);

  const fetchKeyRef = useRef(0);
  const visibleRef = useRef(false);

  const displayId = nodeMdId || filePath || '';
  const isNodeMode = !!nodeMdId;

  // Node mode document content（需在 effectiveFileInfo 之前声明，供其构造虚拟 fileInfo）
  const [nodeContent, setNodeContent] = useState('');
  useEffect(() => {
    if (!nodeMdId) { setNodeContent(''); return; }
    const projectQuery = projectId ? `&project_id=${encodeURIComponent(projectId)}` : '';
    fetch(`/api/nodes?id=${nodeMdId}&action=raw${projectQuery}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.content) {
          setNodeContent(splitFrontmatter(data.content).body);
        }
      })
      .catch(() => {});
  }, [nodeMdId, projectId]);

  // 节点模式下构造虚拟 fileInfo（.md 内容来自 nodeContent），统一走渲染器分发
  const effectiveFileInfo = isNodeMode
    ? (fileInfo || (nodeContent ? { name: nodeMdId || 'node.md', type: 'text' as const, content: nodeContent, size: nodeContent.length, extension: '.md' } : null))
    : (imageSet ? imageActiveInfo : fileInfo);

  // extension 可能带点号（如 ".pdf"），统一去掉后再做类型分发
  const ext = (effectiveFileInfo?.extension || filePath?.split('.').pop() || '').replace(/^\./, '').toLowerCase();

  // 渲染器自带缩放时（docx 分页编辑器按面板宽度自算适配缩放），外层不再套 CSS `zoom`，否则双重缩放
  const viewerOwnsZoom = useMemo(
    () => (effectiveFileInfo ? matchRenderer(ext, effectiveFileInfo)?.ownsZoom === true : false),
    [ext, effectiveFileInfo],
  );

  useEffect(() => {
    visibleRef.current = true;
    return () => { visibleRef.current = false; };
  }, []);

  // =================== Node document loading ===================

  const nodeProjectQuery = useMemo(
    () => (projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''),
    [projectId],
  );

  const loadNodeDocument = useCallback(async (retryCount = 0) => {
    if (!nodeMdId) return;
    const key = ++fetchKeyRef.current;
    setError(null);
    setLoading(true);

    const MAX_RETRIES = 2;
    try {
      const [nodeResp, rawResp] = await Promise.all([
        fetch(`/api/nodes?id=${nodeMdId}${nodeProjectQuery}`).then(r => r.json()),
        fetch(`/api/nodes?id=${nodeMdId}&action=raw${nodeProjectQuery}`).then(r => r.json()),
      ]);
      if (key !== fetchKeyRef.current) return;
      if (nodeResp.success) setNodeData(nodeResp.node);
      if (rawResp.success && rawResp.content) {
        setError(null);
      } else {
        const errMsg = rawResp.error || 'Failed to load document';
        if (retryCount < MAX_RETRIES) {
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
        await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
        if (key !== fetchKeyRef.current) return;
        return loadNodeDocument(retryCount + 1);
      }
      setError(errMsg);
    } finally {
      if (key === fetchKeyRef.current) setLoading(false);
    }
  }, [nodeMdId, nodeProjectQuery]);

  useEffect(() => {
    if (!nodeMdId) { setNodeData(null); setError(null); setOutcomeEditMode(false); return; }
    loadNodeDocument();
    // 加载成果块锁定状态
    fetch(`/api/nodes?id=${nodeMdId}${nodeProjectQuery}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.node) {
          setOutcomeStatus(d.node.outcome_status || null);
          setOutcomeStaleReason(d.node.outcome_stale_reason || null);
        }
      })
      .catch(() => {});
  }, [nodeMdId, loadNodeDocument, nodeProjectQuery]);

  // Listen for external document updates
  useEffect(() => {
    if (!nodeMdId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { node_id?: string };
      if (detail?.node_id === nodeMdId) {
        loadNodeDocument();
        // 同步刷新成果块锁定状态
        fetch(`/api/nodes?id=${nodeMdId}${nodeProjectQuery}`)
          .then(r => r.json())
          .then(d => {
            if (d.success && d.node) {
              setOutcomeStatus(d.node.outcome_status || null);
              setOutcomeStaleReason(d.node.outcome_stale_reason || null);
            }
          })
          .catch(() => {});
      }
    };
    window.addEventListener('node-document-updated', handler);
    return () => window.removeEventListener('node-document-updated', handler);
  }, [nodeMdId, loadNodeDocument, nodeProjectQuery]);

  // Listen for updates to discovered node documents (opened from sidebar)
  useEffect(() => {
    if (!discoveredNodeId || !projectId || !filePath) return;
    const handler = () => {
      // 重新加载文件内容
      fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'read_file', project_id: projectId, file_path: filePath }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.success && visibleRef.current) setFileInfo(data);
        })
        .catch(() => {});
    };
    const eventHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { node_id?: string };
      if (detail?.node_id === discoveredNodeId) handler();
    };
    window.addEventListener('node-document-updated', eventHandler);
    return () => window.removeEventListener('node-document-updated', eventHandler);
  }, [discoveredNodeId, projectId, filePath]);

  // =================== File loading (non-node mode) ===================

  // 来源解析：显式 source 优先，否则按 projectId 兼容推断（Step 2）
  const effectiveSource: FileSourceKind | null = isNodeMode || !filePath
    ? null
    : (source || (projectId ? 'project' : 'local'));
  const fileSource = effectiveSource ? getSource(effectiveSource) : null;

  // 代理 URL（供 PdfViewer / iframe / img）
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!effectiveSource || !filePath) { setProxyUrl(null); return; }
    let cancelled = false;
    getSource(effectiveSource).proxy(filePath)
      .then((u) => { if (!cancelled) setProxyUrl(u); })
      .catch(() => { if (!cancelled) setProxyUrl(null); });
    return () => { cancelled = true; };
  }, [effectiveSource, filePath]);

  useEffect(() => {
    if (imageSet || !fileSource || !filePath) {
      setFileInfo(null);
      setDiscoveredNodeId(null);
      setDiscoveredNodeData(null);
      return;
    }
    setLoading(true);
    setError(null);
    setDiscoveredNodeId(null);
    setDiscoveredNodeData(null);

    fileSource.read(filePath)
      .then((info) => {
        if (!visibleRef.current) return;
        setFileInfo(info);
        // 尝试从 frontmatter 提取 node_id，关联节点数据
        if (info.content) {
          const extractedId = extractNodeIdFromFrontmatter(info.content);
          if (extractedId) {
            setDiscoveredNodeId(extractedId);
            fetch(`/api/nodes?id=${extractedId}`)
              .then(r => r.json())
              .then(nodeResp => {
                if (nodeResp.success && nodeResp.node) {
                  setDiscoveredNodeData(nodeResp.node);
                }
              })
              .catch(() => {});
          }
        }
      })
      .catch(e => {
        if (!visibleRef.current) return;
        setError(e instanceof Error ? e.message : 'Failed to read file');
      })
      .finally(() => { if (visibleRef.current) setLoading(false); });
  }, [isNodeMode, source, projectId, filePath, fileSource, imageSet]);

  // 图片集模式：一次读取全部图片 → slides + 激活索引（激活图按 full_path 匹配，兼容按文件名）
  useEffect(() => {
    if (!imageSet || !fileSource) {
      setImageSlides(null);
      setImageActiveInfo(null);
      setImageIndex(0);
      return;
    }
    setLoading(true);
    setError(null);
    let cancelled = false;
    Promise.all(imageSet.paths.map(p => fileSource.read(p)))
      .then((infos) => {
        if (cancelled) return;
        const withContent = infos.filter(i => !!i.content);
        setImageSlides(withContent.map(i => ({ src: i.content as string, alt: i.name, path: i.full_path })));
        const active = withContent.find(i =>
          i.full_path === imageSet.activePath || i.name === imageSet.activePath.split('/').pop()
        ) || withContent[0] || null;
        setImageActiveInfo(active);
        const idx = active ? withContent.indexOf(active) : 0;
        setImageIndex(idx < 0 ? 0 : idx);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to read images');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [imageSet, fileSource]);

  // =================== 渲染器调度（按文件类型分发到注册插件，懒加载） ===================

  useEffect(() => {
    // 统一走渲染器分发（.md 也已插件化为 MdViewer）
    if (!effectiveFileInfo) {
      setViewerComp(null);
      setViewerLoadError(null);
      return;
    }
    let cancelled = false;
    const matched = matchRenderer(ext, effectiveFileInfo);
    if (!matched) {
      setViewerComp(null);
      setViewerLoadError(null);
      return;
    }
    setViewerLoadError(null);
    matched.load()
      .then((Comp) => { if (!cancelled) setViewerComp(() => Comp); })
      .catch((e) => {
        if (!cancelled) {
          setViewerComp(null);
          setViewerLoadError(e instanceof Error ? e.message : 'Failed to load preview plugin');
        }
      });
    return () => { cancelled = true; };
  }, [effectiveFileInfo, ext]);

  // =================== 未保存结果（transient）落盘 ===================
  // transient 来源的内容驻留内存（如会议纪要草稿）：建议路径存于 full_path，由用户显式保存进当前项目。
  const transientSavePath = !isNodeMode && effectiveSource === 'transient'
    ? (effectiveFileInfo?.full_path || effectiveFileInfo?.name || '')
    : '';
  const [transientSaved, setTransientSaved] = useState<string | null>(null);
  const [savingTransient, setSavingTransient] = useState(false);
  const saveTransient = useCallback(async () => {
    if (!transientSavePath || !effectiveFileInfo?.content) return;
    setSavingTransient(true);
    try {
      const src = getSource('project');
      if (!('write' in src)) throw new Error('Project source is not writable');
      await (src as IWritableSource).write(transientSavePath, effectiveFileInfo.content);
      setTransientSaved(transientSavePath);
      // 落盘成功后按项目来源重开一份（可见已保存的真实文件）
      bus.publish(BusEvents.fileOpen, {
        source: 'project',
        path: transientSavePath,
        name: transientSavePath.split('/').pop() || transientSavePath,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSavingTransient(false);
    }
  }, [transientSavePath, effectiveFileInfo]);

  // =================== Renderers ===================

  // Effective node data: from direct node mode or discovered from sidebar file
  const effectiveNodeData = nodeData || discoveredNodeData;

  const displayName = nodeMdId || discoveredNodeId
    ? (effectiveNodeData?.title || 'Loading...')
    : (fileName || filePath?.split('/').pop() || 'Document');

  // =================== Renderers（所有类型由 viewers/registry 统一分发，含 .md） ===================

  // =================== Collapsed state (standalone mode) ===================

  if (collapsed && mode === 'standalone') {
    return (
      <div className="fixed right-0 top-0 flex flex-col items-center justify-center"
        style={{ width: '44px', height: '100%', backgroundColor: '#fff', borderLeft: '1px solid var(--line)', boxShadow: '-4px 0 16px rgba(0, 0, 0, 0.04)', zIndex }}>
        <button onClick={() => setCollapsed(false)}
          className="flex flex-col items-center gap-1.5 rounded-lg px-2 py-3 transition-colors hover:bg-[var(--paper-hover)]"
          style={{ color: 'var(--info)' }} title="Expand">
          <ChevronsLeft className="h-5 w-5" />
          <span className="text-xs font-medium max-h-[120px] overflow-hidden"
            style={{ writingMode: 'vertical-rl', color: 'var(--info)', letterSpacing: '0.05em' }}>
            {displayName.slice(0, 6) || '...'}
          </span>
        </button>
      </div>
    );
  }

  // =================== Main render ===================

  // 渲染器插件组件（小写 state 变量需大写别名才能在 JSX 中使用）
  const ActiveViewer = viewerComp;

  return (
    <div
      className={mode === 'standalone' ? 'fixed right-0 top-0 flex h-full flex-col' : 'relative flex h-full flex-col'}
      style={{
        width: mode === 'standalone' ? '48%' : '100%',
        minWidth: mode === 'standalone' ? '480px' : undefined,
        maxWidth: mode === 'standalone' ? '780px' : undefined,
        // 2026-09-12 预览面板内容层改纯白：与面板外壳、中栏会话卡片同为白色
        backgroundColor: '#fff',
        borderLeft: mode === 'standalone' ? '1px solid var(--line)' : undefined,
        boxShadow: mode === 'standalone' ? '-12px 0 32px rgba(0, 0, 0, 0.06)' : undefined,
        zIndex: mode === 'standalone' ? zIndex : undefined,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
      onClick={() => onClickToFront?.(displayId)}
    >
      {/* Header（floating 模式嵌入预览面板时省略：名称/关闭已由外部标签栏承担） */}
      {mode !== 'floating' && (
      <div className="flex shrink-0 items-center gap-3 px-5 py-3"
        style={{ borderBottom: '1px solid var(--line-soft)', backgroundColor: '#fff' }}
      >
        {mode === 'tabbed' && onToggleCollapse && (
          <Button onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
            variant="ghost" tone="neutral" size="icon-sm" title="Collapse" aria-label="Collapse">
            <ChevronsRight className="h-4 w-4" />
          </Button>
        )}
        {!onToggleCollapse && mode === 'standalone' && (
          <Button onClick={(e) => { e.stopPropagation(); setCollapsed(true); }}
            variant="ghost" tone="neutral" size="icon-sm" title="Collapse to right" aria-label="Collapse to right">
            <ChevronsRight className="h-4 w-4" />
          </Button>
        )}
        {!isNodeMode && (imageActiveInfo?.type === 'image' || fileInfo?.type === 'image') ? (
          <ImageIcon className="h-4 w-4 shrink-0" style={{ color: 'var(--info)' }} />
        ) : (
          <FileText className="h-4 w-4 shrink-0" style={{ color: 'var(--info)' }} />
        )}
        <span className="flex-1 truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          {displayName}
        </span>
        {!isNodeMode && effectiveFileInfo?.full_path && (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              if (effectiveFileInfo.full_path) desktop.openFile(effectiveFileInfo.full_path);
            }}
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            title="用默认应用打开"
            aria-label="用默认应用打开"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
        )}
        {/* 缩放控制（非成果块编辑模式下显示） */}
        {!(isNodeMode && outcomeViewActive) && (
          <div className="flex items-center gap-0.5 rounded-md px-0.5" style={{ backgroundColor: 'var(--paper-hover)' }}>
            <Button
              onClick={(e) => { e.stopPropagation(); zoomOut(); }}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="缩小"
              aria-label="缩小"
              disabled={zoom <= ZOOM_MIN}
            >
              <ZoomOut className="h-3.5 w-3.5" style={{ opacity: zoom <= ZOOM_MIN ? 0.35 : 1 }} />
            </Button>
            <button
              onClick={(e) => { e.stopPropagation(); zoomReset(); }}
              className="min-w-[32px] rounded px-1 py-0.5 text-center text-xs font-medium tabular-nums transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: zoom === 1 ? 'var(--ink-faint)' : 'var(--info)' }}
              title="恢复 100%"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              onClick={(e) => { e.stopPropagation(); zoomIn(); }}
              variant="ghost"
              tone="neutral"
              size="icon-sm"
              title="放大"
              aria-label="放大"
              disabled={zoom >= ZOOM_MAX}
            >
              <ZoomIn className="h-3.5 w-3.5" style={{ opacity: zoom >= ZOOM_MAX ? 0.35 : 1 }} />
            </Button>
          </div>
        )}
        {/* 成果块视图切换（仅节点模式）：查看成果块 → 编辑 → 预览 三态 */}
        {isNodeMode && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!outcomeViewActive) {
                setOutcomeViewActive(true);
              } else {
                setOutcomeEditMode(v => !v);
              }
            }}
            className="rounded-md px-2 py-1 text-xs font-medium transition-colors"
            style={{
              color: outcomeViewActive && outcomeEditMode ? 'var(--primary-foreground)' : 'var(--info)',
              backgroundColor: outcomeViewActive && outcomeEditMode ? 'var(--primary)' : 'var(--info-soft)',
            }}
            title={!outcomeViewActive ? '仅查看成果块' : outcomeEditMode ? '返回阅读模式' : '编辑成果块'}
          >
            {!outcomeViewActive ? '成果块' : outcomeEditMode ? '预览' : '编辑'}
          </button>
        )}
        <Button onClick={() => onClose(displayId)}
          variant="ghost" tone="neutral" size="icon-sm" aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>
      )}

      {/* Content area */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
      {/* 未保存结果条：transient 来源（如会议纪要草稿）顶部给出显式落盘出口 */}
      {transientSavePath && !loading && (
        <div
          className="flex shrink-0 items-center gap-2 px-3 py-1.5"
          style={{ borderBottom: '1px solid var(--line-soft)', backgroundColor: 'var(--info-soft)' }}
        >
          <span className="min-w-0 flex-1 truncate text-11" style={{ color: 'var(--ink-muted)' }} title={transientSavePath}>
            {transientSaved ? `Saved to ${transientSaved}` : 'Not saved yet'}
          </span>
          <Button
            onClick={(e) => { e.stopPropagation(); void saveTransient(); }}
            disabled={savingTransient || !!transientSaved}
            variant="solid"
            tone="info"
            size="sm"
          >
            Save to current project
          </Button>
        </div>
      )}
      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" style={{ color: 'var(--info)' }} />
          <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>Loading...</span>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
          <AlertCircle className="h-8 w-8" style={{ color: 'var(--danger)' }} />
          <p className="text-center text-sm" style={{ color: 'var(--ink-muted)' }}>{error}</p>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => isNodeMode ? loadNodeDocument() : window.location.reload()}
              variant="solid"
              tone="info"
              size="sm"
            >
              <RefreshCw className="h-3.5 w-3.5" />Retry
            </Button>
            {!isNodeMode && (effectiveFileInfo?.full_path || (effectiveSource === 'local' ? filePath : undefined)) && (
              <Button
                onClick={() => desktop.openFile(effectiveFileInfo?.full_path || filePath!)}
                variant="outline"
                tone="info"
                size="sm"
              >
                <ExternalLink className="h-3.5 w-3.5" />用默认应用打开
              </Button>
            )}
          </div>
        </div>
      ) : isNodeMode && outcomeViewActive ? (
        <div className="flex-1 overflow-y-auto">
          <OutcomeEditor
            nodeMdId={nodeMdId!}
            outcomeStatus={outcomeStatus}
            staleReason={outcomeStaleReason}
            onStatusChange={handleOutcomeStatusChange}
            readonly={!outcomeEditMode}
          />
        </div>
      ) : effectiveFileInfo ? (
        ActiveViewer ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div style={viewerOwnsZoom ? undefined : { zoom }} className="flex-1 overflow-auto">
              <ActiveViewer
                fileInfo={effectiveFileInfo}
                proxyUrl={proxyUrl}
                fileName={fileName}
                source={effectiveSource ?? 'local'}
                onError={(msg) => setError(msg)}
                nodeMdId={nodeMdId || discoveredNodeId || undefined}
                filePath={filePath}
                projectId={projectId || undefined}
                slides={imageSlides || undefined}
                initialIndex={imageIndex}
              />
            </div>
          </div>
        ) : viewerLoadError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
            <AlertCircle className="h-8 w-8" style={{ color: 'var(--danger)' }} />
            <p className="text-center text-sm" style={{ color: 'var(--ink-muted)' }}>{viewerLoadError}</p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" style={{ color: 'var(--info)' }} />
          </div>
        )
      ) : (
        <div className="flex-1" />
      )}
      </div>
      {/* 右侧：轨迹事件检查器（TraceTimeline 选中事件在此渲染详情） */}
      {inspectorSpan && (
        <div className="flex w-[260px] shrink-0 flex-col border-l" style={{ borderColor: 'var(--line-soft)' }}>
          <div className="flex shrink-0 items-center justify-between border-b px-2.5 py-1.5" style={{ borderColor: 'var(--line-soft)' }}>
            <span className="text-11 font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>事件检查器</span>
            <Button onClick={() => setInspectorSpan(null)} variant="ghost" tone="neutral" size="icon-xs" title="关闭检查器" aria-label="关闭检查器">
              <X className="h-3 w-3" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            <EventInspector span={inspectorSpan} isStreaming={false} />
          </div>
        </div>
      )}
      </div>

      {/* 左下角浮动元数据标签：不占布局空间，默认半透明精简，悬停变实体展开完整信息 */}
      {effectiveNodeData && (
        <div
          className="absolute bottom-3 left-3 z-10 max-w-[65%] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-1.5 text-xs"
          onMouseEnter={() => setMetaFooterHover(true)}
          onMouseLeave={() => setMetaFooterHover(false)}
          style={{
            display: 'flex',
            color: metaFooterHover ? 'var(--ink-muted)' : 'var(--ink-faint)',
            backgroundColor: metaFooterHover ? 'color-mix(in oklab, var(--paper) 98%, transparent)' : 'color-mix(in oklab, var(--paper) 55%, transparent)',
            backdropFilter: metaFooterHover ? 'none' : 'blur(2px)',
            WebkitBackdropFilter: metaFooterHover ? 'none' : 'blur(2px)',
            border: metaFooterHover ? '1px solid var(--line)' : '1px solid var(--line-soft)',
            boxShadow: metaFooterHover ? '0 2px 12px rgba(0, 0, 0, 0.10)' : 'none',
            transition: 'background-color var(--dur-fast) var(--ease-fast), color var(--dur-fast) var(--ease-fast), box-shadow var(--dur-fast) var(--ease-fast), border-color var(--dur-fast) var(--ease-fast)',
          }}
        >
          {metaFooterHover ? (
            <>
              <span>Created {formatTime(effectiveNodeData.created_at)}</span>
              <span>Updated {formatTime(effectiveNodeData.updated_at)}</span>
              {effectiveNodeData.model && <span style={{ color: 'var(--info)' }}>{effectiveNodeData.model}</span>}
              {effectiveNodeData.tags && effectiveNodeData.tags.length > 0 && (
                <span className="flex items-center gap-1">
                  {effectiveNodeData.tags.map(t => (
                    <span key={t} className="rounded-full px-2 py-0.5" style={{ backgroundColor: 'var(--info-soft)', color: 'var(--info)' }}>{t}</span>
                  ))}
                </span>
              )}
            </>
          ) : (
            <span>Updated {formatTime(effectiveNodeData.updated_at)}</span>
          )}
        </div>
      )}
    </div>
  );
}
