'use client';

/**
 * WeiboDialog — 微博导出（P2-1）。
 *
 * 两个产物：
 * 1. 文案：`renderWeiboSummary` → ≤140 字钩子（hook + stats + 首 1–2 段）+ 自动 `#话题#`；
 * 2. 方形配图：独立方形模板（1:1 / 4:3），**不复用小红书 3:4 卡片**——竖图进信息流会被裁两边。
 *
 * 导出链路与 ShareCard 一致：portal 离屏渲染静态卡 → html-to-image 捕获内部节点
 * （离屏定位根节点会被克隆到 foreignObject 外导致空白，故捕获自然文档流的内部节点）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toPng } from 'html-to-image';
import { Check, Copy, Download, ImageDown, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseDoc } from '@/lib/md-export/ir';
import {
  WEIBO_EXPORT_RATIO,
  WEIBO_HOOK_MAX,
  WEIBO_SPEC,
  WEIBO_SIZES,
  renderWeiboSummary,
  weiboCardContent,
  type WeiboCardContent,
  type WeiboSizeKey,
} from '@/lib/md-export/targets/weibo';
import { checkDoc } from '@/lib/md-export/check';
import { CheckReport } from './CheckReport';

const WEIBO_ACCENT = '#FF8200';

const SIZE_KEYS = Object.keys(WEIBO_SIZES) as WeiboSizeKey[];

export interface WeiboDialogProps {
  open: boolean;
  onClose: () => void;
  /** 当前文档 markdown 快照（打开瞬间取，避免编辑过程中途变化） */
  markdown: string;
}

/** 方形配图：标题 + 钩子 + 关键数字 + 首 1–2 段 + 话题栏（字数与行数均已封顶，容器 overflow:hidden 兜底） */
function WeiboCard({ content, topics, size }: { content: WeiboCardContent; topics: string[]; size: WeiboSizeKey }) {
  const g = WEIBO_SIZES[size];
  const s = g.scale;
  const clamp = (lines: number) =>
    ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) as const;
  const paras = content.paras.slice(0, g.paras);

  return (
    <div
      style={{
        width: g.w,
        height: g.h,
        padding: g.pad,
        boxSizing: 'border-box',
        backgroundColor: '#FFFFFF',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 10 * s,
        fontFamily: "'PingFang SC', ui-sans-serif, system-ui, sans-serif",
        color: '#1F1F1F',
      }}
    >
      {content.title && (
        <div style={{ fontSize: 21 * s, fontWeight: 700, lineHeight: 1.35, color: '#141414', ...clamp(2) }}>
          {content.title}
        </div>
      )}

      {content.hook && (
        <div style={{ fontSize: 15 * s, lineHeight: 1.7, color: '#3A3A3A', ...clamp(g.hookLines) }}>{content.hook}</div>
      )}

      {content.stats.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 * s }}>
          {content.stats.map((st) => (
            <span
              key={st}
              style={{
                fontSize: 12 * s,
                lineHeight: 1.4,
                padding: `${3 * s}px ${8 * s}px`,
                borderRadius: 999,
                color: WEIBO_ACCENT,
                backgroundColor: '#FFF4E8',
              }}
            >
              {st}
            </span>
          ))}
        </div>
      )}

      {paras.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 * s }}>
          {paras.map((p, i) => (
            <div key={i} style={{ fontSize: 13 * s, lineHeight: 1.75, color: '#4A4A4A', ...clamp(g.paraLines) }}>
              {p}
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1 }} />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          borderTop: '1px solid #EFEFEF',
          paddingTop: 8 * s,
        }}
      >
        <div style={{ fontSize: 11 * s, color: WEIBO_ACCENT, ...clamp(1) }}>
          {topics.map((t) => `#${t}#`).join(' ')}
        </div>
        <div style={{ fontSize: 10 * s, letterSpacing: 1, color: '#B0B0B0' }}>BobWork</div>
      </div>
    </div>
  );
}

export function WeiboDialog({ open, onClose, markdown }: WeiboDialogProps) {
  const [size, setSize] = useState<WeiboSizeKey>('1:1');
  const [busy, setBusy] = useState<'' | 'text' | 'image' | 'download'>('');
  const [flash, setFlash] = useState('');
  const [mounted, setMounted] = useState(false);
  const exportCardRef = useRef<HTMLDivElement>(null);

  const { ir, content, post, checks, imageCount } = useMemo(() => {
    const doc = parseDoc(markdown, { source: 'md-file' });
    return {
      ir: doc,
      content: weiboCardContent(doc),
      post: renderWeiboSummary(doc),
      checks: checkDoc(doc, WEIBO_SPEC),
      imageCount: doc.blocks.filter((b) => b.t === 'image').length,
    };
  }, [markdown]);

  const empty = ir.blocks.length === 0;
  const hookLen = post.hook.length;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const ping = useCallback((v: string, ms = 1500) => {
    setFlash(v);
    setTimeout(() => setFlash(''), ms);
  }, []);

  /** 捕获方形配图：等字体就绪 → 序列化离屏卡（内部静态节点，自然文档流） */
  const capturePng = useCallback(async (): Promise<string | null> => {
    const wrapper = exportCardRef.current;
    const node = (wrapper?.firstElementChild ?? wrapper) as HTMLElement | null;
    if (!node) return null;
    await (document.fonts?.ready ?? Promise.resolve());
    return toPng(node, { pixelRatio: WEIBO_EXPORT_RATIO, cacheBust: true });
  }, []);

  const handleCopyText = useCallback(async () => {
    if (busy || empty) return;
    setBusy('text');
    try {
      await navigator.clipboard.writeText(post.text);
      ping('copy');
    } catch (e) {
      console.warn('[WeiboDialog] clipboard writeText failed:', e);
      ping('error', 2500);
    } finally {
      setBusy('');
    }
  }, [busy, empty, post, ping]);

  const handleCopyImage = useCallback(async () => {
    if (busy || empty) return;
    setBusy('image');
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      ping('copyImage');
    } catch (e) {
      console.warn('[WeiboDialog] copy image failed:', e);
      ping('error', 2500);
    } finally {
      setBusy('');
    }
  }, [busy, empty, capturePng, ping]);

  const handleDownload = useCallback(async () => {
    if (busy || empty) return;
    setBusy('download');
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const link = document.createElement('a');
      link.download = `bobwork-weibo-${size.replace(':', 'x')}-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (e) {
      console.warn('[WeiboDialog] download image failed:', e);
    } finally {
      setBusy('');
    }
  }, [busy, empty, capturePng, size]);

  if (!open) return null;

  return (
    <>
      {mounted &&
        createPortal(
          <div ref={exportCardRef} aria-hidden style={{ position: 'fixed', left: -9999, top: 0, zIndex: 2147483647 }}>
            <WeiboCard content={content} topics={post.topics} size={size} />
          </div>,
          document.body,
        )}

      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center"
        style={{ backgroundColor: 'rgba(0,0,0,0.25)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="flex h-[84vh] w-[900px] max-w-[92vw] flex-col overflow-hidden rounded-2xl"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--line)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.04)',
          }}
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between gap-3 px-5 py-3.5" style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Weibo post</h2>
              <p className="text-11" style={{ color: 'var(--ink-muted)' }}>
                ≤{WEIBO_HOOK_MAX}-char hook + auto hashtags, with a square image (3:4 would be cropped in feed)
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {SIZE_KEYS.map((k) => {
                const active = k === size;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSize(k)}
                    className="rounded-md px-2.5 py-1 text-11 font-medium transition-colors"
                    style={{
                      border: `1px solid ${active ? WEIBO_ACCENT : 'var(--line)'}`,
                      color: active ? WEIBO_ACCENT : 'var(--ink-muted)',
                      backgroundColor: active ? 'color-mix(in oklab, #FF8200 8%, transparent)' : 'transparent',
                    }}
                  >
                    {k}
                  </button>
                );
              })}
              <Button
                onClick={onClose}
                variant="ghost"
                tone="neutral"
                size="icon"
                className="ml-1"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* 主体：左预览 / 右体检 + 文案 */}
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 items-start justify-center overflow-auto p-5" style={{ backgroundColor: 'var(--paper-soft)' }}>
              <WeiboCard content={content} topics={post.topics} size={size} />
            </div>

            <div className="flex w-[300px] shrink-0 flex-col gap-4 overflow-auto p-4" style={{ borderLeft: '1px solid var(--line)' }}>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                    Post text
                  </span>
                  <span className="text-11" style={{ color: hookLen > WEIBO_HOOK_MAX ? '#D9534F' : 'var(--ink-muted)' }}>
                    {hookLen}/{WEIBO_HOOK_MAX}
                  </span>
                </div>
                <div
                  className="whitespace-pre-wrap rounded-lg p-3 text-11 leading-relaxed"
                  style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink)' }}
                >
                  {post.text || '—'}
                </div>
                {post.topics.length > 0 && (
                  <p className="mt-2 text-11" style={{ color: 'var(--ink-muted)' }}>
                    Hashtags auto-picked from title &amp; keywords — edit them after pasting.
                  </p>
                )}
              </div>

              <CheckReport items={checks} />

              <p className="text-11 leading-snug" style={{ color: 'var(--ink-muted)' }}>
                微博 accepts 1–9 images; {imageCount} in this document. Use the square card as the cover and add
                the document images after posting.
              </p>

              {empty && <p className="text-11" style={{ color: 'var(--ink-muted)' }}>Nothing to export — the document is empty.</p>}
            </div>
          </div>

          {/* 底部操作 */}
          <div className="flex items-center justify-between gap-3 px-5 py-3" style={{ borderTop: '1px solid var(--line)' }}>
            <span className="text-11" style={{ color: flash === 'error' ? '#D9534F' : 'var(--ink-muted)' }}>
              {flash === 'copy'
                ? 'Post text copied'
                : flash === 'copyImage'
                  ? 'Image copied'
                  : flash === 'error'
                    ? 'Action failed — check clipboard permission'
                    : `Copy the text, then post it with the ${size} image.`}
            </span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" tone="neutral" size="sm" onClick={handleDownload} disabled={!!busy || empty}>
                {busy === 'download' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                )}
                PNG
              </Button>
              <Button type="button" variant="ghost" tone="neutral" size="sm" onClick={handleCopyImage} disabled={!!busy || empty}>
                {busy === 'image' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ImageDown className="mr-1.5 h-3.5 w-3.5" />
                )}
                Copy image
              </Button>
              <Button type="button" variant="solid" size="sm" onClick={handleCopyText} disabled={!!busy || empty}>
                {busy === 'text' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : flash === 'copy' ? (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                )}
                Copy post text
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
