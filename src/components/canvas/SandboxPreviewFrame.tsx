'use client';

/**
 * 应用内沙箱预览（2026-10-10 方案 B）。
 *
 * 与「在 Hippo 打开」的区别：
 *   - iframe 用 `sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"`，
 *     **不给 `allow-same-origin`** → 文档 origin 变 opaque：读不到宿主 localStorage / Cookie，
 *     跨源 fetch 需预检 → 小程序对宿主的一切调用只能走 postMessage 桥；
 *   - 预览页仍从 `127.0.0.1`（预览 origin）加载，与宿主 UI 的 `localhost` 不同源（方案 A），
 *     所以即使将来放开 sandbox 属性也仍有第二层隔离。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, X, ExternalLink, AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { attachIframeBridgeHost, type PreviewConsoleMessage } from '@/lib/sandbox/iframe-bridge-host';
import { previewOriginFor, openSandboxPreviewInHippo } from '@/lib/sandbox/open-preview';

export interface SandboxPreviewTarget {
  id: string;
  name: string;
}

export interface GraphExecutorResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export function SandboxPreviewFrame({ app, onClose, graph, embedded = false }: {
  app: SandboxPreviewTarget;
  onClose?: () => void;
  /** graph* 动作执行器（宿主画布在 CanvasFlow 里，故由调用方注入；缺省时 graph 动作返回明确错误） */
  graph?: (action: string, data: Record<string, unknown>) => Promise<GraphExecutorResult>;
  /** true = 嵌入右侧预览面板；false = 全屏模态浮层 */
  embedded?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<{ dispose: () => void } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [origin, setOrigin] = useState('');
  /** 预览页 console 上报（error/warn）：宿主侧错误胶囊 + Fix with AI */
  const [consoleMsgs, setConsoleMsgs] = useState<PreviewConsoleMessage[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  /** bridge 已启动：用于区分“页面真的打开了”与 403/白屏/错误页 */
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const lastAppIdRef = useRef(app.id);
  // Layer-1（BobStorage.set/get）写回：iframe 里 localStorage 不可用，宿主批量落盘
  const localPendingRef = useRef(new Map<string, string | null>());
  const localTimerRef = useRef<number | null>(null);
  const flushLocalStorage = useCallback(() => {
    if (localTimerRef.current !== null) {
      window.clearTimeout(localTimerRef.current);
      localTimerRef.current = null;
    }
    if (localPendingRef.current.size === 0) return;
    const entries = Array.from(localPendingRef.current.entries()).map(([key, value]) => ({ key, value }));
    localPendingRef.current.clear();
    void fetch('/api/sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_local_storage', id: app.id, entries }),
      keepalive: true,
    }).catch(() => {});
  }, [app.id]);
  const queueLocalStorage = useCallback((key: string, value: string | null) => {
    localPendingRef.current.set(key, value);
    if (localTimerRef.current !== null) window.clearTimeout(localTimerRef.current);
    localTimerRef.current = window.setTimeout(flushLocalStorage, 300);
  }, [flushLocalStorage]);
  useEffect(() => () => { flushLocalStorage(); }, [flushLocalStorage]);

  const reload = useCallback(() => {
    flushLocalStorage();
    setConsoleMsgs([]);
    setConsoleOpen(false);
    setReady(false);
    setLoadError(false);
    setReloadKey((k) => k + 1);
  }, [flushLocalStorage]);

  // 同一浮层切换到另一个 app：重置加载/错误/console 状态，避免沿用上一个 app 的 ready。
  useEffect(() => {
    if (lastAppIdRef.current === app.id) return;
    lastAppIdRef.current = app.id;
    setConsoleMsgs([]);
    setConsoleOpen(false);
    setReady(false);
    setLoadError(false);
    setReloadKey((k) => k + 1);
  }, [app.id]);

  // console 错误自动上报：供 coding 节点做有界自动修复（每用户轮最多 1 次）。
  // 去抖 300ms，避免同一批 console.error 多次派发；只上报 error 级别，warn 不触发修复。
  useEffect(() => {
    const errors = consoleMsgs.filter((m) => m.level === 'error').map((m) => m.text);
    if (errors.length === 0) return;
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('sandbox-console-errors', {
        detail: { appId: app.id, errors },
      }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [consoleMsgs, app.id]);

  useEffect(() => {
    setOrigin(previewOriginFor(window.location.origin));
  }, []);

  /**
   * 挂宿主桥：只接受来自本 iframe 的消息（sandbox 下 origin 为 'null'，source 才是可靠判据）。
   * 注意必须在 iframe **真正进入文档且已加载**时才能挂 —— 早先写成 `useEffect(..., [app.id])`，
   * 那时 iframe 还没渲染（origin 是另一个 effect 里异步设的），监听器永远没注册，
   * 表现就是小程序所有请求 10s 超时（真实浏览器 E2E 抓到）。
   */
  const attachBridge = useCallback(() => {
    const el = iframeRef.current;
    if (!el || !el.contentWindow) return;
    bridgeRef.current?.dispose();
    bridgeRef.current = attachIframeBridgeHost(el, app.id, {
      graph,
      onConsole: (msgs) => setConsoleMsgs((prev) => [...prev, ...msgs].slice(-50)),
      onReady: () => {
        setReady(true);
        setLoadError(false);
      },
      onLocalStorage: queueLocalStorage,
      log: (m, extra) => console.warn(m, extra ?? ''),
    });
    // 主动握手：子页回 bob_ready，避免 onLoad 晚于子页上报导致一直转圈
    try { el.contentWindow.postMessage({ type: 'bob_host_ready' }, '*'); } catch { /* ignore */ }
  }, [app.id, graph, queueLocalStorage]);

  useEffect(() => {
    attachBridge();
    return () => {
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
    };
  }, [attachBridge]);

  // 加载超时：预览页没有 bridge 报到（403/白屏/错误页）→ 显示人话错误浮层，不把 JSON 暴露给用户。
  useEffect(() => {
    if (!origin || ready || loadError) return;
    const timer = window.setTimeout(() => setLoadError(true), 8000);
    return () => window.clearTimeout(timer);
  }, [origin, ready, loadError, reloadKey]);

  // AI 改码后自动刷新预览（事件带 appId；只刷新同一个 app）。
  // 2026-10-17：此前只有手动 Reload，且 edit_code 不广播 sandbox-changed → 预览长期停留在旧版本。
  // 150ms 去抖：一轮可能连写 index.html + smoke-test.js，避免预览连续闪两次。
  useEffect(() => {
    let timer: number | null = null;
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ appId?: string }>).detail;
      if (d?.appId && d.appId !== app.id) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        reload();
      }, 150);
    };
    window.addEventListener('sandbox-changed', onChanged);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('sandbox-changed', onChanged);
    };
  }, [app.id, reload]);

  // Esc 关闭（仅模态浮层；嵌入右侧面板时不抢小程序/输入框的 Esc）
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embedded, onClose]);

  const src = `${origin}/api/sandbox/preview/${app.id}`;
  const errorCount = consoleMsgs.filter((m) => m.level === 'error').length;

  return (
    <div
      className={embedded
        ? 'flex h-full w-full overflow-hidden'
        : 'fixed inset-0 z-[340] flex items-center justify-center bg-black/40 p-4'}
    >
      <div
        className={embedded
          ? 'flex h-full w-full flex-col overflow-hidden'
          : 'flex h-[86vh] w-[1100px] max-h-[92vh] max-w-[94vw] flex-col overflow-hidden rounded-xl border shadow-2xl'}
        style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)' }}
      >
        <div
          className="flex shrink-0 items-center gap-2 px-4 py-2.5"
          style={{ borderBottom: '1px solid var(--line)', backgroundColor: 'var(--paper-soft)' }}
        >
          <span className="truncate text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>{app.name}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {(errorCount > 0 || consoleOpen) && (
              <Button
                variant="outline"
                tone={errorCount > 0 ? 'danger' : 'neutral'}
                size="sm"
                onClick={() => setConsoleOpen((v) => !v)}
                title="Something isn't working — see what happened or ask AI to fix it"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Issue
              </Button>
            )}
            <Button variant="outline" tone="neutral" size="sm" onClick={reload} title="Reload preview">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button
              variant="outline"
              tone="info"
              size="sm"
              onClick={() => void openSandboxPreviewInHippo({ id: app.id, name: app.name })}
              title="Open in a separate browser window (full window; no canvas/auto-refresh)"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open in browser
            </Button>
            <Button variant="ghost" tone="neutral" size="icon-sm" onClick={onClose} aria-label="Close preview" title="Close (Esc)">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {consoleOpen && (
          <div
            className="max-h-52 shrink-0 overflow-y-auto border-b px-4 py-2"
            style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}
          >
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-11 font-medium" style={{ color: 'var(--ink-strong)' }}>Something isn&apos;t working</div>
                <div className="text-10" style={{ color: 'var(--ink-muted)' }}>
                  AI can try to fix it, or you can try a stronger model.
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="solid"
                  tone="danger"
                  size="sm"
                  disabled={errorCount === 0}
                  onClick={() => {
                    const errors = consoleMsgs.filter((m) => m.level === 'error').map((m) => m.text);
                    window.dispatchEvent(new CustomEvent('sandbox-fix-errors', { detail: { appId: app.id, errors } }));
                  }}
                  title={errorCount > 0 ? 'Ask AI to fix this problem' : 'No errors to fix'}
                >
                  Ask AI to fix
                </Button>
                <Button
                  variant="outline"
                  tone="warn"
                  size="sm"
                  disabled={errorCount === 0}
                  onClick={() => {
                    const errors = consoleMsgs.filter((m) => m.level === 'error').map((m) => m.text);
                    window.dispatchEvent(new CustomEvent('sandbox-escalate-model', { detail: { appId: app.id, errors } }));
                  }}
                  title="Try again with a stronger model (DeepSeek Pro if configured)"
                >
                  Try stronger model
                </Button>
                <Button variant="ghost" tone="neutral" size="sm" onClick={() => setConsoleOpen(false)}>
                  Hide
                </Button>
              </div>
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer text-10" style={{ color: 'var(--ink-muted)' }}>Technical details</summary>
              <div className="mt-1 space-y-0.5">
                {consoleMsgs.length === 0 ? (
                  <div className="text-10" style={{ color: 'var(--ink-muted)' }}>No messages.</div>
                ) : (
                  consoleMsgs.map((m, i) => (
                    <div
                      key={`${i}-${m.level}-${m.text.slice(0, 16)}`}
                      className="whitespace-pre-wrap break-all font-mono text-10 leading-relaxed"
                      style={{ color: m.level === 'error' ? 'var(--danger)' : 'var(--warn)' }}
                    >
                      [{m.level}] {m.text}
                    </div>
                  ))
                )}
              </div>
            </details>
          </div>
        )}
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {origin ? (
            <iframe
              key={reloadKey}
              ref={iframeRef}
              onLoad={attachBridge}
              src={src}
              title={`${app.name} preview`}
              className="h-full w-full border-0"
              style={{ backgroundColor: 'var(--paper)' }}
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            />
          ) : null}
          {origin && !ready && !loadError && (
            <div
              className="absolute inset-0 flex items-center justify-center text-xs"
              style={{ backgroundColor: 'var(--paper)', color: 'var(--ink-muted)' }}
            >
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening…
            </div>
          )}
          {loadError && (
            <div
              className="absolute inset-0 flex items-center justify-center p-6"
              style={{ backgroundColor: 'var(--paper)' }}
            >
              <div className="max-w-md text-center">
                <AlertTriangle className="mx-auto h-6 w-6" style={{ color: 'var(--warn)' }} />
                <h2 className="mt-2 text-base font-semibold" style={{ color: 'var(--ink-strong)' }}>
                  This mini-app didn&apos;t open
                </h2>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                  The preview may still be starting, or the page hit an error. Try again. If it keeps happening, open this mini-app&apos;s Coding chat and ask AI to check it.
                </p>
                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                  <Button variant="solid" tone="brand" size="sm" onClick={reload}>
                    <RefreshCw className="h-3.5 w-3.5" /> Try again
                  </Button>
                  <Button
                    variant="ghost"
                    tone="neutral"
                    size="sm"
                    onClick={() => void openSandboxPreviewInHippo({ id: app.id, name: app.name })}
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open in browser
                  </Button>
                </div>
              </div>
            </div>
          )}
          {!origin && (
            <div className="flex flex-1 items-center justify-center text-xs" style={{ color: 'var(--ink-muted)' }}>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
