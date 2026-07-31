'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Lightbulb, RefreshCw, Check, Loader2, Package, FolderOpen, ChevronDown, Download, Trash2, Link, FolderSearch, Globe, AlertCircle, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface SkillItem {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'external';
  version: string;
  enabled: boolean;
}

interface SkillCategory {
  key: string;
  label: string;
  icon?: string;
  skills: SkillItem[];
}

interface SkillManagerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface InstallResult {
  success: boolean;
  skill?: { name: string; description: string };
  error?: string;
  detail?: string;
}

/** 技能分类 */
function categorizeSkills(skills: SkillItem[]): SkillCategory[] {
  const builtin: SkillItem[] = [];
  const lark: SkillItem[] = [];
  const docs: SkillItem[] = [];
  const design: SkillItem[] = [];
  const dev: SkillItem[] = [];
  const other: SkillItem[] = [];

  const docNames = new Set(['docx', 'pdf', 'pdf-splitter', 'pptx', 'xlsx']);
  const designNames = new Set(['algorithmic-art', 'brand-guidelines', 'canvas-design', 'frontend-design', 'theme-factory', 'slack-gif-creator']);
  const devNames = new Set(['mcp-builder', 'web-artifacts-builder', 'webapp-testing', 'using-coze-cli', 'template']);

  for (const skill of skills) {
    if (skill.source === 'builtin') {
      builtin.push(skill);
    } else if (skill.name.startsWith('lark-')) {
      lark.push(skill);
    } else if (docNames.has(skill.name)) {
      docs.push(skill);
    } else if (designNames.has(skill.name)) {
      design.push(skill);
    } else if (devNames.has(skill.name)) {
      dev.push(skill);
    } else {
      other.push(skill);
    }
  }

  const all: SkillCategory[] = [
    { key: 'builtin', label: '内置技能', skills: builtin },
    { key: 'lark', label: '飞书 / Lark', skills: lark },
    { key: 'docs', label: '文档处理', skills: docs },
    { key: 'design', label: '设计', skills: design },
    { key: 'dev', label: '开发工具', skills: dev },
    { key: 'other', label: '其他', skills: other },
  ];

  return all.filter(c => c.skills.length > 0);
}

function SkillCard({ skill, onToggle, onUninstall }: {
  skill: SkillItem;
  onToggle: (name: string) => void;
  onUninstall?: (name: string) => void;
}) {
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);
  const [needsExpand, setNeedsExpand] = useState(false);

  useEffect(() => {
    const el = descRef.current;
    if (el) {
      setNeedsExpand(el.scrollHeight > el.clientHeight + 2);
    }
  }, [skill.description]);

  return (
    <div
      className="rounded-md border px-3 py-2 transition-colors hover:bg-[oklch(0.95_0.008_80)]"
      style={{
        borderColor: skill.enabled ? 'oklch(0.62 0.17 45 / 0.25)' : 'oklch(0.85 0.01 70)',
        backgroundColor: skill.enabled ? 'oklch(0.62 0.17 45 / 0.03)' : 'transparent',
      }}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => onToggle(skill.name)}
          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
          style={{
            backgroundColor: skill.enabled ? 'oklch(0.62 0.17 45)' : 'transparent',
            borderColor: skill.enabled ? 'oklch(0.62 0.17 45)' : 'oklch(0.75 0.02 60)',
          }}
        >
          {skill.enabled && <Check className="h-3 w-3 text-white" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium truncate" style={{ color: 'oklch(0.30 0.015 50)' }}>
              {skill.name}
            </span>
            {skill.source === 'builtin' && (
              <span className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] leading-tight"
                style={{ backgroundColor: 'oklch(0.62 0.17 45 / 0.12)', color: 'oklch(0.50 0.12 45)' }}>
                <Package className="h-2.5 w-2.5" />内置
              </span>
            )}
            {skill.source === 'user' && (
              <span className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] leading-tight"
                style={{ backgroundColor: 'oklch(0.55 0.15 145 / 0.12)', color: 'oklch(0.45 0.12 145)' }}>
                <FolderOpen className="h-2.5 w-2.5" />用户
              </span>
            )}
          </div>
          <p
            ref={descRef}
            className={descExpanded ? 'mt-0.5 text-[10px] leading-relaxed' : 'mt-0.5 text-[10px] leading-relaxed line-clamp-2'}
            style={{ color: 'oklch(0.55 0.02 50)' }}
          >
            {skill.description}
          </p>
          {needsExpand && (
            <button
              type="button"
              onClick={() => setDescExpanded(!descExpanded)}
              className="mt-0.5 text-[9px] transition-colors hover:underline"
              style={{ color: 'oklch(0.50 0.12 45)' }}
            >
              {descExpanded ? '收起' : '展开全部'}
            </button>
          )}
        </div>
        {skill.source === 'user' && onUninstall && (
          <div className="shrink-0">
            {confirmUninstall ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { onUninstall(skill.name); setConfirmUninstall(false); }}
                  className="text-[10px] rounded px-1.5 py-0.5"
                  style={{ color: '#fff', backgroundColor: 'oklch(0.55 0.18 35)' }}
                >确认</button>
                <button
                  type="button"
                  onClick={() => setConfirmUninstall(false)}
                  className="text-[10px] rounded px-1 py-0.5"
                  style={{ color: 'oklch(0.50 0.02 50)' }}
                ><X className="h-3 w-3" /></button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmUninstall(true)}
                className="rounded p-0.5 transition-colors hover:bg-[oklch(0.90_0.02_50)]"
                title="卸载技能"
              >
                <Trash2 className="h-3 w-3" style={{ color: 'oklch(0.55 0.02 50)' }} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CategorySection({ category, expanded, onToggleExpand, onToggleSkill, onToggleCategory, onUninstall }: {
  category: SkillCategory;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleSkill: (name: string) => void;
  onToggleCategory: (names: string[], enable: boolean) => void;
  onUninstall?: (name: string) => void;
}) {
  const enabledCount = category.skills.filter(s => s.enabled).length;
  const total = category.skills.length;
  const allEnabled = enabledCount === total;

  return (
    <div>
      {/* 分类标题栏 */}
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[oklch(0.95_0.008_80)] sticky top-0 z-10"
        style={{ backgroundColor: 'oklch(0.98 0.005 80)' }}
      >
        <ChevronDown
          className="h-3 w-3 shrink-0 transition-transform"
          style={{
            color: 'oklch(0.55 0.02 50)',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        />
        <span className="text-[11px] font-semibold flex-1" style={{ color: 'oklch(0.35 0.015 50)' }}>
          {category.label}
        </span>
        <span className="text-[10px] mr-1" style={{ color: 'oklch(0.50 0.015 50 / 0.6)' }}>
          {enabledCount}/{total}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCategory(category.skills.map(s => s.name), !allEnabled);
          }}
          className="text-[10px] transition-colors hover:underline shrink-0"
          style={{ color: 'oklch(0.55 0.02 50)' }}
        >
          {allEnabled ? '全部禁用' : '全部启用'}
        </button>
      </button>

      {/* 技能列表 */}
      {expanded && (
        <div className="space-y-1.5 mt-1 ml-4">
          {category.skills.map((skill) => (
            <SkillCard
              key={skill.name}
              skill={skill}
              onToggle={onToggleSkill}
              onUninstall={onUninstall}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillManagerModal({ open, onOpenChange }: SkillManagerModalProps) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['builtin']));

  // 安装表单状态
  const [showInstall, setShowInstall] = useState(false);
  const [installSource, setInstallSource] = useState<'github' | 'local'>('github');
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');
  const [installSuccess, setInstallSuccess] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      const sorted = [...(data.skills || [])].sort((a: SkillItem, b: SkillItem) => {
        const aOrder = sourceOrder[a.source] ?? 2;
        const bOrder = sourceOrder[b.source] ?? 2;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.name.localeCompare(b.name);
      });
      setSkills(sorted);
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
      setShowInstall(false);
      setInstallError('');
      setInstallSuccess('');
    }
  }, [open, loadSkills]);

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

  const toggleCategory = async (skillNames: string[], enable: boolean) => {
    const oldSkills = [...skills];
    setSkills((prev) =>
      prev.map((s) => (skillNames.includes(s.name) ? { ...s, enabled: enable } : s))
    );
    try {
      for (const name of skillNames) {
        await fetch('/api/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: enable ? 'enable' : 'disable', skillName: name }),
        });
      }
      window.dispatchEvent(new Event('skills-changed'));
    } catch (e) {
      console.error('Toggle category error:', e);
      setSkills(oldSkills);
    }
  };

  const toggleCategoryExpand = (key: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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

  // 安装技能
  const handleInstall = async () => {
    setInstallError('');
    setInstallSuccess('');
    if (!installUrl.trim()) {
      setInstallError('请输入 GitHub URL 或选择本地路径');
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
        setInstallError(data.error || data.detail || '安装失败');
        return;
      }
      setInstallSuccess(`已安装: ${data.skill!.name}`);
      setInstallUrl('');
      loadSkills();
    } catch (e: any) {
      setInstallError(e?.message || '网络错误');
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
        setError(data.error || '卸载失败');
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

  const categories = categorizeSkills(skills);
  const allEnabled = skills.length > 0 && skills.every((s) => s.enabled);
  const enabledCount = skills.filter(s => s.enabled).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md gap-0 p-0"
        style={{ fontFamily: "'Noto Serif SC', serif" }}
      >
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle
            className="flex items-center gap-2 text-base"
            style={{ color: 'oklch(0.30 0.015 50)' }}
          >
            <Lightbulb className="h-4 w-4" style={{ color: 'oklch(0.62 0.17 45)' }} />
            Skills
          </DialogTitle>
          <DialogDescription
            className="text-xs"
            style={{ color: 'oklch(0.55 0.02 50)' }}
          >
            Skills are automatically triggered when your message matches their keywords.
            Install new skills from GitHub or local folder.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto px-6 pb-2">
          {/* 视图切换 + 操作栏 */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1 rounded-md border p-0.5" style={{ borderColor: 'oklch(0.85 0.01 70)' }}>
              <button
                type="button"
                onClick={() => setShowInstall(false)}
                className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
                style={{
                  color: !showInstall ? 'oklch(0.30 0.015 50)' : 'oklch(0.55 0.02 50)',
                  backgroundColor: !showInstall ? 'oklch(0.62 0.17 45 / 0.08)' : 'transparent',
                }}
              >
                已安装
              </button>
              <button
                type="button"
                onClick={() => setShowInstall(true)}
                className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors flex items-center gap-1"
                style={{
                  color: showInstall ? 'oklch(0.30 0.015 50)' : 'oklch(0.55 0.02 50)',
                  backgroundColor: showInstall ? 'oklch(0.62 0.17 45 / 0.08)' : 'transparent',
                }}
              >
                <Download className="h-3 w-3" />
                安装
              </button>
            </div>
            {!showInstall && (
              <span className="text-[11px]" style={{ color: 'oklch(0.50 0.015 50)' }}>
                {skills.length === 0
                  ? 'No skills found'
                  : `${enabledCount} / ${skills.length} enabled`}
              </span>
            )}
          </div>

          {error && (
            <p className="mb-3 text-[11px]" style={{ color: 'oklch(0.55 0.18 35)' }}>{error}</p>
          )}

          {/* ===== 安装视图 ===== */}
          {showInstall ? (
            <div className="space-y-4">
              {/* 来源选择 */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] shrink-0" style={{ color: 'oklch(0.45 0.015 50)' }}>来源:</span>
                <div className="flex items-center gap-1 rounded-md border p-0.5" style={{ borderColor: 'oklch(0.85 0.01 70)' }}>
                  <button
                    type="button"
                    onClick={() => { setInstallSource('github'); setInstallUrl(''); setInstallError(''); }}
                    className="rounded px-2.5 py-1 text-[11px] transition-colors flex items-center gap-1"
                    style={{
                      color: installSource === 'github' ? 'oklch(0.30 0.015 50)' : 'oklch(0.55 0.02 50)',
                      backgroundColor: installSource === 'github' ? 'oklch(0.62 0.17 45 / 0.08)' : 'transparent',
                    }}
                  >
                    <Globe className="h-3 w-3" />
                    GitHub
                  </button>
                  <button
                    type="button"
                    onClick={() => { setInstallSource('local'); setInstallUrl(''); setInstallError(''); }}
                    className="rounded px-2.5 py-1 text-[11px] transition-colors flex items-center gap-1"
                    style={{
                      color: installSource === 'local' ? 'oklch(0.30 0.015 50)' : 'oklch(0.55 0.02 50)',
                      backgroundColor: installSource === 'local' ? 'oklch(0.62 0.17 45 / 0.08)' : 'transparent',
                    }}
                  >
                    <FolderSearch className="h-3 w-3" />
                    本地
                  </button>
                </div>
              </div>

              {/* 输入区域 */}
              {installSource === 'github' ? (
                <div>
                  <label className="text-[10px] font-medium" style={{ color: 'oklch(0.45 0.015 50)' }}>
                    GitHub 仓库 URL
                  </label>
                  <div className="mt-1 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5"
                    style={{ borderColor: 'oklch(0.85 0.01 70)', backgroundColor: 'oklch(0.99 0.003 80)' }}>
                    <Link className="h-3.5 w-3.5 shrink-0" style={{ color: 'oklch(0.55 0.02 50)' }} />
                    <input
                      type="text"
                      value={installUrl}
                      onChange={(e) => setInstallUrl(e.target.value)}
                      placeholder="https://github.com/user/repo"
                      className="flex-1 bg-transparent text-xs outline-none"
                      style={{ color: 'oklch(0.30 0.015 50)' }}
                      disabled={installing}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleInstall(); }}
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="text-[10px] font-medium" style={{ color: 'oklch(0.45 0.015 50)' }}>
                    本地技能包路径
                  </label>
                  <div className="mt-1 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5"
                    style={{ borderColor: 'oklch(0.85 0.01 70)', backgroundColor: 'oklch(0.99 0.003 80)' }}>
                    <FolderSearch className="h-3.5 w-3.5 shrink-0" style={{ color: 'oklch(0.55 0.02 50)' }} />
                    <input
                      type="text"
                      value={installUrl}
                      onChange={(e) => setInstallUrl(e.target.value)}
                      placeholder="/path/to/skill/folder"
                      className="flex-1 bg-transparent text-xs outline-none"
                      style={{ color: 'oklch(0.30 0.015 50)' }}
                      disabled={installing}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleInstall(); }}
                    />
                  </div>
                </div>
              )}

              {/* 状态提示 */}
              {installError && (
                <div className="flex items-start gap-1.5 rounded-md px-2.5 py-2 text-[11px]"
                  style={{ backgroundColor: 'oklch(0.55 0.18 35 / 0.06)', color: 'oklch(0.50 0.18 35)' }}>
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
                  <span className="leading-relaxed">{installError}</span>
                </div>
              )}
              {installSuccess && (
                <div className="flex items-center gap-1.5 rounded-md px-2.5 py-2 text-[11px]"
                  style={{ backgroundColor: 'oklch(0.55 0.15 145 / 0.06)', color: 'oklch(0.45 0.12 145)' }}>
                  <Check className="h-3.5 w-3.5 shrink-0" />
                  <span>{installSuccess}</span>
                </div>
              )}

              {/* 安装按钮 */}
              <button
                type="button"
                onClick={handleInstall}
                disabled={installing || !installUrl.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-xs font-medium transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: 'oklch(0.62 0.17 45)',
                  color: '#fff',
                }}
              >
                {installing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    安装中...
                  </>
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5" />
                    安装技能
                  </>
                )}
              </button>

              {/* 技能包规范说明 */}
              <div className="rounded-md border px-3 py-2.5"
                style={{ borderColor: 'oklch(0.85 0.01 70)', backgroundColor: 'oklch(0.98 0.005 80)' }}>
                <p className="text-[10px] font-medium mb-1" style={{ color: 'oklch(0.45 0.015 50)' }}>技能包规范</p>
                <p className="text-[10px] leading-relaxed" style={{ color: 'oklch(0.55 0.02 50)' }}>
                  技能包需包含 <code className="rounded px-1 py-0.5 text-[9px]" style={{ backgroundColor: 'oklch(0.92 0.01 60)' }}>SKILL.md</code> 文件，
                  其中 frontmatter 声明 <code className="rounded px-1 py-0.5 text-[9px]" style={{ backgroundColor: 'oklch(0.92 0.01 60)' }}>name</code> 和
                  <code className="rounded px-1 py-0.5 text-[9px]" style={{ backgroundColor: 'oklch(0.92 0.01 60)' }}>description</code> 字段。
                  GitHub 仓库将从默认分支下载。
                </p>
              </div>
            </div>
          ) : (
            /* ===== 已安装视图 ===== */
            <>
              {/* 操作栏 */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleToggleAll}
                    className="text-[11px] transition-colors hover:underline"
                    style={{ color: 'oklch(0.55 0.02 50)' }}
                  >
                    {allEnabled ? 'Disable All' : 'Enable All'}
                  </button>
                  <button
                    type="button"
                    onClick={loadSkills}
                    disabled={loading}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-[oklch(0.92_0.015_75)]"
                    style={{ color: 'oklch(0.55 0.02 50)' }}
                  >
                    <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'oklch(0.62 0.17 45)' }} />
                </div>
              ) : skills.length === 0 ? (
                <div
                  className="rounded-md border px-4 py-6 text-center"
                  style={{ borderColor: 'oklch(0.85 0.01 70)', backgroundColor: 'oklch(0.97 0.008 80)' }}
                >
                  <Lightbulb className="mx-auto mb-2 h-5 w-5" style={{ color: 'oklch(0.65 0.02 50)' }} />
                  <p className="text-xs" style={{ color: 'oklch(0.55 0.02 50)' }}>No skills installed yet.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {categories.map((cat) => {
                    const expanded = expandedCategories.has(cat.key);
                    return (
                      <CategorySection
                        key={cat.key}
                        category={cat}
                        expanded={expanded}
                        onToggleExpand={() => toggleCategoryExpand(cat.key)}
                        onToggleSkill={toggleSkill}
                        onToggleCategory={toggleCategory}
                        onUninstall={handleUninstall}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md px-4 py-1.5 text-xs transition-colors hover:bg-gray-100"
            style={{ color: 'oklch(0.55 0.02 50)' }}
          >
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
