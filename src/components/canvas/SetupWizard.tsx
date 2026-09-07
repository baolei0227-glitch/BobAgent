'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderCog, Loader2, ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 首次运行向导（First Run Setup）
 *
 * 全新安装后首次启动，告知用户项目保存地址（固定为系统默认目录 ~/BobWork/BobWorkspace，
 * 不提供自定义存储位置，避免项目散落在 iCloud 同步区等异常位置）。
 *
 * 判定与完成标记：
 *  - GET  /api/setup  → firstRun=true 时弹出
 *  - POST /api/setup  → 标记完成（写 setupCompleted 到 .settings.json），此后不再弹出
 */
export function SetupWizard() {
  const [open, setOpen] = useState(false);
  const [defaultDir, setDefaultDir] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const openedRef = useRef(false);

  // 首次运行检测：挂载时请求 /api/setup，firstRun=true 时打开向导
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/setup');
        const d = (await r.json()) as { success?: boolean; firstRun?: boolean; defaultDir?: string };
        if (alive && d.success && d.firstRun) {
          setDefaultDir(d.defaultDir || '');
          setOpen(true);
        }
      } catch {
        // 网络/服务异常：静默跳过，不阻塞主界面
      }
    })();
    return () => { alive = false; };
  }, []);

  /** 完成向导：标记 setupCompleted（默认保存地址固定为内置 BobWorkspace，无自定义步骤） */
  const finish = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      try {
        await fetch('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'complete' }),
        });
      } catch {
        // 标记失败不阻塞关闭；下次启动会再次弹出，属可接受兜底
      }
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }, [submitting]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center px-6"
      style={{
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl shadow-2xl"
        style={{
          backgroundColor: 'var(--paper)',
          border: '1px solid var(--line)',
        }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 pt-6">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl text-base font-bold"
              style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground, #ffffff)' }}
            >
              B
            </div>
            <div>
              <h1 className="text-base font-semibold" style={{ color: 'var(--ink)' }}>
                Welcome to BobWork
              </h1>
              <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                One more step before you start.
              </p>
            </div>
          </div>
        </div>

        {/* 保存地址说明（固定为内置默认，无自定义选择） */}
        <div className="px-6 pt-5">
          <div
            className="mb-2 text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--ink-muted)' }}
          >
            Storage Location
          </div>
          <div
            className="rounded-xl border p-4 text-left"
            style={{
              borderColor: 'var(--primary)',
              backgroundColor: 'var(--primary-soft)',
              boxShadow: '0 0 0 3px var(--primary-soft)',
            }}
          >
            <span className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--ink)' }}>
              <FolderCog className="h-4 w-4" style={{ color: 'var(--primary)' }} />
              Default location
              <span
                className="rounded-full px-2 py-0.5 text-10 font-medium"
                style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}
              >
                Recommended
              </span>
            </span>
            <p className="mt-2 text-xs leading-5" style={{ color: 'var(--ink-muted)' }}>
              Projects, sticky notes and chat data are stored in the standard app folder.
            </p>
            <p
              className="mt-2 truncate font-mono text-xs"
              style={{ color: 'var(--ink-muted)', fontFamily: 'var(--font-mono)' }}
            >
              {defaultDir || '~/BobWork/BobWorkspace'}
            </p>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'color-mix(in oklab, var(--danger) 45%, transparent)', color: 'var(--danger)' }}>
              {error}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-between px-6 pb-6 pt-5">
          <span className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
            <Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
            Your data stays in the default app folder.
          </span>
          <div className="flex items-center gap-2">
            {/* Skip = 中性文字入口（焦点留给 Get Started） */}
            <Button
              variant="ghost"
              tone="neutral"
              size="md"
              onClick={finish}
              disabled={submitting}
            >
              Skip
            </Button>
            {/* 向导主 CTA：h-10 大按钮豁免（className 覆盖仅限此处） */}
            <Button
              variant="solid"
              tone="brand"
              size="md"
              onClick={finish}
              disabled={submitting}
              loading={submitting}
              className="h-10 px-5 text-sm"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Get Started
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
