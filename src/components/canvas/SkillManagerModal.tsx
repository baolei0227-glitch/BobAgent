'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Lightbulb, RefreshCw, Check, Loader2, Package, FolderOpen, Download, Trash, Link, FolderSearch, Globe, AlertCircle, X, Upload, FolderUp, Search, Plug, Sparkles, Bot } from 'lucide-react';
import { skillEntryIcon } from './ext-icons';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from './ToggleSwitch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { McpStorePanel } from './McpStorePanel';
import { AgentStorePanel } from './AgentStorePanel';

export interface SkillItem {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'external';
  version: string;
  enabled: boolean;
  /** 场景/领域类别标注（来自技能 frontmatter 或名称映射表） */
  scenes: string[];
}

/** 下载制技能（随包源，未下载不可用） */
export interface DownloadableSkill {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'external';
  version: string;
  scenes: string[];
  /** 是否已下载到本地（下载后可自由编辑，且已进入可用技能库） */
  installed: boolean;
}

interface SkillManagerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时的初始视图：market（默认，Skill Store）| installed | import */
  initialView?: 'installed' | 'market' | 'import';
}

interface InstallResult {
  success: boolean;
  skill?: { name: string; description: string };
  error?: string;
  detail?: string;
}

/** 场景筛选项（Market 视图场景徽标与 chips 用；Installed 已平铺不分类） */
const SCENE_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All Scenes' },
  { key: 'legal', label: 'Legal' },
  { key: 'bob-work', label: 'Bob Work' },
  { key: 'office', label: 'Office' },
  { key: 'design', label: 'Design' },
  { key: 'lark', label: 'Feishu / Lark' },
  { key: 'docs', label: 'Document Processing' },
  { key: 'dev', label: 'Development Tools' },
  { key: 'general', label: 'General' },
];

function SkillCard({ skill, onToggle, onUninstall, reinstallable, onReinstall, official = true }: {
  skill: SkillItem;
  onToggle: (name: string) => void;
  onUninstall?: (name: string) => void;
  /** 该技能存在随包官方源：可重装官方版（会覆盖本地自定义副本） */
  reinstallable?: boolean;
  onReinstall?: (name: string) => void;
  /** 是否官方来源（内置 / 随包下载）；false = 第三方导入（自定义），显示第三方图标 */
  official?: boolean;
}) {
  // 两态确认互斥：uninstall / reinstall 任一激活即重置另一个
  const [confirmAction, setConfirmAction] = useState<'uninstall' | 'reinstall' | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);
  const [needsExpand, setNeedsExpand] = useState(false);

  useEffect(() => {
    const el = descRef.current;
    if (el) {
      setNeedsExpand(el.scrollHeight > el.clientHeight + 2);
    }
  }, [skill.description]);

  const enabled = skill.enabled;
  const isUserSkill = skill.source !== 'builtin';
  const SkillIcon = skillEntryIcon(skill.name, skill.scenes || [], !!official);

  return (
    <div
      className="rounded-md border px-3 py-2 transition-colors"
      style={{
        borderColor: enabled ? 'color-mix(in oklab, var(--primary) 25%, transparent)' : 'var(--line)',
        backgroundColor: enabled ? 'color-mix(in oklab, var(--primary) 3%, transparent)' : 'var(--input-bg)',
      }}
    >
      {/* 头行：图标 + 名称 + 来源徽标 + 版本（与 Market 卡片同构，便于平铺后视觉对齐） */}
      <div className="flex items-center gap-1.5">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
        >
          <SkillIcon className="h-3.5 w-3.5" />
        </span>
        <span className="flex-1 truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>
          {skill.name}
        </span>
        {skill.source === 'builtin' && (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-xs leading-tight"
            style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)', color: 'var(--primary)' }}
          >
            <Package className="h-2.5 w-2.5" />System
          </span>
        )}
        {skill.source === 'user' && (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-xs leading-tight"
            style={{ backgroundColor: 'color-mix(in oklab, var(--success) 12%, transparent)', color: 'var(--success)' }}
          >
            <FolderOpen className="h-2.5 w-2.5" />User
          </span>
        )}
        <span className="shrink-0 text-xs leading-tight" style={{ color: 'var(--ink-faint)' }}>
          v{skill.version || '1.0.0'}
        </span>
      </div>

      <p
        ref={descRef}
        className={descExpanded ? 'mt-0.5 text-xs leading-relaxed' : 'mt-0.5 text-xs leading-relaxed line-clamp-2'}
        style={{ color: 'var(--ink-muted)' }}
      >
        {skill.description}
      </p>
      {needsExpand && (
        <button
          type="button"
          onClick={() => setDescExpanded(!descExpanded)}
          className="mt-0.5 text-xs transition-colors hover:underline"
          style={{ color: 'var(--primary)' }}
        >
          {descExpanded ? 'Collapse' : 'Expand'}
        </button>
      )}

      {confirmAction ? (
        /* 确认条：卸载 / 重装二次确认（替代整条底栏，避免窄卡片内挤压） */
        <div
          className="mt-2 flex items-center justify-between gap-1.5 rounded-md px-1.5 py-1"
          style={{ backgroundColor: 'color-mix(in oklab, var(--danger) 6%, transparent)' }}
        >
          <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--danger)' }}>
            {confirmAction === 'reinstall' ? 'Restore official version?' : 'Uninstall this skill?'}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              onClick={() => {
                if (confirmAction === 'reinstall') {
                  if (onReinstall) onReinstall(skill.name);
                } else {
                  if (onUninstall) onUninstall(skill.name);
                }
                setConfirmAction(null);
              }}
              variant="solid"
              tone="danger"
              size="micro"
            >Confirm</Button>
            <Button
              type="button"
              onClick={() => setConfirmAction(null)}
              variant="ghost"
              tone="neutral"
              size="icon-xs"
              title="Cancel"
              aria-label="Cancel"
            ><X className="h-3 w-3" /></Button>
          </span>
        </div>
      ) : (
        /* 底栏：启用开关（ToggleSwitch）+ 用户技能附加操作（重装官方版 / 卸载） */
        <div className="mt-2 flex items-center gap-1.5">
          <div
            className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2"
            style={{
              backgroundColor: enabled ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
            }}
            title={enabled ? 'Disable this skill' : 'Enable this skill'}
          >
            <ToggleSwitch
              checked={enabled}
              onChange={() => onToggle(skill.name)}
              title={enabled ? 'Disable this skill' : 'Enable this skill'}
            />
            <span className="truncate text-xs font-medium" style={{ color: enabled ? 'var(--primary)' : 'var(--ink-muted)' }}>
              {enabled ? 'Enabled' : 'Enable'}
            </span>
          </div>
          {isUserSkill && reinstallable && onReinstall && (
            <Button
              type="button"
              onClick={() => setConfirmAction('reinstall')}
              variant="outline"
              tone="brand"
              size="icon-sm"
              className="shrink-0"
              title="Reinstall the bundled official version (overwrites your local edits)"
              aria-label="Reinstall official version"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          )}
          {isUserSkill && onUninstall && (
            <Button
              type="button"
              onClick={() => setConfirmAction('uninstall')}
              variant="outline"
              tone="neutral"
              size="icon-sm"
              className="shrink-0"
              title="Uninstall skill"
              aria-label="Uninstall skill"
            >
              <Trash className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillManagerModal({ open, onOpenChange, initialView }: SkillManagerModalProps) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [downloadables, setDownloadables] = useState<DownloadableSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // 扩展类型：skills = 技能市场 / agents = Agent 市场 / mcp = MCP & Plugins 市场
  const [extTab, setExtTab] = useState<'skills' | 'agents' | 'mcp'>('skills');
  // 视图切换：market=市场（全部随包技能；未装右侧 Install，已装显示 Installed 态不移除）/ installed=已安装(系统+已下载) / import=自定义上传(GitHub/本地)
  const [view, setView] = useState<'installed' | 'market' | 'import'>('market');
  const [installSource, setInstallSource] = useState<'github' | 'local'>('github');
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');
  const [installSuccess, setInstallSuccess] = useState('');
  // 技能搜索（Installed 平铺列表）
  const [skillSearch, setSkillSearch] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // 市场视图状态（搜索/场景筛选/安装中）
  const [marketSearch, setMarketSearch] = useState('');
  const [marketScene, setMarketScene] = useState('all');
  const [downloadingName, setDownloadingName] = useState<string | null>(null);

  // 拖拽处理
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const file = e.dataTransfer.files?.[0];
      if (file) {
        // Electron/Tauri 桌面端有 .path 属性；浏览器端用 webkitRelativePath
        const path = (file as any).path || file.webkitRelativePath || file.name;
        setInstallUrl(path);
        setInstallError('');
      }
    }
  };

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/skills');
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || 'Failed to load');
        return;
      }
      const sourceOrder: Record<string, number> = { builtin: 0, user: 1, external: 2 };
      // 仅显示系统内置（builtin）与用户已下载（user）技能；隐藏外部兼容源（~/.claude、~/.cursor）技能
      const visible = [...(data.skills || [])].filter((s: SkillItem) => s.source !== 'external');
      const sorted = visible.sort((a: SkillItem, b: SkillItem) => {
        const aOrder = sourceOrder[a.source] ?? 2;
        const bOrder = sourceOrder[b.source] ?? 2;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.name.localeCompare(b.name);
      });
      setSkills(sorted);
      // 下载制技能清单（随包源）
      setDownloadables((data.downloadable || []) as DownloadableSkill[]);
    } catch (e) {
      setError('Network error');
      console.error('Load skills error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadSkills();
      setView(initialView ?? 'market');
      setInstallError('');
      setInstallSuccess('');
    }
  }, [open, loadSkills, initialView]);

  const toggleSkill = async (name: string) => {
    const oldSkills = [...skills];
    setSkills((prev) =>
      prev.map((s) => (s.name === name ? { ...s, enabled: !s.enabled } : s))
    );
    const skill = oldSkills.find((s) => s.name === name);
    if (!skill) return;
    const newEnabled = !skill.enabled;
    try {
      await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: newEnabled ? 'enable' : 'disable', skillName: name }),
      });
      window.dispatchEvent(new Event('skills-changed'));
    } catch (e) {
      console.error('Toggle skill error:', e);
      setSkills(oldSkills);
    }
  };

  const handleToggleAll = async () => {
    const allEnabled = skills.length > 0 && skills.every((s) => s.enabled);
    setSkills((prev) => prev.map((s) => ({ ...s, enabled: !allEnabled })));
    try {
      if (allEnabled) {
        for (const skill of skills) {
          await fetch('/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'disable', skillName: skill.name }),
          });
        }
      } else {
        await fetch('/api/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'enableAll' }),
        });
      }
      window.dispatchEvent(new Event('skills-changed'));
    } catch (e) {
      console.error('Toggle all error:', e);
      loadSkills();
    }
  };

  // 市场技能安装：从随包源物化到本地（~/BobWork/skills/<name>/），安装即启用；
  // 已装卡片保留在 Market 并切换为 Installed 态（不移除），编辑/卸载在 Installed 管理
  const handleDownload = async (skillName: string) => {
    if (downloadingName) return;
    setDownloadingName(skillName);
    setInstallError('');
    setInstallSuccess('');
    try {
      const resp = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'installBuiltin', skillName, force: false }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setInstallError(data.error || data.detail || 'Install failed');
        return;
      }
      setInstallSuccess(`Installed: ${data.skill!.name} — toggle & edit it in Installed`);
      loadSkills();
    } catch (e: any) {
      setInstallError(e?.message || 'Network error');
    } finally {
      setDownloadingName(null);
    }
  };

  // 重装官方版：Installed 中随包源技能恢复为随包官方版本（覆盖本地自定义前需二次确认，A 方案）
  const handleReinstall = async (skillName: string) => {
    setInstallError('');
    setInstallSuccess('');
    try {
      const resp = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'installBuiltin', skillName, force: true }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setInstallError(data.error || data.detail || 'Reinstall failed');
        return;
      }
      setInstallSuccess(`Reinstalled official version: ${data.skill?.name ?? skillName}`);
      loadSkills();
    } catch (e: any) {
      setInstallError(e?.message || 'Network error');
    }
  };

  // 安装技能
  const handleInstall = async () => {
    setInstallError('');
    setInstallSuccess('');
    if (!installUrl.trim()) {
      setInstallError('Please enter a GitHub URL or select a local path');
      return;
    }
    setInstalling(true);
    try {
      const resp = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'install',
          source: installSource,
          url: installSource === 'github' ? installUrl.trim() : undefined,
          localPath: installSource === 'local' ? installUrl.trim() : undefined,
        }),
      });
      const data: InstallResult = await resp.json();
      if (!resp.ok || !data.success) {
        setInstallError(data.error || data.detail || 'Installation failed');
        return;
      }
      setInstallSuccess(`Installed: ${data.skill!.name}`);
      setInstallUrl('');
      loadSkills();
    } catch (e: any) {
      setInstallError(e?.message || 'Network error');
    } finally {
      setInstalling(false);
    }
  };

  // 卸载用户技能
  const handleUninstall = async (skillName: string) => {
    try {
      const resp = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'uninstall', skillName }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setError(data.error || 'Uninstall failed');
        return;
      }
      loadSkills();
    } catch (e) {
      console.error('Uninstall error:', e);
    }
  };

  // 本地路径文件选择
  const handleLocalFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setInstallUrl(files[0].webkitRelativePath || files[0].name);
    }
  };

  // Installed 平铺：不再按场景分类，仅按搜索词过滤（2026-09-03）
  const query = skillSearch.trim().toLowerCase();
  const filteredSkills = skills.filter(
    (s) => !query || s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
  );
  const allEnabled = skills.length > 0 && skills.every((s) => s.enabled);
  const enabledCount = skills.filter(s => s.enabled).length;

  // 市场派生数据：全部随包技能（含已装 → 右侧显示 Installed 态，卡片不移除）+ 场景筛选项（用于 Market 视图）
  const marketSkills = downloadables;
  const availableCount = downloadables.filter((d) => !d.installed).length;
  const marketSceneLabel = (s: string) => SCENE_FILTERS.find((f) => f.key === s)?.label ?? s;
  const marketScenes = Array.from(
    new Set(
      downloadables
        .map((d) => d.scenes?.[0])
        .filter((s): s is string => !!s && SCENE_FILTERS.some((f) => f.key === s)),
    ),
  );

  // 随包官方源技能名集合：Installed 中这类 user 技能可「重装官方版」（覆盖本地副本）
  const officialNames = new Set(downloadables.map((d) => d.name));

  const inner = (
    <>
      <DialogHeader className="px-6 pt-6 pb-3">
        <DialogTitle
          className="flex items-center gap-2 text-base"
          style={{ color: 'var(--ink-strong)' }}
        >
          <Sparkles className="h-4 w-4" style={{ color: 'var(--primary)' }} />
          Extensions Store
        </DialogTitle>
      </DialogHeader>

      {/* 扩展类型切换：Skills / MCP & Plugins */}
      <div className="flex items-center gap-1 border-b px-6 py-2 sm:px-8" style={{ borderColor: 'var(--line-soft)' }}>
        <button
          type="button"
          onClick={() => setExtTab('skills')}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            color: extTab === 'skills' ? 'var(--ink-strong)' : 'var(--ink-muted)',
            backgroundColor: extTab === 'skills' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
          }}
        >
          <Lightbulb className="h-3 w-3" />
          Skills
        </button>
        <button
          type="button"
          onClick={() => setExtTab('agents')}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            color: extTab === 'agents' ? 'var(--ink-strong)' : 'var(--ink-muted)',
            backgroundColor: extTab === 'agents' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
          }}
        >
          <Bot className="h-3 w-3" />
          Agents
        </button>
        <button
          type="button"
          onClick={() => setExtTab('mcp')}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            color: extTab === 'mcp' ? 'var(--ink-strong)' : 'var(--ink-muted)',
            backgroundColor: extTab === 'mcp' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
          }}
        >
          <Plug className="h-3 w-3" />
          MCP & Plugins
        </button>
      </div>

        <div ref={scrollRef} className="nowheel min-h-0 overflow-y-auto px-6 pb-4 sm:px-8">
          {extTab === 'skills' ? (
          <>
          {/* 吸顶头部：视图切换 + 计数 + 各视图搜索/筛选（不随内容滚动） */}
          <div
            className="sticky top-0 z-20 -mx-6 mb-3 border-b bg-[var(--paper)] px-6 pb-2 sm:-mx-8 sm:px-8"
            style={{ borderColor: 'var(--line-soft)' }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 rounded-md border p-0.5" style={{ borderColor: 'var(--line)' }}>
                <button
                  type="button"
                  onClick={() => setView('market')}
                  className="rounded px-2.5 py-1 text-xs font-medium transition-colors flex items-center gap-1"
                  style={{
                    color: view === 'market' ? 'var(--ink-strong)' : 'var(--ink-muted)',
                    backgroundColor: view === 'market' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
                  }}
                >
                  <Download className="h-3 w-3" />
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
                  onClick={() => setView('import')}
                  className="rounded px-2.5 py-1 text-xs font-medium transition-colors flex items-center gap-1"
                  style={{
                    color: view === 'import' ? 'var(--ink-strong)' : 'var(--ink-muted)',
                    backgroundColor: view === 'import' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
                  }}
                >
                  <Globe className="h-3 w-3" />
                  Import
                </button>
              </div>
              {view === 'market' && (
                <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  {`${availableCount} available`}
                </span>
              )}
              {view === 'installed' && (
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {skills.length === 0
                      ? 'No skills found'
                      : `${enabledCount} / ${skills.length} enabled`}
                  </span>
                  <button
                    type="button"
                    onClick={handleToggleAll}
                    className="text-xs transition-colors hover:underline"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    {allEnabled ? 'Disable All' : 'Enable All'}
                  </button>
                  <Button
                    type="button"
                    onClick={loadSkills}
                    disabled={loading}
                    variant="ghost"
                    tone="neutral"
                    size="sm"
                  >
                    <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                  </Button>
                </div>
              )}
            </div>

            {/* Market：搜索 + 场景筛选 */}
            {view === 'market' && (
              <div className="mt-2 space-y-2">
                <div className="relative">
                  <Search
                    className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2"
                    style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
                  />
                  <input
                    type="text"
                    value={marketSearch}
                    onChange={(e) => setMarketSearch(e.target.value)}
                    placeholder="Search skills…"
                    className="w-full rounded-md border py-1.5 pl-7 pr-2 text-xs outline-none transition-colors"
                    style={{
                      borderColor: 'var(--line)',
                      backgroundColor: 'var(--input-bg)',
                      color: 'var(--ink-strong)',
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setMarketScene('all')}
                    className="rounded-full px-2 py-0.5 text-xs transition-colors"
                    style={{
                      backgroundColor: marketScene === 'all' ? 'var(--primary)' : 'transparent',
                      color: marketScene === 'all' ? '#fff' : 'var(--ink-muted)',
                      border: marketScene === 'all' ? '1px solid var(--primary)' : '1px solid var(--line)',
                    }}
                  >
                    All
                  </button>
                  {marketScenes.map((sc) => (
                    <button
                      key={sc}
                      type="button"
                      onClick={() => setMarketScene(sc)}
                      className="rounded-full px-2 py-0.5 text-xs transition-colors"
                      style={{
                        backgroundColor: marketScene === sc ? 'var(--primary)' : 'transparent',
                        color: marketScene === sc ? '#fff' : 'var(--ink-muted)',
                        border: marketScene === sc ? '1px solid var(--primary)' : '1px solid var(--line)',
                      }}
                    >
                      {marketSceneLabel(sc)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Installed：搜索 */}
            {view === 'installed' && (
              <>
                <div className="relative mt-2">
                  <Search
                    className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2"
                    style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}
                  />
                  <input
                    type="text"
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    placeholder="搜索技能名称或描述..."
                    className="w-full rounded-md border py-1.5 pl-7 pr-7 text-xs outline-none transition-colors"
                    style={{
                      borderColor: 'var(--line)',
                      backgroundColor: 'var(--input-bg)',
                      color: 'var(--ink-strong)',
                    }}
                  />
                  {skillSearch && (
                    <button
                      type="button"
                      onClick={() => setSkillSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors hover:bg-[var(--paper-soft)]"
                    >
                      <X className="h-3 w-3" style={{ color: 'var(--ink-muted)' }} />
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {error && (
            <p className="mb-3 text-xs" style={{ color: 'var(--danger)' }}>{error}</p>
          )}

          {/* ===== 市场视图（搜索/筛选已吸顶；全部随包技能卡片保留并显示 Installed 态） ===== */}
          {view === 'market' ? (
            <div className="space-y-3">
              {/* 状态提示（安装成功 / 错误） */}
              {installError && (
                <div className="flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--danger) 6%, transparent)', color: 'var(--danger)' }}>
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
                  <span className="leading-relaxed">{installError}</span>
                </div>
              )}
              {installSuccess && (
                <div className="flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--success) 6%, transparent)', color: 'var(--success)' }}>
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  <span>{installSuccess}</span>
                </div>
              )}

              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--primary)' }} />
                </div>
              ) : marketSkills.length === 0 ? (
                <div
                  className="rounded-md border px-4 py-6 text-center"
                  style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}
                >
                  <Package className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
                  <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    No bundled skills available right now.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                  {(() => {
                    const q = marketSearch.trim().toLowerCase();
                    const items = marketSkills.filter((d) => {
                      const sc = d.scenes?.[0];
                      const okScene = marketScene === 'all' || sc === marketScene;
                      const okQuery = !q
                        || d.name.toLowerCase().includes(q)
                        || d.description.toLowerCase().includes(q);
                      return okScene && okQuery;
                    });
                    if (items.length === 0) {
                      return (
                        <p className="col-span-full px-2 py-6 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
                          No skills match your search / filter.
                        </p>
                      );
                    }
                    return items.map((d) => {
                      const busy = downloadingName === d.name;
                      const sc = d.scenes?.[0];
                      const Icon = skillEntryIcon(d.name, d.scenes || [], true);
                      return (
                        <div
                          key={d.name}
                          className="flex items-center gap-2.5 rounded-md border px-3 py-2.5"
                          style={{
                            borderColor: d.installed ? 'color-mix(in oklab, var(--primary) 22%, transparent)' : 'var(--line)',
                            backgroundColor: d.installed ? 'color-mix(in oklab, var(--primary) 3%, transparent)' : 'var(--input-bg)',
                          }}
                        >
                          {/* 图标 */}
                          <span
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                            style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
                          >
                            <Icon className="h-[18px] w-[18px]" />
                          </span>

                          {/* 名称 + 描述 */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-medium" style={{ color: 'var(--ink-strong)' }}>
                                {d.name}
                              </span>
                              {sc && marketScenes.includes(sc) && (
                                <span
                                  className="hidden shrink-0 rounded px-1 py-px text-xs leading-tight md:inline"
                                  style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
                                >
                                  {marketSceneLabel(sc)}
                                </span>
                              )}
                              <span className="shrink-0 text-xs leading-tight" style={{ color: 'var(--ink-faint)' }}>
                                v{d.version || '1.0.0'}
                              </span>
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                              {d.description}
                            </p>
                          </div>

                          {/* 右侧：Install / Installed */}
                          {d.installed ? (
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
                              disabled={busy}
                              loading={busy}
                              onClick={() => handleDownload(d.name)}
                              variant="solid"
                              tone="brand"
                              size="sm"
                            >
                              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                              {busy ? 'Installing…' : 'Install'}
                            </Button>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          ) : view === 'import' ? (
            <div className="space-y-4">
              {/* 来源选择 */}
              <div className="flex items-center gap-2">
                <span className="text-xs shrink-0" style={{ color: 'var(--ink-muted)' }}>Source:</span>
                <div className="flex items-center gap-1 rounded-md border p-0.5" style={{ borderColor: 'var(--line)' }}>
                  <button
                    type="button"
                    onClick={() => { setInstallSource('github'); setInstallUrl(''); setInstallError(''); }}
                    className="rounded px-2.5 py-1 text-xs transition-colors flex items-center gap-1"
                    style={{
                      color: installSource === 'github' ? 'var(--ink-strong)' : 'var(--ink-muted)',
                      backgroundColor: installSource === 'github' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
                    }}
                  >
                    <Globe className="h-3 w-3" />
                    GitHub
                  </button>
                  <button
                    type="button"
                    onClick={() => { setInstallSource('local'); setInstallUrl(''); setInstallError(''); }}
                    className="rounded px-2.5 py-1 text-xs transition-colors flex items-center gap-1"
                    style={{
                      color: installSource === 'local' ? 'var(--ink-strong)' : 'var(--ink-muted)',
                      backgroundColor: installSource === 'local' ? 'color-mix(in oklab, var(--primary) 8%, transparent)' : 'transparent',
                    }}
                  >
                    <FolderSearch className="h-3 w-3" />
                    Local
                  </button>
                </div>
              </div>

              {/* 输入区域 */}
              {installSource === 'github' ? (
                <div>
                  <label className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                    GitHub Repository URL
                  </label>
                  <div className="mt-1 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5"
                    style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
                    <Link className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                    <input
                      type="text"
                      value={installUrl}
                      onChange={(e) => setInstallUrl(e.target.value)}
                      placeholder="https://github.com/user/repo"
                      className="flex-1 bg-transparent text-xs outline-none"
                      style={{ color: 'var(--ink-strong)' }}
                      disabled={installing}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleInstall(); }}
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                    Local skill folder
                  </label>

                  {/* 拖拽上传区域 */}
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-1 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-5 transition-colors"
                    style={{
                      borderColor: dragOver ? 'var(--primary)' : installUrl ? 'color-mix(in oklab, var(--primary) 30%, transparent)' : 'var(--line)',
                      backgroundColor: dragOver ? 'color-mix(in oklab, var(--primary) 6%, transparent)' : installUrl ? 'color-mix(in oklab, var(--primary) 3%, transparent)' : 'var(--input-bg)',
                    }}
                  >
                    {installUrl ? (
                      <div className="flex flex-col items-center gap-1">
                        <FolderUp className="h-6 w-6" style={{ color: 'var(--primary)' }} />
                        <span className="text-xs font-medium max-w-[260px] truncate" style={{ color: 'var(--ink)' }}>
                          {installUrl.split('/').pop() || installUrl}
                        </span>
                        <span className="text-xs max-w-[260px] truncate" style={{ color: 'var(--ink-muted)' }}>
                          {installUrl}
                        </span>
                      </div>
                    ) : (
                      <Upload className="h-6 w-6" style={{ color: 'var(--ink-muted)' }} />
                    )}
                  </div>

                  {/* 隐藏文件选择器（webkitdirectory 选择文件夹） */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    // @ts-expect-error webkitdirectory is not in React types
                    webkitdirectory=""
                    directory=""
                    className="hidden"
                    onChange={handleFileChange}
                  />

                  {/* 手动输入路径（回退） */}
                  <div className="mt-2 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5"
                    style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
                    <FolderSearch className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                    <input
                      type="text"
                      value={installUrl}
                      onChange={(e) => { setInstallUrl(e.target.value); setInstallError(''); }}
                      placeholder="Or type /path/to/skill/folder"
                      className="flex-1 bg-transparent text-xs outline-none"
                      style={{ color: 'var(--ink-strong)' }}
                      disabled={installing}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleInstall(); }}
                    />
                  </div>
                </div>
              )}

              {/* 状态提示 */}
              {installError && (
                <div className="flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--danger) 6%, transparent)', color: 'var(--danger)' }}>
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
                  <span className="leading-relaxed">{installError}</span>
                </div>
              )}
              {installSuccess && (
                <div className="flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--success) 6%, transparent)', color: 'var(--success)' }}>
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  <span>{installSuccess}</span>
                </div>
              )}

              {/* 安装按钮 */}
              <Button
                type="button"
                onClick={handleInstall}
                disabled={installing || !installUrl.trim()}
                loading={installing}
                variant="solid"
                tone="brand"
                size="sm"
                className="w-full"
              >
                {installing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Installing...
                  </>
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5" />
                     Install Skill
                  </>
                )}
              </Button>
            </div>
          ) : (
            /* ===== 已安装视图（操作栏/搜索已吸顶） ===== */
            <>
              {/* 操作状态提示（重装/卸载成功或失败） */}
              {installError && (
                <div className="mb-3 flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--danger) 6%, transparent)', color: 'var(--danger)' }}>
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
                  <span className="leading-relaxed">{installError}</span>
                </div>
              )}
              {installSuccess && (
                <div className="mb-3 flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--success) 6%, transparent)', color: 'var(--success)' }}>
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  <span>{installSuccess}</span>
                </div>
              )}

              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--primary)' }} />
                </div>
              ) : filteredSkills.length === 0 ? (
                <div
                  className="rounded-md border px-4 py-6 text-center"
                  style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}
                >
                  <Lightbulb className="mx-auto mb-2 h-5 w-5" style={{ color: 'var(--ink-faint)' }} />
                  <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {skills.length === 0 ? 'No skills installed yet.' : 'No skills match your search.'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {filteredSkills.map((s) => (
                    <SkillCard
                      key={s.name}
                      skill={s}
                      onToggle={toggleSkill}
                      onUninstall={handleUninstall}
                      reinstallable={officialNames.has(s.name)}
                      official={s.source === 'builtin' || officialNames.has(s.name)}
                      onReinstall={handleReinstall}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          </>
          ) : extTab === 'agents' ? (
            <AgentStorePanel />
          ) : (
            <McpStorePanel />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-3 sm:px-8" style={{ borderColor: 'var(--line-soft)' }}>
          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            variant="ghost"
            tone="neutral"
            size="md"
          >
            Close
          </Button>
        </div>
    </>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0"
        onPointerDownOutside={(e) => e.preventDefault()}
        style={{
          fontFamily: 'var(--font-sans)',
          // 居中浮窗（约 1120px × 90vh，圆角 + 阴影），内容按
          // 顶栏(DialogHeader) / 副标题(扩展类型 tabs) / 滚动内容 / 底栏 四行排布
          width: 'min(1400px, calc(100vw - 48px))',
          height: 'min(90vh, calc(100vh - 48px))',
          maxWidth: 'none',
          borderRadius: 16,
          padding: 0,
          gridTemplateRows: 'auto auto minmax(0, 1fr) auto',
          boxShadow: '0 24px 70px -16px rgba(0,0,0,0.35)',
        }}
      >
        {inner}
      </DialogContent>
    </Dialog>
  );
}
