'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { loadSettings, saveSettings } from '@/lib/settings';

interface MailBindModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 嵌入模式：在 SettingsModal 右栏直接渲染内容，不显示弹窗遮罩 */
  embedded?: boolean;
}

interface MailRuntimeStatus {
  bound?: boolean;
  running?: boolean;
  unreadCount?: number;
  lastError?: string;
}

/**
 * 邮箱感知（IMAP 只读）绑定面板
 *
 * 极简原则：只保留三项**真正需要用户填**的必填项（地址 / 应用密码 / IMAP 主机）；
 * 端口固定 993（隐式 TLS）、目录固定 INBOX，都不进表单（需要时手改 settings.json）。
 * 凭证落在 `.settings.json` 的 `mail` 分组（密码由 secrets.ts 加密存储）。
 *
 * 保存后立刻 POST /api/mail 跑一轮：连不上当场报错，避免「填错了却没有任何反馈」。
 */
export function MailBindModal({ open, onOpenChange, embedded }: MailBindModalProps) {
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<MailRuntimeStatus>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/mail');
      const data = (await resp.json()) as MailRuntimeStatus & { success?: boolean };
      if (data.success) {
        setStatus({
          bound: !!data.bound,
          running: !!data.running,
          unreadCount: data.unreadCount ?? 0,
          lastError: data.lastError,
        });
      }
    } catch { /* 服务端不可达：忽略 */ }
  }, []);

  // 打开时读一次已存凭证（回填地址/主机；密码同样回填，便于确认已配置）
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const s = await loadSettings();
        const m = s.mail;
        setAddress(m?.address ?? '');
        setPassword(m?.password ?? '');
        setImapHost(m?.imapHost ?? '');
        setConfigured(!!(m?.address && m?.password && m?.imapHost));
      } catch { /* 读取失败按未配置处理 */ }
      void refreshStatus();
    })();
  }, [open, refreshStatus]);

  /** 保存凭证 → 立刻跑一轮验证连通性 */
  const save = useCallback(async () => {
    if (!address.trim() || !password.trim() || !imapHost.trim()) return;
    setBusy(true);
    setError('');
    try {
      const s = await loadSettings();
      await saveSettings({
        ...s,
        mail: { ...(s.mail ?? {}), address: address.trim(), password: password.trim(), imapHost: imapHost.trim() },
      });
      setConfigured(true);
      const resp = await fetch('/api/mail', { method: 'POST' });
      const data = (await resp.json()) as MailRuntimeStatus & { success?: boolean; error?: string };
      if (data.success) {
        setStatus({
          bound: !!data.bound,
          running: !!data.running,
          unreadCount: data.unreadCount ?? 0,
          lastError: data.lastError,
        });
        if (data.lastError) setError(data.lastError);
      } else {
        setError(data.error || 'Connection test failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }, [address, password, imapHost]);

  /** 断开：清空 mail 分组（调度器下一轮读到空凭证即 idle） */
  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      const s = await loadSettings();
      await saveSettings({ ...s, mail: {} });
    } catch { /* ignore */ }
    setBusy(false);
    setError('');
    setConfigured(false);
    setStatus({});
    setPassword('');
  }, []);

  if (!open) return null;

  const dotColor = error ? 'var(--danger)' : configured ? 'var(--success)' : 'var(--warn)';
  const stateText = error
    ? error
    : configured
      ? status.running
        ? `Watching inbox · ${status.unreadCount} unread in last scan`
        : 'Configured · waiting for next poll'
      : 'Not connected';

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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: '0.8rem',
          color: dotColor,
          marginBottom: 12,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: dotColor }} />
        <span style={{ color: 'var(--ink)' }}>{stateText}</span>
      </div>

      <div className="text-xs" style={{ color: 'var(--ink-muted)', lineHeight: 1.7, marginBottom: 12 }}>
        Connect your mailbox over IMAP (read-only) so Butler can notice new mail for you. Use an
        app-specific password if your provider requires one (Gmail, QQ, 163…).
      </div>

      <div className="space-y-2">
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Email address (you@example.com)"
          className="text-xs"
          autoComplete="off"
        />
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="App password"
          className="font-mono text-xs"
          autoComplete="off"
        />
        <Input
          value={imapHost}
          onChange={(e) => setImapHost(e.target.value)}
          placeholder="IMAP host (imap.gmail.com)"
          className="font-mono text-xs"
          autoComplete="off"
        />
      </div>

      {error && !configured && (
        <div className="text-xs" style={{ color: 'var(--danger)', marginTop: 8, lineHeight: 1.6 }}>
          {error}
        </div>
      )}

      <div className="flex gap-2 mt-3">
        <Button
          variant="solid"
          tone="brand"
          size="md"
          onClick={save}
          disabled={busy || !address.trim() || !password.trim() || !imapHost.trim()}
          className="flex-1"
        >
          {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : configured ? 'Save & Test' : 'Connect'}
        </Button>
        {configured && (
          <Button variant="outline" tone="danger" size="md" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        )}
      </div>
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
