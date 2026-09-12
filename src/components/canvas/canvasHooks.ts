// canvasHooks.ts —— CanvasFlowInner() 中内聚、低耦合的状态簇抽离为自定义 hook。
// 目标：降低 god component 体量，每个 hook 自包含（仅依赖注入的 API / 事件，不捕获组件本地 state），零行为变更。
'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { loadStarredApps, subscribeStarred, type StarredApp } from '@/lib/sandbox-starred';
import { desktop, isDesktop } from '@/lib/desktop-adapter';
import type { PluginPanelEntry } from '@/lib/plugin-panels';
import pkg from '../../../package.json';

/**
 * 标星小程序（与 SandboxPanel 共享数据源）：点击直接打开预览。
 * 返回与原始 useState 完全相同的 [value, setter] 元组。
 */
export function useStarredApps(): [StarredApp[], Dispatch<SetStateAction<StarredApp[]>>] {
  const [starredApps, setStarredApps] = useState<StarredApp[]>(() => loadStarredApps());
  useEffect(() => subscribeStarred(setStarredApps), []);
  return [starredApps, setStarredApps];
}

/**
 * BobMail 未读数（底部品牌区入口角标）：Sidebar（WantedNoticeCenter）统一广播。
 */
export function useMailPending(): [number, Dispatch<SetStateAction<number>>] {
  const [mailPending, setMailPending] = useState(0);
  useEffect(() => {
    const onPending = (e: Event) => {
      const detail = (e as CustomEvent).detail as { pending?: number } | undefined;
      setMailPending(detail?.pending ?? 0);
    };
    window.addEventListener('bobmail-pending', onPending);
    window.dispatchEvent(new CustomEvent('bobmail-pending-request'));
    return () => window.removeEventListener('bobmail-pending', onPending);
  }, []);
  return [mailPending, setMailPending];
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'no-update'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

/**
 * 底部品牌区：应用版本号 + 更新状态（点击触发检查/下载/安装，复用 desktop.update）。
 * 全部状态与订阅逻辑内聚在此 hook，渲染区仅消费返回值。
 */
export function useUpdateStatus() {
  const [appVersion, setAppVersion] = useState<string>(pkg.version);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateVersion, setUpdateVersion] = useState<string>('');
  const [updateProgress, setUpdateProgress] = useState<number>(0);
  const [updateErrText, setUpdateErrText] = useState('');
  useEffect(() => {
    if (!isDesktop()) return;
    desktop.update.getVersion().then((v) => {
      if (v) setAppVersion(v);
    }).catch(() => {});
    const unsubs = [
      desktop.update.onChecking(() => setUpdateStatus('checking')),
      desktop.update.onAvailable((info) => {
        setUpdateVersion(info?.version || '');
        setUpdateProgress(0);
        setUpdateStatus('available');
      }),
      desktop.update.onNotAvailable(() => setUpdateStatus('idle')),
      desktop.update.onError((info) => {
        setUpdateErrText(info?.message || 'Update failed');
        setUpdateStatus('error');
        setTimeout(() => setUpdateStatus((s) => (s === 'error' ? 'idle' : s)), 4000);
      }),
      desktop.update.onDownloadProgress((p) => {
        setUpdateProgress(p?.percent ?? 0);
        setUpdateStatus('downloading');
      }),
      desktop.update.onDownloaded((info) => {
        if (info?.version) setUpdateVersion(info.version);
        setUpdateProgress(100);
        setUpdateStatus('downloaded');
      }),
      desktop.update.onInstallProgress(() => setUpdateStatus('installing')),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, []);
  return { appVersion, setAppVersion, updateStatus, setUpdateStatus, updateVersion, updateProgress, updateErrText };
}

/**
 * 插件面板注册表（/api/plugin-panels）：驱动通用插件 Tab 与左侧快捷入口，替代逐个手写壳。
 * 拉取失败静默（不显示插件面板入口），不影响主流程。
 */
export function usePluginPanels(): [PluginPanelEntry[], Dispatch<SetStateAction<PluginPanelEntry[]>>] {
  const [pluginPanels, setPluginPanels] = useState<PluginPanelEntry[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/plugin-panels')
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d?.entries)) setPluginPanels(d.entries as PluginPanelEntry[]);
      })
      .catch(() => { /* 静默：注册表拉取失败则不显示插件面板入口 */ });
    return () => { alive = false; };
  }, []);
  return [pluginPanels, setPluginPanels];
}
