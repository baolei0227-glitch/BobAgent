'use client';

/**
 * BobMindPanel — Bob-Mind 插件宿主壳
 *
 * 宿主零便签实现：仅提供一个全屏容器，内嵌 bob-mind-mcp 自带 Web 面板
 * （http://127.0.0.1:9482）。打开前先探测 /api/status 就绪态；
 * 插件未运行（如本机尚未 syncServers 拉起）时给出提示与重试。
 */

import { useCallback, useEffect, useState } from 'react';
import { BrainCircuit, Loader2, RefreshCw, X } from 'lucide-react';

const PANEL_URL = 'http://127.0.0.1:9482';

type Status = 'checking' | 'ready' | 'down';

export function BobMindPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status>('checking');
  // 手动刷新计数：作为 iframe key，点击 Reload 时重建 iframe 强制重载面板
  const [reloadTick, setReloadTick] = useState(0);

  const probe = useCallback(async () => {
    setStatus('checking');
    try {
      const resp = await fetch(`${PANEL_URL}/api/status`, { signal: AbortSignal.timeout(2500) });
      const data = (await resp.json()) as { ok?: boolean };
      setStatus(data?.ok ? 'ready' : 'down');
    } catch {
      setStatus('down');
    }
  }, []);

  // 打开时探测一次；就绪态不重探测（避免 status 抖动导致 iframe 重建闪烁）。
  // 需要重连/刷新由用户点 Reload / Retry 触发。
  useEffect(() => {
    void probe();
  }, [probe]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-canvas-ui="overlay"
      className="fixed z-[240]"
      style={{
        top: 10,
        bottom: 10,
        left: 10,
        right: 10,
        backgroundColor: '#f0f1f3',
        border: '1px solid #d9dce0',
        borderRadius: 18,
        boxShadow: '0 18px 60px rgba(60,60,80,.25)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* 头部：品牌 + 探测态 + 刷新 + 关闭（浅色壳，与 Bob-Mind 面板风格一致） */}
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-2"
        style={{ backgroundColor: '#ffffff', borderBottom: '1px solid #d9dce0' }}
      >
        <BrainCircuit className="h-4 w-4" style={{ color: '#d4a017' }} />
        <span className="text-sm font-semibold" style={{ color: '#2b2d31' }}>
          Bob-Mind
        </span>
        {status === 'checking' && (
          <span className="flex items-center gap-1 text-11" style={{ color: '#9aa0a6' }}>
            <Loader2 className="h-3 w-3 animate-spin" /> Checking plugin…
          </span>
        )}
        {status === 'down' && (
          <span className="text-11" style={{ color: '#d64545' }}>
            Plugin not running — open BobWork once so the bundled plugin can start.
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setReloadTick((t) => t + 1); // 重建 iframe 强制重载面板内容
              void probe();
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[#e7e9ec]"
            style={{ color: '#5c5f66' }}
            title="Reload"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[#e7e9ec]"
            style={{ color: '#5c5f66' }}
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 内容：插件面板 / 就绪前状态（浅灰底） */}
      <div className="min-h-0 flex-1" style={{ backgroundColor: '#eef0f2' }}>
        {status === 'ready' ? (
          <iframe
            key={reloadTick}
            src={PANEL_URL}
            title="Bob-Mind"
            className="h-full w-full border-0"
            style={{ backgroundColor: '#eef0f2' }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            {status === 'checking' ? (
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: '#9aa0a6' }} />
            ) : (
              <>
                <BrainCircuit className="h-8 w-8" style={{ color: '#c6cad0' }} />
                <p className="text-xs" style={{ color: '#7a8088' }}>
                  Bob-Mind plugin isn&apos;t reachable at {PANEL_URL}.
                </p>
                <button
                  type="button"
                  onClick={() => void probe()}
                  className="rounded-md px-3 py-1.5 text-xs font-medium"
                  style={{ color: '#fff', backgroundColor: '#d4a017' }}
                >
                  Retry
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
