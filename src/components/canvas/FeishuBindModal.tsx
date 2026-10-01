'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface FeishuBindModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 连接状态变化回调（父组件用于显示徽标等） */
  onBoundChange?: (bound: boolean) => void;
  /** 嵌入模式：在 SettingsModal 右栏直接渲染内容，不显示弹窗遮罩 */
  embedded?: boolean;
}

interface FeishuStatus {
  bound: boolean;
  running: boolean;
  lastError?: string;
  appId?: string;
}

/**
 * 飞书机器人绑定面板
 *
 * 凭证只有 App ID / App Secret 两项（走长连接，无需公网地址、无需扫码），
 * 故不做表单以外的任何配置项。所有请求只打 /api/feishu，不 import 服务端 / SDK 代码。
 */
export function FeishuBindModal({ open, onOpenChange, onBoundChange, embedded }: FeishuBindModalProps) {
  const [status, setStatus] = useState<FeishuStatus>({ bound: false, running: false });
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** 查询连接状态 */
  const checkStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/feishu?action=status');
      const data = (await resp.json()) as FeishuStatus & { success?: boolean };
      if (data.success) {
        setStatus({ bound: !!data.bound, running: !!data.running, lastError: data.lastError, appId: data.appId });
        onBoundChange?.(!!data.bound);
      }
    } catch { /* 网络错误忽略 */ }
  }, [onBoundChange]);

  /** 连接：先校验凭证，通过才落盘建连 */
  const connect = useCallback(async () => {
    if (!appId.trim() || !appSecret.trim()) return;
    setBusy(true);
    setError('');
    try {
      const resp = await fetch('/api/feishu?action=connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: appId.trim(), appSecret: appSecret.trim() }),
      });
      const data = (await resp.json()) as { success?: boolean; error?: string };
      if (data.success) {
        setAppSecret('');
        await checkStatus();
      } else {
        setError(data.error || 'Connection failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }, [appId, appSecret, checkStatus]);

  /** 解绑：关长连接 + 清凭证 */
  const unbind = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/feishu?action=unbind', { method: 'POST' });
    } catch { /* ignore */ }
    setBusy(false);
    setError('');
    setStatus({ bound: false, running: false });
    onBoundChange?.(false);
  }, [onBoundChange]);

  // 打开时查询一次状态
  useEffect(() => {
    if (open) void checkStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const card = (
    <div
      style={{
        width: embedded ? '100%' : 320,
        maxWidth: 380,
        borderRadius: 6,
        backgroundColor: 'var(--popover)',
        border: '2px solid var(--line)',
        boxShadow: embedded ? 'none' : '0 10px 30px rgba(0,0,0,0.3)',
        padding: 18,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {status.bound ? (
        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: '0.8rem',
            color: status.running ? 'var(--success)' : 'var(--warn)',
            marginBottom: 12,
          }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: status.running ? 'var(--success)' : 'var(--warn)',
            }} />
            {status.running ? 'Connected · Message the bot in Feishu' : 'Configured · connection not running'}
          </div>
          <div className="text-xs" style={{ color: 'var(--ink-muted)', lineHeight: 1.7, marginBottom: 12 }}>
            App ID
            <br />
            <span className="font-mono" style={{ color: 'var(--ink)' }}>{status.appId}</span>
          </div>
          {status.lastError && (
            <div className="text-xs" style={{ color: 'var(--warn)', marginBottom: 12, lineHeight: 1.6 }}>
              {status.lastError}
            </div>
          )}
          {/* 解绑 = 破坏性：danger outline 常态提示 */}
          <Button variant="outline" tone="danger" size="md" onClick={unbind} disabled={busy} className="w-full">
            Disconnect
          </Button>
        </div>
      ) : (
        <div>
          <div className="text-xs" style={{ color: 'var(--ink-muted)', lineHeight: 1.7, marginBottom: 12 }}>
            Connect a Feishu (Lark) self-built app to chat with Butler from Feishu. In the
            developer console: enable the Bot capability, add the <b>im:message</b>,
            <b> im:message.p2p_msg:readonly</b> and <b>im:message:send_as_bot</b> permissions,
            subscribe to <b>im.message.receive_v1</b> using <b>“Receive events through persistent
            connection”</b>, then publish the version.
          </div>
          <div className="space-y-2">
            <Input
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="App ID (cli_…)"
              className="font-mono text-xs"
              autoComplete="off"
            />
            <Input
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="App Secret"
              className="font-mono text-xs"
              autoComplete="off"
            />
          </div>
          {error && (
            <div className="text-xs" style={{ color: 'var(--danger)', marginTop: 8, lineHeight: 1.6 }}>
              {error}
            </div>
          )}
          <Button
            variant="solid"
            tone="brand"
            size="md"
            onClick={connect}
            disabled={busy || !appId.trim() || !appSecret.trim()}
            className="w-full mt-3"
          >
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : 'Connect'}
          </Button>
        </div>
      )}
    </div>
  );

  if (embedded) {
    return <div className="px-5 py-4">{card}</div>;
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3000,
        pointerEvents: 'auto',
        backgroundColor: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-sans)',
      }}
      onPointerDown={(e) => { e.stopPropagation(); onOpenChange(false); }}
    >
      {card}
    </div>
  );
}