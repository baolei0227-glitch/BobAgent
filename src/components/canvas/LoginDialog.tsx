'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Lock, X, Globe, User } from 'lucide-react';

interface LoginDialogProps {
  /** 站点名（如 xiaohongshu.com） */
  siteName: string;
  url: string;
  timeoutSec?: number;
  /** 提交账号密码 */
  onSubmit: (username: string, password: string) => void;
  /** 关闭弹窗（不提交凭据） */
  onClose: () => void;
}

/**
 * BobWork 登录弹窗（browser.login bobwork 模式）。
 * 用户在节点界面输入账号密码，凭据 POST /api/chat/login 回传服务端，
 * 服务端经 browser.login_fill（日志脱敏）代填并提交——凭据不经过模型上下文。
 */
export default function LoginDialog({ siteName, url, timeoutSec, onSubmit, onClose }: LoginDialogProps) {
  const [visible, setVisible] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(timeoutSec ?? null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // 超时倒计时（仅展示提示；服务端超时也会兜底 resolve(null)）
  useEffect(() => {
    if (countdown == null) return;
    const t = setInterval(() => setCountdown((c) => (c != null && c > 0 ? c - 1 : c)), 1000);
    return () => clearInterval(t);
  }, [countdown]);

  const stop = useCallback((e: React.SyntheticEvent) => e.stopPropagation(), []);
  const stopCanvasEvent = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
  }, []);

  const handleSubmit = () => {
    if (submitting) return;
    const u = username.trim();
    if (!u || !password) return;
    setSubmitting(true);
    onSubmit(u, password);
  };

  return createPortal(
    <div
      data-canvas-ui="overlay"
      className="fixed inset-0 z-[2100] flex items-center justify-center transition-opacity duration-200"
      style={{
        backgroundColor: 'rgba(15, 23, 42, 0.45)',
        backdropFilter: 'blur(2px)',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
      }}
      onMouseDown={stopCanvasEvent}
      onPointerDown={stopCanvasEvent}
      onWheel={stopCanvasEvent}
      onClick={stopCanvasEvent}
    >
      <div
        className="relative mx-4 w-full max-w-sm overflow-hidden rounded-2xl shadow-[0_20px_60px_-12px_rgba(0,0,0,0.25)] transition-all duration-300"
        style={{
          backgroundColor: 'var(--card)',
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0) scale(1)' : 'translateY(16px) scale(0.96)',
        }}
        onMouseDown={stop}
        onPointerDown={stop}
        onWheel={stop}
        onClick={stop}
      >
        {/* 顶部渐变装饰条 */}
        <div
          className="h-1.5 w-full"
          style={{ background: 'linear-gradient(135deg, var(--primary), var(--info), var(--purple))' }}
        />

        {/* 头部 */}
        <div
          className="flex items-center gap-3 border-b px-5 py-4"
          style={{ borderColor: 'var(--paper-soft)' }}
        >
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: 'color-mix(in srgb, var(--primary) 12%, transparent)' }}
          >
            <Lock className="h-4 w-4" style={{ color: 'var(--primary)' }} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
              Sign in to {siteName || 'this site'}
            </p>
            {url ? (
              <p className="mt-0.5 flex items-center gap-1 truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                <Globe className="h-3 w-3 shrink-0" />
                <span className="truncate">{url}</span>
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
            style={{ color: 'var(--ink-muted)' }}
            onClick={() => { if (!submitting) onClose(); }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 表单 */}
        <div className="space-y-3 px-5 py-4">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            The credentials you enter here go directly to the browser via the local bridge — they are never
            passed to the AI model.
          </p>
          <div>
            <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Username / phone / email
            </label>
            <div
              className="flex items-center gap-2 rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--paper-soft)', backgroundColor: 'var(--input-bg, transparent)' }}
            >
              <User className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
              <input
                className="w-full bg-transparent text-sm outline-none"
                style={{ color: 'var(--ink)' }}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter account"
                autoFocus
                autoComplete="username"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Password
            </label>
            <div
              className="flex items-center gap-2 rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--paper-soft)', backgroundColor: 'var(--input-bg, transparent)' }}
            >
              <Lock className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
              <input
                type="password"
                className="w-full bg-transparent text-sm outline-none"
                style={{ color: 'var(--ink)' }}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                autoComplete="current-password"
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              />
            </div>
          </div>
        </div>

        {/* 操作区 */}
        <div className="flex items-center justify-between gap-3 border-t px-5 py-3" style={{ borderColor: 'var(--paper-soft)' }}>
          {countdown != null ? (
            <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              Auto-dismiss in {countdown}s
            </span>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
              style={{ color: 'var(--ink-muted)' }}
              onClick={() => { if (!submitting) onClose(); }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg px-4 py-1.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
              style={{ backgroundColor: 'var(--primary)' }}
              disabled={submitting || !username.trim() || !password}
              onClick={handleSubmit}
            >
              {submitting ? 'Signing in…' : 'Sign in & fill'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
