'use client';

import { useEffect, useState } from 'react';
import { desktop, type ScreenOcrGeometry } from '@/lib/desktop-adapter';
import { ScreenOcrEditor } from '@/components/screen-ocr/ScreenOcrEditor';

/**
 * OCR 截图编辑覆盖窗口（微信式：不跳回 BobWork 主界面，在独立全屏覆盖窗口内编辑）
 *
 * 由主进程在截图成功后创建全屏透明置顶 BrowserWindow 加载本页；
 * 页面挂载后主动通过 screen-ocr:get-editor-shot 拉取截图（避免与主进程 send 的时序竞争）。
 * 完成（✓）/ 取消（✕/Esc）后通过 screen-ocr:close-editor 关闭覆盖窗口，回到截图前的界面。
 */
export default function OcrEditorPage() {
  const [editImage, setEditImage] = useState<string | null>(null);
  const [initialSelection, setInitialSelection] = useState<'full' | 'none'>('none');
  /** 截图时刻的窗口几何（整屏链路才有）：供编辑面板做窗口吸附 */
  const [geometry, setGeometry] = useState<ScreenOcrGeometry | null>(null);
  /** 画面属于哪一屏（geometry.screens 下标）；-1/null = 全部屏幕并集 */
  const [screenIndex, setScreenIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  /** 一次编辑结束：重置页面回等待态（常驻窗口隐藏，等下一次截图下发） */
  const resetEditor = () => {
    setEditImage(null);
    setInitialSelection('none');
    setGeometry(null);
    setScreenIndex(null);
    setStatus('loading');
    setError(null);
  };

  useEffect(() => {
    let alive = true;
    // 覆盖窗口必须透明：透出底下屏幕，实现微信式"当前界面直接编辑"
    try {
      document.documentElement.style.background = 'transparent';
      document.body.style.background = 'transparent';
    } catch { /* ignore */ }
    // 首次/兜底：拉取待编辑截图（窗口新建加载时主进程可能已 send 过，主动拉避免时序竞争）
    (async () => {
      try {
        const shot = await desktop.screenOcr.getEditorShot?.();
        if (!alive) return;
        if (shot?.dataUrl) {
          setEditImage(shot.dataUrl);
          setInitialSelection(shot.mode === 'region' ? 'full' : 'none');
          setGeometry(shot.geometry ?? null);
          setScreenIndex(shot.screenIndex ?? null);
          setStatus('loading');
        }
      } catch (e) {
        if (!alive) return;
        setError(`拉取截图失败：${e instanceof Error ? e.message : String(e)}`);
        setStatus('error');
      }
    })();
    // 常驻复用：主进程下发新截图（窗口不销毁，直接更新画面，免重建窗口/重载页面）
    const off = desktop.screenOcr.onNewShot?.(({ dataUrl, mode, geometry: geo, screenIndex: si }) => {
      if (!alive) return;
      setEditImage(dataUrl);
      setInitialSelection(mode === 'region' ? 'full' : 'none');
      setGeometry(geo ?? null);
      setScreenIndex(si ?? null);
      setStatus('loading');
      setError(null);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // 加载中：半透明暗底 + 等待提示（覆盖窗口应瞬间拿到数据，此处仅兜底）
  if (status === 'error') {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)',
          color: '#fff',
          fontSize: 15,
          fontFamily: 'var(--font-sans)',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <span>{error ?? '截图编辑初始化失败'}</span>
        <button
          onClick={() => desktop.screenOcr.closeEditor?.()}
          style={{
            padding: '8px 24px',
            borderRadius: 999,
            border: 'none',
            background: 'rgba(255,255,255,0.2)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          关闭
        </button>
      </div>
    );
  }

  if (!editImage) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)',
          color: 'rgba(255,255,255,0.9)',
          fontSize: 14,
          fontFamily: 'var(--font-sans)',
        }}
      >
        正在载入截图…
      </div>
    );
  }

  return (
    <ScreenOcrEditor
      key={editImage}
      dataUrl={editImage}
      initialSelection={initialSelection}
      geometry={geometry}
      screenIndex={screenIndex}
      onDone={async (editedDataUrl) => {
        // 清理暂存截图 → 复制到剪贴板 → 重置并隐藏（常驻窗口等下一次截图）
        desktop.screenOcr.finishEdit();
        const r = await desktop.screenOcr.copyImage(editedDataUrl);
        if (!r.ok) {
          setError(`复制图片失败：${r.error ?? '未知错误'}`);
          setStatus('error');
          return;
        }
        resetEditor();
        desktop.screenOcr.closeEditor?.();
      }}
      onOcr={(dataUrl) => desktop.screenOcr.ocrRegion(dataUrl)}
      onCancel={() => {
        desktop.screenOcr.cancelEdit();
        resetEditor();
        desktop.screenOcr.closeEditor?.();
      }}
    />
  );
}
