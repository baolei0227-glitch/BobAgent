'use client';

/**
 * ImageGen History Modal — 版本历史弹窗
 *
 *  通过 Portal 挂在 document.body，覆盖在画布之上。
 *  功能：
 *   · 缩略图网格展示原始图（如有）+ 所有版本（最新在右）
 *   · 键盘 ← → 导航，Enter = 选中预览，Escape = 关闭
 *   · 单击缩略图 = 切换到该版本（节点主预览区展示）
 *   · Compare 模式：点 Compare 按钮 → 选两张图 → 自动启动滑块对比
 *   · Pin / Delete 每个版本（原始图不可 Pin/Delete）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Pin, PinOff, Trash, GitCompareArrows, Check, ArrowLeft, ArrowRight, Paperclip, ImageIcon, Layers } from 'lucide-react';
import type { ImageGenVersion, TriplotGroup } from '@/lib/types';
import type { ImageGenApiRef, AttachmentImage } from './viewers/ImageAiEditor';
import type { MutableRefObject } from 'react';

/** 展示项：原始图或版本 */
type DisplayItem = ImageGenVersion & { isOriginal?: boolean; displayLabel: string };

export interface ImageGenHistoryModalProps {
  versions: ImageGenVersion[];
  /** 原始图 dataUrl（首次生成时捕获的输入图） */
  originalImage?: string;
  currentImage?: string;
  editorRef: MutableRefObject<ImageGenApiRef | null>;
  onSelect: (v: ImageGenVersion) => void;
  onTogglePin: (vId: string) => void;
  onDelete: (vId: string) => void;
  onClose: () => void;
  /** 附件图片（只读展示，标注附件图标与版本图区分） */
  attachments?: AttachmentImage[];
  /** 三视图版本组 */
  triplotGroups?: TriplotGroup[];
  /** 激活的三视图组 id */
  triplotActiveGroupId?: string;
  /** 激活的三视图视角 */
  triplotActiveView?: 'front' | 'side' | 'top';
  /** 切换三视图视角 */
  onTriplotViewSwitch?: (groupId: string, view: 'front' | 'side' | 'top') => void;
  /** 删除整个三视图组（同时删3张磁盘文件） */
  onTriplotGroupDelete?: (groupId: string) => void;
  /** 嵌入式（画布节点）模式：去掉全屏遮罩与 portal，面板占满父容器（由 Album 节点控制尺寸）。
   *  样式与操作逻辑与弹窗完全一致。 */
  embedded?: boolean;
}

export function ImageGenHistoryModal({
  versions,
  originalImage,
  currentImage,
  editorRef,
  onSelect,
  onTogglePin,
  onDelete,
  onClose,
  attachments = [],
  triplotGroups = [],
  triplotActiveGroupId,
  triplotActiveView = 'front',
  onTriplotViewSwitch,
  onTriplotGroupDelete,
  embedded = false,
}: ImageGenHistoryModalProps) {
  const [focusIdx, setFocusIdx] = useState(0);
  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // 构建展示列表：原始图（如有）在前，版本在后
  const displayItems = useMemo<DisplayItem[]>(() => {
    const items: DisplayItem[] = [];
    if (originalImage) {
      items.push({
        id: '__original__',
        dataUrl: originalImage,
        timestamp: 0,
        prompt: '',
        pinned: false,
        isOriginal: true,
        displayLabel: 'ORIGINAL',
      });
    }
    versions.forEach((v, i) => {
      items.push({ ...v, displayLabel: `v${i + 1}` });
    });
    return items;
  }, [originalImage, versions]);

  // 初始聚焦当前版本
  useEffect(() => {
    const idx = displayItems.findIndex((v) => v.dataUrl === currentImage);
    setFocusIdx(idx >= 0 ? idx : displayItems.length - 1);
  }, [displayItems, currentImage]);

  const focusVersion = useMemo(() => displayItems[focusIdx], [displayItems, focusIdx]);

  // 键盘导航
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (compareMode) {
        setCompareMode(false);
        setCompareA(null);
      } else {
        onClose();
      }
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      setFocusIdx((i) => Math.max(0, i - 1));
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      setFocusIdx((i) => Math.min(displayItems.length - 1, i + 1));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (focusVersion) {
        if (compareMode) {
          if (!compareA) {
            setCompareA(focusVersion.dataUrl);
          } else if (compareA !== focusVersion.dataUrl) {
            editorRef.current?.startCompare(compareA, focusVersion.dataUrl);
            setCompareMode(false);
            setCompareA(null);
            onClose();
          }
        } else {
          onSelect(focusVersion);
        }
      }
      e.preventDefault();
    } else if (e.key === 'c' || e.key === 'C') {
      setCompareMode((m) => !m);
      setCompareA(null);
      e.preventDefault();
    }
  }, [compareMode, compareA, focusVersion, onClose, onSelect, editorRef, displayItems.length]);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  // 点击缩略图
  const handleClick = useCallback((v: DisplayItem, idx: number) => {
    setFocusIdx(idx);
    if (compareMode) {
      if (!compareA) {
        setCompareA(v.dataUrl);
      } else if (compareA === v.dataUrl) {
        // 取消选择
        setCompareA(null);
      } else {
        // 两张都选好了 → 启动对比
        editorRef.current?.startCompare(compareA, v.dataUrl);
        setCompareMode(false);
        setCompareA(null);
        onClose();
      }
    } else {
      onSelect(v);
    }
  }, [compareMode, compareA, editorRef, onSelect, onClose]);

  const portal = typeof document !== 'undefined' ? document.body : null;

  // ── 面板内容：弹窗与嵌入式（画布节点）共用同一套样式与操作逻辑 ──
  const panelBody = (
    <>
        {/* ── 标题栏 ── */}
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: 'rgba(255,255,255,0.08)' }}
        >
          <span className="text-sm font-semibold" style={{ color: '#fff' }}>
            Version Album
          </span>
          <span className="text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>
            {originalImage
              ? `1 original + ${versions.length} versions`
              : `${versions.length} versions`}
            {triplotGroups.length > 0 && ` · ${triplotGroups.length} triplot group(s)`}
          </span>
          <div className="flex-1" />

          {/* Compare 按钮 */}
          <button
            type="button"
            onClick={() => { setCompareMode((m) => !m); setCompareA(null); }}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-12 font-medium transition-all"
            style={{
              borderColor: compareMode ? 'rgba(96,84,241,0.5)' : 'rgba(255,255,255,0.12)',
              backgroundColor: compareMode ? 'rgba(96,84,241,0.18)' : 'rgba(255,255,255,0.04)',
              color: compareMode ? '#C7BEFF' : 'rgba(255,255,255,0.7)',
            }}
            title="Compare two versions (C)"
          >
            <GitCompareArrows className="h-3.5 w-3.5" />
            {compareMode ? 'Cancel Compare' : 'Compare'}
          </button>

          {/* 关闭 */}
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.6)' }}
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Compare 模式提示 ── */}
        {compareMode && (
          <div
            className="shrink-0 px-4 py-2 text-12"
            style={{
              backgroundColor: 'rgba(96,84,241,0.08)',
              color: '#C7BEFF',
              borderBottom: '1px solid rgba(96,84,241,0.15)',
            }}
          >
            {compareA
              ? '✓ First image selected. Click another version to start the slider comparison.'
              : 'Select the first image to compare (left side of slider).'}
          </div>
        )}

        {/* ── 缩略图网格 ── */}
        <div
          ref={gridRef}
          className="flex-1 overflow-y-auto p-4"
          style={{ scrollbarWidth: 'thin' }}
        >
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            }}
          >
            {displayItems.map((v, idx) => {
              const isCurrent = currentImage === v.dataUrl;
              const isFocused = idx === focusIdx;
              const isCompareA = compareA === v.dataUrl;
              const isOriginal = !!v.isOriginal;
              return (
                <div
                  key={v.id}
                  className="group relative cursor-pointer overflow-hidden rounded-lg transition-all"
                  style={{
                    border: isCompareA
                      ? '3px solid #6054F1'
                      : isCurrent
                        ? '2px solid #6054F1'
                        : isFocused
                          ? '2px solid rgba(96,84,241,0.4)'
                          : isOriginal
                            ? '2px solid rgba(34,197,94,0.45)'
                            : v.pinned
                              ? '2px solid rgba(245,158,11,0.5)'
                              : '1px solid rgba(255,255,255,0.08)',
                    boxShadow: isCompareA
                      ? '0 0 16px rgba(96,84,241,0.5)'
                      : isCurrent
                        ? '0 0 8px rgba(96,84,241,0.3)'
                        : 'none',
                  }}
                  onClick={() => handleClick(v, idx)}
                >
                  {/* 图片 */}
                  <div className="relative aspect-square overflow-hidden" style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
                    <img
                      src={v.dataUrl}
                      alt={v.displayLabel}
                      className="h-full w-full object-contain"
                    />
                  </div>

                  {/* 版本号 + 时间 */}
                  <div
                    className="flex items-center justify-between px-2 py-1.5"
                    style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
                  >
                    <span className="text-11 font-mono font-bold" style={{ color: isOriginal ? '#86EFAC' : '#C7BEFF' }}>
                      {v.displayLabel}
                    </span>
                    <span className="text-9" style={{ color: 'rgba(255,255,255,0.4)' }}>
                      {isOriginal ? '—' : new Date(v.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  {/* 当前预览标记 */}
                  {isCurrent && (
                    <div
                      className="absolute left-1 top-1 rounded px-1 py-0.5 text-8 font-bold"
                      style={{ backgroundColor: 'rgba(96,84,241,0.85)', color: '#fff' }}
                    >
                      CURRENT
                    </div>
                  )}

                  {/* 原始图标记 */}
                  {isOriginal && !isCurrent && (
                    <div
                      className="absolute left-1 top-1 flex items-center gap-0.5 rounded px-1 py-0.5 text-8 font-bold"
                      style={{ backgroundColor: 'rgba(34,197,94,0.85)', color: '#fff' }}
                    >
                      <ImageIcon className="h-2 w-2" />
                      ORIGINAL
                    </div>
                  )}

                  {/* Compare A 标记 */}
                  {isCompareA && (
                    <div
                      className="absolute right-1 top-1 flex items-center gap-0.5 rounded px-1 py-0.5 text-8 font-bold"
                      style={{ backgroundColor: 'rgba(96,84,241,0.85)', color: '#fff' }}
                    >
                      <Check className="h-2 w-2" /> A
                    </div>
                  )}

                  {/* Pinned 标记（仅非原始图） */}
                  {!isOriginal && v.pinned && (
                    <div
                      className="absolute right-1 top-1 flex items-center justify-center"
                      style={{
                        width: 16, height: 16,
                        backgroundColor: 'rgba(245,158,11,0.85)',
                        borderRadius: '50%',
                        marginTop: isCompareA ? '18px' : '0',
                      }}
                    >
                      <Pin className="h-2 w-2" style={{ color: '#fff' }} />
                    </div>
                  )}

                  {/* Prompt 预览（hover 时，仅非原始图） */}
                  {!isOriginal && (
                    <div
                      className="absolute inset-x-0 bottom-0 translate-y-full transition-transform group-hover:translate-y-0"
                      style={{
                        backgroundColor: 'rgba(0,0,0,0.88)',
                        padding: '6px 8px',
                        maxHeight: '60px',
                        overflow: 'hidden',
                      }}
                    >
                      <p className="text-10 leading-snug" style={{ color: 'rgba(255,255,255,0.7)' }}>
                        {v.prompt.slice(0, 120) || '(no prompt)'}
                      </p>
                    </div>
                  )}

                  {/* hover 操作按钮（仅非原始图） */}
                  {!isOriginal && (
                    <div
                      className="absolute right-1 flex gap-1 transition-opacity"
                      style={{
                        top: isCompareA || v.pinned ? '36px' : '4px',
                        opacity: 0,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0'; }}
                    >
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onTogglePin(v.id); }}
                        className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-white/20"
                        title={v.pinned ? 'Unpin' : 'Pin'}
                        style={{
                          backgroundColor: 'rgba(0,0,0,0.6)',
                          color: v.pinned ? '#FCD34D' : '#fff',
                        }}
                      >
                        {v.pinned ? <PinOff className="h-2.5 w-2.5" /> : <Pin className="h-2.5 w-2.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onDelete(v.id); }}
                        className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-red-500/70"
                        title="Delete"
                        style={{ backgroundColor: 'rgba(0,0,0,0.6)', color: '#fff' }}
                      >
                        <Trash className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── 三视图 TriplotGroups 区 ── */}
          {triplotGroups.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 flex items-center gap-1.5 text-11 font-semibold" style={{ color: 'rgba(255,255,255,0.55)' }}>
                <Layers className="h-3 w-3" style={{ color: '#C7BEFF' }} />
                Triplot Groups ({triplotGroups.length})
                <span className="ml-1 text-9" style={{ color: 'rgba(255,255,255,0.3)' }}>
                  · click a view to preview, delete removes all 3 files
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {triplotGroups.map((group, gIdx) => {
                  const isActiveGroup = triplotActiveGroupId === group.id;
                  return (
                    <div
                      key={group.id}
                      className="relative rounded-xl p-2.5 transition-all"
                      style={{
                        border: isActiveGroup
                          ? '1.5px solid rgba(96,84,241,0.55)'
                          : '1px solid rgba(255,255,255,0.08)',
                        backgroundColor: isActiveGroup
                          ? 'rgba(96,84,241,0.08)'
                          : 'rgba(255,255,255,0.02)',
                      }}
                    >
                      {/* 组标题栏 */}
                      <div className="mb-2 flex items-center justify-between px-1">
                        <div className="flex items-center gap-2">
                          <span className="text-11 font-mono font-bold" style={{ color: '#C7BEFF' }}>
                            #{gIdx + 1}
                          </span>
                          <span className="text-10" style={{ color: 'rgba(255,255,255,0.35)' }}>
                            {new Date(group.timestamp).toLocaleString([], {
                              month: '2-digit', day: '2-digit',
                              hour: '2-digit', minute: '2-digit',
                            })}
                          </span>
                          {group.pinned && (
                            <span
                              className="flex h-4 items-center justify-center rounded-full px-1.5 text-9 font-bold"
                              style={{ backgroundColor: 'rgba(245,158,11,0.25)', color: '#FCD34D' }}
                            >
                              <Pin className="h-2 w-2 mr-0.5" /> PINNED
                            </span>
                          )}
                          {isActiveGroup && (
                            <span
                              className="flex h-4 items-center justify-center rounded-full px-1.5 text-9 font-bold"
                              style={{ backgroundColor: 'rgba(96,84,241,0.3)', color: '#C7BEFF' }}
                            >
                              ACTIVE
                            </span>
                          )}
                        </div>
                        {onTriplotGroupDelete && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onTriplotGroupDelete(group.id); }}
                            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-red-500/70"
                            title="Delete entire triplot group (3 images)"
                            style={{ backgroundColor: 'rgba(220,38,38,0.25)', color: '#FCA5A5' }}
                          >
                            <Trash className="h-3 w-3" />
                          </button>
                        )}
                      </div>

                      {/* 三视图并排 */}
                      <div className="grid grid-cols-3 gap-2">
                        {(['front', 'side', 'top'] as const).map((key) => {
                          const vData = group[key];
                          const label = key.charAt(0).toUpperCase() + key.slice(1);
                          const isActiveView = isActiveGroup && triplotActiveView === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => {
                                if (onTriplotViewSwitch) onTriplotViewSwitch(group.id, key);
                                else onSelect(vData);
                              }}
                              className="group/view relative overflow-hidden rounded-lg transition-all"
                              style={{
                                border: isActiveView
                                  ? '2px solid #6054F1'
                                  : '1px solid rgba(255,255,255,0.08)',
                                boxShadow: isActiveView ? '0 0 8px rgba(96,84,241,0.3)' : 'none',
                              }}
                            >
                              <div className="relative aspect-square overflow-hidden" style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
                                <img src={vData.dataUrl} alt={label} className="h-full w-full object-contain" />
                              </div>
                              <div className="flex items-center justify-between px-2 py-1" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}>
                                <span className="text-10 font-bold" style={{ color: isActiveView ? '#C7BEFF' : 'rgba(255,255,255,0.6)' }}>
                                  {label}
                                </span>
                                <span className="text-8" style={{ color: 'rgba(255,255,255,0.3)' }}>
                                  {new Date(vData.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                              {isActiveView && (
                                <div className="absolute left-1 top-1 rounded px-1 py-0.5 text-8 font-bold"
                                  style={{ backgroundColor: 'rgba(96,84,241,0.85)', color: '#fff' }}>
                                  CURRENT
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── 附件图片区（只读，标注 Paperclip 图标） ── */}
          {attachments.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center gap-1.5 text-11 font-semibold" style={{ color: 'rgba(255,255,255,0.5)' }}>
                <Paperclip className="h-3 w-3" />
                Attachments ({attachments.length})
              </div>
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
              >
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="group relative overflow-hidden rounded-lg"
                    style={{
                      border: '1px solid rgba(236,72,153,0.25)',
                      opacity: 0.85,
                    }}
                    title={a.name}
                  >
                    {/* 图片 */}
                    <div className="relative aspect-square overflow-hidden" style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
                      <img src={a.dataUrl} alt={a.name} className="h-full w-full object-contain" />
                    </div>

                    {/* 文件名 */}
                    <div
                      className="flex items-center gap-1 px-2 py-1.5"
                      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
                    >
                      <Paperclip className="h-2.5 w-2.5 shrink-0" style={{ color: '#F9A8D4' }} />
                      <span className="truncate text-10" style={{ color: 'rgba(255,255,255,0.6)' }}>
                        {a.name}
                      </span>
                    </div>

                    {/* 附件标识角标 */}
                    <div
                      className="absolute right-1 top-1 flex items-center gap-0.5 rounded px-1 py-0.5 text-8 font-bold"
                      style={{ backgroundColor: 'rgba(236,72,153,0.7)', color: '#fff' }}
                    >
                      <Paperclip className="h-2 w-2" />
                      ATTACH
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── 底部状态栏 ── */}
        <div
          className="flex shrink-0 items-center gap-3 border-t px-4 py-2"
          style={{ borderColor: 'rgba(255,255,255,0.08)', backgroundColor: 'rgba(0,0,0,0.3)' }}
        >
          <div className="flex items-center gap-1 text-10" style={{ color: 'rgba(255,255,255,0.4)' }}>
            <kbd className="rounded border px-1 py-0.5" style={{ borderColor: 'rgba(255,255,255,0.15)' }}>
              <ArrowLeft className="inline h-2.5 w-2.5" /> <ArrowRight className="inline h-2.5 w-2.5" />
            </kbd>
            <span>Navigate</span>
          </div>
          <div className="flex items-center gap-1 text-10" style={{ color: 'rgba(255,255,255,0.4)' }}>
            <kbd className="rounded border px-1 py-0.5" style={{ borderColor: 'rgba(255,255,255,0.15)' }}>Enter</kbd>
            <span>{compareMode ? 'Select for compare' : 'Preview'}</span>
          </div>
          <div className="flex items-center gap-1 text-10" style={{ color: 'rgba(255,255,255,0.4)' }}>
            <kbd className="rounded border px-1 py-0.5" style={{ borderColor: 'rgba(255,255,255,0.15)' }}>C</kbd>
            <span>{compareMode ? 'Exit compare' : 'Compare mode'}</span>
          </div>
          <div className="flex items-center gap-1 text-10" style={{ color: 'rgba(255,255,255,0.4)' }}>
            <kbd className="rounded border px-1 py-0.5" style={{ borderColor: 'rgba(255,255,255,0.15)' }}>Esc</kbd>
            <span>Close</span>
          </div>
          <div className="flex-1" />
          {focusVersion && (
            <div className="text-10" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {compareMode && compareA ? 'Pick 2nd image →' : `${focusVersion.displayLabel} / ${displayItems.length}`}
            </div>
          )}
        </div>
    </>
  );

  if (embedded) {
    // 嵌入式（画布节点）：无遮罩、无 portal，面板占满父容器（Album 节点控制尺寸）
    return (
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{ backgroundColor: '#18181b', borderColor: 'rgba(255,255,255,0.10)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {panelBody}
      </div>
    );
  }

  if (!portal) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[85vh] w-[min(900px,92vw)] flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{
          backgroundColor: '#18181b',
          borderColor: 'rgba(255,255,255,0.10)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {panelBody}
      </div>
    </div>,
    portal,
  );
}
