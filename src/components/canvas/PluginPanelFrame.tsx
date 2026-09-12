'use client';

/**
 * PluginPanelFrame — 通用插件面板宿主框（右侧预览面板内嵌）
 *
 * 插件面板注册表的通用渲染壳：mode=serve 的插件先探测就绪态（probeUrl）再挂 iframe，
 * 插件未运行（如 MCP 尚未拉起/端口未监听）时提示 + Retry；mode=static 由宿主代理托管，
 * 无需探测，直接 iframe 加载宿主 /api/plugin-panel/<id> URL。
 *
 * 标签页切换/关闭/缩放由右侧预览面板统一提供；本组件只负责「铺满父容器」。
 */

import { useCallback, useEffect, useState } from 'react';
import { Boxes, Loader2 } from 'lucide-react';

type Status = 'checking' | 'ready' | 'down';

interface PluginPanelFrameProps {
  /** 面板显示名（提示文案用） */
  name: string;
  /** iframe src（serve = 插件 URL；static = 宿主代理 URL） */
  src: string;
  /** serve 形态就绪探测端点（static 无） */
  probeUrl?: string;
}

export function PluginPanelFrame({ name, src, probeUrl }: PluginPanelFrameProps) {
  const [status, setStatus] = useState<Status>(() => (probeUrl ? 'checking' : 'ready'));

  const probe = useCallback(async () => {
    if (!probeUrl) return;
    setStatus('checking');
    try {
      const resp = await fetch(probeUrl, { signal: AbortSignal.timeout(2500) });
      const data = (await resp.json()) as { ok?: boolean };
      setStatus(data?.ok ? 'ready' : 'down');
    } catch {
      setStatus('down');
    }
  }, [probeUrl]);

  // 每次挂载探测一次（预览面板切到该 tab 重新挂载 = 重新探测 + 重新加载 iframe）
  useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <div className="h-full w-full" style={{ backgroundColor: 'var(--paper-soft)', position: 'relative' }}>
      {status === 'ready' ? (
        <iframe
          src={src}
          title={name}
          className="h-full w-full border-0"
          style={{ backgroundColor: 'var(--paper-soft)' }}
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
          {status === 'checking' ? (
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--ink-faint)' }} />
          ) : (
            <>
              <Boxes className="h-8 w-8" style={{ color: 'var(--ink-faint)' }} />
              <p className="text-xs" style={{ color: 'var(--ink-muted)', fontFamily: 'var(--font-sans)' }}>
                {name} plugin isn&apos;t reachable. Make sure the plugin service is enabled and running.
              </p>
              <button
                type="button"
                onClick={() => void probe()}
                className="rounded-md px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
                style={{ color: 'var(--primary-foreground)', backgroundColor: 'var(--primary)', fontFamily: 'var(--font-sans)' }}
              >
                Retry
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
