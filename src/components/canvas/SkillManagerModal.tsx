'use client';

import { useEffect, useState, useCallback } from 'react';
import { Lightbulb, RefreshCw, Check, Loader2, Package, FolderOpen, ChevronDown } from 'lucide-react';
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

function SkillCard({ skill, onToggle }: { skill: SkillItem; onToggle: (name: string) => void }) {
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
          <p className="mt-0.5 text-[10px] leading-relaxed line-clamp-2" style={{ color: 'oklch(0.55 0.02 50)' }}>
            {skill.description}
          </p>
        </div>
      </div>
    </div>
  );
}

function CategorySection({ category, expanded, onToggle, onToggleCategory }: {
  category: SkillCategory;
  expanded: boolean;
  onToggle: () => void;
  onToggleCategory: (enable: boolean) => void;
}) {
  const enabledCount = category.skills.filter(s => s.enabled).length;
  const total = category.skills.length;
  const allEnabled = enabledCount === total;

  return (
    <div>
      {/* 分类标题栏 */}
      <button
        type="button"
        onClick={onToggle}
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
            onToggleCategory(!allEnabled);
          }}
          className="text-[10px] transition-colors hover:underline shrink-0"
          style={{ color: 'oklch(0.55 0.02 50)' }}
        >
          {allEnabled ? '全部禁用' : '全部启用'}
        </button>
      </button>

      {/* 技能列表 */}
      {expanded && (
        <div className="space-y-1.5 mt-1">
          {category.skills.map((skill) => (
            <SkillCard
              key={skill.name}
              skill={skill}
              onToggle={onToggleCategory instanceof Function ? () => {} : () => {}}
            />
          ))}
          {/* 重新渲染 SkillCard 需要传入正确的 onToggle */}
          {category.skills.map((skill) => (
            <div key={skill.name} style={{ display: 'none' }} />
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
            Drag skill folders into <code className="rounded px-1 py-0.5" style={{ backgroundColor: 'oklch(0.92 0.01 60)' }}>~/BobAgent/skills/</code> to install.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto px-6 pb-2">
          {/* 操作栏 */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px]" style={{ color: 'oklch(0.50 0.015 50)' }}>
              {skills.length === 0
                ? 'No skills found'
                : `${enabledCount} / ${skills.length} enabled`}
            </span>
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

          {error && (
            <p className="mb-3 text-[11px]" style={{ color: 'oklch(0.55 0.18 35)' }}>{error}</p>
          )}

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
              <p className="mt-1 text-[11px]" style={{ color: 'oklch(0.60 0.02 50)' }}>
                Drag skill folders into <code className="rounded px-1 py-0.5" style={{ backgroundColor: 'oklch(0.92 0.01 60)' }}>~/BobAgent/skills/</code>
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {categories.map((cat) => {
                const expanded = expandedCategories.has(cat.key);
                return (
                  <div key={cat.key}>
                    {/* 分类标题栏 */}
                    <button
                      type="button"
                      onClick={() => toggleCategoryExpand(cat.key)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[oklch(0.95_0.008_80)]"
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
                        {cat.label}
                      </span>
                      <span className="text-[10px] mr-1" style={{ color: 'oklch(0.50 0.015 50 / 0.6)' }}>
                        {cat.skills.filter(s => s.enabled).length}/{cat.skills.length}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const allEnabled = cat.skills.every(s => s.enabled);
                          toggleCategory(cat.skills.map(s => s.name), !allEnabled);
                        }}
                        className="text-[10px] transition-colors hover:underline shrink-0"
                        style={{ color: 'oklch(0.55 0.02 50)' }}
                      >
                        {cat.skills.every(s => s.enabled) ? '全部禁用' : '全部启用'}
                      </button>
                    </button>

                    {/* 技能列表 */}
                    {expanded && (
                      <div className="space-y-1.5 mt-1 ml-4">
                        {cat.skills.map((skill) => (
                          <SkillCard
                            key={skill.name}
                            skill={skill}
                            onToggle={toggleSkill}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
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
