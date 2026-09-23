'use client';

/**
 * McpStorePanel — Extensions Store · MCP & Plugins tab
 *
 * Market（全部可下载项；未装右侧 Install，已装卡片保留并显示 Installed）→ Install 即从预置模板写入 .settings.json 并启用；
 * 需 API Key 的条目只让用户填一行 Key（自动写入 env/headers，不暴露放置结构）；
 * 高风险条目（bob-browser/bobby/github/notion）下载前需二次确认。
 * Installed（已配置）→ 启停 / 连接状态 / 卸载（Bundled 系统服务仅启停）。
 * 自定/进阶 server 管理与编辑保留在 设置 → MCP Servers（本面板给出提示）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Search,
  Download,
  Loader2,
  AlertCircle,
  Check,
  Trash,
  ExternalLink,
  ShieldAlert,
  Plug,
  Puzzle,
  Settings2,
  RefreshCw,
  KeyRound,
} from 'lucide-react';
import { mcpEntryIcon } from './ext-icons';
import { ToggleSwitch } from './ToggleSwitch';
import { Button } from '@/components/ui/button';
import { loadSettings, updateSettingsFields } from '@/lib/settings';
import { desktop } from '@/lib/desktop-adapter';

interface McpAuthDetail {
  placeholder: string;
  signupUrl: string;
  description: string;
}

interface McpRuntime {
  state: string;
  error?: string;
  missingDeps?: string[];
}

interface McpStoreEntry {
  id: string;
  name: string;
  description: string;
  group: 'bundled' | 'download' | 'custom';
  category: string;
  risk: 'normal' | 'high';
  vetted: boolean;
  auth: boolean;
  /** 展示归属：plugin = 可独立打开的本地/随包能力；mcp = 作为节点工具连接的外部服务 */
  kind: 'plugin' | 'mcp';
  /** 静态插件面板（如 Screenshot OCR）：Installed 卡显示专用 Configure */
  pluginPanel?: 'screenshot-ocr';
  /** 条目自带配置页（Bob OCR 插件）：Installed 卡显示 Configure 入口 */
  config?: boolean;
  /** 条目需额外装配（Bob Browser 扩展下载/绑定）：Installed 卡显示 Setup 展开块 */
  setup?: boolean;
  installed: boolean;
  enabled: boolean;
  authDetail: McpAuthDetail | null;
  status?: McpRuntime;
}

const SYS_COLORS: Record<string, string> = {
  active: '#34a853',
  error: '#ea4335',
  pending: '#9aa0a6',
};

/** Add Custom 可选场景词（点击自动追加到名称，供服务端按启发式自动标注场景后注入） */
const SCENE_CHIPS = ['legal', 'ocr', 'coding', 'butler', 'design', 'audio'];

/* ===== Screenshot OCR（静态插件卡）：启用开关 + BobWork Capture 授权检测 直接落在卡片上 ===== */

type OcrPerm = 'granted' | 'denied' | 'unknown' | 'missing' | 'checking';

const OCR_PERM_META: Record<OcrPerm, { label: string; color: string }> = {
  granted: { label: 'Authorized', color: 'var(--success)' },
  denied: { label: 'Not authorized', color: 'var(--danger)' },
  unknown: { label: 'Status unknown', color: 'var(--ink-faint)' },
  missing: { label: 'Unavailable', color: 'var(--ink-faint)' },
  checking: { label: 'Checking…', color: 'var(--ink-muted)' },
};

/** 截图 OCR 引擎三态（settings.screenOcr.engine） */
type ScreenOcrEngine = 'auto' | 'mcp' | 'local';
const OCR_ENGINE_OPTIONS: Array<{ value: ScreenOcrEngine; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'bob-ocr-mcp first, fall back to local Swift Vision' },
  { value: 'mcp', label: 'MCP', hint: 'bob-ocr-mcp only' },
  { value: 'local', label: 'Local', hint: 'local Swift Vision only' },
];

/**
 * Screenshot OCR 插件卡（⌘⇧O 截图 OCR）。
 * 静态 bundled 卡：无 mcp 服务实例——启停读写 settings.screenOcr.enabled；
 * 状态点/副标题反映 BobWork Capture 屏幕录制授权，「检测 + 开关」直接在卡上操作，无弹窗。
 */

/** OCR 条目图标（模块级常量：mcpEntryIcon 返回稳定引用，避免 render 内创建组件） */
const OCR_ENTRY_ICON = mcpEntryIcon('OCR');

function ScreenshotOcrCard() {
  const [enabled, setEnabled] = useState(true);
  const [engine, setEngine] = useState<ScreenOcrEngine>('auto');
  const [perm, setPerm] = useState<OcrPerm>('checking');

  // 读功能开关 + 引擎（settings.screenOcr；undefined = 默认启用 / auto）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await loadSettings();
        if (!cancelled) {
          setEnabled(s.screenOcr?.enabled !== false);
          const e = s.screenOcr?.engine;
          setEngine(e === 'mcp' || e === 'local' ? e : 'auto');
        }
      } catch { /* 读取失败保持默认启用 / auto */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // 检测：查询 BobWork Capture 授权状态（助手 check 模式自报，不弹窗不截图）
  const refreshStatus = useCallback(async () => {
    setPerm('checking');
    try {
      const r = await desktop.screenOcr.getPermissionStatus();
      setPerm(r.status === 'granted' ? 'granted' : r.status === 'denied' ? 'denied' : r.status === 'missing' ? 'missing' : 'unknown');
    } catch {
      setPerm('unknown');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    await persistScreenOcr({ enabled: next });
  };

  const changeEngine = async (next: ScreenOcrEngine) => {
    setEngine(next);
    await persistScreenOcr({ engine: next });
  };

  // 写完整 screenOcr 对象（updateSettingsFields 为浅合并，缺省补全避免丢另一字段）
  const persistScreenOcr = async (patch: Partial<{ enabled: boolean; engine: ScreenOcrEngine }>) => {
    try {
      const s = await loadSettings();
      const cur = s.screenOcr ?? {};
      const base = {
        enabled: cur.enabled !== false,
        engine: (cur.engine === 'mcp' || cur.engine === 'local' ? cur.engine : 'auto') as ScreenOcrEngine,
      };
      await updateSettingsFields({ screenOcr: { ...base, ...patch } });
    } catch { /* 保存失败保持本地状态 */ }
  };

  const meta = OCR_PERM_META[perm];
  const dotColor = enabled ? meta.color : 'var(--line)';
  const subtitle = enabled ? meta.label : 'Disabled';
  return (
    <div className="rounded-md border px-3 py-2.5" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
        >
          <OCR_ENTRY_ICON className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} title={`Screen-recording permission: ${meta.label}`} />
            <span className="truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>Screenshot OCR</span>
            <span
              className="rounded px-1.5 py-px text-10 font-medium leading-4"
              style={{ color: 'var(--ink-muted)', backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)' }}
            >
              System
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs leading-snug" style={{ color: enabled ? meta.color : 'var(--ink-muted)' }}>
            {subtitle}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {enabled && perm === 'denied' && (
            <Button
              type="button"
              onClick={() => { void desktop.screenOcr.openPermissions(); }}
              variant="solid"
              tone="brand"
              size="sm"
              title="Open System Settings → Screen Recording to grant permission"
            >
              Authorize
            </Button>
          )}
          <Button
            type="button"
            onClick={() => void refreshStatus()}
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            title="Re-check screen-recording permission"
            aria-label="Re-check permission"
          >
            {perm === 'checking' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
          <ToggleSwitch
            checked={enabled}
            onChange={() => void toggleEnabled()}
            title={enabled ? 'Disable screenshot OCR' : 'Enable screenshot OCR'}
          />
        </div>
      </div>

      {/* OCR 引擎切换（三态；disabled 时置灰不可点） */}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-10 font-medium uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>OCR Engine</span>
        <div
          className="ml-auto inline-flex items-center gap-0.5 rounded-full p-0.5"
          style={{ backgroundColor: 'var(--paper-hover)' }}
        >
          {OCR_ENGINE_OPTIONS.map((o) => {
            const active = engine === o.value;
            return (
              <button
                key={o.value}
                type="button"
                disabled={!enabled}
                onClick={() => void changeEngine(o.value)}
                title={o.hint}
                className="rounded-full px-2 py-0.5 text-10 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: active ? 'var(--primary-soft)' : 'transparent',
                  color: active ? 'var(--primary-strong)' : 'var(--ink-muted)',
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function McpStorePanel() {
  const [view, setView] = useState<'market' | 'installed' | 'custom'>('market');
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<McpStoreEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 展开态：key 输入 / 高风险确认
  const [keyRowId, setKeyRowId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  // Installed 卡更换 API Key（已装条目按预置 authScheme 回写 env/headers）
  const [editKeyId, setEditKeyId] = useState<string | null>(null);
  const [editKey, setEditKey] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);
  // 展开态：Bob Browser 扩展装配（下载/绑定链接）
  const [setupOpenId, setSetupOpenId] = useState<string | null>(null);
  // Add Custom：自建/自托管 MCP（registry 之外，作为独立 tab 视图）
  const [customName, setCustomName] = useState('');
  const [customEndpoint, setCustomEndpoint] = useState('');
  const [addingCustom, setAddingCustom] = useState(false);

  const load = useCallback(async () => {
    try {
      const [storeRes, statusRes] = await Promise.all([
        fetch('/api/mcp/store'),
        fetch('/api/mcp/status'),
      ]);
      const store = (await storeRes.json()) as { entries?: McpStoreEntry[] };
      const status = (await statusRes.json()) as { statuses?: Array<McpRuntime & { id: string }> };
      const st = new Map((status.statuses || []).map((r) => [r.id, r]));
      setEntries(
        (store.entries || []).map((e) => ({
          ...e,
          status: st.get(e.id)
            ? { state: st.get(e.id)!.state, error: st.get(e.id)!.error, missingDeps: st.get(e.id)!.missingDeps }
            : undefined,
        })),
      );
    } catch (e) {
      setNotice({ type: 'err', text: e instanceof Error ? e.message : 'Failed to load MCP store' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (type: 'ok' | 'err', text: string) => {
    setNotice({ type, text });
    window.setTimeout(() => setNotice(null), 3000);
  };

  const postAction = async (action: 'install' | 'uninstall' | 'enable' | 'disable' | 'updateKey', id: string, extra?: { apiKey?: string }) => {
    const res = await fetch('/api/mcp/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, id, ...extra }),
    });
    const data = (await res.json()) as { success?: boolean; error?: string };
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Operation failed (${res.status})`);
    }
  };

  /** Download（可选 apiKey，可选高风险二次确认） */
  const handleDownload = async (e: McpStoreEntry, key?: string) => {
    setBusyId(e.id);
    setNotice(null);
    try {
      await postAction('install', e.id, key ? { apiKey: key } : undefined);
      setKeyRowId(null);
      setConfirmId(null);
      setApiKey('');
      flash('ok', `Installed ${e.name}`);
      await load();
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Install failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggle = async (e: McpStoreEntry) => {
    setBusyId(e.id);
    try {
      await postAction(e.enabled ? 'disable' : 'enable', e.id);
      await load();
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleUninstall = async (e: McpStoreEntry) => {
    setBusyId(e.id);
    setNotice(null);
    try {
      await postAction('uninstall', e.id);
      setConfirmDelId(null);
      flash('ok', `Uninstalled ${e.name}`);
      await load();
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Uninstall failed');
    } finally {
      setBusyId(null);
    }
  };

  /** Installed 卡更换 API Key（updateKey：按预置 authScheme 写回 env/headers，保留其余配置并重连） */
  const handleUpdateKey = async (e: McpStoreEntry) => {
    const key = editKey.trim();
    if (!key) return;
    setBusyId(e.id);
    setNotice(null);
    try {
      await postAction('updateKey', e.id, { apiKey: key });
      setEditKeyId(null);
      setEditKey('');
      flash('ok', `Updated API key for ${e.name}`);
      await load();
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Failed to update the API key.');
    } finally {
      setBusyId(null);
    }
  };

  /** Configure（Bob OCR 等自带配置页的插件）：探测插件常驻服务并打开其配置页 */
  const handleOpenConfig = async (e: McpStoreEntry) => {
    setBusyId(e.id);
    setNotice(null);
    try {
      const res = await fetch('/api/ocr');
      const data = (await res.json()) as { mcpOnline?: boolean; settingsUrl?: string | null; error?: string };
      if (res.ok && data.mcpOnline && data.settingsUrl) {
        window.open(data.settingsUrl, '_blank', 'noopener,noreferrer');
      } else {
        flash('err', data.error || 'Bob OCR plugin is offline or not configured. Start it with: bob-ocr-mcp --install-daemon');
      }
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Failed to reach Bob OCR plugin. Is it running? (bob-ocr-mcp --serve)');
    } finally {
      setBusyId(null);
    }
  };

  /** Bob Browser：下载扩展 zip（BobWork 从本机已安装包实时打包，不依赖桥运行） */
  const handleDownloadExtension = async (e: McpStoreEntry) => {
    setBusyId(e.id);
    setNotice(null);
    try {
      const res = await fetch('/api/wanted/browser-extension-zip');
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        flash('err', data?.error || 'bob-browser-mcp is not installed. Run: npm install -g bob-browser-mcp');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bob-browser-extension.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      flash('ok', 'Extension downloaded — load it at chrome://extensions → Load unpacked');
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Failed to download the extension.');
    } finally {
      setBusyId(null);
    }
  };

  /** Bob Browser：复制连接地址（桥在线取 mcpUrl/token 派生；离线回退本机 token.json） */
  const handleCopyBindingLink = async (e: McpStoreEntry) => {
    try {
      const res = await fetch('/api/wanted/browser-bridge-token');
      const data = (await res.json()) as { bindingUrl?: string; error?: string };
      if (!res.ok || !data.bindingUrl) {
        flash('err', data?.error || 'No bridge endpoint available. Start bob-browser-mcp once, then retry.');
        return;
      }
      await navigator.clipboard.writeText(data.bindingUrl);
      flash('ok', 'Endpoint copied — the extension auto-connects to the bridge via /setup/status; paste this into a direct MCP client if needed.');
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Failed to copy the binding link.');
    }
  };

  /** Bob Browser：复制纯 token（桥在线取 /setup/status 实时 token；离线回退本机 token.json） */
  const handleCopyToken = async (e: McpStoreEntry) => {
    try {
      const res = await fetch('/api/wanted/browser-bridge-token');
      const data = (await res.json()) as { bindingUrl?: string; token?: string; error?: string };
      if (!res.ok || (!data.token && !data.bindingUrl)) {
        flash('err', data?.error || 'No token available. Start bob-browser-mcp once, then retry.');
        return;
      }
      let tok = data.token || '';
      if (!tok && data.bindingUrl) {
        const m = /[?&]token=([^&]+)/.exec(data.bindingUrl);
        if (m) tok = decodeURIComponent(m[1]);
      }
      if (!tok) {
        flash('err', 'No token found — restart bob-browser-mcp so it exposes a fresh token.');
        return;
      }
      await navigator.clipboard.writeText(tok);
      flash('ok', 'Token copied — authenticate direct MCP clients with it (Bearer).');
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Failed to copy the token.');
    }
  };

  /** 场景词 chip：追加/替换/移除名称尾部的 `-场景词` 后缀（帮助自动打场景） */
  const toggleSceneChip = (keyword: string) => {
    setCustomName((prev) => {
      const low = prev.toLowerCase();
      const isOn = low === keyword || low.endsWith(`-${keyword}`);
      if (isOn) {
        // 移除尾部 `-keyword`
        const cut = low === keyword ? prev.length - keyword.length : prev.length - keyword.length - 1;
        return prev.slice(0, cut).replace(/(-(?:legal|ocr|coding|butler|design|audio))+$/g, '').trimEnd();
      }
      const base = prev.replace(/(-(?:legal|ocr|coding|butler|design|audio))+$/g, '').trimEnd();
      return base ? `${base}-${keyword}` : keyword;
    });
  };

  /** Add Custom：注册 registry 之外的自定义 MCP（URL 或命令） */
  const handleAddCustom = async () => {
    const nm = customName.trim();
    const ep = customEndpoint.trim();
    if (!nm || !ep) {
      flash('err', 'Enter both a name and an endpoint (URL or command).');
      return;
    }
    setAddingCustom(true);
    setNotice(null);
    try {
      const res = await fetch('/api/mcp/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'addCustom', name: nm, endpoint: ep }),
      });
      const data = (await res.json()) as { success?: boolean; name?: string; error?: string };
      if (!res.ok || !data.success) {
        flash('err', data.error || 'Failed to add the custom server.');
        return;
      }
      setView('installed');
      setCustomName('');
      setCustomEndpoint('');
      flash('ok', `Added ${data.name ?? nm} — enable & manage it in Installed → MCP`);
      await load();
    } catch (err) {
      flash('err', err instanceof Error ? err.message : 'Failed to add the custom server.');
    } finally {
      setAddingCustom(false);
    }
  };

  // Market：全部下载制条目（已装卡片保留并显示 Installed 态）；系统 bundled 服务在 Installed · System
  const marketList = entries.filter((e) => e.group === 'download');
  const availableCount = marketList.filter((e) => !e.installed).length;
  const installedList = entries.filter((e) => e.installed);
  const q = search.trim().toLowerCase();
  const filteredMarket = q ? marketList.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)) : marketList;

  const statusColor = (s?: McpRuntime) => {
    if (!s) return SYS_COLORS.pending;
    if (s.state === 'active') return SYS_COLORS.active;
    if (s.state === 'error') return SYS_COLORS.error;
    return SYS_COLORS.pending;
  };

  const badge = (text: string, fg: string, bg: string) => (
    <span
      className="rounded px-1.5 py-px text-10 font-medium leading-4"
      style={{ color: fg, backgroundColor: bg }}
    >
      {text}
    </span>
  );

  const renderNotice = (
    <>
      {notice && (
        <div
          className="mb-3 flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs"
          style={{
            backgroundColor:
              notice.type === 'ok'
                ? 'color-mix(in oklab, var(--success) 6%, transparent)'
                : 'color-mix(in oklab, var(--danger) 6%, transparent)',
            color: notice.type === 'ok' ? 'var(--success)' : 'var(--danger)',
          }}
        >
          {notice.type === 'ok' ? <Check className="h-3.5 w-3.5 shrink-0" /> : <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}
    </>
  );

  /** Market 条目卡（按 kind 分区复用于 Plugins / MCP 两节） */
  const renderMarketCard = (e: McpStoreEntry) => {
    const keyOpen = keyRowId === e.id;
    const confirmOpen = confirmId === e.id;
    // Bob Browser 通过 Chrome 扩展装配：用插件（Puzzle）图标而非分类 Globe
    const EntryIcon = e.id === 'bob-browser-mcp' ? Puzzle : mcpEntryIcon(e.category);
    return (
      <div
        key={e.id}
        className="rounded-md border px-3 py-2.5"
        style={{
          borderColor: e.installed ? 'color-mix(in oklab, var(--primary) 22%, transparent)' : 'var(--line)',
          backgroundColor: e.installed ? 'color-mix(in oklab, var(--primary) 3%, transparent)' : 'transparent',
        }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
          >
            <EntryIcon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>{e.name}</span>
              {e.category && badge(e.category, 'var(--ink-muted)', 'color-mix(in oklab, var(--ink-muted) 12%, transparent)')}
              {e.auth && badge('API key', 'var(--ink-muted)', 'color-mix(in oklab, var(--primary) 12%, transparent)')}
              {e.risk === 'high' && badge('Powerful', 'var(--danger)', 'color-mix(in oklab, var(--danger) 10%, transparent)')}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              {e.description}
            </p>
          </div>
          {e.installed ? (
            <span
              className="flex shrink-0 items-center rounded-md px-2.5 py-1.5 text-xs font-medium"
              style={{
                color: 'var(--success)',
                border: '1px solid color-mix(in oklab, var(--success) 30%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--success) 6%, transparent)',
              }}
            >
              Installed
            </span>
          ) : (
            <Button
              type="button"
              disabled={busyId === e.id}
              loading={busyId === e.id}
              onClick={() => {
                if (e.risk === 'high') setConfirmId(e.id);
                else if (e.auth) { setKeyRowId(keyOpen ? null : e.id); setApiKey(''); }
                else void handleDownload(e);
              }}
              variant="solid"
              tone="brand"
              size="sm"
              className="shrink-0"
            >
              {busyId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
              {busyId === e.id ? 'Installing…' : 'Install'}
            </Button>
          )}
        </div>

        {/* Powerful 能力二次确认 */}
        {confirmOpen && (
          <div className="mt-2 flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'color-mix(in oklab, var(--danger) 30%, transparent)', backgroundColor: 'color-mix(in oklab, var(--danger) 6%, transparent)' }}>
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--danger)' }} />
            <span className="flex-1 leading-relaxed" style={{ color: 'var(--ink)' }}>
              {e.name} can {e.id === 'bob-browser-mcp' ? 'control your real browser' : e.id === 'bobby' ? 'run local commands and control apps' : e.id === 'github' ? 'modify your GitHub repositories' : 'read and write your connected workspace'} on your behalf. Confirm install?
            </span>
            <Button type="button" onClick={() => { setConfirmId(null); setApiKey(''); if (e.auth) setKeyRowId(e.id); else void handleDownload(e); }} variant="solid" tone="danger" size="sm">
              Confirm
            </Button>
            <Button type="button" onClick={() => setConfirmId(null)} variant="ghost" tone="neutral" size="sm">
              Cancel
            </Button>
          </div>
        )}

        {/* API Key 一行输入 */}
        {keyOpen && (
          <div className="mt-2 space-y-1.5">
            {e.authDetail?.description && (
              <p className="text-11 leading-snug" style={{ color: 'var(--ink-muted)' }}>
                {e.authDetail.description}{' '}
                {e.authDetail.signupUrl && (
                  <a href={e.authDetail.signupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline" style={{ color: 'var(--primary)' }}>
                    Get a key <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <input
                type="password"
                autoFocus
                value={apiKey}
                onChange={(ev) => setApiKey(ev.target.value)}
                placeholder={e.authDetail?.placeholder || 'Paste API key…'}
                onKeyDown={(ev) => { if (ev.key === 'Enter' && apiKey.trim()) void handleDownload(e, apiKey.trim()); }}
                className="h-7 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none"
                style={{ borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
              />
              <Button
                type="button"
                disabled={busyId === e.id || !apiKey.trim()}
                loading={busyId === e.id}
                onClick={() => void handleDownload(e, apiKey.trim())}
                variant="solid"
                tone="brand"
                size="sm"
              >
                {busyId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                Install
              </Button>
              <Button type="button" onClick={() => { setKeyRowId(null); setApiKey(''); }} variant="ghost" tone="neutral" size="sm">
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  /** Installed 条目卡（Plugins / MCP 两节共用） */
  const renderInstalledCard = (e: McpStoreEntry) => {
    // Screenshot OCR：静态 bundled 插件卡（自渲染：开关 + 授权检测，无 mcp 服务）
    if (e.pluginPanel === 'screenshot-ocr') return <ScreenshotOcrCard key={e.id} />;
    // Bob Browser 通过 Chrome 扩展装配：用插件（Puzzle）图标而非分类 Globe
    const EntryIcon = e.id === 'bob-browser-mcp' ? Puzzle : mcpEntryIcon(e.category);
    return (
      <div key={e.id} className="rounded-md border px-3 py-2.5" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center gap-2.5">
          {/* 图标（与 Market 卡同尺寸） */}
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
          >
            <EntryIcon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: statusColor(e.status) }} title={e.status?.error || e.status?.state || 'idle'} />
              <span className="truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>{e.name}</span>
              {e.group === 'bundled' && badge('System', 'var(--ink-muted)', 'color-mix(in oklab, var(--primary) 12%, transparent)')}
              {e.group === 'custom' && badge('Custom', 'var(--primary-strong)', 'color-mix(in oklab, var(--primary) 12%, transparent)')}
              {e.auth && badge('API key', 'var(--ink-muted)', 'color-mix(in oklab, var(--primary) 12%, transparent)')}
              {e.risk === 'high' && badge('Powerful', 'var(--danger)', 'color-mix(in oklab, var(--danger) 10%, transparent)')}
            </div>
            <p className="mt-0.5 truncate text-xs leading-snug" style={{ color: 'var(--ink-muted)' }}>
              {e.status?.error
                ? e.status.error
                : e.enabled
                  ? 'Connected'
                  : 'Disabled'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {e.setup && (
              <button
                type="button"
                onClick={() => { setSetupOpenId(setupOpenId === e.id ? null : e.id); setConfirmDelId(null); }}
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-soft)]"
                style={{ color: setupOpenId === e.id ? 'var(--primary)' : 'var(--ink-muted)' }}
                title="Load the Bob Browser Chrome extension (download & bind)"
              >
                <Puzzle className="h-3 w-3" />
              </button>
            )}
            {e.config && (
              <Button
                type="button"
                disabled={busyId === e.id}
                onClick={() => void handleOpenConfig(e)}
                variant="ghost"
                tone="neutral"
                size="sm"
                title="Open this plugin's configuration page (vision / GLM-OCR / Online OCR)"
              >
                <Settings2 className="h-3 w-3" />
                Configure
              </Button>
            )}
            {e.auth && (
              <button
                type="button"
                onClick={() => { setEditKeyId(editKeyId === e.id ? null : e.id); setEditKey(''); setSetupOpenId(null); }}
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-soft)]"
                style={{ color: editKeyId === e.id ? 'var(--primary)' : 'var(--ink-muted)' }}
                title="Update API key"
              >
                <KeyRound className="h-3 w-3" />
              </button>
            )}
            {e.group !== 'bundled' && (
              <>
                {confirmDelId === e.id ? (
                  <Button
                    type="button"
                    onClick={() => void handleUninstall(e)}
                    variant="solid"
                    tone="danger"
                    size="micro"
                  >
                    Confirm?
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => setConfirmDelId(e.id)}
                    variant="ghost"
                    tone="danger"
                    size="icon-sm"
                    title="Uninstall"
                    aria-label="Uninstall"
                  >
                    <Trash className="h-3 w-3" />
                  </Button>
                )}
              </>
            )}
            <ToggleSwitch
              checked={e.enabled}
              disabled={busyId === e.id}
              onChange={() => void handleToggle(e)}
              title={e.enabled ? 'Disable this server' : 'Enable this server'}
            />
          </div>
        </div>
        {/* Installed 卡内嵌：更换 API Key（仅 auth 条目） */}
        {editKeyId === e.id && (
          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="password"
              autoFocus
              value={editKey}
              onChange={(ev) => setEditKey(ev.target.value)}
              placeholder={`New API key for ${e.name}…`}
              onKeyDown={(ev) => { if (ev.key === 'Enter' && editKey.trim()) void handleUpdateKey(e); }}
              className="h-7 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none"
              style={{ borderColor: 'var(--line)', color: 'var(--ink-strong)' }}
            />
            <Button
              type="button"
              disabled={busyId === e.id || !editKey.trim()}
              loading={busyId === e.id}
              onClick={() => void handleUpdateKey(e)}
              variant="solid"
              tone="brand"
              size="sm"
            >
              {busyId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
            </Button>
            <Button
              type="button"
              onClick={() => { setEditKeyId(null); setEditKey(''); }}
              variant="ghost"
              tone="neutral"
              size="sm"
            >
              Cancel
            </Button>
          </div>
        )}
        {/* Bob Browser 扩展装配（下载扩展 + 复制绑定链接/Token） */}
        {setupOpenId === e.id && (
          <div className="mt-2 space-y-1.5 rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}>
            <p className="leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              Load the extension at <b style={{ color: 'var(--ink)' }}>chrome://extensions → Load unpacked</b>, then paste the binding link into its popup (⚙ Settings → Binding) to connect your real browser.
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                disabled={busyId === e.id}
                loading={busyId === e.id}
                onClick={() => void handleDownloadExtension(e)}
                variant="solid"
                tone="brand"
                size="sm"
              >
                {busyId === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                Download Extension
              </Button>
              <Button
                type="button"
                disabled={busyId === e.id}
                onClick={() => void handleCopyBindingLink(e)}
                variant="outline"
                tone="neutral"
                size="sm"
              >
                Copy Binding Link
              </Button>
              <Button
                type="button"
                disabled={busyId === e.id}
                onClick={() => void handleCopyToken(e)}
                variant="outline"
                tone="neutral"
                size="sm"
                title="Copy just the token — always available, persists at ~/.bob-browser-mcp/token.json"
              >
                Copy Token
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* 吸顶头部：视图切换 + 计数 + Market 搜索（不随内容滚动） */}
      <div
        className="sticky top-0 z-20 -mx-6 mb-3 border-b bg-[var(--paper)] px-6 pb-2 sm:-mx-8 sm:px-8"
        style={{ borderColor: 'var(--line-soft)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 rounded-md border p-0.5" style={{ borderColor: 'var(--line)' }}>
            <button
              type="button"
              onClick={() => setView('market')}
              className="rounded px-2.5 py-1 text-xs font-medium transition-colors"
              style={{
                color: view === 'market' ? 'var(--ink-strong)' : 'var(--ink-muted)',
                backgroundColor: view === 'market' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
              }}
            >
              Market
            </button>
            <button
              type="button"
              onClick={() => setView('installed')}
              className="rounded px-2.5 py-1 text-xs font-medium transition-colors"
              style={{
                color: view === 'installed' ? 'var(--ink-strong)' : 'var(--ink-muted)',
                backgroundColor: view === 'installed' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
              }}
            >
              Installed
            </button>
            <button
              type="button"
              onClick={() => { setView('custom'); setConfirmId(null); setKeyRowId(null); }}
              className="rounded px-2.5 py-1 text-xs font-medium transition-colors"
              style={{
                color: view === 'custom' ? 'var(--ink-strong)' : 'var(--ink-muted)',
                backgroundColor: view === 'custom' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
              }}
              title="Add an MCP server that is not in the store catalog (self-hosted / custom URL or command)"
            >
              Add Custom
            </button>
          </div>
          <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            {view === 'market' ? `${availableCount} available` : view === 'installed' ? `${installedList.length} installed` : ''}
          </span>
        </div>
        {view === 'market' && (
          <div className="relative mt-2">
            <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: 'var(--ink-muted)' }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search MCP servers…"
              className="w-full rounded-md border py-1.5 pl-7 pr-2 text-xs outline-none transition-colors"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink-strong)' }}
            />
          </div>
        )}
      </div>

      {renderNotice}

      {/* ===== Market：可下载服务器（搜索已吸顶） ===== */}
      {view === 'market' ? (
        <>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--primary)' }} />
            </div>
          ) : filteredMarket.length === 0 ? (
            <div className="rounded-md border px-4 py-6 text-center" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
              <Plug className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
              <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                {marketList.length === 0 ? 'No downloadable servers yet.' : 'No servers match your search.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {(() => {
                const sections = [
                  { key: 'plugins', label: 'Plugins', items: filteredMarket.filter((e) => (e.kind ?? 'plugin') === 'plugin') },
                  { key: 'mcp', label: 'MCP', items: filteredMarket.filter((e) => (e.kind ?? 'mcp') === 'mcp') },
                ].filter((s) => s.items.length > 0);
                if (sections.length === 0) {
                  return (
                    <div className="rounded-md border px-4 py-6 text-center" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
                      <Plug className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
                      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {marketList.length === 0 ? 'No downloadable servers yet.' : 'No servers match your search.'}
                      </p>
                    </div>
                  );
                }
                return (
                  <>
                    {sections.map((sec) => (
                      <div key={sec.key}>
                        <div className="mb-1.5 flex items-baseline gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>{sec.label}</span>
                          <span className="text-11" style={{ color: 'var(--ink-faint)' }}>
                            {sec.items.filter((i) => !i.installed).length} available
                          </span>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                          {sec.items.map((item) => renderMarketCard(item))}
                        </div>
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
          )}
        </>
      ) : view === 'custom' ? (
        /* ===== Add Custom：自建/自托管 MCP ===== */
        <>
          <div className="mb-3">
            <div className="flex items-center gap-1.5">
              <Plug className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
              <span className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>Connect a custom MCP server</span>
            </div>
          </div>
          <div className="space-y-2 rounded-md border px-3 py-2.5" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Name</label>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. My Local MCP"
                className="w-full rounded-md border px-2.5 py-1.5 text-xs outline-none"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)', color: 'var(--ink-strong)' }}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {SCENE_CHIPS.map((k) => {
                  const low = customName.toLowerCase();
                  const active = low === k || low.endsWith(`-${k}`);
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => toggleSceneChip(k)}
                      className="rounded-full border px-2 py-0.5 text-11 font-medium transition-colors"
                      style={{
                        borderColor: active ? 'color-mix(in oklab, var(--primary) 45%, transparent)' : 'var(--line)',
                        backgroundColor: active ? 'color-mix(in oklab, var(--primary) 10%, transparent)' : 'transparent',
                        color: active ? 'var(--primary-strong)' : 'var(--ink-muted)',
                      }}
                      title={active ? 'Remove this scene keyword from the name' : 'Append this scene keyword to the name'}
                    >
                      {k}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-11 leading-snug" style={{ color: 'var(--ink-faint)' }}>
                Click a scene keyword to append it to the name (e.g. Sogou Search-legal) so BobWork recognizes and injects this MCP&apos;s tools; click again to remove or switch.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>Endpoint</label>
              <input
                type="text"
                value={customEndpoint}
                onChange={(e) => setCustomEndpoint(e.target.value)}
                placeholder="https://…  (or a command like  npx -y @some/mcp-server)"
                className="w-full rounded-md border px-2.5 py-1.5 text-xs outline-none"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper)', color: 'var(--ink-strong)' }}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAddCustom(); }}
              />
              <p className="mt-1 text-11 leading-snug" style={{ color: 'var(--ink-faint)' }}>
                URL → streamable-http; anything else → stdio command. Advanced options (headers / env / timeouts) live in the server config file.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                onClick={() => { setCustomName(''); setCustomEndpoint(''); }}
                variant="ghost"
                tone="neutral"
                size="sm"
              >
                Clear
              </Button>
              <Button
                type="button"
                disabled={addingCustom || !customName.trim() || !customEndpoint.trim()}
                loading={addingCustom}
                onClick={() => void handleAddCustom()}
                variant="solid"
                tone="brand"
                size="sm"
              >
                {addingCustom ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
              </Button>
            </div>
          </div>
        </>
      ) : (
        /* ===== Installed：已配置服务器 ===== */
        <>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--primary)' }} />
            </div>
          ) : installedList.length === 0 ? (
            <div className="rounded-md border px-4 py-6 text-center" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
              <Plug className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
              <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>No MCP servers configured yet. Download one from Market.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {(() => {
                const sections = [
                  { key: 'plugins', label: 'Plugins', items: installedList.filter((e) => (e.kind ?? 'plugin') === 'plugin') },
                  { key: 'mcp', label: 'MCP', items: installedList.filter((e) => (e.kind ?? 'mcp') === 'mcp') },
                ].filter((s) => s.items.length > 0);
                if (sections.length === 0) {
                  return (
                    <div className="rounded-md border px-4 py-6 text-center" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
                      <Plug className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
                      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>No MCP servers configured yet. Download one from Market.</p>
                    </div>
                  );
                }
                return (
                  <>
                    {sections.map((sec) => (
                      <div key={sec.key}>
                        <div className="mb-1.5 flex items-baseline gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>{sec.label}</span>
                          <span className="text-11" style={{ color: 'var(--ink-faint)' }}>{sec.items.length} installed</span>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                          {sec.items.map((item) => renderInstalledCard(item))}
                        </div>
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>
          )}
          <p className="mt-4 text-11" style={{ color: 'var(--ink-faint)' }}>
            Custom servers are added via the Add Custom tab; advanced editing (command / env / headers) is stored in the server config file.
          </p>
        </>
      )}
    </div>
  );
}
