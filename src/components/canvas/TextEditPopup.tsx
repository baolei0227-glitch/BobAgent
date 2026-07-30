'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Send, Check, Loader2, AlertCircle, ChevronRight, ArrowLeft, Star, MessageSquare, GripHorizontal, Settings, Plus, Minimize2, Maximize2 } from 'lucide-react';
import type { TextPreset } from '@/lib/settings';
import { updateTextPresets } from '@/lib/settings';
import { MermaidRenderer } from './MermaidRenderer';

interface TextEditPopupProps {
  selectedText: string;
  nodeMdId: string;
  onClose: () => void;
  onApplied: () => void;
  position?: { x: number; y: number };
}

const FAVORITES_KEY = 'text-edit-favorites';
const POPUP_MIN_WIDTH = 400;

/** 根据名称查找叶子预设 */
function findLeafPreset(presets: TextPreset[], name: string): TextPreset | null {
  for (const p of presets) {
    if (p.children && p.children.length > 0) {
      const found = p.children.find(c => c.name === name);
      if (found) return found;
    } else if (p.name === name) {
      return p;
    }
  }
  return null;
}

/** 将位置 clamp 到视口内 */
function clampToViewport(x: number, y: number, width: number, height: number) {
  const pad = 16;
  return {
    x: Math.min(Math.max(x, pad), window.innerWidth - width - pad),
    y: Math.min(Math.max(y, pad), window.innerHeight - height - pad),
  };
}

export function TextEditPopup({ selectedText, nodeMdId, onClose, onApplied, position }: TextEditPopupProps) {
  const [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState('');
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [presets, setPresets] = useState<TextPreset[]>([]);
  const [showPresets, setShowPresets] = useState(false);
  const [presetQuery, setPresetQuery] = useState('');
  const [presetIndex, setPresetIndex] = useState(0);
  const [presetLevel, setPresetLevel] = useState<'root' | 'children'>('root');
  const [parentPreset, setParentPreset] = useState<TextPreset | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const [favoriteNames, setFavoriteNames] = useState<string[]>([]);
  const [isAnnotationMode, setIsAnnotationMode] = useState(false);
  const [annotationNote, setAnnotationNote] = useState('');
  const [multiHint, setMultiHint] = useState<{ count: number; originalContent: string; replacement: string } | null>(null);
  const [selectedPresetPrompt, setSelectedPresetPrompt] = useState<string | null>(null);
  const [showPresetEditor, setShowPresetEditor] = useState(false);
  const [editorPresets, setEditorPresets] = useState<TextPreset[]>([]);
  const [presetsSaving, setPresetsSaving] = useState(false);

  // 最小化状态：只显示标题栏
  const [minimized, setMinimized] = useState(false);

  // 拖拽定位 + 视口限制
  const defaultX = position?.x ?? Math.max(0, (window.innerWidth - POPUP_MIN_WIDTH) / 2);
  const defaultY = position?.y ?? Math.max(0, (window.innerHeight - 500) / 2);
  const [popupPos, setPopupPos] = useState({ x: defaultX, y: defaultY });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });

  const countOccurrences = useCallback((content: string, target: string): number => {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = content.match(new RegExp(escaped, 'g'));
    return matches ? matches.length : 0;
  }, []);

  // 初始化：聚焦、加载预设/收藏、视口限制初始位置
  useEffect(() => {
    inputRef.current?.focus();
    fetch('/api/text/presets')
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setPresets(d.presets);
          setEditorPresets(d.presets);
        }
      })
      .catch(() => {});
    try {
      const stored = localStorage.getItem(FAVORITES_KEY);
      if (stored) setFavoriteNames(JSON.parse(stored));
    } catch {}
  }, []);

  // Esc 关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showPresetEditor) {
          setShowPresetEditor(false);
          return;
        }
        if (showPresets) {
          setShowPresets(false);
          return;
        }
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, showPresetEditor, showPresets]);

  // 点击外部关闭预设菜单
  useEffect(() => {
    if (!showPresets) return;
    const handleClick = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setShowPresets(false);
      }
    };
    // delay to avoid firing on the same click that opened it
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [showPresets]);

  // 保存收藏
  const saveFavorites = useCallback((names: string[]) => {
    setFavoriteNames(names);
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(names)); } catch {}
  }, []);

  const toggleFavorite = useCallback((name: string) => {
    setFavoriteNames(prev => {
      const next = prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name];
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // 保存预设到服务端
  const handleSavePresets = useCallback(async () => {
    setPresetsSaving(true);
    try {
      const valid = editorPresets.filter(p => {
        const hasName = p.name.trim();
        const hasPrompt = p.prompt.trim();
        const hasChildren = p.children && p.children.length > 0;
        return hasName && (hasPrompt || hasChildren);
      });
      await updateTextPresets(valid);
      // 同步到下拉列表和编辑器
      setPresets(valid);
      setEditorPresets(valid);
    } catch (e) {
      console.error('保存预设失败:', e);
    } finally {
      setPresetsSaving(false);
    }
  }, [editorPresets]);

  // 获取收藏的预设对象
  const favoritePresets = favoriteNames
    .map(name => findLeafPreset(presets, name))
    .filter(Boolean) as TextPreset[];

  // 点击常用便签，填入输入框并设置预设（不自动执行）
  const applyFavoritePreset = useCallback((preset: TextPreset) => {
    if (isAnnotationMode) return;
    const prefix = `/${preset.name} `;
    setInstruction(prev => {
      // 如果输入框为空或以 / 开头，替换；否则追加
      if (!prev.trim() || prev.startsWith('/')) return prefix;
      return prev + ' ' + prefix;
    });
    setSelectedPresetPrompt(preset.prompt);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [isAnnotationMode]);

  useEffect(() => {
    // 检测 / 触发预设菜单
    const val = instruction;
    const lastSlash = val.lastIndexOf('/');
    if (lastSlash >= 0) {
      const afterSlash = val.slice(lastSlash + 1);
      const before = val.slice(0, lastSlash);
      if (before === '' || before.endsWith(' ') || before.endsWith('\n')) {
        setShowPresets(true);
        setPresetQuery(afterSlash.toLowerCase());
        setPresetLevel('root');
        setParentPreset(null);
        return;
      }
    }
    setShowPresets(false);
    setPresetLevel('root');
    setParentPreset(null);
  }, [instruction]);

  // 当前显示的预设列表（根据层级变化）
  const currentPresets = presetLevel === 'children' && parentPreset
    ? (parentPreset.children || [])
    : presets.filter(p => !p.name || !presets.some(other => other.children?.some(c => c.name === p.name)));

  // 过滤匹配的预设
  const filteredPresets = presetQuery
    ? currentPresets.filter(p => p.name.toLowerCase().includes(presetQuery))
    : currentPresets;

  useEffect(() => {
    if (presetIndex >= filteredPresets.length) {
      setPresetIndex(0);
    }
  }, [filteredPresets.length, presetIndex]);

  const goToChildren = useCallback((preset: TextPreset) => {
    setParentPreset(preset);
    setPresetLevel('children');
    setPresetIndex(0);
    setPresetQuery('');
  }, []);

  const goBackToRoot = useCallback(() => {
    setPresetLevel('root');
    setParentPreset(null);
    setPresetIndex(0);
    setPresetQuery('');
  }, []);

  const applyLeafPreset = useCallback((preset: TextPreset) => {
    const val = instruction;
    const lastSlash = val.lastIndexOf('/');
    const displayName = parentPreset ? `${parentPreset.name} > ${preset.name}` : preset.name;
    // 填入预设名 + 空格，不自动执行，允许用户继续输入加工文字
    const newInstruction = val.slice(0, lastSlash) + displayName + ' ';
    setInstruction(newInstruction);
    setShowPresets(false);
    setPresetLevel('root');
    setParentPreset(null);
    setSelectedPresetPrompt(preset.prompt);
    // 保持焦点在输入框，光标移到末尾
    setTimeout(() => {
      inputRef.current?.focus();
      if (inputRef.current) {
        inputRef.current.selectionStart = inputRef.current.value.length;
        inputRef.current.selectionEnd = inputRef.current.value.length;
      }
    }, 50);
  }, [instruction, parentPreset]);

  const applyPreset = useCallback((preset: TextPreset) => {
    if (preset.children && preset.children.length > 0) {
      goToChildren(preset);
    } else {
      applyLeafPreset(preset);
    }
  }, [goToChildren, applyLeafPreset]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showPresets && filteredPresets.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPresetIndex(i => (i + 1) % filteredPresets.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPresetIndex(i => (i - 1 + filteredPresets.length) % filteredPresets.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyPreset(filteredPresets[presetIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (presetLevel === 'children') {
          goBackToRoot();
        } else {
          setShowPresets(false);
        }
        return;
      }
    }

    // Cmd/Ctrl+Enter: AI 编辑（有指令时）
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (instruction.trim()) {
        handleEdit(instruction.trim(), selectedPresetPrompt || undefined);
        setSelectedPresetPrompt(null);
      }
      return;
    }

    // Enter: 有预览 → 迭代修改；有预设 → AI 编辑；无预设 → 直接替换
    if (e.key === 'Enter' && !showPresets) {
      e.preventDefault();
      if (instruction.trim()) {
        if (preview) {
          // 已有预览，对预览提修改意见
          handleEdit(instruction.trim());
        } else if (selectedPresetPrompt) {
          handleEdit(instruction.trim(), selectedPresetPrompt);
          setSelectedPresetPrompt(null);
        } else {
          handleDirectReplace(instruction);
        }
      }
    }
  };

  // 直接替换选中文字（无 AI）
  const handleDirectReplace = async (replacement: string) => {
    if (!replacement) return;
    setError('');
    setMultiHint(null);

    try {
      const rawResp = await fetch(`/api/nodes?id=${nodeMdId}&action=raw`);
      const rawData = await rawResp.json();
      if (!rawData.success || !rawData.content) {
        setError('Failed to read document');
        return;
      }

      const cnt = countOccurrences(rawData.content, selectedText);
      if (cnt > 1) {
        // 默认只修改选中处，提示可全选
        await doReplace(rawData.content, replacement, false, true);
        setMultiHint({ count: cnt, originalContent: rawData.content, replacement });
        return;
      }

      await doReplace(rawData.content, replacement, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save error');
    }
  };

  /** 执行实际替换（single = 仅第一处，否则全部） */
  const doReplace = async (originalContent: string, replacement: string, replaceAll: boolean, keepOpen = false) => {
    setApplying(true);
    try {
      const escaped = selectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = replaceAll ? 'g' : '';
      const updatedContent = originalContent.replace(new RegExp(escaped, flags), replacement);

      if (updatedContent === originalContent) {
        setError('Failed to match original text');
        setApplying(false);
        return;
      }

      const saveResp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_content', node_id: nodeMdId, content: updatedContent }),
      });

      const saveData = await saveResp.json();
      if (saveData.success) {
        onApplied();
        if (!keepOpen) onClose();
        return true;
      } else {
        setError(saveData.error || 'Save failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save error');
    } finally {
      setApplying(false);
    }
    return false;
  };

  // AI 编辑
  const handleEdit = async (userInstruction: string, presetPrompt?: string) => {
    if (!userInstruction.trim()) return;
    const isRefine = !!preview;
    if (isRefine) {
      setRefining(true);
      setInstruction(''); // 清空修改意见输入框
    } else {
      setLoading(true);
    }
    setError('');

    try {
      const body: Record<string, string> = {
        selected_text: selectedText,
        instruction: userInstruction.trim(),
      };
      if (presetPrompt) {
        body.preset_prompt = presetPrompt;
      }
      if (preview) {
        body.current_result = preview;
      }

      const resp = await fetch('/api/text/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.success) {
        setPreview(data.edited_text);
      } else {
        setError(data.error || 'Edit failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
      setRefining(false);
    }
  };

  const handleApplyEdit = async () => {
    if (!preview) return;
    setError('');
    setMultiHint(null);

    try {
      const rawResp = await fetch(`/api/nodes?id=${nodeMdId}&action=raw`);
      const rawData = await rawResp.json();
      if (!rawData.success || !rawData.content) {
        setError('Failed to read document');
        return;
      }

      const cnt = countOccurrences(rawData.content, selectedText);
      if (cnt > 1) {
        // 默认只修改选中处，提示可全选
        await doReplace(rawData.content, preview, false, true);
        setMultiHint({ count: cnt, originalContent: rawData.content, replacement: preview });
        return;
      }

      await doReplace(rawData.content, preview, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save error');
    }
  };

  // 批注：将选中文字包裹为标注标签并保存
  const handleApplyAnnotation = async (note: string) => {
    if (!note) return;
    setApplying(true);
    setError('');

    try {
      const rawResp = await fetch(`/api/nodes?id=${nodeMdId}&action=raw`);
      const rawData = await rawResp.json();
      if (!rawData.success || !rawData.content) {
        setError('Failed to read document');
        setApplying(false);
        return;
      }

      const escapedNote = note
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const annotated = `<mark class="annotation" data-note="${escapedNote}">${selectedText}</mark>`;
      const updatedContent = rawData.content.replace(selectedText, annotated);

      if (updatedContent === rawData.content) {
        setError('Failed to match original text');
        setApplying(false);
        return;
      }

      const saveResp = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_content', node_id: nodeMdId, content: updatedContent }),
      });

      const saveData = await saveResp.json();
      if (saveData.success) {
        onApplied();
        onClose();
      } else {
        setError(saveData.error || 'Save failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save error');
    } finally {
      setApplying(false);
    }
  };

  // 拖拽处理
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, px: popupPos.x, py: popupPos.y };
  }, [popupPos]);

  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPopupPos({ x: dragStart.current.px + dx, y: dragStart.current.py + dy });
    };
    const handleMouseUp = () => {
      setDragging(false);
      // 拖拽结束后 clamp 到视口内
      setPopupPos(prev => {
        const el = popupRef.current;
        if (!el) return prev;
        const rect = el.getBoundingClientRect();
        return clampToViewport(prev.x, prev.y, rect.width, rect.height);
      });
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={popupRef}
      className="text-edit-popup fixed z-[9999]"
      style={{
        left: popupPos.x,
        top: popupPos.y,
      }}
    >
      <div
        className="flex max-h-[80vh] flex-col rounded-xl shadow-2xl transition-all duration-200"
        style={{
          width: preview ? '560px' : POPUP_MIN_WIDTH,
          backgroundColor: '#faf8f3',
          border: '1px solid oklch(0.80 0.03 60 / 0.4)',
          fontFamily: "'Noto Serif SC', serif",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header - 可拖拽 */}
        <div
          className="flex shrink-0 items-center gap-1.5 px-3 py-2 cursor-grab active:cursor-grabbing select-none"
          style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}
          onMouseDown={handleDragStart}
        >
          <GripHorizontal className="h-3.5 w-3.5 shrink-0" style={{ color: '#b0a890' }} />
          <span className="text-[12px] font-semibold shrink-0" style={{ color: '#2c2416' }}>
            文本编辑
          </span>

          {/* 收藏预设 — 移到标题栏 */}
          <div className="flex items-center gap-1 flex-1 overflow-hidden">
            {favoritePresets.map(p => (
              <button
                key={p.name}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isAnnotationMode) return;
                  applyFavoritePreset(p);
                }}
                className="inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors shrink-0"
                style={{
                  backgroundColor: 'oklch(0.97 0.02 95)',
                  borderColor: 'oklch(0.88 0.03 85 / 0.5)',
                  color: 'oklch(0.40 0.02 50)',
                }}
                title={p.prompt}
              >
                <Star className="h-2.5 w-2.5 shrink-0" style={{ color: '#d4a017', fill: '#d4a017' }} />
                {p.name}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowPresetEditor(!showPresetEditor)}
            className="rounded-md p-1 transition-colors hover:bg-[rgba(0,0,0,0.04)] cursor-pointer shrink-0"
            style={{ color: showPresetEditor ? 'oklch(0.50 0.12 180)' : '#7a7260' }}
            title="提示词设置"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            onClick={() => setMinimized(!minimized)}
            className="rounded-md p-1 transition-colors hover:bg-[rgba(0,0,0,0.04)] cursor-pointer shrink-0"
            style={{ color: '#7a7260' }}
            title={minimized ? '展开' : '最小化'}
          >
            {minimized ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1 transition-colors hover:bg-[rgba(0,0,0,0.04)] cursor-pointer shrink-0"
            style={{ color: '#7a7260' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!minimized && (
          <>
        {/* 预设编辑器面板 */}
        {showPresetEditor && (
          <div
            className="shrink-0 px-4 py-3 space-y-2 overflow-y-auto ai-canvas-scroll"
            style={{ borderBottom: '1px solid rgba(0,0,0,0.06)', maxHeight: '240px', backgroundColor: 'oklch(0.97 0.008 80)' }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold" style={{ color: 'oklch(0.50 0.12 180)' }}>
                提示词预设
              </span>
              <button
                onClick={handleSavePresets}
                disabled={presetsSaving}
                className="rounded-md px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
                style={{ backgroundColor: 'oklch(0.50 0.12 180)', color: 'white' }}
              >
                {presetsSaving ? '保存中...' : '保存'}
              </button>
            </div>
            {editorPresets.map((preset, index) => {
              const hasChildren = preset.children && preset.children.length > 0;
              return (
              <div
                key={index}
                className="flex items-center gap-2 rounded-lg border px-3 py-2 group"
                style={{
                  borderColor: hasChildren ? 'oklch(0.50 0.12 180 / 0.3)' : 'oklch(0.88 0.01 70)',
                  backgroundColor: hasChildren ? 'oklch(0.50 0.12 180 / 0.03)' : 'oklch(0.97 0.008 80)',
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <input
                      value={preset.name}
                      onChange={(e) => {
                        const updated = [...editorPresets];
                        updated[index] = { ...updated[index], name: e.target.value };
                        setEditorPresets(updated);
                      }}
                      placeholder="名称（如：精简）"
                      className="flex-1 text-xs font-medium bg-transparent outline-none"
                      style={{ color: 'oklch(0.30 0.015 50)' }}
                    />
                    {hasChildren && (
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium"
                        style={{ backgroundColor: 'oklch(0.50 0.12 180 / 0.12)', color: 'oklch(0.50 0.12 180)' }}
                      >
                        {preset.children!.length} 子项
                      </span>
                    )}
                  </div>
                  <input
                    value={preset.prompt}
                    onChange={(e) => {
                      const updated = [...editorPresets];
                      updated[index] = { ...updated[index], prompt: e.target.value };
                      setEditorPresets(updated);
                    }}
                    placeholder={hasChildren ? '（分组，无需填写提示词）' : '提示词内容（如：删除冗余表述...）'}
                    className="w-full text-[10px] bg-transparent outline-none mt-0.5"
                    style={{ color: hasChildren ? 'oklch(0.50 0.12 180)' : 'oklch(0.50 0.02 50)' }}
                  />
                </div>
                <button
                  onClick={() => {
                    setEditorPresets(editorPresets.filter((_, i) => i !== index));
                  }}
                  className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[oklch(0.90_0.02_80)]"
                  style={{ color: 'oklch(0.55 0.18 35)' }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
            <button
              onClick={() => {
                setEditorPresets([...editorPresets, { name: '', prompt: '' }]);
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border py-2 text-xs transition-colors hover:bg-[oklch(0.95_0.01_80)]"
              style={{ borderColor: 'oklch(0.88 0.01 70)', borderStyle: 'dashed', color: 'oklch(0.50 0.12 180)' }}
            >
              <Plus className="h-3 w-3" />
              Add Preset
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 ai-canvas-scroll">
          {/* 标签栏：批注标签 */}
          <div className="flex flex-wrap items-center gap-1">
            {/* 批注标签 */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsAnnotationMode(!isAnnotationMode);
                setError('');
                setPreview('');
                if (!isAnnotationMode) {
                  setTimeout(() => inputRef.current?.focus(), 50);
                }
              }}
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                isAnnotationMode
                  ? 'border-[oklch(0.50_0.12_220_/_0.4)] bg-[oklch(0.50_0.12_220_/_0.08)] text-[oklch(0.50_0.12_220)]'
                  : 'border-[oklch(0.88_0.03_85_/_0.5)] bg-[oklch(0.97_0.02_95)] text-[oklch(0.40_0.02_50)] hover:border-[oklch(0.55_0.15_220_/_0.3)]'
              }`}
              title="批注模式"
            >
              <MessageSquare className="h-3 w-3" />
              批注
            </button>
          </div>

          {/* 输入区 + 预览（左右分栏） */}
          {preview ? (
            <div className="flex gap-3" style={{ maxHeight: '320px' }}>
              {/* 预览 - 左侧 */}
              <div className="flex-1 flex flex-col min-w-0" style={{ flex: '1 1 55%' }}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#537D96' }}>
                    预览
                  </span>
                  {(loading || refining) && (
                    <span className="text-[10px]" style={{ color: '#537D96' }}>
                      {refining ? '正在修改...' : 'AI 正在生成...'}
                    </span>
                  )}
                </div>
                <div
                  className="flex-1 overflow-y-auto rounded-lg border p-3 text-[12px] leading-relaxed ai-canvas-scroll"
                  style={{
                    backgroundColor: loading ? '#ffffff' : 'oklch(0.55 0.15 45 / 0.04)',
                    borderColor: 'oklch(0.55 0.15 45 / 0.15)',
                    color: '#4a4232',
                    minHeight: '120px',
                  }}
                >
                  {loading && !refining ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin" style={{ color: '#537D96' }} />
                    </div>
                  ) : (
                    <MermaidRenderer content={preview} />
                  )}
                </div>
              </div>

              {/* 修改意见 - 右侧 */}
              <div className="flex flex-col" style={{ flex: '1 1 45%' }}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: '#8a8270' }}>
                    修改意见
                  </span>
                </div>
                <textarea
                  ref={inputRef}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入修改意见，Enter 迭代..."
                  rows={4}
                  className="flex-1 w-full resize-none rounded-lg border px-3 py-2 text-[12px] outline-none transition-colors"
                  style={{
                    backgroundColor: '#ffffff',
                    borderColor: 'rgba(0,0,0,0.1)',
                    color: '#2c2416',
                    fontFamily: "'Noto Serif SC', serif",
                    minHeight: '120px',
                  }}
                />
              </div>
            </div>
          ) : (
            /* 无预览：完整宽度输入框 */
            <div className="relative">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: isAnnotationMode ? 'oklch(0.50 0.12 220)' : '#8a8270' }}>
                  {isAnnotationMode ? '输入批注内容' : '输入文字直接替换 / 键入 / 选预设'}
                </span>
                {selectedPresetPrompt && !isAnnotationMode && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{ backgroundColor: 'oklch(0.62 0.17 45 / 0.12)', color: 'oklch(0.50 0.12 45)' }}
                  >
                    <Send className="h-2.5 w-2.5" />
                    已选预设
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedPresetPrompt(null);
                      }}
                      className="ml-0.5 rounded-full hover:bg-[oklch(0.62_0.17_45_/_0.2)]"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                )}
              </div>
              <textarea
                ref={inputRef}
                value={isAnnotationMode ? annotationNote : instruction}
                onChange={(e) => {
                  if (isAnnotationMode) {
                    setAnnotationNote(e.target.value);
                  } else {
                    setInstruction(e.target.value);
                  }
                }}
                onKeyDown={(e) => {
                  if (isAnnotationMode) {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      if (annotationNote.trim()) {
                        handleApplyAnnotation(annotationNote.trim());
                      }
                    }
                  } else {
                    handleKeyDown(e);
                  }
                }}
                placeholder={isAnnotationMode ? '输入批注内容，Cmd+Enter 保存...' : '输入文字直接替换选中内容，或输入 / 选择预设提示词...'}
                rows={isAnnotationMode ? 2 : 3}
                className="w-full resize-none rounded-lg border px-3 py-2 text-[12px] outline-none transition-colors"
                style={{
                  backgroundColor: '#ffffff',
                  borderColor: isAnnotationMode ? 'oklch(0.55 0.15 220 / 0.3)' : 'rgba(0,0,0,0.1)',
                  color: '#2c2416',
                  fontFamily: "'Noto Serif SC', serif",
                }}
              />

            {/* 预设下拉菜单（仅编辑模式） */}
            {!isAnnotationMode && showPresets && (
              <div
                className="absolute left-0 right-0 z-10 rounded-lg border py-1 shadow-lg"
                style={{
                  bottom: '100%',
                  marginBottom: '4px',
                  backgroundColor: '#fff',
                  borderColor: 'oklch(0.80 0.03 60 / 0.4)',
                  maxHeight: '360px',
                  overflowY: 'auto',
                }}
              >
                {presetLevel === 'children' && parentPreset && (
                  <button
                    onClick={goBackToRoot}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                    style={{ color: '#8a8270', borderBottom: '1px solid rgba(0,0,0,0.05)' }}
                  >
                    <ArrowLeft className="h-3 w-3" />
                    <span className="font-medium">{parentPreset.name}</span>
                    <span className="text-[10px]" style={{ color: '#b0a890' }}>— 返回上级</span>
                  </button>
                )}

                {filteredPresets.length === 0 ? (
                  <div className="px-3 py-2 text-[11px]" style={{ color: '#8a8270' }}>
                    无匹配的预设
                  </div>
                ) : (
                  filteredPresets.map((p, i) => {
                    const hasChildren = p.children && p.children.length > 0;
                    const isFav = !hasChildren && favoriteNames.includes(p.name);
                    return (
                      <div
                        key={p.name}
                        className="flex items-center"
                        style={{
                          backgroundColor: i === presetIndex ? 'oklch(0.95_0.01_80)' : 'transparent',
                        }}
                      >
                        <button
                          onClick={() => applyPreset(p)}
                          className="flex flex-1 items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                          style={{ color: '#2c2416' }}
                        >
                          {hasChildren ? (
                            <span className="inline-flex items-center justify-center h-4 w-4 shrink-0 rounded text-[9px] font-bold"
                              style={{ backgroundColor: 'oklch(0.50 0.12 180 / 0.12)', color: 'oklch(0.50 0.12 180)' }}
                            >+</span>
                          ) : (
                            <ChevronRight className="h-3 w-3 shrink-0" style={{ color: 'oklch(0.62 0.17 45)' }} />
                          )}
                          <span className="font-medium">/{p.name}</span>
                          {hasChildren ? (
                            <span className="text-[10px]" style={{ color: '#8a8270' }}>
                              — {p.children!.length} 个子项
                            </span>
                          ) : (
                            <span className="truncate text-[10px]" style={{ color: '#8a8270' }}>
                              — {p.prompt.slice(0, 40)}...
                            </span>
                          )}
                        </button>
                        {/* 收藏按钮（叶子预设才有） */}
                        {!hasChildren && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFavorite(p.name);
                            }}
                            className="shrink-0 px-2 py-2 transition-colors hover:bg-[oklch(0.95_0.01_80)]"
                            title={isFav ? '取消收藏' : '收藏为常用'}
                          >
                            <Star
                              className="h-3 w-3"
                              style={{
                                color: isFav ? '#d4a017' : 'oklch(0.65 0.02 60)',
                                fill: isFav ? '#d4a017' : 'none',
                              }}
                            />
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
          )}

          {/* 错误 */}
          {error && (
            <div
              className="flex items-start gap-2 rounded-lg border p-3 text-[12px]"
              style={{ borderColor: 'oklch(0.55 0.18 27 / 0.2)', backgroundColor: 'oklch(0.55 0.18 27 / 0.05)', color: '#a04030' }}
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
        </div>

        {/* 多处相同文字提示 */}
        {multiHint && (
          <div
            className="shrink-0 px-4 py-2 flex items-center justify-between gap-3"
            style={{ borderTop: '1px solid oklch(0.55 0.15 45 / 0.15)', backgroundColor: 'oklch(0.62 0.17 45 / 0.03)' }}
          >
            <span className="text-[11px]" style={{ color: '#8a8270' }}>
              已修改选中处，文中还有 <b style={{ color: '#5c5342' }}>{multiHint.count - 1}</b> 处相同文字
            </span>
            <button
              onClick={async () => {
                setMultiHint(null);
                await doReplace(multiHint.originalContent, multiHint.replacement, true);
              }}
              disabled={applying}
              className="rounded-md px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 hover:opacity-90"
              style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
            >
              {applying ? '修改中...' : `修改全部(${multiHint.count}处)`}
            </button>
          </div>
        )}

        {/* Footer */}
        {(preview || instruction.trim() || annotationNote.trim()) && (
          <div
            className="flex shrink-0 items-center justify-between gap-2 px-3 py-2"
            style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}
          >
            <button
              onClick={onClose}
              className="rounded-md px-2.5 py-1 text-[11px] transition-colors hover:bg-[rgba(0,0,0,0.04)]"
              style={{ color: '#8a8270' }}
            >
              关闭
            </button>

            <div className="flex items-center gap-1.5">
              {/* 批注模式 */}
              {isAnnotationMode && annotationNote.trim() && (
                <button
                  onClick={() => handleApplyAnnotation(annotationNote.trim())}
                  disabled={applying}
                  className="inline-flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                  style={{ backgroundColor: 'oklch(0.50 0.12 220)', color: 'white' }}
                >
                  {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
                  保存批注
                </button>
              )}

              {/* 编辑模式 */}
              {!isAnnotationMode && (
                <>
                  {/* 预览 / 修改 */}
                  {instruction.trim() && !showPresets && (
                    <button
                      onClick={() => {
                        const prompt = preview ? undefined : (selectedPresetPrompt || undefined);
                        handleEdit(instruction.trim(), prompt);
                        if (selectedPresetPrompt) setSelectedPresetPrompt(null);
                      }}
                      disabled={loading || refining}
                      className="inline-flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                      style={{ backgroundColor: 'oklch(0.62 0.17 45)', color: 'white' }}
                    >
                      {loading ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : refining ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : preview ? (
                        <Send className="h-3 w-3" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      {loading ? '生成中...' : refining ? '修改中...' : preview ? '修改' : '预览'}
                    </button>
                  )}

                  {/* 执行 */}
                  {instruction.trim() && !showPresets && (
                    <button
                      onClick={() => {
                        if (preview) {
                          handleApplyEdit();
                        } else {
                          handleDirectReplace(instruction.trim());
                        }
                      }}
                      disabled={applying}
                      className="inline-flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                      style={{ backgroundColor: preview ? '#27ae60' : 'oklch(0.50 0.02 50)', color: 'white' }}
                    >
                      {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      {applying ? '执行中...' : '执行'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
