'use client';

/**
 * ButlerDocPanel —— Butler 文档阅读面板（右侧展开）
 *
 * 日报等回执落成真实文档后，点击即在助理面板同位置展开一栏阅读。
 * **渲染器完全复用画布的 viewers/registry**（md / docx / pdf / xlsx / 图片 / 代码 / 纯文本），
 * 本面板只负责：按 path 拉 FileInfo → 匹配渲染器 → 懒加载并注入统一 props。
 *
 * 只读：面板内不提供写回；需要编辑时由标题栏「编辑」把文档转交画布右侧预览面板的 md 编辑器。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { basename } from 'path';
import { matchRenderer } from '@/components/canvas/viewers/registry';
import type { ViewerRenderProps } from '@/components/canvas/viewers/types';
import type { FileInfo, FileSourceKind } from '@/lib/files/types';
import { getSource } from '@/lib/files/registry';
import { registerFileSources } from '@/lib/files/sources';

/**
 * 注册统一文件来源。本面板会读「项目相对路径」（对话产物 homework/… 等），
 * 与 UnifiedViewer 同口径复用 ProjectSource；getSource 依赖注册表已登记，故在此登记（幂等）。
 */
registerFileSources();

/** 绝对路径判定：Butler 报告文档是绝对路径，对话产物是项目相对路径 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~/');
}

export interface ButlerDocPanelProps {
  /**
   * 文档路径，两种形态：
   *  - 绝对路径 = Butler 报告文档（必须位于 APP_ROOT/butler 内且不在 .state 下，服务端校验）；
   *  - 项目相对路径（homework/… materials/…）= 对话产物，走项目来源读取。
   */
  path: string;
  /** 独立浮窗模式的关闭回调；嵌入抽屉栏时省略（关闭由抽屉统一提供） */
  onClose?: () => void;
  /** 嵌入抽屉栏：去掉 fixed/锚定/阴影/圆角，填满父容器 */
  embedded?: boolean;
  /**
   * 「编辑」回调：把文档转交画布右侧预览面板的 md 编辑器打开。
   * 抽屉是居中浮层会盖住画布，所以由抽屉负责（收起抽屉 + 发 file.open）。
   * 缺省时不显示编辑按钮。
   */
  onEdit?: (path: string) => void;
  /**
   * 读取结果回调（ok=false = 这个路径没读出来）。抽屉据此把失败的 `OutputFile:` 行
   * **还原回正文**——卡片点不开时用户至少还能看到并复制路径（2026-10-05）。
   */
  onLoadResult?: (path: string, ok: boolean) => void;
}

/** 独立浮窗默认样式（embedded 时改为填满父栏，由抽屉提供边框与背景） */
function panelStyle(embedded?: boolean): React.CSSProperties {
  if (embedded) {
    return {
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      color: 'var(--foreground)',
      fontFamily: 'var(--font-sans)',
      fontSize: 13,
      overflow: 'hidden',
    };
  }
  return {
    position: 'fixed',
    right: 20,
    top: 64,
    width: 620,
    maxWidth: 'calc(100vw - 40px)',
    height: 'calc(100vh - 108px)',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 16,
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    boxShadow: '0 18px 48px rgba(0,0,0,0.18)',
    color: 'var(--foreground)',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    zIndex: 1250,
    overflow: 'hidden',
  };
}

const iconBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--muted-foreground)',
  cursor: 'pointer',
  fontSize: 13,
  padding: '2px 6px',
  borderRadius: 6,
};

export function ButlerDocPanel({ path, onClose, embedded, onEdit, onLoadResult }: ButlerDocPanelProps) {
  const [file, setFile] = useState<FileInfo | null>(null);
  const [sourceKind, setSourceKind] = useState<FileSourceKind>('local');
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ViewerComp, setViewerComp] = useState<ComponentType<ViewerRenderProps> | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);

  const butlerDoc = isAbsolutePath(path);
  /** 可编辑：项目内的 Markdown 产物（Butler 报告文档是只读沉淀，不提供编辑入口） */
  const canEdit = !!onEdit && !butlerDoc && /\.(md|markdown)$/i.test(path);

  const load = useCallback(async () => {
    setError(null);
    setViewerError(null);
    try {
      if (isAbsolutePath(path)) {
        // 绝对路径有两个来源，客户端不知道 APP_ROOT，不做路径猜测（猜错会把报告文档当普通文件读，
        // 丢掉服务端越界校验与 2MB 上限）：
        //   ① Butler 报告文档（<butler>/<角色>/<日期>/docs/）：服务端校验目录的只读通道；
        //   ② 跨项目文件（管家把别的项目的资料发给用户，2026-10-05）：越界即回落到本地文件来源
        //      （人类 UI 通道，可读任意路径；AI 工具侧的 isReadablePath 授权不受影响）。
        const res = await fetch(`/api/butler/report-doc?action=read&path=${encodeURIComponent(path)}`);
        const data = await res.json();
        if (data?.success) {
          setFile(data.file as FileInfo);
          setSourceKind('local');
          setProxyUrl(null);
          onLoadResult?.(path, true);
          return;
        }
        const src = getSource('local');
        try {
          setFile(await src.read(path));
          setSourceKind('local');
          setProxyUrl(await src.proxy(path).catch(() => null));
          onLoadResult?.(path, true);
        } catch {
          // 两种来源都读不到：报服务端给的第一个错误（更像"这不是 Butler 文档"），信息量更大
          setError(data?.error ?? '读取文档失败');
          setFile(null);
          onLoadResult?.(path, false);
        }
      } else {
        // 对话产物（homework/… materials/…）：项目相对路径，复用项目来源，与画布查看器同口径
        const src = getSource('project');
        setFile(await src.read(path));
        setSourceKind('project');
        setProxyUrl(await src.proxy(path).catch(() => null));
        onLoadResult?.(path, true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取文档失败');
      onLoadResult?.(path, false);
    }
  }, [path, onLoadResult]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!file) {
      setViewerComp(null);
      return;
    }
    let cancelled = false;
    const matched = matchRenderer(file.extension.replace(/^\./, ''), file);
    if (!matched) {
      setViewerComp(null);
      return;
    }
    matched
      .load()
      .then((Comp) => {
        if (!cancelled) setViewerComp(() => Comp);
      })
      .catch((e: unknown) => {
        if (!cancelled) setViewerError(e instanceof Error ? e.message : '渲染器加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const handleError = useCallback((message: string) => setViewerError(message), []);

  return (
    <section style={panelStyle(embedded)} role="dialog" aria-label="文档预览">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 14px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 14,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {basename(path)}
        </div>
        {canEdit && (
          <button type="button" onClick={() => onEdit?.(path)} style={iconBtn} aria-label="Edit">
            Edit
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose} style={iconBtn} aria-label="Close">
            ✕
          </button>
        )}
      </header>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        {viewerError && <p style={{ color: 'var(--danger)' }}>渲染失败：{viewerError}</p>}
        {!error && !file && <p style={{ color: 'var(--muted-foreground)' }}>正在读取…</p>}
        {!error && file && !ViewerComp && !viewerError && (
          <p style={{ color: 'var(--muted-foreground)' }}>正在载入渲染器…</p>
        )}
        {file && ViewerComp && (
          <ViewerComp
            fileInfo={file}
            proxyUrl={proxyUrl}
            fileName={file.name}
            source={sourceKind}
            onError={handleError}
          />
        )}
      </div>
    </section>
  );
}
