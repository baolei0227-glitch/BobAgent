'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader2, X, Trash2, Save, Upload, ImageOff,
  AlignLeft, AlignCenter, AlignRight,
  Palette, Type, Pilcrow, FileText, FileCode, Lock,
} from 'lucide-react';
import type { DocxExportConfig } from '@/lib/md-to-docx';
import { DEFAULT_DOCX_CONFIG } from '@/lib/md-to-docx';

// ---------------------------------------------------------------------------
// Preset types & storage
// ---------------------------------------------------------------------------

interface DocxPreset {
  id: string;
  name: string;
  isBuiltin: boolean;
  config: DocxExportConfig;
}

const BUILTIN_PRESETS: DocxPreset[] = [
  {
    id: 'builtin-default-cn',
    name: '默认中文',
    isBuiltin: true,
    config: { ...DEFAULT_DOCX_CONFIG },
  },
  {
    id: 'builtin-compact-report',
    name: '紧凑报告',
    isBuiltin: true,
    config: {
      bodyFont: '微软雅黑',
      bodySize: 11,
      lineHeight: 1.15,
      margin: 'narrow',
      headingColor: '2b579a',
      codeFont: 'Consolas',
      pageNumber: 'right',
      header: { ...DEFAULT_DOCX_CONFIG.header },
    },
  },
  {
    id: 'builtin-legal-cn',
    name: '中文公文（仿宋）',
    isBuiltin: true,
    config: {
      bodyFont: '仿宋',
      bodySize: 14, // 四号
      lineHeight: 1.5,
      margin: 'standard',
      headingColor: '000000',
      codeFont: 'Consolas',
      pageNumber: 'center',
      header: { ...DEFAULT_DOCX_CONFIG.header },
    },
  },
];

const STORAGE_KEY = 'docx-export-presets';
const LAST_PRESET_KEY = 'docx-export-last-preset';

function loadPresets(): DocxPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return BUILTIN_PRESETS;
    const custom = JSON.parse(raw) as DocxPreset[];
    return [...BUILTIN_PRESETS, ...custom.filter((p) => !p.isBuiltin)];
  } catch {
    return BUILTIN_PRESETS;
  }
}

function saveCustomPresets(presets: DocxPreset[]) {
  const custom = presets.filter((p) => !p.isBuiltin);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
}

function loadLastPresetId(): string | null {
  try {
    return localStorage.getItem(LAST_PRESET_KEY);
  } catch {
    return null;
  }
}

function saveLastPresetId(id: string) {
  localStorage.setItem(LAST_PRESET_KEY, id);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADING_COLORS = [
  { label: 'Dark Gray', value: '1a1a1a' },
  { label: 'Black', value: '000000' },
  { label: 'Blue', value: '2b579a' },
];

const FONT_OPTIONS = [
  { label: '宋体', value: '宋体' },
  { label: '微软雅黑', value: '微软雅黑' },
  { label: '仿宋', value: '仿宋' },
  { label: '楷体', value: '楷体' },
  { label: 'Times New Roman', value: 'Times New Roman' },
  { label: '思源黑体（免费开源）', value: 'Source Han Sans SC' },
  { label: '思源宋体（免费开源）', value: 'Source Han Serif SC' },
  { label: '霞鹜文楷（免费开源）', value: 'LXGW WenKai' },
  { label: '苹方（macOS 自带）', value: 'PingFang SC' },
];

const CODE_FONT_OPTIONS = [
  { label: 'Consolas', value: 'Consolas' },
  { label: '等线', value: '等线' },
  { label: 'Source Code Pro', value: 'Source Code Pro' },
];

// ---------------------------------------------------------------------------
// CSS (range slider + animations)
// ---------------------------------------------------------------------------

const DIALOG_CSS = `
.docx-range {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  background: var(--line);
  outline: none;
}
.docx-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--primary);
  cursor: pointer;
  border: 2px solid var(--paper);
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.docx-range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--primary);
  cursor: pointer;
  border: 2px solid var(--paper);
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
@keyframes docx-enter {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes docx-backdrop-enter {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes docx-slide-fade {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;

// ---------------------------------------------------------------------------
// Segmented Control (iOS-style)
// ---------------------------------------------------------------------------

function SegmentedControl({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
}) {
  return (
    <div
      className="inline-flex rounded-lg p-0.5"
      style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 6%, transparent)' }}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="rounded-[6px] px-2.5 py-1 text-xs font-medium transition-all duration-150"
            style={{
              backgroundColor: active ? 'var(--paper)' : 'transparent',
              color: active ? 'var(--ink)' : 'var(--ink-muted)',
              boxShadow: active
                ? '0 1px 2px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04)'
                : 'none',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select (enhanced)
// ---------------------------------------------------------------------------

function Select({
  value,
  onChange,
  options,
  className = '',
}: {
  value: string | number;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
  className?: string;
}) {
  return (
    <select
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-md border px-2 py-1 text-xs outline-none cursor-pointer transition-colors ${className}`}
      style={{
        borderColor: 'var(--line)',
        backgroundColor: 'var(--paper)',
        color: 'var(--ink)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'color-mix(in oklab, var(--ink) 25%, var(--line))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--line)';
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Section card
// ---------------------------------------------------------------------------

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl px-3.5 py-3 space-y-2.5"
      style={{
        backgroundColor: 'color-mix(in oklab, var(--ink) 2.5%, transparent)',
        border: '1px solid color-mix(in oklab, var(--line) 60%, transparent)',
      }}
    >
      <div className="flex items-center gap-1.5">
        <span style={{ color: 'var(--ink-muted)' }}>{icon}</span>
        <span
          className="text-11 font-semibold uppercase tracking-wide"
          style={{ color: 'var(--ink-muted)' }}
        >
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Label helper
// ---------------------------------------------------------------------------

function FieldLabel({ children, width = 'w-10' }: { children: React.ReactNode; width?: string }) {
  return (
    <span
      className={`text-xs font-medium ${width} shrink-0`}
      style={{ color: 'var(--ink-muted)' }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export interface ExportDocxDialogProps {
  open: boolean;
  onClose: () => void;
  onExport: (config: DocxExportConfig, fileName: string) => Promise<void>;
  /** HTML 导出（自包含 HTML 文件下载） */
  onExportHtml: (fileName: string) => Promise<void>;
  /** PDF 导出（Electron printToPDF → 文件下载） */
  onExportPdf: (fileName: string) => Promise<void>;
  defaultFileName: string;
}

type ExportFormat = 'docx' | 'html' | 'pdf';

export function ExportDocxDialog({ open, onClose, onExport, onExportHtml, onExportPdf, defaultFileName }: ExportDocxDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('docx');
  const [presets, setPresets] = useState<DocxPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [config, setConfig] = useState<DocxExportConfig>({ ...DEFAULT_DOCX_CONFIG });
  const [fileName, setFileName] = useState(defaultFileName);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');

  const imageInputRef = useRef<HTMLInputElement>(null);

  // Init: load presets + last used
  useEffect(() => {
    if (!open) return;
    setFormat('docx');
    const loaded = loadPresets();
    setPresets(loaded);
    const lastId = loadLastPresetId();
    const target = loaded.find((p) => p.id === lastId) ?? loaded[0];
    if (target) {
      setSelectedPresetId(target.id);
      setConfig({ ...target.config });
    }
    setFileName(defaultFileName);
    setError(null);
    setShowSaveAs(false);
    setNewPresetName('');
  }, [open, defaultFileName]);

  // Esc to close
  useEffect(() => {
    if (!open || exporting) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [open, onClose, exporting]);

  const applyPreset = useCallback((id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (preset) {
      setSelectedPresetId(id);
      setConfig({ ...preset.config });
    }
  }, [presets]);

  const updateConfig = <K extends keyof DocxExportConfig>(key: K, value: DocxExportConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setSelectedPresetId('');
  };

  const updateHeader = <K extends keyof DocxExportConfig['header']>(
    key: K,
    value: DocxExportConfig['header'][K],
  ) => {
    setConfig((prev) => ({
      ...prev,
      header: { ...prev.header, [key]: value },
    }));
    setSelectedPresetId('');
  };

  const handlePickImage = () => imageInputRef.current?.click();

  const handleHeaderImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|gif|webp|bmp)$/i.test(file.type)) {
      setError('Header image must be PNG / JPG / GIF / WEBP / BMP');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Header image size must be ≤ 2MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      updateHeader('imageDataUrl', dataUrl);
      setError(null);
    };
    reader.onerror = () => setError('Failed to read image file');
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSaveAs = () => {
    const name = newPresetName.trim();
    if (!name) return;
    const newPreset: DocxPreset = {
      id: `custom-${Date.now()}`,
      name,
      isBuiltin: false,
      config: { ...config },
    };
    const updated = [...presets, newPreset];
    setPresets(updated);
    saveCustomPresets(updated);
    setSelectedPresetId(newPreset.id);
    saveLastPresetId(newPreset.id);
    setShowSaveAs(false);
    setNewPresetName('');
  };

  const handleDeletePreset = () => {
    const target = presets.find((p) => p.id === selectedPresetId);
    if (!target || target.isBuiltin) return;
    const updated = presets.filter((p) => p.id !== selectedPresetId);
    setPresets(updated);
    saveCustomPresets(updated);
    const fallback = updated[0];
    setSelectedPresetId(fallback.id);
    setConfig({ ...fallback.config });
  };

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const name = fileName.trim() || defaultFileName || 'export';
      if (format === 'docx') {
        saveLastPresetId(selectedPresetId || presets[0]?.id || '');
        await onExport(config, name);
      } else if (format === 'html') {
        await onExportHtml(name);
      } else {
        await onExportPdf(name);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  if (!open) return null;

  const currentPreset = presets.find((p) => p.id === selectedPresetId);
  const canDelete = !!currentPreset && !currentPreset.isBuiltin;

  return (
    <>
      <style>{DIALOG_CSS}</style>

      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center"
        style={{
          backgroundColor: 'rgba(0,0,0,0.25)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          animation: 'docx-backdrop-enter 200ms ease-out',
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !exporting) onClose();
        }}
      >
        {/* Dialog */}
        <div
          className="w-[520px] rounded-2xl overflow-hidden"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--line)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.04)',
            animation: 'docx-enter 220ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          {/* Header bar */}
          <div
            className="flex items-center justify-between px-5 py-3.5"
            style={{ borderBottom: '1px solid var(--line)' }}
          >
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                Export
              </h2>
              <SegmentedControl
                value={format}
                onChange={(v) => setFormat(v as ExportFormat)}
                options={[
                  { label: 'DOCX', value: 'docx' },
                  { label: 'HTML', value: 'html' },
                  { label: 'PDF', value: 'pdf' },
                ]}
              />
            </div>
            <button
              onClick={onClose}
              disabled={exporting}
              className="rounded-lg p-1.5 transition-colors disabled:opacity-50"
              style={{ color: 'var(--ink-muted)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'color-mix(in oklab, var(--ink) 8%, transparent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-4 py-3.5 space-y-3 max-h-[72vh] overflow-y-auto">
            {format === 'docx' && (
            <>
            {/* ── Preset ─────────────────────────────────────── */}
            <Section icon={<Palette className="h-3.5 w-3.5" />} title="Preset">
              <div className="flex flex-wrap gap-1.5">
                {presets.map((p) => {
                  const active = p.id === selectedPresetId;
                  return (
                    <button
                      key={p.id}
                      onClick={() => applyPreset(p.id)}
                      className="rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 flex items-center gap-1"
                      style={{
                        backgroundColor: active
                          ? 'color-mix(in oklab, var(--primary) 12%, transparent)'
                          : 'color-mix(in oklab, var(--ink) 4%, transparent)',
                        color: active ? 'var(--primary)' : 'var(--ink-muted)',
                        border: `1px solid ${
                          active
                            ? 'color-mix(in oklab, var(--primary) 30%, transparent)'
                            : 'var(--line)'
                        }`,
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          e.currentTarget.style.backgroundColor = 'color-mix(in oklab, var(--ink) 8%, transparent)';
                          e.currentTarget.style.color = 'var(--ink)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          e.currentTarget.style.backgroundColor = 'color-mix(in oklab, var(--ink) 4%, transparent)';
                          e.currentTarget.style.color = 'var(--ink-muted)';
                        }
                      }}
                    >
                      {p.isBuiltin && <Lock className="h-2.5 w-2.5" />}
                      {p.name}
                    </button>
                  );
                })}
              </div>

              {/* Save-as / Delete row */}
              <div className="flex items-center gap-2 pt-0.5">
                {showSaveAs ? (
                  <div
                    className="flex items-center gap-2 flex-1"
                    style={{ animation: 'docx-slide-fade 200ms ease-out' }}
                  >
                    <input
                      value={newPresetName}
                      onChange={(e) => setNewPresetName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveAs()}
                      placeholder="Preset name..."
                      className="flex-1 rounded-md border px-2 py-1 text-xs outline-none"
                      style={{
                        borderColor: 'var(--line)',
                        backgroundColor: 'var(--paper)',
                        color: 'var(--ink)',
                      }}
                      autoFocus
                    />
                    <button
                      onClick={handleSaveAs}
                      className="rounded-md px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80"
                      style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setShowSaveAs(false);
                        setNewPresetName('');
                      }}
                      className="rounded-md px-2 py-1 text-xs font-medium transition-colors"
                      style={{ color: 'var(--ink-muted)' }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowSaveAs(true)}
                    className="inline-flex items-center gap-1 text-xs font-medium transition-colors"
                    style={{ color: 'var(--ink-muted)' }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'var(--ink)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--ink-muted)';
                    }}
                  >
                    <Save className="h-3 w-3" />
                    Save as preset
                  </button>
                )}
                {canDelete && !showSaveAs && (
                  <button
                    onClick={handleDeletePreset}
                    className="ml-auto inline-flex items-center gap-1 text-xs font-medium transition-colors"
                    style={{ color: 'var(--ink-muted)' }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = '#dc2626';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--ink-muted)';
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </button>
                )}
              </div>
            </Section>

            {/* ── Document Style ─────────────────────────────── */}
            <Section icon={<Type className="h-3.5 w-3.5" />} title="Document Style">
              <div className="space-y-2">
                {/* Row 1: Font + Size */}
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FieldLabel>Font</FieldLabel>
                    <Select
                      value={config.bodyFont}
                      onChange={(v) => updateConfig('bodyFont', v)}
                      options={FONT_OPTIONS}
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FieldLabel width="w-8">Size</FieldLabel>
                    <SegmentedControl
                      value={String(config.bodySize)}
                      onChange={(v) => updateConfig('bodySize', Number(v))}
                      options={[
                        { label: '10', value: '10' },
                        { label: '11', value: '11' },
                        { label: '12', value: '12' },
                        { label: '14', value: '14' },
                      ]}
                    />
                  </div>
                </div>

                {/* Row 2: Line + Margin */}
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FieldLabel>Line</FieldLabel>
                    <SegmentedControl
                      value={String(config.lineHeight)}
                      onChange={(v) => updateConfig('lineHeight', Number(v))}
                      options={[
                        { label: '1.0', value: '1' },
                        { label: '1.15', value: '1.15' },
                        { label: '1.5', value: '1.5' },
                        { label: '2.0', value: '2' },
                      ]}
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FieldLabel>Margin</FieldLabel>
                    <SegmentedControl
                      value={config.margin}
                      onChange={(v) => updateConfig('margin', v as DocxExportConfig['margin'])}
                      options={[
                        { label: 'Narrow', value: 'narrow' },
                        { label: 'Standard', value: 'standard' },
                        { label: 'Wide', value: 'wide' },
                      ]}
                    />
                  </div>
                </div>

                {/* Row 3: Heading color + Code font */}
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FieldLabel>Heading</FieldLabel>
                    <div className="flex items-center gap-1.5">
                      {HEADING_COLORS.map((c) => {
                        const active = config.headingColor === c.value;
                        return (
                          <button
                            key={c.value}
                            onClick={() => updateConfig('headingColor', c.value)}
                            className="w-4 h-4 rounded-full transition-all duration-150"
                            style={{
                              backgroundColor: `#${c.value}`,
                              border: active
                                ? '2px solid var(--primary)'
                                : '1px solid var(--line)',
                              transform: active ? 'scale(1.15)' : 'scale(1)',
                            }}
                            title={c.label}
                          />
                        );
                      })}
                      {/* Custom color picker */}
                      <label
                        className="relative w-4 h-4 rounded-full cursor-pointer overflow-hidden"
                        style={{ border: '1px solid var(--line)' }}
                        title="Custom color"
                      >
                        <div
                          className="w-full h-full rounded-full"
                          style={{
                            background:
                              'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)',
                          }}
                        />
                        <input
                          type="color"
                          value={`#${config.headingColor}`}
                          onChange={(e) =>
                            updateConfig('headingColor', e.target.value.slice(1))
                          }
                          className="absolute inset-0 opacity-0 cursor-pointer"
                        />
                      </label>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FieldLabel width="w-8">Code</FieldLabel>
                    <Select
                      value={config.codeFont}
                      onChange={(v) => updateConfig('codeFont', v)}
                      options={CODE_FONT_OPTIONS}
                    />
                  </div>
                </div>

                {/* Row 4: Page number */}
                <div className="flex items-center gap-2">
                  <FieldLabel>Page #</FieldLabel>
                  <SegmentedControl
                    value={config.pageNumber}
                    onChange={(v) =>
                      updateConfig('pageNumber', v as DocxExportConfig['pageNumber'])
                    }
                    options={[
                      { label: 'Off', value: 'off' },
                      { label: 'Center', value: 'center' },
                      { label: 'Right', value: 'right' },
                    ]}
                  />
                </div>
              </div>
            </Section>

            {/* ── Header ─────────────────────────────────────── */}
            <Section icon={<Pilcrow className="h-3.5 w-3.5" />} title="Header">
              <div className="flex items-center gap-2">
                <SegmentedControl
                  value={config.header.type}
                  onChange={(v) =>
                    updateHeader('type', v as DocxExportConfig['header']['type'])
                  }
                  options={[
                    { label: 'Off', value: 'off' },
                    { label: 'Text', value: 'text' },
                    { label: 'Image', value: 'image' },
                  ]}
                />
                {/* Alignment buttons */}
                <div
                  className="ml-auto inline-flex rounded-lg p-0.5"
                  style={{
                    backgroundColor: 'color-mix(in oklab, var(--ink) 6%, transparent)',
                  }}
                >
                  {(['left', 'center', 'right'] as const).map((pos) => {
                    const Icon =
                      pos === 'left'
                        ? AlignLeft
                        : pos === 'center'
                          ? AlignCenter
                          : AlignRight;
                    const active = config.header.align === pos;
                    return (
                      <button
                        key={pos}
                        type="button"
                        title={`Align ${pos}`}
                        onClick={() => updateHeader('align', pos)}
                        className="rounded-[6px] p-1 transition-all duration-150"
                        style={{
                          backgroundColor: active ? 'var(--paper)' : 'transparent',
                          color: active ? 'var(--ink)' : 'var(--ink-muted)',
                          boxShadow: active
                            ? '0 1px 2px rgba(0,0,0,0.12)'
                            : 'none',
                        }}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Text header content */}
              {config.header.type === 'text' && (
                <div
                  key="text-content"
                  style={{ animation: 'docx-slide-fade 200ms ease-out' }}
                >
                  <input
                    type="text"
                    value={config.header.text}
                    onChange={(e) => updateHeader('text', e.target.value)}
                    placeholder="Header text..."
                    className="w-full rounded-md border px-2.5 py-1.5 text-xs outline-none"
                    style={{
                      borderColor: 'var(--line)',
                      backgroundColor: 'var(--paper)',
                      color: 'var(--ink)',
                    }}
                    maxLength={200}
                    autoFocus
                  />
                </div>
              )}

              {/* Image header content */}
              {config.header.type === 'image' && (
                <div
                  key="image-content"
                  className="space-y-2"
                  style={{ animation: 'docx-slide-fade 200ms ease-out' }}
                >
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/gif,image/webp,image/bmp"
                    className="hidden"
                    onChange={handleHeaderImageFile}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handlePickImage}
                      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors"
                      style={{
                        borderColor: 'var(--line)',
                        backgroundColor: 'var(--paper)',
                        color: 'var(--ink)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor =
                          'color-mix(in oklab, var(--ink) 5%, transparent)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--paper)';
                      }}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {config.header.imageDataUrl ? 'Replace' : 'Upload'}
                    </button>
                    {config.header.imageDataUrl && (
                      <button
                        type="button"
                        onClick={() => updateHeader('imageDataUrl', '')}
                        title="Remove image"
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors"
                        style={{
                          borderColor: 'var(--line)',
                          backgroundColor: 'var(--paper)',
                          color: 'var(--ink-muted)',
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {config.header.imageDataUrl ? (
                    <div
                      className="rounded-md border flex items-center justify-center overflow-hidden"
                      style={{
                        borderColor: 'var(--line)',
                        backgroundColor: 'var(--surface)',
                        height: '48px',
                      }}
                    >
                      <img
                        src={config.header.imageDataUrl}
                        alt="Header preview"
                        style={{
                          maxHeight: '100%',
                          maxWidth: '100%',
                          objectFit: 'contain',
                        }}
                      />
                    </div>
                  ) : (
                    <div
                      className="rounded-md border flex items-center justify-center gap-1.5 text-xs"
                      style={{
                        borderColor: 'var(--line)',
                        backgroundColor:
                          'color-mix(in oklab, var(--ink) 3%, transparent)',
                        color: 'var(--ink-muted)',
                        height: '48px',
                      }}
                    >
                      <ImageOff className="h-3.5 w-3.5" />
                      No image selected
                    </div>
                  )}
                </div>
              )}
            </Section>
            </>
            )}

            {/* ── HTML / PDF 说明 ─────────────────────────────── */}
            {format !== 'docx' && (
              <div
                className="rounded-xl px-3.5 py-3"
                style={{
                  backgroundColor: 'color-mix(in oklab, var(--ink) 2.5%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--line) 60%, transparent)',
                }}
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span style={{ color: 'var(--ink-muted)' }}>
                    {format === 'html' ? <FileCode className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                  </span>
                  <span
                    className="text-11 font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    {format === 'html' ? 'HTML' : 'PDF'}
                  </span>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                  {format === 'html'
                    ? '自包含 HTML 文件：内联排版样式，可直接用浏览器打开或分享。'
                    : 'PDF 文件：A4 页面、2cm 页边距，随正文内容自动分页。'}
                </p>
              </div>
            )}

            {/* ── File Name ──────────────────────────────────── */}
            <Section icon={<FileText className="h-3.5 w-3.5" />} title="File Name">
              <div className="flex items-center gap-2">
                <input
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  className="flex-1 rounded-md border px-2.5 py-1.5 text-sm outline-none"
                  style={{
                    borderColor: 'var(--line)',
                    backgroundColor: 'var(--paper)',
                    color: 'var(--ink)',
                  }}
                />
                <span
                  className="text-xs font-medium"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  .{format}
                </span>
              </div>
            </Section>

            {/* Error */}
            {error && (
              <div
                className="rounded-md px-3 py-2 text-xs"
                style={{
                  backgroundColor: 'rgba(239,68,68,0.1)',
                  color: '#dc2626',
                }}
              >
                {error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div
            className="flex items-center justify-end gap-2 px-5 py-3.5"
            style={{
              borderTop: '1px solid var(--line)',
              backgroundColor: 'color-mix(in oklab, var(--ink) 1.5%, transparent)',
            }}
          >
            <button
              onClick={onClose}
              disabled={exporting}
              className="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
              style={{ color: 'var(--ink-muted)' }}
              onMouseEnter={(e) => {
                if (!exporting)
                  e.currentTarget.style.backgroundColor =
                    'color-mix(in oklab, var(--ink) 6%, transparent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="rounded-lg px-5 py-1.5 text-sm font-medium flex items-center gap-1.5 transition-opacity disabled:opacity-50"
              style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
            >
              {exporting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {exporting ? 'Exporting...' : 'Export'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
