'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Trash, Loader2, Plus, X, Code2, Download, Upload, Star, Boxes, RefreshCw, Globe, Pencil, Copy, History, Sparkles, MoreVertical } from 'lucide-react';
import {
  loadSettings,
  updateSandboxGraphPermission,
  isSandboxFullTrust,
  type SandboxGraphPermission,
  type SandboxChatPermission,
} from '@/lib/settings';
import { openSandboxPreviewInHippo } from '@/lib/sandbox/open-preview';
import { useConfirm } from './ConfirmDialog';
import { Button } from '@/components/ui/button';
import { loadStarredApps, toggleStarredApp, subscribeStarred, isStarred, pruneStarredApps } from '@/lib/sandbox-starred';

/** 图标快选（App details 弹窗内的一排常见 emoji）：点一下即填入，仍可在输入框里手改 */
const ICON_CHOICES = [
  '✅', '📋', '📝', '📊', '📈', '📖', '🧮', '🔁',
  '🍅', '🌱', '⏰', '📅', '🤖', '🚀', '👤', '💡',
  '⭐', '🎯', '🔧', '⚙️', '💰', '🛒', '🎨', '📷',
  '🔒', '🌐', '🧩', '❤️', '🔥', '📁',
];

/** 「最近打开」持久化（localStorage；仅本机 UI 态） */
const RECENT_KEY = 'bobwork.recent-sandbox-apps';
function loadRecentApps(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
function markAppOpened(id: string): Record<string, number> {
  const next = { ...loadRecentApps(), [id]: Date.now() };
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
  return next;
}

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
    description: 'Write a file to the global butler/ directory',
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
    description: 'Request model-call permission — no dialog any more: granted immediately unless this app was revoked',
    returns: '{ granted: boolean, level: "none"|"permanent" }',
  },
  {
    action: 'chat',
    description: 'Call the AI model (no tools, plain text). Requires chat permission + a model from the configured pool.',
    params: ['model?:string', 'messages:Array<{role,content}>', 'maxTokens?:number', 'temperature?:number'],
    returns: '{ content, model, usage? }',
  },
  {
    action: 'hostTool',
    description: 'Invoke ANY host tool by name — same registry the canvas AI agent uses (read_file / write_file / list_directory / run_command / execute_script / butler_* / create_project / notes_* / mcp__* …). No confirmation in full trust mode.',
    params: ['name:string', 'args?:object'],
    returns: '{ success: boolean, result: string, durationMs: number }',
  },
  {
    action: 'listHostTools',
    description: 'List every host tool available to hostTool (name / description / category / scenes)',
    returns: 'Array<{ name, description, category, scenes }>',
  },
];

interface SandboxApp {
  id: string;
  name: string;
  description: string;
  /** 卡片图标：emoji 或 1-2 个字符（缺省用 Code2 图标） */
  icon?: string;
  createdAt: string;
  updatedAt: string;
  entry: string;
  /** 来源/信任分级：imported = 第三方 ZIP，hostTool 只给只读且限自己目录（2026-10-10 评估 A5） */
  origin?: 'built' | 'imported';
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

/** 回收站条目（服务端 /api/sandbox GET 下发） */
interface TrashEntry {
  trashId: string;
  appId: string;
  name: string;
  deletedAt: string;
}

interface SandboxTemplate {
  id: string;
  label: string;
  description: string;
  entry: string;
}

/**
 * Bob Sandbox 全屏管理页（小程序商城）：小程序清单 / 新建（模板）/ 导入 / 权限 / 删除 / 打开预览。
 * 服务端数据源：GET /api/sandbox（apps + templates）。
 * 供 CanvasFlow 以全屏覆盖层打开；边栏入口形态已随 rail 移除。
 */
export function SandboxPanel({ onClose }: { onClose?: () => void }) {
  const [apps, setApps] = useState<SandboxApp[]>([]);
  const [templates, setTemplates] = useState<SandboxTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('blank');
  /** 卡片「…」菜单：资产操作收进来，卡片只留一个 Open 主按钮 */
  const [menuAppId, setMenuAppId] = useState<string | null>(null);
  const [apiDocsOpen, setApiDocsOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 标星（收藏）小程序 id 集合：localStorage 持久化，与 Sidebar 收起态 rail 共享
  const [starredIds, setStarredIds] = useState<string[]>(() => loadStarredApps().map((a) => a.id));
  // 标星弹窗：点击标星时弹出，支持编辑图标显示文字
  const [starDialog, setStarDialog] = useState<{ appId: string; appName: string; label: string } | null>(null);
  // 小程序详情弹窗（2026-10-18）：改名/描述/图标 + 复制 + 历史版本回滚
  const [metaDialog, setMetaDialog] = useState<{
    appId: string;
    name: string;
    description: string;
    icon: string;
    history: Array<{ stamp: string; file: string; size: number }> | null;
    historyLoading: boolean;
  } | null>(null);
  const [metaSaving, setMetaSaving] = useState(false);
  // 图标 AI 一键生成（路线 A）：生成中禁用按钮；失败就地内联提示，不弹窗
  const [iconGenerating, setIconGenerating] = useState(false);
  const [iconError, setIconError] = useState('');
  useEffect(() => subscribeStarred((apps) => setStarredIds(apps.map((a) => a.id))), []);
  // 小程序画布对接授权表（appId → none/read/control），点击权限 chip 循环切换
  const [permissions, setPermissions] = useState<Record<string, SandboxGraphPermission>>({});
  // 全局「完全信任」（2026-10-10 放开小程序权限）：只读，默认开 —— 模型零提示 + hostTool 全能力直通。
  // 无 UI 开关：收回请改 settings.json → sandboxFullTrust = false（本组件仅据此展示画布 chip 的默认级别）。
  const [fullTrust, setFullTrust] = useState(true);
  // 只读的模型调用授权表（2026-10-10 评估 C2）：授权控件已移除，但"这个 app 还能不能调模型"
  // 必须可见——否则被显式 revoke 的 app 只会静默失败。这里只读，不提供任何写入口。
  const [chatPermissions, setChatPermissions] = useState<Record<string, SandboxChatPermission>>({});
  // 回收站 + 孤儿目录（2026-10-10：删除改为可恢复）
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [ghosts, setGhosts] = useState<string[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  // 操作结果提示（删除解绑了几个节点、恢复成功/失败等），一条内联提示，不弹窗
  const [notice, setNotice] = useState<string | null>(null);
  // 搜索 / 排序 / 最近打开（2026-10-10 评估 P0-3：原来做完就找不到）
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'opened' | 'name'>('updated');
  const [recent, setRecent] = useState<Record<string, number>>(() => loadRecentApps());
  const { ask: askConfirm, render: confirmRender } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/sandbox');
      const data = await resp.json();
      if (data.success) {
        const list = (data.apps as SandboxApp[]) || [];
        setApps(list);
        setTemplates(data.templates || []);
        setTrash((data.trash as TrashEntry[]) || []);
        setGhosts((data.ghosts as string[]) || []);
        // 死标星回收：删除/改名后 ⌘F 的快捷图标不该继续存在（2026-10-10 评估 P1-3）
        pruneStarredApps(list.map((a) => a.id));
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
      setChatPermissions((settings.sandboxChatPermissions ?? {}) as Record<string, SandboxChatPermission>);
      setFullTrust(isSandboxFullTrust(settings));
    } catch {
      setPermissions({});
      setChatPermissions({});
      setFullTrust(true);
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
        onClose?.();
        void openSandboxPreviewInHippo({ id: data.app.id, name: data.app.name });
      }
    } catch (e) {
      setNotice(`新建失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await askConfirm({
      title: 'Delete mini-app?',
      message: `Move “${name}” to Trash? You can restore it later.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      const resp = await fetch('/api/sandbox', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = (await resp.json()) as {
        success?: boolean; error?: string; nodesUnbound?: number; permissionsCleared?: boolean;
      };
      if (!resp.ok || data.success === false) {
        setNotice(`删除失败：${data.error || resp.status}`);
        return;
      }
      // 连接点收尾：标星（localStorage 在客户端，服务端删不到）+ 通知其它 UI
      if (isStarred(id)) toggleStarredApp({ id, name });
      window.dispatchEvent(new CustomEvent('sandbox-deleted', { detail: { appId: id } }));
      setApps((prev) => prev.filter((a) => a.id !== id));
      const unbound = data.nodesUnbound ?? 0;
      setNotice(
        `已把「${name}」移入回收站` +
        (unbound > 0 ? `，并解绑了 ${unbound} 个引用它的画布节点（节点保留）` : '') +
        (data.permissionsCleared ? '，授权记录已清理' : '') +
        '。可在回收站恢复。',
      );
      void load();
    } catch (e) {
      setNotice(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 打开详情弹窗（改名/描述/图标 + 复制 + 历史） */
  const openMetaDialog = (app: SandboxApp) => {
    setMetaDialog({
      appId: app.id,
      name: app.name,
      description: app.description || '',
      icon: app.icon || '',
      history: null,
      historyLoading: false,
    });
  };

  /** AI 一键生成图标（路线 A）：用名称+描述让任务模型挑一个 emoji，回填输入框（可再改/再生成） */
  const suggestIcon = async () => {
    if (!metaDialog || iconGenerating) return;
    setIconGenerating(true);
    setIconError('');
    try {
      const resp = await fetch('/api/sandbox/icon-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: metaDialog.name, description: metaDialog.description }),
      });
      const data = (await resp.json()) as { success?: boolean; icon?: string; error?: string };
      if (!resp.ok || data.success === false || !data.icon) {
        setIconError(data.error || 'Generation failed');
        return;
      }
      const next = data.icon;
      setMetaDialog((d) => (d ? { ...d, icon: next } : null));
    } catch (e) {
      setIconError(e instanceof Error && e.message ? e.message : 'Generation failed');
    } finally {
      setIconGenerating(false);
    }
  };

  const saveMeta = async () => {
    if (!metaDialog || metaSaving || !metaDialog.name.trim()) return;
    setMetaSaving(true);
    try {
      const resp = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_meta',
          id: metaDialog.appId,
          name: metaDialog.name,
          description: metaDialog.description,
          icon: metaDialog.icon,
        }),
      });
      const data = (await resp.json()) as { success?: boolean; error?: string };
      if (!resp.ok || data.success === false) {
        setNotice(`保存失败：${data.error || resp.status}`);
        return;
      }
      setMetaDialog(null);
      setNotice(`已更新「${metaDialog.name.trim()}」的名称/描述/图标`);
      void load();
    } catch (e) {
      setNotice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMetaSaving(false);
    }
  };

  const duplicateFromDialog = async () => {
    if (!metaDialog || metaSaving) return;
    setMetaSaving(true);
    try {
      const resp = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'duplicate', id: metaDialog.appId }),
      });
      const data = (await resp.json()) as { success?: boolean; app?: SandboxApp; error?: string };
      if (!resp.ok || data.success === false || !data.app) {
        setNotice(`复制失败：${data.error || resp.status}`);
        return;
      }
      setMetaDialog(null);
      setNotice(`已复制为「${data.app.name}」（代码复制，不复制私有数据/历史版本）`);
      void load();
    } catch (e) {
      setNotice(`复制失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMetaSaving(false);
    }
  };

  const loadHistory = async () => {
    if (!metaDialog) return;
    const appId = metaDialog.appId;
    setMetaDialog((d) => (d ? { ...d, historyLoading: true } : null));
    try {
      const resp = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'history', id: appId }),
      });
      const data = (await resp.json()) as { success?: boolean; entries?: Array<{ stamp: string; file: string; size: number }> };
      setMetaDialog((d) => (d && d.appId === appId ? { ...d, history: data.entries || [], historyLoading: false } : d));
    } catch {
      setMetaDialog((d) => (d && d.appId === appId ? { ...d, history: [], historyLoading: false } : d));
    }
  };

  const restoreHistory = async (entry: { stamp: string; file: string }) => {
    if (!metaDialog) return;
    try {
      const resp = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore_version', id: metaDialog.appId, file: entry.file, stamp: entry.stamp }),
      });
      const data = (await resp.json()) as { success?: boolean; error?: string };
      if (!resp.ok || data.success === false) {
        setNotice(`回滚失败：${data.error || resp.status}`);
        return;
      }
      setNotice(`已回滚 ${entry.file} 到 ${entry.stamp}`);
      void load();
      void loadHistory();
    } catch (e) {
      setNotice(`回滚失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 回收站：恢复 / 彻底删除 */
  const handleTrashAction = async (trashId: string, action: 'restore' | 'purge') => {
    try {
      const resp = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, trashId }),
      });
      const data = (await resp.json()) as { success?: boolean; error?: string; appId?: string };
      if (!resp.ok || data.success === false) {
        setNotice(`${action === 'restore' ? '恢复' : '彻底删除'}失败：${data.error || resp.status}`);
        return;
      }
      setNotice(action === 'restore' ? `已恢复「${data.appId}」` : '已彻底删除该回收站条目');
      void load();
    } catch (e) {
      setNotice(`操作失败：${e instanceof Error ? e.message : String(e)}`);
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
        setNotice(`已导入「${data.app?.name || data.app?.id || ''}」—— 它会以 Imported 标记运行（宿主工具只给只读权限）。`);
        await load();
      } else {
        setNotice(`导入失败：${data.error || resp.status}`);
      }
    } catch (e) {
      setNotice(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** 循环切换某小程序的画布对接授权：none → read → control → none。
   *  2026-10-10 修：起点必须与 chip **显示**的有效级别一致 —— 显示按 `?? (fullTrust ? 'control' : 'none')`
   *  取默认，点击却从 `?? 'none'` 起算，会把显示为 Control 的项一键降成 Read，且 None 永不可见。
   *  同时改成显式写入（含 'none'）：完全信任下"删键"等于回到默认 control，撤销会静默失效。 */
  const cyclePermission = async (appId: string) => {
    const cur = permissions[appId] ?? (fullTrust ? 'control' : 'none');
    const next: SandboxGraphPermission = cur === 'none' ? 'read' : cur === 'read' ? 'control' : 'none';
    try {
      await updateSandboxGraphPermission(appId, next);
      setPermissions((prev) => ({ ...prev, [appId]: next }));
    } catch (e) {
      setNotice(`画布授权切换失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Esc 分层（2026-10-10 评估 P1-1）：先关最上层子弹窗，再关整个商城。
  // 原来子弹窗里按 Esc 会直接关掉商城，用户填了一半的名字/表单全丢。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (starDialog) { setStarDialog(null); return; }
      if (menuAppId) { setMenuAppId(null); return; }
      if (trashOpen) { setTrashOpen(false); return; }
      if (apiDocsOpen) { setApiDocsOpen(false); return; }
      if (createOpen) { setCreateOpen(false); return; }
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, starDialog, menuAppId, trashOpen, apiDocsOpen, createOpen]);

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
              <Button
                variant="ghost"
                tone="neutral"
                size="icon-sm"
                onClick={() => setApiDocsOpen(false)}
                aria-label="关闭 API 文档"
              >
                <X className="h-4 w-4" />
              </Button>
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
                      Layer 3 — Global butler/ Directory (async, for final deliverables)
                    </p>
                    <ul className="text-xs space-y-0.5" style={{ color: 'var(--ink-muted)' }}>
                      <li><code style={{ fontWeight: 600 }}>await BobStorage.writeWanted(filename, content)</code> — writes to <code>~/BobWork/butler/</code></li>
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
                  . Full trust is {fullTrust ? 'ON' : 'OFF'} (global, set via
                  settings.json → sandboxFullTrust; no in-app switch) — with it on, mini-programs call models and
                  every host tool through{' '}
                  <code className="text-xs" style={{ background: 'var(--paper-soft)', padding: '1px 4px', borderRadius: 3 }}>
                    BobWork.host(name, args)
                  </code>{' '}
                  without any prompt.
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

// Write a final deliverable to butler/
await BobStorage.writeWanted('result.txt', 'Hello');

// ========== Full host capability (full trust mode) ==========
// Every host tool the canvas AI uses is callable, with no prompts:
const tools = await BobWork.listHostTools();            // discover names
const file = await BobWork.host('read_file', { path: 'homework/report.md' });
await BobWork.host('write_file', { path: 'homework/notes.md', content: '# hi' });
const ls = await BobWork.host('list_directory', { path: 'homework' });
const run = await BobWork.host('run_command', { cmd: 'ls -la' });
await BobWork.host('create_project', { name: 'New project' });

// Discover all built-in actions at runtime
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
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => setStarDialog(null)}
              >
                Cancel
              </Button>
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                disabled={!starDialog.label.trim()}
                onClick={() => {
                  toggleStarredApp({ id: starDialog.appId, name: starDialog.label.trim() });
                  setStarDialog(null);
                }}
              >
                Star
              </Button>
            </div>
          </div>
        </div>
      )}
      {/* 小程序详情弹窗（2026-10-18）：改名/描述/图标 + 复制 + 历史版本回滚 */}
      {metaDialog && (
        <div
          className="fixed inset-0 z-[2000] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onClick={() => setMetaDialog(null)}
        >
          <div
            className="mx-4 max-h-[82vh] w-full max-w-lg overflow-y-auto rounded-lg border p-4 shadow-xl"
            style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Pencil className="h-4 w-4" style={{ color: 'var(--primary)' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>App details</span>
              </div>
              <Button variant="ghost" tone="neutral" size="icon-sm" onClick={() => setMetaDialog(null)} aria-label="Close">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <label className="block">
              <span className="mb-1 block text-11" style={{ color: 'var(--ink-muted)' }}>Name</span>
              <input
                value={metaDialog.name}
                onChange={(e) => setMetaDialog((d) => (d ? { ...d, name: e.target.value } : null))}
                maxLength={80}
                className="w-full rounded border px-2 py-1 text-xs outline-none focus:border-[var(--info)]"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
              />
            </label>

            {/* 图标：手输 + emoji 快选 + AI 一键生成 */}
            <div className="mt-2">
              <span className="mb-1 flex items-center gap-1.5 text-11" style={{ color: 'var(--ink-muted)' }}>
                Icon
                {iconError && (
                  <span className="truncate text-10" style={{ color: 'var(--danger)' }}>{iconError}</span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <input
                  value={metaDialog.icon}
                  onChange={(e) => { setIconError(''); setMetaDialog((d) => (d ? { ...d, icon: e.target.value } : null)); }}
                  maxLength={8}
                  placeholder="🧩"
                  className="w-12 shrink-0 rounded border px-2 py-1 text-center text-sm outline-none focus:border-[var(--info)]"
                  style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                />
                <Button
                  variant="ghost"
                  tone="info"
                  size="xs"
                  onClick={() => void suggestIcon()}
                  loading={iconGenerating}
                  title="Generate an icon from the name and description"
                >
                  {iconGenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  {iconGenerating ? 'Generating…' : 'AI generate'}
                </Button>
                {metaDialog.icon && (
                  <Button
                    variant="ghost"
                    tone="neutral"
                    size="xs"
                    onClick={() => { setIconError(''); setMetaDialog((d) => (d ? { ...d, icon: '' } : null)); }}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <div className="mt-1.5 flex max-h-16 flex-wrap gap-1 overflow-y-auto">
                {ICON_CHOICES.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => { setIconError(''); setMetaDialog((d) => (d ? { ...d, icon: emoji } : null)); }}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-sm transition-colors hover:bg-[color-mix(in_oklab,var(--info)_12%,transparent)]"
                    style={{
                      border: `1px solid ${metaDialog.icon === emoji ? 'var(--info)' : 'transparent'}`,
                      backgroundColor: metaDialog.icon === emoji ? 'color-mix(in oklab, var(--info) 10%, transparent)' : 'transparent',
                    }}
                    aria-label={`Use icon ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
            <label className="mt-2 block">
              <span className="mb-1 block text-11" style={{ color: 'var(--ink-muted)' }}>Description</span>
              <textarea
                value={metaDialog.description}
                onChange={(e) => setMetaDialog((d) => (d ? { ...d, description: e.target.value } : null))}
                rows={3}
                maxLength={300}
                className="w-full resize-none rounded border px-2 py-1 text-xs outline-none focus:border-[var(--info)]"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
              />
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                onClick={saveMeta}
                disabled={metaSaving || !metaDialog.name.trim()}
              >
                {metaSaving ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="outline" tone="neutral" size="sm" onClick={duplicateFromDialog} disabled={metaSaving}>
                <Copy className="h-3 w-3" /> Duplicate
              </Button>
              <Button variant="outline" tone="neutral" size="sm" onClick={loadHistory} disabled={metaSaving || metaDialog.historyLoading}>
                <History className="h-3 w-3" /> {metaDialog.history ? 'Refresh versions' : 'Version history'}
              </Button>
              <span className="ml-auto truncate font-mono text-10" style={{ color: 'var(--ink-faint)' }}>{metaDialog.appId}</span>
            </div>
            {metaDialog.history !== null && (
              <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--line-soft)' }}>
                <div className="mb-1 text-11 font-medium" style={{ color: 'var(--ink-muted)' }}>File versions (newest first)</div>
                {metaDialog.historyLoading ? (
                  <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--ink-muted)' }} /></div>
                ) : metaDialog.history.length === 0 ? (
                  <p className="py-3 text-center text-11" style={{ color: 'var(--ink-muted)' }}>
                    No versions yet — a version is saved automatically before each AI write.
                  </p>
                ) : (
                  <div className="max-h-52 space-y-1 overflow-y-auto">
                    {metaDialog.history.map((entry) => (
                      <div
                        key={`${entry.stamp}-${entry.file}`}
                        className="flex items-center gap-2 rounded border px-2 py-1.5"
                        style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-11" style={{ color: 'var(--ink-strong)' }}>{entry.file}</div>
                          <div className="text-10" style={{ color: 'var(--ink-muted)' }}>
                            {entry.stamp} · {Math.max(1, Math.round(entry.size / 1024))} KB
                          </div>
                        </div>
                        <Button variant="outline" tone="warn" size="micro" onClick={() => void restoreHistory(entry)}>
                          Restore
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <p className="mt-2 text-10 leading-relaxed" style={{ color: 'var(--ink-faint)' }}>
              Duplicate copies code only (no private data or version history). Versions are created automatically before each write and can be restored above.
            </p>
          </div>
        </div>
      )}
      {confirmRender}

      {/* 回收站弹窗（2026-10-10）：删除改为可恢复；孤儿目录只提示不自动删 */}
      {trashOpen && (
        <div
          className="fixed inset-0 z-[320] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
          onClick={() => setTrashOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg shadow-xl mx-4 max-h-[80vh] overflow-y-auto"
            style={{ backgroundColor: 'var(--paper)', border: '1px solid var(--line)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <div className="flex items-center gap-2">
                <Trash className="h-4 w-4" style={{ color: 'var(--ink-muted)' }} />
                <span className="text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>Recycle Bin</span>
                <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>{trash.length} item(s)</span>
              </div>
              <Button variant="ghost" tone="neutral" size="icon-sm" onClick={() => setTrashOpen(false)} aria-label="Close recycle bin">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="px-4 py-3 space-y-2">
              {trash.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>回收站为空。</p>
              )}
              {trash.map((t) => (
                <div key={t.trashId} className="flex items-center gap-2 rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--line-soft)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold" style={{ color: 'var(--ink-strong)' }}>{t.name}</div>
                    <div className="truncate text-11" style={{ color: 'var(--ink-muted)' }}>
                      {t.appId} · 删除于 {fmt(t.deletedAt)}
                    </div>
                  </div>
                  <Button variant="outline" tone="success" size="xs" onClick={() => void handleTrashAction(t.trashId, 'restore')}>Restore</Button>
                  <Button variant="ghost" tone="danger" size="xs" onClick={() => void handleTrashAction(t.trashId, 'purge')}>Delete forever</Button>
                </div>
              ))}
              {ghosts.length > 0 && (
                <p className="pt-1 text-11" style={{ color: 'var(--warn)' }}>
                  另有 {ghosts.length} 个无 manifest 的孤儿目录（历史删除后又被写盘复活的残留）：{ghosts.slice(0, 5).join('、')}
                  {ghosts.length > 5 ? ' …' : ''}。它们不在小程序列表里，需要时手动删除 bob-sandbox/apps/ 下对应目录。
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );

  // ---- 全屏管理页（商城化布局，无预览 iframe；为小程序商城做准备）----
  /** 搜索 + 排序后的可见列表（2026-10-10 评估 P0-3） */
  const visibleApps = (() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? apps.filter((a) => `${a.name} ${a.description} ${a.id}`.toLowerCase().includes(q))
      : apps;
    const arr = [...filtered];
    if (sortBy === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    else if (sortBy === 'opened') arr.sort((a, b) => (recent[b.id] ?? 0) - (recent[a.id] ?? 0));
    else arr.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return arr;
  })();

  const fmt = (iso: string) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };
  return (
    <>
      {/* 居中浮窗外壳（约 880px × 78vh，圆角 + 阴影），背景保留主 UI */}
      <div
        className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 p-6"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div
          className="flex h-[90vh] w-[1400px] max-h-[94vh] max-w-[94vw] flex-col overflow-hidden rounded-2xl border shadow-2xl"
          style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--line)' } as React.CSSProperties}
        >
      <div className="flex min-h-0 w-full flex-1 flex-col">
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
            {/* 完全信任开关没有 UI 入口（2026-10-10 定档）：小程序权限全局默认放开，
                需要收回时改 settings.json 的 sandboxFullTrust = false（本组件只读该值用于展示画布 chip 默认级别）。 */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {trash.length > 0 && (
                <Button
                  variant="outline"
                  tone="neutral"
                  size="sm"
                  onClick={() => setTrashOpen(true)}
                  title="Recycle bin — restore or permanently delete removed mini-programs"
                >
                  <Trash className="h-3.5 w-3.5" /> Trash ({trash.length})
                </Button>
              )}
              <Button
                variant="outline"
                tone="info"
                size="sm"
                onClick={() => setApiDocsOpen(true)}
              >
                <Code2 className="h-3.5 w-3.5" /> API
              </Button>
              <Button
                variant="outline"
                tone="neutral"
                size="sm"
                onClick={handleImportClick}
                disabled={importing}
                loading={importing}
              >
                {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Import
              </Button>
              <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={handleImportFile} />
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                onClick={() => setCreateOpen((v) => !v)}
              >
                <Plus className="h-3.5 w-3.5" /> New App
              </Button>
              <Button
                variant="ghost"
                tone="neutral"
                size="icon"
                onClick={load}
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                tone="danger"
                size="icon"
                onClick={onClose}
                title="Close (Esc)"
                aria-label="Close (Esc)"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* 操作结果提示（删除解绑/恢复结果等）：一条内联条，可手动关闭 */}
          {notice && (
            <div
              className="flex shrink-0 items-start gap-2 px-6 py-2 text-xs"
              style={{ borderBottom: '1px solid var(--line-soft)', backgroundColor: 'var(--paper-soft)', color: 'var(--ink)' }}
            >
              <span className="flex-1">{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="shrink-0 rounded px-1 text-11 transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-muted)' }}
                aria-label="Dismiss notice"
              >
                关闭
              </button>
            </div>
          )}

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
              <Button
                variant="solid"
                tone="brand"
                size="sm"
                onClick={handleCreate}
                disabled={creating}
                loading={creating}
              >
                {creating && <Loader2 className="h-3 w-3 animate-spin" />} Create
              </Button>
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
            </div>
          )}

          {/* 主体：应用卡片网格 */}
          <div className="flex-1 overflow-y-auto px-6 py-5 ai-canvas-scroll">
            {/* 搜索 + 排序（做完就找不到的止血） */}
            {apps.length > 0 && (
              <div className="mb-3 flex items-center gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search mini programs…"
                  className="w-64 rounded-md border px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-[var(--info)]"
                  style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as 'updated' | 'opened' | 'name')}
                  className="rounded-md border px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                >
                  <option value="updated">Recently updated</option>
                  <option value="opened">Recently opened</option>
                  <option value="name">Name</option>
                </select>
                <span className="text-11" style={{ color: 'var(--ink-muted)' }}>
                  {visibleApps.length === apps.length ? `${apps.length} apps` : `${visibleApps.length} / ${apps.length}`}
                </span>
              </div>
            )}
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--info)' }} />
              </div>
            ) : visibleApps.length === 0 && apps.length > 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <Boxes className="h-10 w-10" style={{ color: 'var(--ink-faint)' }} />
                <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>{`No mini programs match "${query}"`}</p>
                <Button variant="outline" tone="neutral" size="md" onClick={() => setQuery('')}>Clear search</Button>
              </div>
            ) : visibleApps.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <Boxes className="h-10 w-10" style={{ color: 'var(--ink-faint)' }} />
                <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>No mini programs yet</p>
                <Button
                  variant="solid"
                  tone="brand"
                  size="md"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" /> New App
                </Button>
              </div>
            ) : (
              <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                {visibleApps.map((app) => {
                  // 有效级别 = 显式表项（含显式 none = 已 Revoke）优先；无表项时按完全信任开关取默认
                  const level = permissions[app.id] ?? (fullTrust ? 'control' : 'none');
                  const permMeta = PERMISSION_META[level];
                  const isStarred = starredIds.includes(app.id);
                  return (
                    <div
                      key={app.id}
                      className="flex flex-col rounded-xl border p-4 transition-shadow hover:shadow-md"
                      style={{ borderColor: 'var(--line)', backgroundColor: 'var(--card)' }}
                    >
                      {/* 名称 + 标星 */}
                      <div className="flex items-start gap-2.5">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: 'var(--primary-soft)' }}>
                          {app.icon ? (
                            <span className="text-base leading-none" aria-hidden>{app.icon}</span>
                          ) : (
                            <Code2 className="h-4 w-4" style={{ color: 'var(--primary)' }} />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>{app.name}</span>
                            {app.origin === 'imported' && (
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-10 font-semibold"
                                style={{ backgroundColor: 'var(--warn-soft, oklch(0.96 0.03 80))', color: 'var(--warn, oklch(0.5 0.12 80))' }}
                                title="Imported mini-program (third-party code): host tools are limited to read-only access inside its own folder"
                              >
                                Imported
                              </span>
                            )}
                            {/* 星标 = warn 语义（收藏/取消收藏），图标 fill 由 isStarred 驱动 */}
                            <Button
                              variant="ghost"
                              tone="warn"
                              size="icon-xs"
                              onClick={() => {
                                if (isStarred) toggleStarredApp({ id: app.id, name: app.name });
                                else setStarDialog({ appId: app.id, appName: app.name, label: app.name });
                              }}
                              title={isStarred ? 'Unstar (remove from sidebar)' : 'Star (pin to sidebar)'}
                              aria-label={isStarred ? 'Unstar' : 'Star'}
                            >
                              <Star className="h-3.5 w-3.5" style={{ color: isStarred ? 'var(--primary-strong)' : 'var(--ink-muted)', fill: isStarred ? 'var(--primary-strong)' : 'transparent' }} />
                            </Button>
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
                        {recent[app.id] ? <span>· Opened {fmt(new Date(recent[app.id]).toISOString())}</span> : null}
                      </div>

                      {/* 权限 chip：画布对接可切换；AI 模型调用只显示状态（没有任何应用内开关，2026-10-10 评估 C2） */}
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
                        <span
                          className="flex shrink-0 cursor-default items-center rounded-full px-2 py-0.5 text-11 font-semibold leading-none"
                          style={
                            (chatPermissions[app.id] ?? (fullTrust ? 'permanent' : 'none')) === 'none'
                              ? { color: 'oklch(0.45 0.02 55)', backgroundColor: 'oklch(0.96 0.005 70)', border: '1px solid oklch(0.88 0.01 70)' }
                              : { color: 'oklch(0.4 0.08 150)', backgroundColor: 'oklch(0.95 0.03 150)', border: '1px solid oklch(0.82 0.07 150)' }
                          }
                          title={
                            (chatPermissions[app.id] ?? (fullTrust ? 'permanent' : 'none')) === 'none'
                              ? `Model calls disabled for this app (explicit deny in settings.json → sandboxChatPermissions["${app.id}"]). No in-app switch — edit the config file to re-enable.`
                              : `Model calls allowed${chatPermissions[app.id] ? ' (explicit grant)' : ' (global full trust)'}. No in-app switch — revoke via settings.json → sandboxChatPermissions["${app.id}"] = "none".`
                          }
                        >
                          {(chatPermissions[app.id] ?? (fullTrust ? 'permanent' : 'none')) === 'none' ? 'AI: off' : 'AI: on'}
                        </span>
                      </div>

                      {/* 操作行 */}
                      <div className="mt-auto flex items-center gap-1 pt-3" style={{ borderTop: '1px solid var(--line-soft)', marginTop: 10 }}>
                        <Button
                          variant="solid"
                          tone="brand"
                          size="sm"
                          onClick={() => {
                            setRecent(markAppOpened(app.id));
                            // 商店/普通用户：直接开 Hippo（顶层页，最稳）；Coding 节点调试仍走应用内 Preview。
                            onClose?.();
                            void openSandboxPreviewInHippo({ id: app.id, name: app.name });
                          }}
                          title="Open this mini-app in the browser (Hippo)"
                        >
                          <Globe className="h-3 w-3" /> Open
                        </Button>
                        <div className="relative ml-auto">
                          <Button
                            variant="ghost"
                            tone="neutral"
                            size="icon-sm"
                            onClick={() => setMenuAppId((v) => (v === app.id ? null : app.id))}
                            title="More"
                            aria-label="More"
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                          {menuAppId === app.id && (
                            <>
                              <div className="fixed inset-0 z-[100]" onClick={() => setMenuAppId(null)} />
                              <div
                                className="absolute right-0 top-full z-[101] mt-1 w-44 rounded-lg border p-1 shadow-xl"
                                style={{ backgroundColor: 'var(--popover)', borderColor: 'var(--line)' }}
                              >
                                <button
                                  type="button"
                                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--paper-soft)]"
                                  style={{ color: 'var(--ink)' }}
                                  onClick={() => { setMenuAppId(null); openMetaDialog(app); }}
                                >
                                  <Pencil className="h-3.5 w-3.5" /> Details &amp; history
                                </button>
                                <button
                                  type="button"
                                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--paper-soft)]"
                                  style={{ color: 'var(--ink)' }}
                                  onClick={() => { setMenuAppId(null); handleExport(app.id); }}
                                >
                                  <Download className="h-3.5 w-3.5" /> Export
                                </button>
                                <button
                                  type="button"
                                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--paper-soft)]"
                                  style={{ color: 'var(--danger)' }}
                                  onClick={() => { setMenuAppId(null); void handleDelete(app.id, app.name); }}
                                >
                                  <Trash className="h-3.5 w-3.5" /> Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </div>
        </div>
      </div>
      {sharedModals}
    </>
  );
}

