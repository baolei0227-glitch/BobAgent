'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, RefreshCw, Loader2, Plus, Check, ChevronDown, FolderOpen, Sparkles, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TemplateFillPanel, type FillTemplateItem } from './TemplateFillDialog';

/** 模板库场景（来自 /api/skills/templates） */
interface TemplateScene {
  name: string;
  templates: { name: string; size: number; mtime: number; fields: string[] }[];
}

interface DocxTemplatePanelProps {
  /** 打开面板时预选的场景名（如 AI 扫描到模板字段后跳转） */
  initialScene?: string;
}

/**
 * 独立 docx 模板插件面板（预览面板 tab type='template'）
 *
 * 与 ChatNode 完全解耦，整条链路不经过 AI：
 *  - 场景选择 / 上传建库（复用独立 docx-template-mcp 模板库）
 *  - 字段填写 / 生成 / 结果列表：复用 TemplateFillPanel（onGenerated 不传 → 零 token）
 */
export function DocxTemplatePanel({ initialScene }: DocxTemplatePanelProps) {
  const [scenes, setScenes] = useState<TemplateScene[]>([]);
  const [scene, setScene] = useState(initialScene || '');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgError, setMsgError] = useState(false);
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
  const sceneMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 场景管理：重命名 / 删除（对齐模板库管理弹窗）
  const [renamingScene, setRenamingScene] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteScene, setConfirmDeleteScene] = useState<string | null>(null);

  const loadScenes = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/skills/templates');
      const data = await resp.json();
      if (resp.ok) {
        const list = (data.scenes || []) as TemplateScene[];
        setScenes(list);
        // 预选场景失效时回退到第一个有可填模板的场景
        if (scene && !list.some((s) => s.name === scene)) {
          setScene(list.find((s) => s.templates.some((t) => t.fields.length > 0))?.name || '');
        }
      }
    } catch (e) {
      console.error('Load template scenes error:', e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadScenes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 场景下拉：点击外部关闭
  useEffect(() => {
    if (!sceneMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!sceneMenuRef.current?.contains(e.target as Node)) setSceneMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sceneMenuOpen]);

  /** 上传 .docx 到当前场景 */
  const uploadFiles = async (files: File[]) => {
    const target = scene.trim();
    if (!target) {
      setMsg('Pick or enter a scene name first');
      setMsgError(true);
      return;
    }
    const docxFiles = files.filter((f) => f.name.toLowerCase().endsWith('.docx'));
    if (docxFiles.length === 0) {
      setMsg('Only .docx template files are supported');
      setMsgError(true);
      return;
    }
    setUploading(true);
    setMsg('');
    const results: string[] = [];
    for (const file of docxFiles) {
      try {
        const fd = new FormData();
        fd.append('scene', target);
        fd.append('file', file);
        const resp = await fetch('/api/skills/templates', { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Upload failed');
        results.push(`${file.name} (${(data.fields || []).length} fields)`);
      } catch (e) {
        results.push(`${file.name}: ${e instanceof Error ? e.message : 'Upload failed'}`);
      }
    }
    setMsgError(results.some((r) => r.includes(': ')));
    setMsg(results.join('; '));
    setUploading(false);
    loadScenes();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) uploadFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) uploadFiles(files);
    e.target.value = '';
  };

  /** 当前场景的可填模板（有字段占位符） → 传给 TemplateFillPanel */
  const currentTemplates: FillTemplateItem[] = useMemo(() => {
    const s = scenes.find((x) => x.name === scene);
    if (!s) return [];
    return s.templates
      .filter((t) => t.fields.length > 0)
      .map((t) => ({ file: t.name, fields: t.fields }));
  }, [scenes, scene]);

  // 场景管理操作：重命名 / 删除场景 / 删除单个模板（复用 /api/skills/templates）
  const handleStartRename = (name: string) => {
    setRenamingScene(name);
    setRenameValue(name);
  };

  const handleRenameSceneSubmit = async () => {
    if (!renamingScene) return;
    const newName = renameValue.trim();
    if (!newName || newName === renamingScene) {
      setRenamingScene(null);
      return;
    }
    try {
      const resp = await fetch('/api/skills/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename_scene', scene: renamingScene, newScene: newName }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setScene((cur) => (cur === renamingScene ? newName : cur));
        setMsg(`Scene renamed to "${newName}"`);
        setMsgError(false);
        await loadScenes();
      } else {
        setMsg(data.error || 'Rename failed');
        setMsgError(true);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Rename failed');
      setMsgError(true);
    } finally {
      setRenamingScene(null);
    }
  };

  const handleDeleteSceneSubmit = async () => {
    if (!confirmDeleteScene) return;
    try {
      const resp = await fetch('/api/skills/templates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene: confirmDeleteScene }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setMsg(`Scene "${confirmDeleteScene}" deleted`);
        setMsgError(false);
        setScene((cur) => (cur === confirmDeleteScene ? '' : cur));
        await loadScenes();
      } else {
        setMsg(data.error || 'Delete failed');
        setMsgError(true);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Delete failed');
      setMsgError(true);
    } finally {
      setConfirmDeleteScene(null);
    }
  };

  const handleDeleteTemplate = async (file: string) => {
    if (!scene) return;
    try {
      const resp = await fetch('/api/skills/templates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene, filename: file }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setMsg(`Deleted "${scene}/${file}"`);
        setMsgError(false);
        await loadScenes();
      } else {
        setMsg(data.error || 'Delete failed');
        setMsgError(true);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Delete failed');
      setMsgError(true);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header：场景选择 + 上传 + 刷新 */}
      <div
        className="flex shrink-0 flex-col gap-2 px-4 py-3"
        style={{ borderBottom: '1px solid var(--line)', backgroundColor: '#fff' }}
      >
        <div className="flex items-center gap-1.5">
          <FileText className="h-4 w-4" style={{ color: 'var(--primary)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--ink-strong)' }}>
            Templates
          </span>
          <Button
            type="button"
            onClick={loadScenes}
            disabled={loading}
            variant="ghost"
            tone="neutral"
            size="icon-xs"
            className="ml-auto"
            title="Refresh template library"
            aria-label="Refresh template library"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* 场景选择：输入 + Existing 下拉 */}
        <div className="flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2.5 py-1.5"
            style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}
          >
            <Plus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
            <input
              type="text"
              value={scene}
              onChange={(e) => { setScene(e.target.value); setMsg(''); }}
              placeholder="Scene (e.g. Due Diligence)"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none"
              style={{ color: 'var(--ink-strong)' }}
            />
          </div>
          <div className="relative shrink-0" ref={sceneMenuRef}>
            <Button
              type="button"
              onClick={() => setSceneMenuOpen((v) => !v)}
              variant="outline"
              tone="neutral"
              size="icon-sm"
              title="Select an existing scene"
              aria-label="Select an existing scene"
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
            {sceneMenuOpen && (
              <div
                className="absolute right-0 z-50 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border shadow-lg"
                style={{ backgroundColor: 'var(--popover)', borderColor: 'var(--line)' }}
              >
                <div className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
                  Scenes ({scenes.length})
                </div>
                {scenes.length === 0 ? (
                  <div className="px-2.5 py-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    No scenes yet — type a new name above
                  </div>
                ) : scenes.map((s) => (
                  <div key={s.name} className="px-1 py-0.5">
                    {renamingScene === s.name ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameSceneSubmit();
                          if (e.key === 'Escape') setRenamingScene(null);
                        }}
                        onBlur={handleRenameSceneSubmit}
                        placeholder="New scene name"
                        className="w-full rounded border px-2 py-1 text-xs outline-none"
                        style={{ borderColor: 'var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--ink)' }}
                      />
                    ) : confirmDeleteScene === s.name ? (
                      <div className="flex items-center gap-1 px-1.5 py-1 text-xs">
                        <span style={{ color: 'var(--ink)' }}>Delete &amp; its files?</span>
                        <Button
                          type="button"
                          onClick={() => setConfirmDeleteScene(null)}
                          variant="ghost"
                          tone="neutral"
                          size="micro"
                          className="ml-auto"
                        >Cancel</Button>
                        <Button
                          type="button"
                          onClick={handleDeleteSceneSubmit}
                          variant="solid"
                          tone="danger"
                          size="micro"
                        >Delete</Button>
                      </div>
                    ) : (
                      <div className="group flex items-center gap-0.5 rounded px-1.5 py-1 hover:bg-[var(--paper-soft)]">
                        <button
                          type="button"
                          onClick={() => { setScene(s.name); setSceneMenuOpen(false); setMsg(''); }}
                          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs"
                          style={{ color: scene === s.name ? 'var(--primary)' : 'var(--ink)' }}
                        >
                          {scene === s.name && <Check className="h-3 w-3 shrink-0" />}
                          <span className="truncate">{s.name}</span>
                          <span className="shrink-0 text-11" style={{ color: 'var(--ink-faint)' }}>
                            {s.templates.filter((t) => t.fields.length > 0).length} fillable
                          </span>
                        </button>
                        <button
                          type="button"
                          title="Rename scene"
                          onClick={() => handleStartRename(s.name)}
                          className="hidden shrink-0 rounded p-0.5 transition-colors group-hover:block hover:bg-[var(--paper-hover)]"
                          style={{ color: 'var(--ink-muted)' }}
                        ><Pencil className="h-3 w-3" /></button>
                        <button
                          type="button"
                          title="Delete scene"
                          onClick={() => setConfirmDeleteScene(s.name)}
                          className="hidden shrink-0 rounded p-0.5 transition-colors group-hover:block hover:bg-[var(--paper-hover)]"
                          style={{ color: 'var(--danger)' }}
                        ><Trash2 className="h-3 w-3" /></button>
                      </div>
                    )}
                  </div>
                ))}
                <div
                  className="flex cursor-pointer items-center gap-1 border-t px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--paper-soft)]"
                  style={{ borderColor: 'var(--line)', color: 'var(--brand)' }}
                  onClick={() => { setSceneMenuOpen(false); setRenamingScene(null); }}
                >
                  <Plus className="h-3 w-3" /> New scene…
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 拖拽上传建库 */}
        <div
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); }}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 transition-colors"
          style={{
            borderColor: dragOver ? 'var(--primary)' : 'var(--line)',
            backgroundColor: dragOver ? 'color-mix(in oklab, var(--primary) 6%, transparent)' : 'var(--input-bg)',
          }}
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--primary)' }} />
          ) : (
            <FolderOpen className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
          )}
          <span className="truncate text-xs" style={{ color: uploading ? 'var(--primary)' : 'var(--ink-muted)' }}>
            {uploading ? 'Uploading…' : 'Add templates: drag & drop .docx here or click to browse'}
          </span>
        </div>
        <input ref={fileInputRef} type="file" accept=".docx" multiple className="hidden" onChange={handleFileSelect} />

        {msg && (
          <div
            className="rounded-md px-2.5 py-1.5 text-11 leading-relaxed"
            style={{
              backgroundColor: msgError ? 'color-mix(in oklab, var(--danger) 8%, transparent)' : 'color-mix(in oklab, var(--success) 8%, transparent)',
              color: msgError ? 'var(--danger)' : 'var(--success)',
            }}
          >
            {msg}
          </div>
        )}
      </div>

      {/* Body：字段填写 + 生成 + 结果（TemplateFillPanel，零 AI） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {scene && currentTemplates.length > 0 ? (
          <TemplateFillPanel scene={scene} templates={currentTemplates} onClose={() => {}} embedded onDeleteTemplate={handleDeleteTemplate} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
            <Sparkles className="h-6 w-6" style={{ color: 'var(--ink-faint)' }} />
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              {loading
                ? 'Loading template library…'
                : scene
                  ? `No fillable templates in "${scene}" — templates must contain {{ field }} placeholders.`
                  : 'Pick or create a scene above, then add .docx templates.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
