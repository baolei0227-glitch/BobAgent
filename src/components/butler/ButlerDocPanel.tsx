'use client';

/**
 * ButlerDocPanel —— Butler 文档阅读面板（右侧展开）
 *
 * 日报等回执落成真实文档后，点击即在助理面板同位置展开一栏阅读。
 * **渲染器完全复用画布的 viewers/registry**（md / docx / pdf / xlsx / 图片 / 代码 / 纯文本），
 * 本面板只负责：按 path 拉 FileInfo → 匹配渲染器 → 懒加载并注入统一 props。
 *
 * 只读：面板不提供写回（MdViewer 的编辑回写通道不启用）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { basename } from 'path';
import { matchRenderer } from '@/components/canvas/viewers/registry';
import type { ViewerRenderProps } from '@/components/canvas/viewers/types';
import type { FileInfo } from '@/lib/files/types';

export interface ButlerDocPanelProps {
  /** 文档绝对路径（必须位于 APP_ROOT/butler 目录内且不在 .state 下，服务端校验） */
  path: string;
  /** 独立浮窗模式的关闭回调；嵌入抽屉栏时省略（关闭由抽屉统一提供） */
  onClose?: () => void;
  /** 嵌入抽屉栏：去掉 fixed/锚定/阴影/圆角，填满父容器 */
  embedded?: boolean;
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

export function ButlerDocPanel({ path, onClose, embedded }: ButlerDocPanelProps) {
  const [file, setFile] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ViewerComp, setViewerComp] = useState<ComponentType<ViewerRenderProps> | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setViewerError(null);
    try {
      const res = await fetch(`/api/butler/report-doc?action=read&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!data?.success) {
        setError(data?.error ?? '读取文档失败');
        setFile(null);
        return;
      }
      setFile(data.file as FileInfo);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取文档失败');
    }
  }, [path]);

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
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {basename(path)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>Butler 报告文档 · 只读</div>
        </div>
        <button type="button" onClick={() => void load()} style={iconBtn} aria-label="刷新">
          重新载入
        </button>
        {onClose && (
          <button type="button" onClick={onClose} style={iconBtn} aria-label="关闭">
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
            proxyUrl={null}
            fileName={file.name}
            source="local"
            onError={handleError}
            filePath={file.full_path}
          />
        )}
      </div>
    </section>
  );
}
