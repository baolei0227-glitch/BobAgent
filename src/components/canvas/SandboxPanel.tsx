'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Trash, Play, Loader2, Plus, X, Code2, Download, Upload, Star, Boxes, RefreshCw } from 'lucide-react';
import {
  loadSettings,
  updateSandboxGraphPermission,
  updateSandboxChatPermission,
  type SandboxGraphPermission,
  type SandboxChatPermission,
} from '@/lib/settings';
import { useConfirm } from './ConfirmDialog';
import { loadStarredApps, toggleStarredApp, subscribeStarred } from '@/lib/sandbox-starred';

/** Bridge action definition (mirrors BridgeActionDef from bridge.ts) */
interface BridgeActionDef {
  action: string;
  description: string;
  params?: string[];
  returns?: string;
}

/** Static bridge actions list for the API docs modal */
const BRIDGE_ACTIONS: BridgeActionDef[] = [
  {
    action: 'listActions',
    description: 'List all available bridge actions and their parameters',
    returns: 'BridgeActionDef[]',
  },
  {
    action: 'listNodes',
    description: 'List all nodes in the current project',
    returns: 'Array<{ nodeId, title, updatedAt }>',
  },
  {
    action: 'readNode',
    description: 'Read a node content by its node ID',
    params: ['nodeId:string'],
    returns: '{ nodeId, title, summary, content }',
  },
  {
    action: 'writeWanted',
    description: 'Write a file to the global wanted/ directory',
    params: ['filename:string', 'content:string'],
    returns: '{ path }',
  },
  {
    action: 'getProjectInfo',
    description: 'Get current project metadata',
    returns: '{ id, name, path }',
  },
  {
    action: 'chatGetPermission',
    description: 'Query whether this app is granted the model-call (chat) permission',
    returns: '{ granted: boolean }',
  },
  {
    action: 'chatRequestPermission',
    description: 'Request model-call permission from the user (host shows a confirmation dialog)',
    returns: '{ granted: boolean }',
  },
  {
    action: 'chat',
    description: 'Call the AI model (no tools, plain text). Requires chat permission + a model from the configured pool.',
    params: ['model?:string', 'messages:Array<{role,content}>', 'maxTokens?:number', 'temperature?:number'],
    returns: '{ content, model, usage? }',
  },
];

interface SandboxApp {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  entry: string;
}

/** 画布对接授权 chip 的展示元信息（太空舱对接协议） */
const PERMISSION_META: Record<
  SandboxGraphPermission,
  { label: string; text: string; bg: string; border: string; title: string }
> = {
  none: {
    label: 'None',
    text: 'oklch(0.45 0.02 55)',
    bg: 'oklch(0.96 0.005 70)',
    border: 'oklch(0.88 0.01 70)',
    title: 'Canvas access: not granted',
  },
  read: {
    label: 'Read',
    text: 'oklch(0.45 0.1 220)',
    bg: 'oklch(0.95 0.02 220)',
    border: 'oklch(0.85 0.05 220)',
    title: 'Canvas access: read-only',
  },
  control: {
    label: 'Control',
    text: 'oklch(0.5 0.14 35)',
    bg: 'oklch(0.96 0.03 35)',
    border: 'oklch(0.85 0.08 35)',
    title: 'Canvas access: read + operate',
  },
};

interface SandboxTemplate {
  id: string;
  label: string;
  description: string;
  entry: string;
}

/** 打开预览：派发 open-sandbox-preview 事件，由 CanvasFlow 在右侧悬浮面板打开 sandbox tab */
function openPreview(app: SandboxApp) {
  window.dispatchEvent(
    new CustomEvent('open-sandbox-preview', { detail: { id: app.id, name: app.name } }),
  );
}

/**
 * Bob Sandbox 边栏面板：小程序清单 / 新建（模板）/ 删除 / 打开预览。
 * 服务端数据源：GET /api/sandbox（apps + templates）。
 *
 * fullscreen 模式：全屏管理页（商城化布局，无预览 iframe），供 CanvasFlow 以全屏覆盖层打开。
 * 两种模式共享同一份 state / 数据加载 / 操作 handlers，避免逻辑重复。
 */
export function SandboxPanel({
  fullscreen = false,
  onClose,
}: {
  fullscreen?: boolean;
  onClose?: () => void;
}) {
  const [apps, setApps] = useState<SandboxApp[]>([]);
  const [templates, setTemplates] = useState<SandboxTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('blank');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [apiDocsOpen, setApiDocsOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 标星（收藏）小程序 id 集合：localStorage 持久化，与 Sidebar 收起态 rail 共享
  const [starredIds, setStarredIds] = useState<string[]>(() => loadStarredApps().map((a) => a.id));
  // 标星弹窗：点击标星时弹出，支持编辑图标显示文字
  const [starDialog, setStarDialog] = useState<{ appId: string; appName: string; label: string } | null>(null);
  useEffect(() => subscribeStarred((apps) => setStarredIds(apps.map((a) => a.id))), []);
  // 小程序画布对接授权表（appId → none/read/control），点击权限 chip 循环切换
  const [permissions, setPermissions] = useState<Record<string, SandboxGraphPermission>>({});
  // 小程序模型调用（bridge chat）三级授权表（appId → none/per_call/permanent），点击 chip 弹授权窗
  const [chatPermissions, setChatPermissions] = useState<Record<string, SandboxChatPermission>>({});
  const { ask: confirmAsk, askChoices: confirmAskChoices, render: confirmRender } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/sandbox');
      const data = await resp.json();
      if (data.success) {
        setApps(data.apps || []);
        setTemplates(data.templates || []);
      }
    } catch {
      setApps([]);
    } finally {
      setLoading(false);
    }
    // 读取画布对接授权表（Electron IPC / localStorage）
    try {
      const settings = await loadSettings();
      setPermissions(settings.sandboxGraphPermissions ?? {});
      // 模型调用授权表：直接保留三级（none / per_call / permanent），不再压平成 boolean
      setChatPermissions((settings.sandboxChatPermissions ?? {}) as Record<string, SandboxChatPermission>);
    } catch {
      setPermissions({});
      setChatPermissions({});
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 监听 sandbox-changed 事件（节点 AI 写入/修改小程序后广播），自动刷新列表
  useEffect(() => {
    const handler = () => load();
    window.addEventListener('sandbox-changed', handler);
    return () => window.removeEventListener('sandbox-changed', handler);
  }, [load]);

  // 监听 sandbox-permission-changed（小程序经 GraphGateway 授权弹窗获授权后广播），同步授权 chip
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ appId?: string; level?: SandboxGraphPermission }>).detail;
      if (!d?.appId) return;
      setPermissions((prev) => {
        const next = { ...prev };
        if (d.level && d.level !== 'none') next[d.appId as string] = d.level;
        else delete next[d.appId as string];
        return next;
      });
    };
    window.addEventListener('sandbox-permission-changed', handler);
    return () => window.removeEventListener('sandbox-permission-changed', handler);
  }, []);

  // 监听 sandbox-chat-permission-changed（小程序经模型调用授权弹窗获授权后广播），同步三级授权 chip
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ appId?: string; granted?: boolean; level?: SandboxChatPermission }>).detail;
      if (!d?.appId) return;
      setChatPermissions((prev) => {
        const next = { ...prev };
        if (d.level && d.level !== 'none') next[d.appId as string] = d.level;
        else if (d.granted) next[d.appId as string] = 'permanent';
        else delete next[d.appId as string];
        return next;
      });
    };
    window.addEventListener('sandbox-chat-permission-changed', handler);
    return () => window.removeEventListener('sandbox-chat-permission-changed', handler);
  }, []);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const resp = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name: name.trim() || 'Untitled App',
          template,
        }),
      });
      const data = await resp.json();
      if (data.success && data.app) {
        setApps((prev) => [data.app, ...prev]);
        setName('');
        setCreateOpen(false);
        openPreview(data.app);
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch('/api/sandbox', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setApps((prev) => prev.filter((a) => a.id !== id));
      setConfirmDelete(null);
    } catch {
      // ignore
    }
  };

  const handleExport = (id: string) => {
    // Triggers browser download of the app as ZIP
    window.location.href = `/api/sandbox/export/${id}`;
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch('/api/sandbox/import', {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      if (data.success) {
        await load();
      }
    } catch {
      // ignore
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** 向所有当前打开的 sandbox 预览 iframe 广播 chat 权限变更事件 */
  const broadcastChatPermissionChanged = useCallback((appId: string, granted: boolean) => {
    try {
      const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/api/sandbox/preview/"]');
      iframes.forEach((iframe) => {
        try {
          iframe.contentWindow?.postMessage(
            { type: 'bob_chat_permission_changed', appId, granted },
            '*',
          );
        } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
  }, []);

  /** 循环切换某小程序的画布对接授权：none → read → control → none */
  const cyclePermission = async (appId: string) => {
    const cur = permissions[appId] ?? 'none';
    const next: SandboxGraphPermission = cur === 'none' ? 'read' : cur === 'read' ? 'control' : 'none';
    try {
      await updateSandboxGraphPermission(appId, next);
      setPermissions((prev) => {
        const updated = { ...prev };
        if (next === 'none') delete updated[appId];
        else updated[appId] = next;
        return updated;
      });
      // 广播给 iframe（badge 内的 graph 系列动作状态感知）
      broadcastChatPermissionChanged(appId, next !== 'none');
    } catch {
      // ignore
    }
  };

  /** 刷新对应小程序预览 iframe：权限变更后重新加载以读取最新授权状态 */
  const reloadAppIframe = (appId: string) => {
    try {
      const targetIframe = document.querySelector<HTMLIFrameElement>(
        `iframe[src*="/api/sandbox/preview/${encodeURIComponent(appId)}"]`,
      );
      if (targetIframe?.contentWindow) {
        targetIframe.contentWindow.location.reload();
      }
    } catch { /* ignore */ }
  };

  /** 模型调用（bridge chat）三级授权：未授权 → 弹「首次使用模型授权」选择窗（Permanent / Ask Every Time / Deny）；
   *  已授权 → 点击弹确认后撤销，避免误关。 */
  const handleChatPermissionClick = async (appId: string) => {
    const current = chatPermissions[appId] ?? 'none';

    // 已授权：确认后撤销（切回 none）
    if (current !== 'none') {
      const revoke = await confirmAsk({
        title: 'Revoke Model Access',
        message:
          `Revoke AI model-call access for mini-program "${appId}"?\n\n` +
          'It will no longer be able to call your configured models.',
        confirmLabel: 'Revoke',
        cancelLabel: 'Keep',
      });
      if (!revoke) return;
      try {
        await updateSandboxChatPermission(appId, 'none');
        setChatPermissions((prev) => {
          const next = { ...prev };
          delete next[appId];
          return next;
        });
        broadcastChatPermissionChanged(appId, false);
        reloadAppIframe(appId);
      } catch { /* ignore */ }
      return;
    }

    // 未授权：首次使用模型授权 —— 三级选择弹窗
    const chosen = await confirmAskChoices({
      title: 'Model-Call Permission',
      message:
        `Mini-program "${appId}" requests permission to call your AI models.\n\n` +
        '▸ "Permanent Allow" — grant forever, never ask again for this mini-program\n' +
        '▸ "Ask Every Time" — confirm before each call (with cost estimate)\n' +
        '▸ "Deny" — block all model calls',
      choices: [
        { label: 'Permanent Allow', value: 'permanent' },
        { label: 'Ask Every Time', value: 'per_call' },
        { label: 'Deny', value: 'none' },
      ],
      cancelLabel: 'Cancel',
    });
    if (!chosen) return; // 取消不改变状态
    const level: SandboxChatPermission = chosen === 'permanent' || chosen === 'per_call' ? chosen : 'none';
    try {
      await updateSandboxChatPermission(appId, level);
      setChatPermissions((prev) => {
        const next = { ...prev };
        if (level === 'none') delete next[appId];
        else next[appId] = level;
        return next;
      });
      broadcastChatPermissionChanged(appId, level !== 'none');
      reloadAppIframe(appId);
    } catch { /* ignore */ }
  };

  // 全屏模式：Esc 关闭
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, onClose]);

  // ---- 共享弹窗（fullscreen 市场与边栏入口共用）----
  const sharedModals = (
    <>
      {/* Bridge API Docs Modal */}
      {apiDocsOpen && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onClick={() => setApiDocsOpen(false)}
        >
          <div
            className="rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
            style={{ backgroundColor: 'var(--paper)', border: '1px solid var(--line)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--line-soft)' }}>
              <div className="flex items-center gap-2">
                <Code2 className="h-4 w-4" style={{ color: 'var(--info)' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>
                  Mini-app Bridge & Storage API
                </span>
              </div>
              <button
                type="button"
                onClick={() => setApiDocsOpen(false)}
                className="rounded p-1 transition-colors hover:bg-[var(--paper-hover)]"
              >
                <X className="h-4 w-4" style={{ color: 'var(--ink-muted)' }} />
              </button>
            </div>
            <div className="px-4 py-3 space-y-4">
              {/* BobStorage section */}
              <div>
                <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--info)' }}>
                  window.BobStorage — 3-Layer Persistence (auto-injected)
                </h3>
                <p className="text-xs mb-2" style={{ color: 'var(--ink-muted)' }}>
                  The iframe runtime automatically exposes a global{' '}
                  <code className="text-xs" style={{ background: 'var(--paper-soft)', padding: '1px 4px', borderRadius: 3 }}>
                    BobStorage
                  </code>{' '}
                  object. Data is auto-namespaced per app — no risk of collision with other mini-apps.
                </p>

                <div className="space-y-2">
                  <div className="rounded-md border p-2" style={{ borderColor: 'var(--line-soft)' }}>
                    <p className="text-xs font-semibold mb-1" style={{ color: 'var(--success)' }}>
                      Layer 1 — Browser localStorage (synchronous, lost on cache clear)
                    </p>
                    <ul className="text-xs space-y-0.5" style={{ color: 'var(--ink-muted)' }}>
                      <li><code style={{ fontWeight: 600 }}>BobStorage.set(key, value)</code> — writes JSON-serializable value</li>
                      <li><code style={{ fontWeight: 600 }}>BobStorage.get(key)</code> — returns parsed value or <code>null</code></li>
                      <li><code style={{ fontWeight: 600 }}>BobStorage.remove(key)</code> — removes a single key</li>
                      <li><code style={{ fontWeight: 600 }}>BobStorage.listLocalKeys()</code> — lists all keys for this app</li>
                    </ul>
                  </div>

                  <div className="rounded-md border p-2" style={{ borderColor: 'var(--line-soft)' }}>
                    <p className="text-xs font-semibold mb-1" style={{ color: 'var(--info)' }}>
                      Layer 2 — App-private Disk Directory (async, survives restart/reinstall)
                    </p>
                    <p className="text-xs mb-1" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                      Path: <code>~/BobWork/.sandbox/apps/&lt;appId&gt;/data/&lt;key&gt;.json</code>
                    </p>
                    <ul className="text-xs space-y-0.5" style={{ color: 'var(--ink-muted)' }}>
                      <li><code style={{ fontWeight: 600 }}>await BobStorage.save(key, value)</code> — writes JSON to disk</li>
                      <li><code style={{ fontWeight: 600 }}>await BobStorage.load(key)</code> — returns parsed value or <code>null</code></li>
                      <li><code style={{ fontWeight: 600 }}>await BobStorage.listDiskKeys()</code> — lists all disk keys for this app</li>
                      <li><code style={{ fontWeight: 600 }}>await BobStorage.deleteKey(key)</code> — removes a disk key</li>
                    </ul>
                  </div>

                  <div className="rounded-md border p-2" style={{ borderColor: 'var(--line-soft)' }}>
                    <p className="text-xs font-semibold mb-1" style={{ color: 'var(--danger)' }}>
                      Layer 3 — Global wanted/ Directory (async, for final deliverables)
                    </p>
                    <ul className="text-xs space-y-0.5" style={{ color: 'var(--ink-muted)' }}>
                      <li><code style={{ fontWeight: 600 }}>await BobStorage.writeWanted(filename, content)</code> — writes to <code>~/BobWork/wanted/</code></li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Host Bridge section */}
              <div>
                <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--info)' }}>
                  window.BobWork — Host API Bridge
                </h3>
                <p className="text-xs mb-2" style={{ color: 'var(--ink-muted)' }}>
                  Call host APIs via{' '}
                  <code className="text-xs" style={{ background: 'var(--paper-soft)', padding: '1px 4px', borderRadius: 3 }}>
                    window.BobWork.request(action, data)
                  </code>
                  .
                </p>
                {BRIDGE_ACTIONS.map((a) => (
                  <div key={a.action} className="mb-2 rounded-md border p-2" style={{ borderColor: 'var(--line-soft)' }}>
                    <div className="flex items-center gap-2">
                      <code className="text-xs font-semibold" style={{ color: 'var(--info)' }}>
                        {a.action}
                      </code>
                      {a.params && a.params.length > 0 && (
                        <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                          ({a.params.join(', ')})
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {a.description}
                    </p>
                    {a.returns && (
                      <p className="mt-0.5 text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                        Returns: {a.returns}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <div className="rounded-md p-2" style={{ backgroundColor: 'var(--paper-soft)' }}>
                <p className="text-xs font-medium mb-1" style={{ color: 'var(--ink)' }}>
                  Usage example:
                </p>
                <pre className="text-xs overflow-x-auto" style={{ color: 'var(--ink-strong)' }}>
{`// ========== Persistence ==========
// UI preference / temp state — localStorage (no await needed)
BobStorage.set('theme', 'dark');
const theme = BobStorage.get('theme');

// Important records / history — disk private dir
await BobStorage.save('records', [
  { id: 1, title: 'Case A', createdAt: Date.now() }
]);
const records = await BobStorage.load('records');

// ========== Host bridge ==========
// List all nodes in the current project
const nodes = await BobWork.request('listNodes');

// Read a node by ID
const node = await BobWork.request('readNode', {
  nodeId: 'n_abc123'
});

// Write a final deliverable to wanted/
await BobStorage.writeWanted('result.txt', 'Hello');

// Discover all actions at runtime
const actions = await BobWork.listActions();`}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 标星弹窗：编辑图标显示文字 */}
      {starDialog && (
        <div
          className="fixed inset-0 z-[2000] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onClick={() => setStarDialog(null)}
        >
          <div
            className="w-72 rounded-lg border p-3 shadow-lg"
            style={{ backgroundColor: 'var(--card)', borderColor: 'var(--line)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center gap-1.5">
              <Star className="h-3.5 w-3.5" style={{ color: 'var(--primary-strong)', fill: 'var(--primary-strong)' }} />
              <span className="text-xs font-semibold" style={{ color: 'var(--ink-strong)' }}>
                Star App
              </span>
            </div>
            <p className="mb-2 text-11" style={{ color: 'var(--ink-muted)' }}>
              Edit the label shown on the sidebar icon:
            </p>
            <input
              autoFocus
              value={starDialog.label}
              onChange={(e) => setStarDialog((d) => (d ? { ...d, label: e.target.value } : null))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && starDialog.label.trim()) {
                  toggleStarredApp({ id: starDialog.appId, name: starDialog.label.trim() });
                  setStarDialog(null);
                }
                if (e.key === 'Escape') setStarDialog(null);
              }}
              className="w-full rounded border px-2 py-1 text-xs outline-none transition-colors focus:border-[var(--info)]"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
            />
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setStarDialog(null)}
                className="rounded px-2 py-1 text-xs transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!starDialog.label.trim()}
                onClick={() => {
                  toggleStarredApp({ id: starDialog.appId, name: starDialog.label.trim() });
                  setStarDialog(null);
                }}
                className="rounded px-2 py-1 text-xs font-medium transition-opacity disabled:opacity-40"
                style={{ backgroundColor: 'var(--primary)', color: 'white' }}
              >
                Star
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmRender}
    </>
  );

  // ---- 全屏管理页（商城化布局，无预览 iframe；为小程序商城做准备）----
  if (fullscreen) {
    const fmt = (iso: string) => {
      if (!iso) return '—';
      try {
        return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch { return iso; }
    };
    return (
      <>
        <div
          className="fixed inset-0 z-[120] flex flex-col"
          style={{ backgroundColor: 'var(--paper)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* 顶栏 */}
          <div
            className="flex shrink-0 items-center gap-3 px-6 py-3"
            style={{ borderBottom: '1px solid var(--line)', backgroundColor: 'var(--paper-soft)' }}
          >
            <Boxes className="h-5 w-5 shrink-0" style={{ color: 'var(--primary)' }} />
            <span className="text-base font-bold tracking-tight" style={{ color: 'var(--ink)' }}>Bob Sandbox</span>
            <span className="rounded-full px-2 py-0.5 text-11 font-semibold" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>
              Mini Program Store
            </span>
            <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>{apps.length} apps</span>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setApiDocsOpen(true)}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--info)', border: '1px solid color-mix(in oklab, var(--info) 35%, transparent)' }}
              >
                <Code2 className="h-3.5 w-3.5" /> API
              </button>
              <button
                type="button"
                onClick={handleImportClick}
                disabled={importing}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-50"
                style={{ color: 'var(--ink-muted)', border: '1px solid var(--line)' }}
              >
                {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Import
              </button>
              <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={handleImportFile} />
              <button
                type="button"
                onClick={() => setCreateOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
                style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
              >
                <Plus className="h-3.5 w-3.5" /> New App
              </button>
              <button
                type="button"
                onClick={load}
                className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--danger-soft)]"
                style={{ color: 'var(--ink-muted)' }}
                title="Close (Esc)"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* 新建表单（内联展开） */}
          {createOpen && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--line-soft)', backgroundColor: 'var(--primary-soft)' }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="App name…"
                className="w-56 rounded-md border px-2.5 py-1.5 text-xs outline-none transition-colors"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
              />
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="rounded-md border px-2 py-1.5 text-xs outline-none"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating}
                className="flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-50"
                style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
              >
                {creating && <Loader2 className="h-3 w-3 animate-spin" />} Create
              </button>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* 主体：应用卡片网格 */}
          <div className="flex-1 overflow-y-auto px-6 py-5 ai-canvas-scroll">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--info)' }} />
              </div>
            ) : apps.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <Boxes className="h-10 w-10" style={{ color: 'var(--ink-faint)' }} />
                <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>No mini programs yet</p>
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-medium transition-colors"
                  style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
                >
                  <Plus className="h-3.5 w-3.5" /> New App
                </button>
              </div>
            ) : (
              <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                {apps.map((app) => {
                  const level = permissions[app.id] ?? 'none';
                  const permMeta = PERMISSION_META[level];
                  const chatLevel = chatPermissions[app.id] ?? 'none';
                  const isStarred = starredIds.includes(app.id);
                  const chatMeta =
                    chatLevel === 'permanent'
                      ? { label: 'AI On', color: 'oklch(0.4 0.08 150)', bg: 'oklch(0.95 0.03 150)', border: 'oklch(0.82 0.07 150)', title: 'Model call: permanent access (click to revoke)' }
                      : chatLevel === 'per_call'
                        ? { label: 'AI Ask', color: 'oklch(0.45 0.1 80)', bg: 'oklch(0.96 0.03 80)', border: 'oklch(0.85 0.08 80)', title: 'Model call: ask each time (click to revoke)' }
                        : { label: 'AI Off', color: 'oklch(0.45 0.02 55)', bg: 'oklch(0.96 0.005 70)', border: 'oklch(0.88 0.01 70)', title: 'Model call: not granted (click for first-use authorization)' };
                  return (
                    <div
                      key={app.id}
                      className="flex flex-col rounded-xl border p-4 transition-shadow hover:shadow-md"
                      style={{ borderColor: 'var(--line)', backgroundColor: 'var(--card)' }}
                    >
                      {/* 名称 + 标星 */}
                      <div className="flex items-start gap-2.5">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: 'var(--primary-soft)' }}>
                          <Code2 className="h-4 w-4" style={{ color: 'var(--primary)' }} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>{app.name}</span>
                            <button
                              type="button"
                              onClick={() => {
                                if (isStarred) toggleStarredApp({ id: app.id, name: app.name });
                                else setStarDialog({ appId: app.id, appName: app.name, label: app.name });
                              }}
                              className="shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--warn-soft)]"
                              title={isStarred ? 'Unstar (remove from sidebar)' : 'Star (pin to sidebar)'}
                            >
                              <Star className="h-3.5 w-3.5" style={{ color: isStarred ? 'var(--primary-strong)' : 'var(--ink-muted)', fill: isStarred ? 'var(--primary-strong)' : 'transparent' }} />
                            </button>
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                            {app.description || 'No description'}
                          </p>
                        </div>
                      </div>

                      {/* 元信息 */}
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-11" style={{ color: 'var(--ink-faint)' }}>
                        <span className="rounded px-1.5 py-0.5 font-mono" style={{ backgroundColor: 'var(--paper-soft)' }}>
                          {app.entry || 'index.html'}
                        </span>
                        <span>Updated {fmt(app.updatedAt)}</span>
                      </div>

                      {/* 权限 chips */}
                      <div className="mt-3 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => cyclePermission(app.id)}
                          className="flex shrink-0 items-center rounded-full px-2 py-0.5 text-11 font-semibold leading-none transition-[filter] hover:brightness-95"
                          style={{ color: permMeta.text, backgroundColor: permMeta.bg, border: `1px solid ${permMeta.border}` }}
                          title={`${permMeta.title}. Click to cycle: None → Read → Control → None`}
                        >
                          {permMeta.label}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleChatPermissionClick(app.id)}
                          className="flex shrink-0 items-center rounded-full px-2 py-0.5 text-11 font-semibold leading-none transition-[filter] hover:brightness-95"
                          style={{ color: chatMeta.color, backgroundColor: chatMeta.bg, border: `1px solid ${chatMeta.border}` }}
                          title={chatMeta.title}
                        >
                          {chatMeta.label}
                        </button>
                      </div>

                      {/* 操作行 */}
                      <div className="mt-auto flex items-center gap-1 pt-3" style={{ borderTop: '1px solid var(--line-soft)', marginTop: 10 }}>
                        <button
                          type="button"
                          onClick={() => { onClose?.(); openPreview(app); }}
                          className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
                          style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
                          title="Open preview in side panel"
                        >
                          <Play className="h-3 w-3" /> Preview
                        </button>
                        <button
                          type="button"
                          onClick={() => handleExport(app.id)}
                          className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--paper-hover)]"
                          style={{ color: 'var(--ink-muted)' }}
                          title="Export as ZIP"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                        {confirmDelete === app.id ? (
                          <button
                            type="button"
                            onClick={() => handleDelete(app.id)}
                            className="rounded px-1.5 py-0.5 text-11"
                            style={{ color: '#fff', backgroundColor: 'var(--danger)' }}
                          >
                            Confirm
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(app.id)}
                            className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--danger-soft)]"
                            style={{ color: 'var(--ink-muted)' }}
                            title="Delete"
                          >
                            <Trash className="h-3.5 w-3.5" style={{ color: 'var(--danger)' }} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {sharedModals}
      </>
    );
  }

  // ---- 边栏模式：统一入口，点击直接打开全屏小程序市场 ----
  // （小程序清单 / 新建 / 导入 / 权限等管理功能已全部收进全屏市场，边栏不再展开列表）
  return (
    <div className="px-2 py-1" style={{ borderTop: '1px solid var(--line-soft)', marginTop: 10, paddingTop: 10 }}>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('sandbox-store-open'))}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--paper-hover)]"
        title="Open Mini Program Store"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'var(--primary-soft)' }}>
          <Boxes className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-tight" style={{ color: 'var(--ink)' }}>
            Bob Sandbox
          </span>
          <span className="block text-10 leading-tight" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
            Mini Program Store
          </span>
        </span>
        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-10 font-semibold" style={{ backgroundColor: 'var(--primary-soft)', color: 'var(--primary)' }}>
          {apps.length}
        </span>
      </button>

      {/* 列表区已移除：小程序清单/新建/导入/权限等管理功能收进全屏市场，见 fullscreen 分支 */}

      {/* Bridge API Docs Modal / 标星弹窗 / confirm 已并入 sharedModals（fullscreen 与边栏共用） */}
      {sharedModals}
    </div>
  );
}

