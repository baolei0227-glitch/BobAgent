'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Loader2, X } from 'lucide-react';

interface WechatBindModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 绑定状态变化回调（父组件用于显示徽标等） */
  onBoundChange?: (bound: boolean) => void;
  /** 嵌入模式：在 SettingsModal 右栏直接渲染内容，不显示弹窗遮罩 */
  embedded?: boolean;
}

type WechatPhase = 'idle' | 'fetching' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';

interface WechatState {
  phase: WechatPhase;
  qrcodeUrl?: string;
  error?: string;
}

/**
 * 微信 iLink 绑定弹窗
 * 供 ⌘F 统一面板（UnifiedPalette）与侧边栏设置菜单共用。
 */
export function WechatBindModal({ open, onOpenChange, onBoundChange, embedded }: WechatBindModalProps) {
  const [state, setState] = useState<WechatState>({ phase: 'idle' });
  const [bound, setBound] = useState(false);
  const [sessionDead, setSessionDead] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setBoundSafe = useCallback((b: boolean) => {
    setBound(b);
    onBoundChange?.(b);
  }, [onBoundChange]);

  /** 统一应用后端状态：bound / sessionDead（有凭证但轮询已死）/ binding */
  const applyStatus = useCallback((data: any) => {
    setBoundSafe(!!data.bound);
    setSessionDead(!!data.bound && !data.running);
    if (data.binding) {
      setState(data.binding);
    } else if (data.bound && data.running) {
      setState((s) => ({ ...s, phase: 'confirmed' }));
    }
  }, [setBoundSafe]);

  /** 查询绑定状态 */
  const checkStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/wechat?action=status');
      const data = await resp.json();
      if (data.success) applyStatus(data);
    } catch { /* 网络错误忽略 */ }
  }, [applyStatus]);

  /** 发起绑定 + 轮询扫码状态 */
  const startBind = useCallback(async () => {
    setState({ phase: 'fetching' });
    try {
      const resp = await fetch('/api/wechat?action=bind', { method: 'POST' });
      const data = await resp.json();
      if (data.success) {
        const st = data.state ?? data.binding;
        // 后端返回的二维码 URL 为空时直接报错（不能进入 waiting 却无图）
        if (st && st.phase === 'waiting' && !st.qrcodeUrl) {
          setState({ phase: 'error', error: 'QR code not returned by server' });
          return;
        }
        setState(st ?? { phase: 'fetching' });
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          try {
            const r = await fetch('/api/wechat?action=status');
            const d = await r.json();
            if (d.success) {
              applyStatus(d);
              if (d.binding && ['confirmed', 'expired', 'error'].includes(d.binding.phase)) {
                if (pollRef.current) clearInterval(pollRef.current);
                pollRef.current = null;
              }
            }
          } catch { /* ignore */ }
        }, 2000);
      } else {
        setState({ phase: 'error', error: data.error || 'Binding failed' });
      }
    } catch (err: any) {
      setState({ phase: 'error', error: err?.message || 'Network error' });
    }
  }, [setBoundSafe]);

  /** 解绑 */
  const unbind = useCallback(async () => {
    try {
      await fetch('/api/wechat?action=unbind', { method: 'POST' });
    } catch { /* ignore */ }
    setBoundSafe(false);
    setState({ phase: 'idle' });
  }, [setBoundSafe]);

  // 打开时：查询状态；未绑定或会话已失效则自动发起扫码
  useEffect(() => {
    if (open) {
      void (async () => {
        await checkStatus();
        const resp = await fetch('/api/wechat?action=status');
        const data = await resp.json().catch(() => null);
        if (data?.success && (!data.bound || !data.running)) {
          await startBind();
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 卸载时清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  if (!open) return null;

  const cardContent = (
    <div
      style={{
        width: embedded ? '100%' : 300,
        maxWidth: 360,
        borderRadius: 6,
        backgroundColor: 'var(--popover)',
        border: '2px solid var(--line)',
        boxShadow: embedded ? 'none' : '0 10px 30px rgba(0,0,0,0.3)',
        padding: 18,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {!embedded && (
        /* 弹窗头部 */
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="text-sm font-bold" style={{ color: 'var(--ink)' }}>
            WeChat iLink Bind
          </div>
          <button
            onClick={() => onOpenChange(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-muted)', padding: 2 }}
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      )}

        {bound && !sessionDead ? (
          <div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: '0.8rem',
              color: 'var(--success)',
              marginBottom: 12,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--success)' }} />
              Bound · Send commands via WeChat
            </div>
            <div className="text-xs" style={{ color: 'var(--ink-muted)', lineHeight: 1.7, marginBottom: 12 }}>
              Message the bot in WeChat to create:
              <br />· <b>/todo meeting tomorrow 3pm</b> → calendar event
              <br />· <b>/note record an idea</b> → save to notebook
              <br />· <b>/help</b> → list all commands
              <br />· Plain text → save to todo list
            </div>
            <button
              onClick={unbind}
              style={{
                width: '100%',
                padding: '7px 0',
                borderRadius: 4,
                border: '1.5px solid color-mix(in oklab, var(--danger) 60%, transparent)',
                backgroundColor: 'transparent',
                color: 'var(--danger)',
                fontSize: '0.8rem',
                cursor: 'pointer',
              }}
            >
              Unbind WeChat
            </button>
          </div>
        ) : (
          <div>
            {sessionDead && (
              <div style={{
                fontSize: '0.8rem',
                color: 'var(--warn)',
                backgroundColor: 'var(--warn-soft)',
                border: '1px solid var(--warn-soft)',
                borderRadius: 4,
                padding: '6px 8px',
                marginBottom: 10,
                lineHeight: 1.6,
              }}>
                ⚠️ WeChat session expired (connection lost after restart or credentials expired). Scan again to rebind.
              </div>
            )}
            {state.phase === 'fetching' && (
              <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--ink-muted)' }}>
                <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 8px' }} />
                Fetching QR code…
              </div>
            )}
            {(state.phase === 'waiting' || state.phase === 'scanned') && state.qrcodeUrl && (
              <div style={{ textAlign: 'center' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={state.qrcodeUrl}
                  alt="wechat qr"
                  width={180}
                  height={180}
                  style={{ borderRadius: 4, border: '1px solid color-mix(in oklab, var(--primary) 40%, transparent)' }}
                />
                <div className="text-xs" style={{ color: 'var(--ink-muted)', marginTop: 10 }}>
                  {state.phase === 'scanned' ? (
                    <span style={{ color: 'var(--success)' }}>Scanned, waiting for confirmation…</span>
                  ) : (
                    'Scan with WeChat to bind (valid for ~2 min)'
                  )}
                </div>
              </div>
            )}
            {state.phase === 'confirmed' && (
              <div style={{ textAlign: 'center', color: 'var(--success)', padding: '16px 0' }}>
                Bound successfully. You can now send commands via WeChat.
              </div>
            )}
            {state.phase === 'expired' && (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <div className="text-xs" style={{ color: 'var(--ink-muted)', marginBottom: 10 }}>QR code expired</div>
                <button
                  onClick={startBind}
                  style={{
                    padding: '6px 16px',
                    borderRadius: 4,
                    border: '1.5px solid var(--primary)',
                    backgroundColor: 'var(--primary)',
                    color: '#fff',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  Get QR code again
                </button>
              </div>
            )}
            {state.phase === 'error' && (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <div className="text-xs" style={{ color: 'var(--danger)', marginBottom: 10 }}>
                  {state.error || 'Binding failed'}
                </div>
                <button
                  onClick={startBind}
                  style={{
                    padding: '6px 16px',
                    borderRadius: 4,
                    border: '1.5px solid var(--primary)',
                    backgroundColor: 'var(--primary)',
                    color: '#fff',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {state.phase === 'idle' && (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <button
                  onClick={startBind}
                  style={{
                    padding: '6px 16px',
                    borderRadius: 4,
                    border: '1.5px solid var(--primary)',
                    backgroundColor: 'var(--primary)',
                    color: '#fff',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  {sessionDead ? 'Re-scan to bind' : 'Bind WeChat'}
                </button>
              </div>
            )}
          </div>
        )}
    </div>
  );

  if (embedded) {
    return <div className="px-5 py-4">{cardContent}</div>;
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // 必须高于设置面板（SettingsModal z-[2000]）与登录弹窗（z-[2100]）：
        // 微信绑定从设置菜单打开时弹窗要盖过设置面板，否则二维码被遮挡
        zIndex: 3000,
        // 显式恢复交互：设置面板（Radix modal）打开时会在 body 上设置 pointer-events:none，
        // 本弹窗是手动 fixed 层，需用 auto 覆盖继承，否则"看得见但点不到"
        pointerEvents: 'auto',
        backgroundColor: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "var(--font-sans)",
      }}
      onPointerDown={(e) => { e.stopPropagation(); onOpenChange(false); }}
    >
      {cardContent}
    </div>
  );
}
