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

/** 品牌 logo 变更广播事件：设置面板 / 分享卡落盘 settings.brandLogo 后发出，侧边栏据此即时跟随 */
export const BRAND_LOGO_CHANGED_EVT = 'brand-logo-changed';

/** 默认品牌图标：不透明白底，需 multiply 融进栏底（见 CanvasFlow 渲染处注释） */
const DEFAULT_BRAND_LOGO = '/hippo-icon.png';

export interface BrandLogo {
  /** 图片地址：默认图标，或头像池条目的 dataUrl */
  src: string;
  /** 是否用 multiply 融掉不透明白底（仅默认图标需要；头像池条目自带 alpha，直接叠加） */
  multiply: boolean;
}

/** 通知各消费端重新解析品牌 logo（写入方在持久化 settings.brandLogo 之后调用） */
export function notifyBrandLogoChanged(): void {
  window.dispatchEvent(new Event(BRAND_LOGO_CHANGED_EVT));
}

/**
 * 底部品牌区 logo：读 settings.brandLogo（头像池 id）→ 解析出头像池里的 dataUrl；
 * 未设置 / 条目已失效（删除或换机）/ 非桌面环境一律回落默认图标，不出现空白图标。
 */
export function useBrandLogo(): BrandLogo {
  const [logo, setLogo] = useState<BrandLogo>({ src: DEFAULT_BRAND_LOGO, multiply: true });
  useEffect(() => {
    let alive = true;
    const fallback = () => setLogo({ src: DEFAULT_BRAND_LOGO, multiply: true });
    const resolve = async () => {
      try {
        const api = (window as unknown as {
          api?: {
            settings?: { load: () => Promise<{ brandLogo?: string } | null> };
            avatar?: { list: () => Promise<Array<{ id: string; dataUrl: string }>> };
          };
        }).api;
        const id = (await api?.settings?.load())?.brandLogo;
        if (!alive) return;
        if (!id) { fallback(); return; }
        const list = (await api?.avatar?.list()) ?? [];
        if (!alive) return;
        const hit = list.find((a) => a.id === id);
        setLogo(hit ? { src: hit.dataUrl, multiply: false } : { src: DEFAULT_BRAND_LOGO, multiply: true });
      } catch {
        if (alive) fallback();
      }
    };
    void resolve();
    const onChange = () => { void resolve(); };
    window.addEventListener(BRAND_LOGO_CHANGED_EVT, onChange);
    return () => { alive = false; window.removeEventListener(BRAND_LOGO_CHANGED_EVT, onChange); };
  }, []);
  return logo;
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
