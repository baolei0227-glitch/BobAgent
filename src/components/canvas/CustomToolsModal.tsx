'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Plus, Wrench, Trash, ShieldAlert, ChevronRight } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  loadSettings,
  updateCustomTools,
  updateConfirmTools,
  DEFAULT_CONFIRM_TOOLS,
  migrateOldSettingsIfNeeded,
  type AppSettings,
  type CustomToolDef,
} from '@/lib/settings';

interface CustomToolsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 嵌入模式：在 SettingsModal 右栏直接渲染内容，不包 Dialog 外壳 */
  embedded?: boolean;
}

/** 工具清单条目（来自 /api/tools） */
interface ToolListEntry {
  name: string;
  description: string;
  category: string;
  /** 场景标注：空数组 = 通用工具 */
  scenes: string[];
}

/** 场景分组展示顺序与标签（与工具场景过滤 SCENED_TOOLS 一致）；其余场景按字母序排后 */
const SCENE_GROUPS: { key: string; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'coding', label: 'AI Coding' },
  { key: 'node', label: 'Node Graph' },
  { key: 'wanted', label: 'Wanted' },
  { key: 'legal', label: 'Legal' },
  { key: 'audio', label: 'Audio' },
  { key: 'skill', label: 'Skill' },
  { key: 'design', label: 'Design' },
  { key: 'ocr', label: 'OCR' },
];

export function CustomToolsModal({ open, onOpenChange, embedded }: CustomToolsModalProps) {
  const [customTools, setCustomTools] = useState<CustomToolDef[]>([]);
  const [confirmTools, setConfirmTools] = useState<string[]>([]);
  const [allTools, setAllTools] = useState<ToolListEntry[]>([]);
  const [saved, setSaved] = useState(false);
  // 打开时的自定义工具名快照：保存时 diff 出「本次新增」的工具，自动加入确认名单
  const originalToolNamesRef = useRef<Set<string>>(new Set());
  // 折叠的场景分组：默认全部折叠，点击标题展开
  const [collapsedScenes, setCollapsedScenes] = useState<Set<string>>(
    () => new Set(SCENE_GROUPS.map((g) => g.key)),
  );

  const toggleSceneCollapse = (scene: string) => {
    setCollapsedScenes((prev) => {
      const next = new Set(prev);
      if (next.has(scene)) next.delete(scene);
      else next.add(scene);
      return next;
    });
  };

  useEffect(() => {
    if (open) {
      const load = async () => {
        let settings: AppSettings = await migrateOldSettingsIfNeeded() || await loadSettings();
        setCustomTools(settings.customTools || []);
        setConfirmTools(settings.confirmTools ?? [...DEFAULT_CONFIRM_TOOLS]);
        originalToolNamesRef.current = new Set((settings.customTools || []).map((t) => t.name));
        setSaved(false);
        // 拉取全量工具清单（内置 + 自定义 + MCP，与模型可见一致）
        try {
          const res = await fetch('/api/tools');
          const data = await res.json();
          if (Array.isArray(data.tools)) setAllTools(data.tools as ToolListEntry[]);
        } catch { /* 清单拉取失败不阻断 */ }
      };
      load();
    }
  }, [open]);

  /** 切换工具是否进入「需手动确认名单」；Confirm → Direct 是白名单化（解除询问），弹风险提示确认 */
  const toggleConfirm = (name: string) => {
    const inList = confirmTools.includes(name);
    if (inList) {
      const ok = window.confirm(
        `Switch "${name}" to Direct?\n\nTools in Direct mode run immediately without asking you first. The AI may call this tool automatically and send conversation context to its configured endpoint.\n\nOnly whitelist tools you fully trust.`,
      );
      if (!ok) return;
      setConfirmTools((prev) => prev.filter((n) => n !== name));
    } else {
      setConfirmTools((prev) => [...prev, name]);
    }
  };

  const handleSave = async () => {
    const activeCustomTools = customTools.filter((t) => t.enabled);
    if (activeCustomTools.length > 0) {
      const lines = activeCustomTools.map((t) => `• ${t.name || '(unnamed)'}`);
      const msg = `Save and enable the following custom HTTP tools?\n\n${lines.join('\n')}\n\nAI will automatically invoke these tools based on their descriptions during conversations, which may send conversation data to external servers. Confirm save?`;
      if (!window.confirm(msg)) return;
    }

    await updateCustomTools(customTools);

    // 新增的自定义工具自动加入「需手动确认名单」（未来添加的工具默认需确认）
    const addedNames = customTools
      .filter((t) => t.name && !originalToolNamesRef.current.has(t.name))
      .map((t) => t.name);
    const nextConfirm = [...new Set([...confirmTools, ...addedNames])];
    if (JSON.stringify(nextConfirm) !== JSON.stringify(confirmTools)) {
      await updateConfirmTools(nextConfirm);
      setConfirmTools(nextConfirm);
    }

    window.dispatchEvent(new Event('provider-configs-changed'));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const paperInputStyle = {
    fontFamily: "var(--font-sans)",
    backgroundColor: 'var(--input-bg)',
    borderColor: 'var(--line)',
    color: 'var(--ink)',
  } as const;

  const inner = (
    <>
      {!embedded && (
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--ink-strong)' }}>
            <Wrench className="h-4 w-4" style={{ color: 'var(--primary)' }} />
            Custom Tools
          </DialogTitle>
        </DialogHeader>
      )}

        <div className={`overflow-y-auto pb-2${embedded ? ' px-0' : ' max-h-[55vh] px-6'}`}>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4" style={{ color: 'var(--primary)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>
                Custom Tools
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                const ok = window.confirm(
                  'Register a custom HTTP tool\n\nAI will send conversation parameters to the endpoint you configure, which may include sensitive information. Only add servers you fully trust. Confirm adding a new tool?',
                );
                if (!ok) return;
                setCustomTools([
                  ...customTools,
                  {
                    name: '',
                    description: '',
                    endpoint: '',
                    method: 'POST',
                    parameters: { type: 'object', properties: {}, required: [] },
                    enabled: true,
                  },
                ]);
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors"
              style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
            >
              <Plus className="h-3 w-3" />
              Add
            </button>
          </div>

          {customTools.map((tool, idx) => (
            <div
              key={idx}
              className="mb-3 rounded-lg border p-3"
              style={{ borderColor: 'var(--line-soft)', backgroundColor: 'var(--popover)' }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                  Tool #{idx + 1}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const updated = [...customTools];
                      updated[idx] = { ...tool, enabled: !tool.enabled };
                      setCustomTools(updated);
                    }}
                    className="flex h-5 w-9 items-center rounded-full transition-colors"
                    style={{
                      backgroundColor: tool.enabled ? 'var(--primary)' : 'var(--line)',
                    }}
                  >
                    <span
                      className="h-3.5 w-3.5 rounded-full bg-white transition-transform"
                      style={{ transform: tool.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomTools(customTools.filter((_, i) => i !== idx));
                    }}
                    className="rounded p-1 transition-colors hover:bg-[color-mix(in_oklab,var(--danger)_10%,transparent)]"
                    style={{ color: 'var(--danger)' }}
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-0.5 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                    Name (function name)
                  </label>
                  <Input
                    type="text"
                    placeholder="get_weather"
                    value={tool.name}
                    onChange={(e) => {
                      const updated = [...customTools];
                      updated[idx] = { ...tool, name: e.target.value };
                      setCustomTools(updated);
                    }}
                    className="h-7 text-xs"
                    style={paperInputStyle}
                  />
                </div>
                <div>
                  <label className="mb-0.5 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                    HTTP Method
                  </label>
                  <select
                    value={tool.method || 'POST'}
                    onChange={(e) => {
                      const updated = [...customTools];
                      updated[idx] = { ...tool, method: e.target.value as 'GET' | 'POST' };
                      setCustomTools(updated);
                    }}
                    className="h-7 w-full rounded-md border px-2 text-xs"
                    style={{
                      fontFamily: "var(--font-sans)",
                      backgroundColor: 'var(--input-bg)',
                      borderColor: 'var(--line)',
                      color: 'var(--ink)',
                    }}
                  >
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                  </select>
                </div>
              </div>

              <div className="mt-2">
                <label className="mb-0.5 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                  Description (AI decides whether to invoke based on this)
                </label>
                <Input
                  type="text"
                  placeholder="Get weather information for a specified city"
                  value={tool.description}
                  onChange={(e) => {
                    const updated = [...customTools];
                    updated[idx] = { ...tool, description: e.target.value };
                    setCustomTools(updated);
                  }}
                  className="h-7 text-xs"
                  style={paperInputStyle}
                />
              </div>

              <div className="mt-2">
                <label className="mb-0.5 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                  Endpoint URL
                </label>
                <Input
                  type="text"
                  placeholder="https://api.example.com/weather"
                  value={tool.endpoint}
                  onChange={(e) => {
                    const updated = [...customTools];
                    updated[idx] = { ...tool, endpoint: e.target.value };
                    setCustomTools(updated);
                  }}
                  className="h-7 text-xs"
                  style={paperInputStyle}
                />
              </div>

              <div className="mt-2">
                <label className="mb-0.5 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                  Parameters (JSON Schema)
                </label>
                <textarea
                  value={JSON.stringify(tool.parameters || { type: 'object', properties: {}, required: [] }, null, 2)}
                  onChange={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value);
                      const updated = [...customTools];
                      updated[idx] = { ...tool, parameters: parsed };
                      setCustomTools(updated);
                    } catch {
                      // 解析失败时不更新，允许用户继续编辑
                    }
                  }}
                  className="w-full rounded-md border px-2 py-1.5 text-xs font-mono"
                  style={{
                    backgroundColor: 'var(--input-bg)',
                    borderColor: 'var(--line)',
                    color: 'var(--ink)',
                    minHeight: '60px',
                    resize: 'vertical',
                  }}
                  placeholder={`{\n  "type": "object",\n  "properties": {\n    "city": {\n      "type": "string",\n      "description": "City name"\n    }\n  },\n  "required": ["city"]\n}`}
                />
              </div>
            </div>
          ))}

          {/* ===== 需手动确认名单（全工具分类管理） ===== */}
          <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line-soft)' }}>
            <div className="mb-2 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" style={{ color: 'var(--primary)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--ink-strong)' }}>
                Confirmation List
              </span>
            </div>
            {(() => {
              if (allTools.length === 0) {
                return <div className="text-xs" style={{ color: 'var(--ink-muted)' }}>Loading tool list...</div>;
              }
              // 按场景分组：取工具第一个场景标注，无标注 = General（通用）
              const groups = new Map<string, ToolListEntry[]>();
              for (const t of allTools) {
                const scene = t.scenes && t.scenes.length > 0 ? t.scenes[0] : 'general';
                if (!groups.has(scene)) groups.set(scene, []);
                groups.get(scene)!.push(t);
              }
              const knownScenes = SCENE_GROUPS.map((g) => g.key);
              const extraScenes = [...groups.keys()].filter((k) => !knownScenes.includes(k)).sort();
              const order = [...SCENE_GROUPS.map((g) => g.key), ...extraScenes];
              return order
                .map((scene) => ({ scene, list: groups.get(scene) || [] }))
                .filter((g) => g.list.length > 0)
                .map(({ scene, list }) => {
                  const label = SCENE_GROUPS.find((g) => g.key === scene)?.label ?? scene;
                  const isCollapsed = collapsedScenes.has(scene);
                  return (
                    <div key={scene} className="mb-2">
                      <button
                        type="button"
                        onClick={() => toggleSceneCollapse(scene)}
                        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_6%,transparent)]"
                      >
                        <ChevronRight
                          className="h-3 w-3 shrink-0 transition-transform"
                          style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', color: 'var(--ink-faint)' }}
                        />
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-faint)' }}>
                          {label} · {list.length}
                        </span>
                        {scene !== 'general' && (
                          <span
                            className="rounded-full px-1.5 py-px text-10 font-medium"
                            style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
                          >
                            Scoped
                          </span>
                        )}
                      </button>
                      {!isCollapsed && (
                        <div className="mt-1">
                          {list.map((t) => {
                            const inList = confirmTools.includes(t.name);
                            return (
                              <div
                                key={t.name}
                                className="mb-1 flex items-center gap-2 rounded-md px-2 py-1"
                                style={{ backgroundColor: 'var(--input-bg)' }}
                              >
                                <span
                                  className="flex-1 truncate text-xs"
                                  title={`${t.name} — ${t.description}`}
                                  style={{ color: inList ? 'var(--ink)' : 'var(--ink-muted)' }}
                                >
                                  {t.name}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => toggleConfirm(t.name)}
                                  title={
                                    inList
                                      ? 'Confirm (yellow): AI asks you before every call. Click to switch to Direct (green).'
                                      : 'Direct (green): AI runs it immediately without confirmation. Click to switch to Confirm (yellow).'
                                  }
                                  className="h-5 shrink-0 rounded-md px-2 text-11 font-semibold transition-colors"
                                  style={{
                                    backgroundColor: inList
                                      ? 'color-mix(in oklab, var(--warn) 15%, transparent)'
                                      : 'color-mix(in oklab, var(--success) 15%, transparent)',
                                    color: inList ? 'var(--warn)' : 'var(--success)',
                                    border: `1px solid ${inList
                                      ? 'color-mix(in oklab, var(--warn) 45%, transparent)'
                                      : 'color-mix(in oklab, var(--success) 45%, transparent)'}`,
                                  }}
                                >
                                  {inList ? 'Confirm' : 'Direct'}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                });
            })()}
          </div>
        </div>

        <div className="px-6 pb-4 pt-2">
          <button
            type="button"
            onClick={handleSave}
            className="w-full rounded-lg py-2 text-sm font-medium transition-colors"
            style={{
              backgroundColor: saved ? 'var(--success)' : 'var(--primary)',
              color: 'white',
            }}
          >
            {saved ? (
              <span className="flex items-center justify-center gap-1"><Check className="h-4 w-4" />Saved</span>
            ) : 'Save'}
          </button>
        </div>
    </>
  );
  if (embedded) {
    return <div className="px-5 py-4">{inner}</div>;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0" style={{ fontFamily: "var(--font-sans)" }}>
        {inner}
      </DialogContent>
    </Dialog>
  );
}
