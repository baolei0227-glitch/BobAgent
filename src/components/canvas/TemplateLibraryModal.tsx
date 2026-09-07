'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { FileText, FolderOpen, RefreshCw, Check, Loader2, AlertCircle, Plus, Trash, ClipboardList, Pencil } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { type FillTemplateItem } from './TemplateFillDialog';

interface TemplateLibraryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 嵌入模式：在 SettingsModal 右栏直接渲染内容，不包 Dialog 外壳 */
  embedded?: boolean;
}

/** 模板库场景（来自 /api/skills/templates） */
interface TemplateScene {
  name: string;
  templates: { name: string; size: number; mtime: number; fields: string[] }[];
}

/** 当前选中的模板场景名（用户输入） */
function effectiveScene(custom: string): string {
  return custom.trim();
}

/**
 * 模板库管理弹窗（独立 docx-template-mcp 模板库）
 * - 上传：拖拽/选择 .docx 文件到指定场景
 * - 填写：跳转预览面板 Templates tab（独立插件模式，零 AI），复用已识别缓存的字段
 * - 删除 / 打开本地目录 / 刷新
 */
export function TemplateLibraryModal({ open, onOpenChange, embedded }: TemplateLibraryModalProps) {
  const [templateScenes, setTemplateScenes] = useState<TemplateScene[]>([]);
  const [templateRoot, setTemplateRoot] = useState('');
  const [customScene, setCustomScene] = useState('');
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateUploading, setTemplateUploading] = useState(false);
  const [templateMsg, setTemplateMsg] = useState('');
  const [templateMsgError, setTemplateMsgError] = useState(false);
  const [templateDragOver, setTemplateDragOver] = useState(false);
  const templateFileInputRef = useRef<HTMLInputElement>(null);
  // 场景下拉管理（Existing）：展开/选择/重命名/删除
  const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
  const [renamingScene, setRenamingScene] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteScene, setConfirmDeleteScene] = useState<string | null>(null);
  const sceneMenuRef = useRef<HTMLDivElement>(null);
  const customSceneInputRef = useRef<HTMLInputElement>(null);
  // 最近一次成功上传的结果（用于展示字段识别反馈）
  const [lastUpload, setLastUpload] = useState<{ filename: string; fields: string[] } | null>(null);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const resp = await fetch('/api/skills/templates');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '加载失败');
      setTemplateScenes(data.scenes || []);
      setTemplateRoot(data.root || '');
    } catch (e) {
      console.error('Load templates error:', e);
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadTemplates();
      setTemplateMsg('');
    }
  }, [open, loadTemplates]);

  // 场景下拉：点击外部关闭
  useEffect(() => {
    if (!sceneMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!sceneMenuRef.current?.contains(e.target as Node)) {
        setSceneMenuOpen(false);
        setRenamingScene(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sceneMenuOpen]);

  const uploadTemplateFiles = async (files: File[]) => {
    const scene = effectiveScene(customScene);
    if (!scene) {
      setTemplateMsg('Please enter a scene name first');
      setTemplateMsgError(true);
      return;
    }
    setTemplateUploading(true);
    setTemplateMsg('');
    // 仅支持 .docx（独立 docx-template-mcp 不支持旧版 .doc）
    const docxFiles = files.filter((f) => f.name.toLowerCase().endsWith('.docx'));
    if (docxFiles.length === 0) {
      setTemplateUploading(false);
      setTemplateMsg('Only .docx template files are supported');
      setTemplateMsgError(true);
      return;
    }
    const results: string[] = [];
    const fieldsInfo: string[] = [];
    for (const file of docxFiles) {
      try {
        const fd = new FormData();
        fd.append('scene', scene);
        fd.append('file', file);
        const resp = await fetch('/api/skills/templates', { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Upload failed');
        results.push(data.filename);
        // 记录最近一次上传结果，用于字段识别反馈展示
        setLastUpload({ filename: data.filename, fields: Array.isArray(data.fields) ? data.fields : [] });
        if (data.fields && Array.isArray(data.fields)) {
          fieldsInfo.push(`${data.filename}: ${data.fields.length > 0 ? data.fields.join(', ') : 'no placeholders detected'}`);
        }
      } catch (e) {
        results.push(`${file.name}: ${e instanceof Error ? e.message : 'Upload failed'}`);
      }
    }
    if (results.length === docxFiles.length && results.every((r) => !r.includes(':'))) {
      setTemplateMsg(`Uploaded to "${scene}": ${results.join(', ')}${fieldsInfo.length > 0 ? `; fields: ${fieldsInfo.join('; ')}` : ''}`);
      setTemplateMsgError(false);
    } else {
      setTemplateMsg(results.join('; '));
      setTemplateMsgError(true);
    }
    setTemplateUploading(false);
    loadTemplates();
  };

  const handleTemplateDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTemplateDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) uploadTemplateFiles(files);
  };

  const handleTemplateFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) uploadTemplateFiles(files);
    e.target.value = '';
  };

  const handleTemplateDelete = async (scene: string, filename: string) => {
    try {
      const resp = await fetch('/api/skills/templates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene, filename }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setTemplateMsg(data.error || 'Delete failed');
        setTemplateMsgError(true);
        return;
      }
      setTemplateMsg(`Deleted "${scene}/${filename}"`);
      setTemplateMsgError(false);
      loadTemplates();
    } catch (e) {
      console.error('Delete template error:', e);
      setTemplateMsg('Delete failed');
      setTemplateMsgError(true);
    }
  };

  // 在 Finder 中打开模板库根目录（Electron 环境）
  const openTemplatesFolder = async () => {
    if (!templateRoot) return;
    try {
      const w = window as unknown as { api?: { openFile?: (p: string) => Promise<unknown> } };
      if (w.api?.openFile) {
        await w.api.openFile(templateRoot);
      }
    } catch (e) {
      console.error('Open templates folder error:', e);
    }
  };

  // 场景下拉：选择已有场景作为上传目标
  const handleSelectScene = (name: string) => {
    setCustomScene(name);
    setSceneMenuOpen(false);
    setRenamingScene(null);
  };

  // 场景下拉：开始重命名（就地编辑）
  const handleStartRename = (name: string) => {
    setRenamingScene(name);
    setRenameValue(name);
  };

  // 场景下拉：提交重命名（POST rename_scene → 目录 mv）
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
      if (!resp.ok || !data.success) {
        setTemplateMsg(data.error || 'Rename failed');
        setTemplateMsgError(true);
        return;
      }
      // 重命名后若当前输入框正指向旧场景，同步更新
      setCustomScene((cur) => (cur === renamingScene ? newName : cur));
      setTemplateMsg(`Scene renamed to "${newName}"`);
      setTemplateMsgError(false);
      loadTemplates();
    } catch (e) {
      console.error('Rename scene error:', e);
      setTemplateMsg('Rename failed');
      setTemplateMsgError(true);
    } finally {
      setRenamingScene(null);
    }
  };

  // 场景下拉：提交删除整个场景（DELETE 无 filename → 删除场景目录）
  const handleDeleteSceneSubmit = async () => {
    if (!confirmDeleteScene) return;
    try {
      const resp = await fetch('/api/skills/templates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene: confirmDeleteScene }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setTemplateMsg(data.error || 'Delete failed');
        setTemplateMsgError(true);
      } else {
        setTemplateMsg(`Scene "${confirmDeleteScene}" deleted`);
        setTemplateMsgError(false);
        setCustomScene((cur) => (cur === confirmDeleteScene ? '' : cur));
        loadTemplates();
      }
    } catch (e) {
      console.error('Delete scene error:', e);
      setTemplateMsg('Delete failed');
      setTemplateMsgError(true);
    } finally {
      setConfirmDeleteScene(null);
    }
  };

  /** 打开模板填写：跳转预览面板 Templates tab（独立插件模式，零 AI），直接复用已识别缓存的字段 */
  const openTemplateFill = (scene: TemplateScene) => {
    const templates: FillTemplateItem[] = scene.templates
      .filter((t) => t.fields.length > 0)
      .map((t) => ({ file: t.name, fields: t.fields }));
    if (templates.length === 0) {
      setTemplateMsg(`No fillable templates in "${scene.name}" (templates must contain {{ field }} placeholders)`);
      setTemplateMsgError(true);
      return;
    }
    // 关闭管理弹窗，跳转预览面板 Templates tab（携带场景名）
    onOpenChange(false);
    window.dispatchEvent(new CustomEvent('open-template-panel', { detail: { scene: scene.name } }));
  };

  // 当前 Target Scene 的场景与模板（Existing templates 只显示当前场景，而非全部）
  const activeScene = templateScenes.find((s) => s.name === effectiveScene(customScene));
  const activeTemplates = activeScene?.templates ?? [];

  const inner = (
    <>
      {!embedded && (
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle
            className="flex items-center gap-2 text-base"
            style={{ color: 'var(--ink-strong)' }}
          >
            <FileText className="h-4 w-4" style={{ color: 'var(--primary)' }} />
            Templates
          </DialogTitle>
        </DialogHeader>
      )}

        <div className={`nowheel overflow-y-auto pb-2${embedded ? ' px-0' : ' max-h-[55vh] px-6'}`}>
          <div className="space-y-4">
            {/* 场景输入 + Existing 场景管理下拉 */}
            <div>
              <label className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                Target Scene
              </label>
              <div className="mt-1.5 flex items-center gap-1.5">
                <div className="flex flex-1 items-center gap-1.5 rounded-md border px-2.5 py-1.5"
                  style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
                  <Plus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                  <input
                    ref={customSceneInputRef}
                    type="text"
                    value={customScene}
                    onChange={(e) => { setCustomScene(e.target.value); setTemplateMsg(''); }}
                    placeholder="Enter scene name (e.g. Due Diligence)"
                    className="flex-1 bg-transparent text-xs outline-none"
                    style={{ color: 'var(--ink-strong)' }}
                  />
                </div>
                <div className="relative shrink-0" ref={sceneMenuRef}>
                  <Button
                    type="button"
                    onClick={() => setSceneMenuOpen((v) => !v)}
                    variant="outline"
                    tone="neutral"
                    size="sm"
                    title="Select or manage existing scenes"
                  >
                    Existing ▾
                  </Button>
                  {sceneMenuOpen && (
                    <div
                      className="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-lg border shadow-lg"
                      style={{ backgroundColor: 'var(--popover)', borderColor: 'var(--line)' }}
                    >
                      <div className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
                        Scenes ({templateScenes.length})
                      </div>
                      {templateScenes.length === 0 ? (
                        <div className="px-2.5 py-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                          No scenes yet — type a new name above
                        </div>
                      ) : templateScenes.map((scene) => (
                        <div key={scene.name} className="px-1 py-0.5">
                          {renamingScene === scene.name ? (
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
                          ) : confirmDeleteScene === scene.name ? (
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
                            <div className="group flex items-center gap-0.5 rounded px-1.5 py-1">
                              <button
                                type="button"
                                onClick={() => handleSelectScene(scene.name)}
                                className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs"
                                style={{ color: 'var(--ink)' }}
                              >
                                <span className="truncate">{scene.name}</span>
                                <span className="shrink-0 text-xs" style={{ color: 'var(--ink-faint)' }}>({scene.templates.length})</span>
                              </button>
                              <button
                                type="button"
                                title="Rename scene"
                                onClick={() => handleStartRename(scene.name)}
                                className="hidden shrink-0 rounded p-0.5 transition-colors group-hover:block hover:bg-[var(--paper-hover)]"
                                style={{ color: 'var(--ink-muted)' }}
                              ><Pencil className="h-3 w-3" /></button>
                              <button
                                type="button"
                                title="Delete scene"
                                onClick={() => setConfirmDeleteScene(scene.name)}
                                className="hidden shrink-0 rounded p-0.5 transition-colors group-hover:block hover:bg-[var(--paper-hover)]"
                                style={{ color: 'var(--danger)' }}
                              ><Trash className="h-3 w-3" /></button>
                            </div>
                          )}
                        </div>
                      ))}
                      <div
                        className="flex cursor-pointer items-center gap-1 border-t px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--paper-soft)]"
                        style={{ borderColor: 'var(--line)', color: 'var(--brand)' }}
                        onClick={() => { setSceneMenuOpen(false); setRenamingScene(null); customSceneInputRef.current?.focus(); }}
                      >
                        <Plus className="h-3 w-3" /> New scene…
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 拖拽上传区 */}
            <div
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setTemplateDragOver(true); }}
              onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setTemplateDragOver(false); }}
              onDrop={handleTemplateDrop}
              onClick={() => templateFileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 transition-colors"
              style={{
                borderColor: templateDragOver ? 'var(--primary)' : 'var(--line)',
                backgroundColor: templateDragOver ? 'color-mix(in oklab, var(--primary) 6%, transparent)' : 'var(--input-bg)',
              }}
            >
              {templateUploading ? (
                <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--primary)' }} />
              ) : (
                <FileText className="h-6 w-6" style={{ color: 'var(--primary)' }} />
              )}
              <span className="text-xs font-medium" style={{ color: templateUploading ? 'var(--primary)' : 'var(--ink)' }}>
                {templateUploading ? 'Uploading…' : 'Drag & drop .docx files here'}
              </span>
              <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                or click to browse · multiple files supported
              </span>
            </div>
            <input
              ref={templateFileInputRef}
              type="file"
              accept=".docx"
              multiple
              className="hidden"
              onChange={handleTemplateFileSelect}
            />

            {/* 字段识别反馈：最近一次上传的自动扫描结果 */}
            {lastUpload && !templateUploading && (
              <div className="rounded-md border px-3 py-2.5"
                style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>
                    {lastUpload.filename}
                  </span>
                  <span className="shrink-0 text-xs" style={{ color: 'var(--primary)' }}>
                    {lastUpload.fields.length} field{lastUpload.fields.length === 1 ? '' : 's'}
                  </span>
                </div>
                {lastUpload.fields.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {lastUpload.fields.map((f) => (
                      <span
                        key={f}
                        className="rounded px-1 py-px text-xs"
                        style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)', color: 'var(--primary)' }}
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                    No placeholders detected — use <code className="font-mono" style={{ color: 'var(--ink-muted)' }}>{'{{ field }}'}</code> in Word
                  </p>
                )}
              </div>
            )}

            {/* 上传/删除结果提示 */}
            {templateMsg && (
              <div className="flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs"
                style={{
                  backgroundColor: templateMsgError ? 'color-mix(in oklab, var(--danger) 6%, transparent)' : 'color-mix(in oklab, var(--success) 6%, transparent)',
                  color: templateMsgError ? 'var(--danger)' : 'var(--success)',
                }}>
                {templateMsgError
                  ? <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
                  : <Check className="h-3.5 w-3.5 shrink-0 mt-px" />}
                <span className="leading-relaxed">{templateMsg}</span>
              </div>
            )}

            {/* 模板列表 */}
            <div className="rounded-md border px-3 py-2.5"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                  Existing templates{activeScene ? ` (${activeTemplates.length})` : ''}
                </p>
                <Button
                  type="button"
                  onClick={loadTemplates}
                  disabled={templatesLoading}
                  variant="ghost"
                  tone="neutral"
                  size="micro"
                >
                  <RefreshCw className={`h-3 w-3 ${templatesLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
              </div>
              {templatesLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--primary)' }} />
                </div>
              ) : !effectiveScene(customScene) ? (
                <p className="py-3 text-center text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                  Enter a scene name above to view its templates.
                </p>
              ) : !activeScene ? (
                <p className="py-3 text-center text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                  New scene — no templates yet. Upload .docx files above.
                </p>
              ) : activeTemplates.length === 0 ? (
                <p className="py-3 text-center text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                  Empty scene — upload .docx files above.
                </p>
              ) : (
                <div className="max-h-44 space-y-2 overflow-y-auto pr-0.5">
                  <div>
                    <div className="flex items-center gap-1 text-xs font-medium"
                      style={{ color: 'var(--ink-muted)' }}>
                      <FolderOpen className="h-3 w-3 shrink-0" style={{ color: 'color-mix(in oklab, var(--primary) 70%, transparent)' }} />
                      {activeScene.name}
                      <span className="font-normal" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                        ({activeTemplates.length})
                      </span>
                    </div>
                    <ul className="ml-4 space-y-1">
                      {activeTemplates.map((t) => (
                        <li key={t.name} className="group py-0.5">
                          <div className="flex items-center gap-1.5">
                            <FileText className="h-3 w-3 shrink-0" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }} />
                            <span className="flex-1 truncate text-xs" style={{ color: 'var(--ink)' }}>
                              {t.name}
                            </span>
                            <span className="shrink-0 text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
                              {(t.size / 1024).toFixed(0)} KB
                            </span>
                            <button
                              type="button"
                              onClick={() => openTemplateFill(activeScene)}
                              className="shrink-0 rounded p-0.5 opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--paper-soft)]"
                              title={`Fill ${t.name}`}
                            >
                              <ClipboardList className="h-3 w-3" style={{ color: 'var(--primary)' }} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleTemplateDelete(activeScene.name, t.name)}
                              className="shrink-0 rounded p-0.5 opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--paper-soft)]"
                              title={`Delete ${t.name}`}
                            >
                              <Trash className="h-3 w-3" style={{ color: 'var(--danger)' }} />
                            </button>
                          </div>
                          {t.fields.length > 0 ? (
                            <div className="ml-4 mt-0.5 flex flex-wrap gap-1">
                              {t.fields.map((f) => (
                                <span
                                  key={f}
                                  className="rounded px-1 py-px text-xs"
                                  style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)', color: 'var(--primary)' }}
                                >
                                  {f}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="ml-4 mt-0.5 block text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 40%, transparent)' }}>
                              No placeholders detected
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>

            {/* 说明：本地模板库路径 */}
            <div className="rounded-md border px-3 py-2.5"
              style={{ borderColor: 'var(--line)', backgroundColor: 'var(--input-bg)' }}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs font-medium shrink-0" style={{ color: 'var(--ink-muted)' }}>
                  Local path
                </p>
                {templateRoot && (
                  <Button
                    type="button"
                    onClick={openTemplatesFolder}
                    variant="ghost"
                    tone="brand"
                    size="sm"
                    className="shrink-0"
                    title="Open template library folder in Finder"
                  >
                    <FolderOpen className="h-3 w-3" />
                    Open Folder
                  </Button>
                )}
              </div>
              {templateRoot && (
                <p className="mb-1.5 break-all text-xs leading-relaxed" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                  {templateRoot}
                </p>
              )}
              <p className="text-xs leading-relaxed" style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}>
                Shared template library. Only .docx is supported. Managed by the standalone docx-template-mcp plugin — other MCP agents read the same library.
              </p>
            </div>
          </div>
        </div>

        {!embedded && (
          <div className="flex items-center justify-end gap-2 px-6 py-4">
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
        )}
    </>
  );
  if (embedded) {
    return <div className="px-5 py-4">{inner}</div>;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md gap-0 p-0"
        style={{ fontFamily: "var(--font-sans)" }}
      >
        {inner}
      </DialogContent>
    </Dialog>
  );
}
