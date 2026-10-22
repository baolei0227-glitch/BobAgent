'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Code2, Plus, FolderOpen, Loader2, Boxes, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEFAULT_MODEL_ID } from '@/lib/types';

interface SandboxApp {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  entry: string;
}

interface SandboxTemplate {
  id: string;
  label: string;
  description: string;
  entry: string;
  /** 可选：模板自带的「灵感需求描述种子」，选模板时预填需求描述框（可选） */
  promptSeed?: { category: string; interaction: string; persistence: string };
}

interface CreatedNodePayload {
  nodeId: string;
  title: string;
  sandboxAppId?: string;
  appName?: string;
  /** 可选：创建对话框里填写的初始需求，画布层先把它作为首轮 user 消息塞进节点 */
  initialPrompt?: string;
  /** 可选：创建时附带的参考图/文件；画布层创建节点后上传并挂到首轮消息 */
  referenceFile?: File;
}

interface Props {
  open: boolean;
  /** 画布坐标（flow 坐标），创建节点时写入 frontmatter 便于重启恢复布局 */
  position: { x: number; y: number } | null;
  onClose: () => void;
  /** 创建成功回调，由画布层挂载节点并打开预览 */
  onCreated: (payload: CreatedNodePayload) => void;
}

/**
 * AI Coding 节点创建对话框（画布 ＋ Add session → Coding 触发）。
 *
 * 2026-10-18 简化：默认视图只留「愿望输入 + Build」，其余（预设 / 名称 / 参考文件 / Fast build）
 * 全部收进可折叠的 More options。预设改为下拉选择且默认 Blank（不预选任何预设），名称/参考/勾选默认空白。
 * Fast build 只是一个 checkbox；后端只需 fast_build=true + 愿望或预设种子即可跳过 6 问
 * （见 lib/runtime/context.ts 的 specReady 判定），未列项由模型按最简默认值处理。
 * Fast build 开启时主界面用按钮文案 `Build (Fast)` 作为状态提示，避免折叠导致模式不可见。
 */
function deriveAppName(wish: string, templateLabel: string): string {
  const oneLine = wish.replace(/\s+/g, ' ').trim();
  if (oneLine) return oneLine.length > 24 ? `${oneLine.slice(0, 24).trim()}…` : oneLine;
  return templateLabel ? `${templateLabel} App` : 'Untitled App';
}

export function AICodingCreateDialog({ open, position, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<'create' | 'bind'>('create');
  const [apps, setApps] = useState<SandboxApp[]>([]);
  const [templates, setTemplates] = useState<SandboxTemplate[]>([]);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('blank');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  // Fast build：默认关（6 问是默认质量门禁），显式开启后跳过 6 问直接按愿望/预设种子出首版
  const [fastBuild, setFastBuild] = useState(false);
  /** More options 折叠开关（预设 / 名称 / 参考文件 / Fast build） */
  const [moreOpen, setMoreOpen] = useState(false);
  /** 可选参考图/文件：挂到首轮消息，AI 可先看再动手 */
  const [referenceFile, setReferenceFile] = useState<File | null>(null);

  const loadSandbox = useCallback(async () => {
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
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时重置状态并预加载小程序清单与模板
  useEffect(() => {
    if (open) {
      setMode('create');
      setName('');
      setTemplate('blank');
      setPrompt('');
      setFastBuild(false);
      setMoreOpen(false);
      setReferenceFile(null);
      loadSandbox();
    }
  }, [open, loadSandbox]);

  if (!open) return null;

  /** 当前选中模板的种子（blank 无种子）；供 canBuild 与 Fast build 简报复用 */
  const seed = template !== 'blank' ? templates.find((t) => t.id === template)?.promptSeed : undefined;
  // Fast build 至少要有一句愿望或模板种子，否则简报没有可建内容（会回落到 6 问）
  const canBuild = !fastBuild || !!prompt.trim() || !!seed;

  /** 创建绑定节点，成功后统一回调 */
  const createNode = async (title: string, sandboxAppId?: string, appName = '', initialPromptText = '', nodeType = 'coding', sandboxSpec?: Record<string, unknown> | null, refFile?: File | null) => {
    setCreating(true);
    try {
      const resp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title,
          model: DEFAULT_MODEL_ID,
          sources: [],
          node_type: nodeType,
          ...(position ? { position_x: position.x, position_y: position.y } : {}),
          ...(sandboxAppId ? { sandbox_app_id: sandboxAppId } : {}),
          ...(sandboxSpec ? { sandbox_spec: sandboxSpec } : {}),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        onCreated({
          nodeId: data.node_id,
          title: data.title || title,
          sandboxAppId,
          appName,
          initialPrompt: initialPromptText.trim() || undefined,
          ...(refFile ? { referenceFile: refFile } : {}),
        });
        onClose();
      }
    } catch {
      // 创建失败：忽略，保持对话框打开
    } finally {
      setCreating(false);
    }
  };

  /** 新建小程序项目 → 创建 AI Coding 节点 */
  const handleCreateApp = async () => {
    if (creating || !canBuild) return;
    setCreating(true);
    try {
      const tpl = templates.find((t) => t.id === template);
      // 6 问仍是默认：只有显式开启 Fast build 时，才把 fast_build=true 随节点落盘；
      // 简报字段取自模板种子与愿望，未列项由模型按最简默认值处理；否则 spec=null，首轮照旧弹 6 问。
      let sandboxSpec: Record<string, unknown> | null = null;
      if (fastBuild) {
        sandboxSpec = {
          ...(seed?.category ? { category: seed.category } : {}),
          ...(seed?.interaction ? { interaction: seed.interaction } : {}),
          ...(seed?.persistence ? { persistence: seed.persistence } : {}),
          wish: prompt.trim().slice(0, 600),
          source: seed ? 'template' : 'wish',
          fast_build: true,
        };
      }
      const appName = name.trim() || deriveAppName(prompt, tpl?.label || '');
      const resp = await fetch('/api/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name: appName, template }),
      });
      const data = await resp.json();
      if (data.success && data.app) {
        await createNode(data.app.name, data.app.id, data.app.name, prompt, 'coding', sandboxSpec, referenceFile);
        setReferenceFile(null);
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      data-canvas-ui="overlay"
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.18)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="max-h-[85vh] w-[440px] max-w-[92vw] overflow-y-auto rounded-2xl border p-5 shadow-2xl"
        style={{
          backgroundColor: 'var(--popover)',
          borderColor: 'var(--line)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {/* 标题栏 */}
        <div className="mb-4 flex items-center justify-between">
          <span className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--ink-strong)' }}>
            <Code2 className="h-4 w-4" style={{ color: 'var(--info)' }} />
            AI Coding
          </span>
          <Button
            type="button"
            onClick={onClose}
            variant="ghost"
            tone="neutral"
            size="icon-sm"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 模式切换：新建项目 / 绑定已有 */}
        <div className="mb-3 flex gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--paper-soft)' }}>
          <button
            type="button"
            onClick={() => setMode('create')}
            className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              mode === 'create'
                ? { backgroundColor: 'var(--popover)', color: 'var(--info)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <Plus className="h-3.5 w-3.5" />
            New Project
          </button>
          <button
            type="button"
            onClick={() => setMode('bind')}
            className="flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            style={
              mode === 'bind'
                ? { backgroundColor: 'var(--popover)', color: 'var(--info)', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Bind Existing
          </button>
        </div>

        {mode === 'create' ? (
          /* ---- 新建项目：默认视图只有愿望 + Build，其余收进 More options ---- */
          <div>
            {/* 1. 愿望输入：主入口 */}
            <div className="mb-3">
              <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                What do you want to build?
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreateApp();
                }}
                placeholder='Describe your mini-app — e.g. "calculates overtime pay".'
                rows={3}
                className="w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--info)]"
                style={{
                  borderColor: 'var(--line)',
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--font-sans)',
                  lineHeight: 1.6,
                }}
              />
              <div className="mt-1 flex items-center justify-between" style={{ color: 'var(--ink-muted)' }}>
                <span className="text-11">
                  ⌘/Ctrl + Enter · {fastBuild ? 'builds directly' : 'AI asks a few questions first'}
                </span>
                <span className="text-11">{prompt.length}/800</span>
              </div>
            </div>

            {/* 2. 主操作：Fast build 开启时用文案提示当前模式 */}
            <Button
              type="button"
              onClick={handleCreateApp}
              disabled={creating || !canBuild}
              loading={creating}
              variant="solid"
              tone="info"
              size="md"
              className="w-full"
            >
              {creating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Code2 className="h-3.5 w-3.5" />
                  {fastBuild ? 'Build (Fast)' : 'Build Mini App'}
                </>
              )}
            </Button>

            {/* 3. More options：折叠收纳预设 / 名称 / 参考文件 / Fast build，默认全部空白 */}
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              className="mt-3 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors"
              style={{
                borderColor: moreOpen ? 'color-mix(in oklab, var(--info) 45%, transparent)' : 'var(--line)',
                backgroundColor: 'var(--paper-soft)',
                color: 'var(--ink)',
              }}
            >
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 transition-transform"
                style={{ color: 'var(--ink-muted)', transform: moreOpen ? 'rotate(90deg)' : 'none' }}
              />
              <span>More options</span>
              <span className="ml-auto truncate text-11" style={{ color: 'var(--ink-muted)' }}>
                preset · name · file · Fast build
              </span>
            </button>

            {moreOpen && (
              <div className="mt-2 space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)', backgroundColor: 'var(--paper-soft)' }}>
                {/* 预设：下拉选择，默认 Blank（不预选任何预设） */}
                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-11" style={{ color: 'var(--ink-muted)' }}>Preset</span>
                  <select
                    value={template}
                    onChange={(e) => {
                      const next = e.target.value;
                      setTemplate(next);
                      // 选中预设且愿望为空时，用一句简短描述预填（可自行覆盖）
                      if (next !== 'blank' && !prompt.trim()) {
                        const t = templates.find((x) => x.id === next);
                        if (t) setPrompt(`Build a «${t.label}» mini-app: ${t.description}.`);
                      }
                    }}
                    aria-label="Template preset"
                    className="min-w-0 flex-1 rounded border px-2 py-1.5 text-11 outline-none focus:border-[var(--info)]"
                    style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                  >
                    <option value="blank">Blank — start from scratch</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label} — {t.description}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 名称（可空：留空时从愿望自动生成） */}
                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-11" style={{ color: 'var(--ink-muted)' }}>Name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Optional — auto from wish"
                    className="min-w-0 flex-1 rounded border px-2 py-1.5 text-11 outline-none focus:border-[var(--info)]"
                    style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                  />
                </div>

                {/* 参考图/文件（可选）：创建后上传并挂到首轮消息 */}
                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-11" style={{ color: 'var(--ink-muted)' }}>Reference</span>
                  <div className="min-w-0 flex-1">
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      onChange={(e) => setReferenceFile(e.target.files?.[0] ?? null)}
                      className="block w-full text-11"
                      style={{ color: 'var(--ink-muted)' }}
                    />
                    {referenceFile && (
                      <span className="mt-0.5 flex items-center gap-2 text-10" style={{ color: 'var(--ink-muted)' }}>
                        <span className="truncate">{referenceFile.name}</span>
                        <button
                          type="button"
                          onClick={() => setReferenceFile(null)}
                          className="shrink-0 underline"
                        >
                          Clear
                        </button>
                      </span>
                    )}
                  </div>
                </div>

                {/* Fast build（默认关）：跳过 6 问，直接按愿望/预设种子出首版 */}
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={fastBuild}
                    onChange={(e) => setFastBuild(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  />
                  <span className="text-11 leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                    <span className="font-medium" style={{ color: 'var(--ink-strong)' }}>Fast build</span>
                    {' '}— skip the 6 questions
                  </span>
                </label>

                {!canBuild && (
                  <p className="text-10" style={{ color: 'var(--danger)' }}>
                    Add a wish or pick a preset so Fast build has something to build.
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          /* ---- 绑定已有项目 ---- */
          <div className="max-h-[260px] overflow-y-auto pr-1">
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--info)' }} />
              </div>
            ) : apps.length === 0 ? (
              <p className="py-4 text-center text-xs" style={{ color: 'var(--ink-muted)' }}>
                No mini-apps yet — switch to New Project to create one.
              </p>
            ) : (
              apps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  onClick={async () => {
                    await createNode(app.name, app.id, app.name, '', 'coding', null, referenceFile);
                    setReferenceFile(null);
                  }}
                  disabled={creating}
                  className="mb-1.5 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--info)_8%,transparent)] disabled:opacity-60"
                  style={{ borderColor: 'color-mix(in oklab, var(--info) 50%, transparent)', backgroundColor: 'var(--popover)' }}
                >
                  <Boxes className="h-4 w-4 shrink-0" style={{ color: 'var(--info)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" style={{ color: 'var(--ink-strong)' }}>
                      {app.name}
                    </span>
                    {app.description && (
                      <span className="block truncate text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }}>
                        {app.description}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
