'use client';

/**
 * PluginPanelFrame — 通用插件面板宿主框（右侧预览面板内嵌）
 *
 * 插件面板注册表的通用渲染壳：mode=serve 的插件先探测就绪态再挂 iframe，
 * 未就绪时给出具体原因 + Retry；mode=static 由宿主代理托管，无需探测，
 * 直接 iframe 加载宿主 /api/plugin-panel/<id> URL。
 *
 * 探测统一走宿主路由 /api/plugin-panel-probe/<id>（而非前端直连插件 statusPath）：
 * 插件端口被残留旧进程占用时，前端直连会命中那个旧进程并误判就绪、静默加载旧界面；
 * 宿主侧结合插件写下的端口冲突标记能识别这种情况并回报 port-in-use。
 *
 * 标签页切换/关闭/缩放由右侧预览面板统一提供；本组件只负责「铺满父容器」。
 */

import { useCallback, useEffect, useState } from 'react';
import { Boxes, Loader2 } from 'lucide-react';

type Status = 'checking' | 'ready' | 'down';

/** 宿主探测路由返回（与 PluginPanelProbe 同形状） */
interface ProbeResult {
  ok?: boolean;
  reason?: 'port-in-use' | 'unreachable';
  port?: number;
  holderPid?: number | null;
}

interface PluginPanelFrameProps {
  /** 所属插件 id（走宿主探测路由；缺省时退回直连 probeUrl） */
  pluginId?: string;
  /** 面板显示名（提示文案用） */
  name: string;
  /** iframe src（serve = 插件 URL；static = 宿主代理 URL） */
  src: string;
  /** serve 形态就绪探测端点（static 无） */
  probeUrl?: string;
}

/** 未就绪文案：优先给出可操作的具体原因（如端口被残留进程占用） */
function downMessage(name: string, result: ProbeResult | null): string {
  if (result?.reason === 'port-in-use') {
    const port = result.port ? ` ${result.port}` : '';
    const holder = result.holderPid ? ` (pid ${result.holderPid})` : '';
    return `${name} panel port${port} is already in use by another process${holder}. Quit that process or restart BobWork, then retry.`;
  }
  return `${name} plugin isn't reachable. Make sure the plugin service is enabled and running.`;
}

export function PluginPanelFrame({ pluginId, name, src, probeUrl }: PluginPanelFrameProps) {
  const [status, setStatus] = useState<Status>(() => (probeUrl ? 'checking' : 'ready'));
  const [result, setResult] = useState<ProbeResult | null>(null);

  const probe = useCallback(async () => {
    if (!probeUrl) return;
    setStatus('checking');
    setResult(null);
    // 有 pluginId 时走宿主探测（能识别端口被残留旧进程占用）；否则退回直连插件端点
    const endpoint = pluginId ? `/api/plugin-panel-probe/${encodeURIComponent(pluginId)}` : probeUrl;
    try {
      const resp = await fetch(endpoint, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
      const data = (await resp.json()) as ProbeResult;
      if (data?.ok) {
        setStatus('ready');
        return;
      }
      setResult(data ?? null);
      setStatus('down');
    } catch {
      setResult({ ok: false, reason: 'unreachable' });
      setStatus('down');
    }
  }, [pluginId, probeUrl]);

  // 每次挂载探测一次（预览面板切到该 tab 重新挂载 = 重新探测 + 重新加载 iframe）
  useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <div className="h-full w-full" style={{ backgroundColor: '#fff', position: 'relative' }}>
      {status === 'ready' ? (
        <iframe
          src={src}
          title={name}
          className="h-full w-full border-0"
          style={{ backgroundColor: '#fff' }}
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          {status === 'checking' ? (
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--ink-faint)' }} />
          ) : (
            <>
              <Boxes className="h-8 w-8" style={{ color: 'var(--ink-faint)' }} />
              <p className="text-xs" style={{ color: 'var(--ink-muted)', fontFamily: 'var(--font-sans)' }}>
                {downMessage(name, result)}
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
