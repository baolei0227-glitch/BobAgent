'use client';

/**
 * PosterDialog — 设计稿海报导出（P2-2）。
 *
 * 与小红书卡片相反：这里**保留完整排版**（一份 md 一次成图，不切块）。
 * 四种规格 1:1 / 3:4 / 9:16 / 长图，规格只影响容器尺寸与字号刻度：
 * 定高规格把内容等比缩放到容器内（不裁切、不溢出），长图高度自适应。
 *
 * 导出链路同 ShareCard / WeiboDialog：portal 离屏渲染 → html-to-image 捕获内部静态节点。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toPng } from 'html-to-image';
import { Check, ImageDown, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseDoc, type DocInline } from '@/lib/md-export/ir';
import {
  POSTER_EXPORT_RATIO,
  POSTER_SPEC,
  POSTER_SIZES,
  posterBlocks,
  posterCover,
  posterNoise,
  type PosterBlock,
  type PosterCover,
  type PosterSizeKey,
} from '@/lib/md-export/targets/poster';
import { checkDoc } from '@/lib/md-export/check';
import { CheckReport } from './CheckReport';

const POSTER_FONT = "'PingFang SC', ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = '#C2410C';

const SIZE_KEYS = Object.keys(POSTER_SIZES) as PosterSizeKey[];

export interface PosterDialogProps {
  open: boolean;
  onClose: () => void;
  /** 当前文档 markdown 快照（打开瞬间取） */
  markdown: string;
}

const clamp = (lines: number) =>
  ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' }) as const;

function PosterInline({ inline }: { inline: DocInline[] }) {
  return (
    <>
      {inline.map((i, k) => {
        switch (i.t) {
          case 'strong':
            return (
              <strong key={k} style={{ fontWeight: 700, color: '#111111' }}>
                {i.value}
              </strong>
            );
          case 'em':
            return <em key={k}>{i.value}</em>;
          case 'del':
            return (
              <span key={k} style={{ textDecoration: 'line-through', color: '#9A9A9A' }}>
                {i.value}
              </span>
            );
          case 'code':
            return (
              <code
                key={k}
                style={{
                  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                  fontSize: '0.92em',
                  padding: '1px 5px',
                  borderRadius: 4,
                  backgroundColor: '#F4F4F5',
                  color: '#B3261E',
                }}
              >
                {i.value}
              </code>
            );
          case 'link':
            return (
              <span key={k} style={{ color: '#3B6FD4' }}>
                {i.value}
              </span>
            );
          default:
            return <span key={k}>{i.value}</span>;
        }
      })}
    </>
  );
}

/** 单个海报区块（h1 已提到封面；h3+ 降级为加粗小标题；宽表转键值对；代码折叠为说明） */
function PosterBlockView({ b }: { b: PosterBlock }) {
  switch (b.t) {
    case 'section':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <span style={{ width: 4, height: 18, borderRadius: 2, backgroundColor: ACCENT }} />
          <span style={{ fontSize: 20, fontWeight: 700, color: '#141414', lineHeight: 1.4 }}>{b.text}</span>
        </div>
      );
    case 'sub':
      return <div style={{ fontSize: 16, fontWeight: 700, color: '#1F1F1F', lineHeight: 1.5 }}>{b.text}</div>;
    case 'para':
      return (
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.85, color: '#3A3A3A', ...clamp(3) }}>
          <PosterInline inline={b.inline} />
        </p>
      );
    case 'list':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {b.items.map((it, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 16, lineHeight: 1.75, color: '#3A3A3A' }}>
              <span style={{ flexShrink: 0, color: ACCENT, fontWeight: 600 }}>
                {b.ordered ? `${i + 1}.` : '·'}
              </span>
              <span style={{ minWidth: 0, ...clamp(2) }}>
                <PosterInline inline={it} />
              </span>
            </div>
          ))}
          {b.truncated > 0 && (
            <div style={{ fontSize: 13, color: '#9A9A9A' }}>…另有 {b.truncated} 项，完整内容见原文档</div>
          )}
        </div>
      );
    case 'quote':
      return (
        <div style={{ borderLeft: `3px solid #E4E4E7`, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {b.lines.map((l, i) => (
            <div key={i} style={{ fontSize: 15, lineHeight: 1.8, color: '#6B6B6B', ...clamp(3) }}>
              {l}
            </div>
          ))}
        </div>
      );
    case 'kv':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {b.pairs.map(([k, v], i) => (
            <div key={i} style={{ display: 'flex', gap: 10, fontSize: 15, lineHeight: 1.7, color: '#3A3A3A' }}>
              <span style={{ flexShrink: 0, fontWeight: 600, color: '#1F1F1F', maxWidth: '42%', ...clamp(2) }}>{k}</span>
              <span style={{ minWidth: 0 }}>{v}</span>
            </div>
          ))}
          <div style={{ fontSize: 13, color: '#9A9A9A' }}>{b.note}</div>
        </div>
      );
    case 'table':
      return (
        <table
          style={{
            borderCollapse: 'collapse',
            width: '100%',
            fontSize: 14,
            lineHeight: 1.6,
            color: '#3A3A3A',
            tableLayout: 'fixed',
          }}
        >
          <thead>
            <tr>
              {b.header.map((c, i) => (
                <th
                  key={i}
                  style={{ border: '1px solid #E4E4E7', backgroundColor: '#FAFAFA', padding: '8px 10px', textAlign: 'left', fontWeight: 600, wordBreak: 'break-word' }}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} style={{ border: '1px solid #E4E4E7', padding: '8px 10px', wordBreak: 'break-word', verticalAlign: 'top' }}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'code':
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 14,
            lineHeight: 1.7,
            color: '#6B6B6B',
            backgroundColor: '#F7F7F8',
            borderRadius: 8,
            padding: '10px 14px',
          }}
        >
          <span style={{ color: ACCENT, fontWeight: 600 }}>{'</>'}</span>
          <span>{b.summary}</span>
        </div>
      );
    case 'image':
      // 外链图在离屏导出时可能因跨域失败：保留占位说明，避免整块塌陷
      return (
        <div style={{ textAlign: 'center' }}>
          {b.src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.src} alt={b.alt} style={{ maxWidth: '100%', borderRadius: 8, display: 'block', margin: '0 auto' }} />
          ) : (
            <div style={{ fontSize: 14, color: '#9A9A9A' }}>〔图片{b.alt ? `：${b.alt}` : ''}〕</div>
          )}
        </div>
      );
    case 'hr':
      return <div style={{ height: 1, backgroundColor: '#EAEAEA', margin: '4px 0' }} />;
  }
}

/**
 * 海报画布：定高规格把正文等比缩放到内容区内（宽度反向放大后缩放，保持满宽 → 只压字号刻度），
 * 长图规格高度自适应、不缩放。
 */
function PosterCanvas({ cover, blocks, size }: { cover: PosterCover; blocks: PosterBlock[]; size: PosterSizeKey }) {
  const g = POSTER_SIZES[size];
  const auto = g.h <= 0;
  const areaRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const area = areaRef.current;
    const body = bodyRef.current;
    if (!area || !body) return;

    if (auto) {
      body.style.transform = 'none';
      body.style.width = `${area.clientWidth}px`;
      return;
    }

    const availW = area.clientWidth;
    const availH = area.clientHeight;
    if (!availW || !availH) return;

    // 迭代：缩放系数 f 决定未缩放宽度（availW / f），宽度又影响内容高度，收敛即可
    let f = 1;
    for (let i = 0; i < 5; i++) {
      body.style.transform = 'none';
      body.style.width = `${availW / f}px`;
      const next = Math.min(1, availH / Math.max(1, body.scrollHeight));
      if (Math.abs(next - f) < 0.004) {
        f = next;
        break;
      }
      f = next;
    }
    body.style.width = `${availW / f}px`;
    body.style.transform = `scale(${f})`;
    body.style.transformOrigin = 'top left';
  }, [size, auto, cover, blocks]);

  const hasCover = !!(cover.title || cover.hook || cover.stats.length);

  return (
    <div
      style={{
        width: g.w,
        height: auto ? 'auto' : g.h,
        padding: g.pad,
        boxSizing: 'border-box',
        backgroundColor: '#FFFFFF',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        fontFamily: POSTER_FONT,
        color: '#1F1F1F',
      }}
    >
      {hasCover && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 18, borderBottom: '2px solid #141414' }}>
          {cover.title && (
            <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.3, letterSpacing: -0.2, ...clamp(3) }}>
              {cover.title}
            </div>
          )}
          {cover.hook && (
            <div style={{ fontSize: 16, lineHeight: 1.85, color: '#4A4A4A', ...clamp(3) }}>{cover.hook}</div>
          )}
          {cover.stats.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {cover.stats.map((s) => (
                <span
                  key={s}
                  style={{
                    fontSize: 13,
                    lineHeight: 1.4,
                    padding: '4px 10px',
                    borderRadius: 999,
                    color: ACCENT,
                    backgroundColor: '#FFF3EA',
                    fontWeight: 600,
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        ref={areaRef}
        style={{ flex: auto ? 'none' : '1 1 auto', minHeight: 0, overflow: 'hidden', position: 'relative' }}
      >
        <div ref={bodyRef} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {blocks.map((b, i) => (
            <PosterBlockView key={i} b={b} />
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #EFEFEF', paddingTop: 10 }}>
        <span style={{ fontSize: 11, letterSpacing: 1, color: '#B0B0B0' }}>BobWork</span>
        <span style={{ fontSize: 11, color: '#C4C4C4' }}>{size === 'long' ? 'Long image' : size}</span>
      </div>
    </div>
  );
}

export function PosterDialog({ open, onClose, markdown }: PosterDialogProps) {
  const [size, setSize] = useState<PosterSizeKey>('3:4');
  const [busy, setBusy] = useState<'' | 'image' | 'download'>('');
  const [flash, setFlash] = useState('');
  const [mounted, setMounted] = useState(false);
  const exportCardRef = useRef<HTMLDivElement>(null);

  const { cover, blocks, checks, noise } = useMemo(() => {
    const doc = parseDoc(markdown, { source: 'md-file' });
    const bs = posterBlocks(doc);
    return {
      cover: posterCover(doc),
      blocks: bs,
      checks: checkDoc(doc, POSTER_SPEC),
      noise: posterNoise(bs),
    };
  }, [markdown]);

  /** 仅标题/钩子的极短文档也应可导出，故不只看 blocks */
  const empty = blocks.length === 0 && !cover.title && !cover.hook && cover.stats.length === 0;

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

  /** 捕获海报：等字体与布局稳定 → 序列化离屏画布（内部静态节点，自然文档流） */
  const capturePng = useCallback(async (): Promise<string | null> => {
    const wrapper = exportCardRef.current;
    const node = (wrapper?.firstElementChild ?? wrapper) as HTMLElement | null;
    if (!node) return null;
    await (document.fonts?.ready ?? Promise.resolve());
    await new Promise((r) => setTimeout(r, 120));
    return toPng(node, { pixelRatio: POSTER_EXPORT_RATIO, cacheBust: true });
  }, []);

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
      console.warn('[PosterDialog] copy image failed:', e);
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
      link.download = `bobwork-poster-${size}-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (e) {
      console.warn('[PosterDialog] download failed:', e);
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
            <PosterCanvas cover={cover} blocks={blocks} size={size} />
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
          className="flex h-[88vh] w-[980px] max-w-[94vw] flex-col overflow-hidden rounded-2xl"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--line)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.04)',
          }}
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between gap-3 px-5 py-3.5" style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Design poster</h2>
              <p className="text-11" style={{ color: 'var(--ink-muted)' }}>
                Full layout kept — auto-fitted to each ratio, no cropping
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
                      border: `1px solid ${active ? ACCENT : 'var(--line)'}`,
                      color: active ? ACCENT : 'var(--ink-muted)',
                      backgroundColor: active ? 'color-mix(in oklab, #C2410C 8%, transparent)' : 'transparent',
                    }}
                  >
                    {k === 'long' ? 'Long' : k}
                  </button>
                );
              })}
              <Button onClick={onClose} variant="ghost" tone="neutral" size="icon" className="ml-1" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* 主体：左画布 / 右体检 */}
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 justify-center overflow-auto p-5" style={{ backgroundColor: 'var(--paper-soft)' }}>
              <PosterCanvas cover={cover} blocks={blocks} size={size} />
            </div>

            <div className="flex w-[300px] shrink-0 flex-col gap-4 overflow-auto p-4" style={{ borderLeft: '1px solid var(--line)' }}>
              <CheckReport items={checks} />

              <div className="text-11 leading-snug" style={{ color: 'var(--ink-muted)' }}>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                  Layout notes
                </div>
                <div>{blocks.length} blocks · {noise.section} sections · {noise.sub} sub-headings</div>
                {noise.folded > 0 && <div>{noise.folded} block(s) folded (code / wide table)</div>}
                <div className="mt-1">
                  {size === 'long'
                    ? 'Long image grows with the content — best for archiving.'
                    : 'Fixed ratios scale the whole layout down to fit — same content, smaller type.'}
                </div>
              </div>

              {empty && <p className="text-11" style={{ color: 'var(--ink-muted)' }}>Nothing to export — the document is empty.</p>}
            </div>
          </div>

          {/* 底部操作 */}
          <div className="flex items-center justify-between gap-3 px-5 py-3" style={{ borderTop: '1px solid var(--line)' }}>
            <span className="text-11" style={{ color: flash === 'error' ? '#D9534F' : 'var(--ink-muted)' }}>
              {flash === 'copyImage'
                ? 'Image copied'
                : flash === 'error'
                  ? 'Action failed — check clipboard permission'
                  : `Exporting ${size === 'long' ? 'long image' : size} · PNG @${POSTER_EXPORT_RATIO}x`}
            </span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" tone="neutral" size="sm" onClick={handleCopyImage} disabled={!!busy || empty}>
                {busy === 'image' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : flash === 'copyImage' ? (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <ImageDown className="mr-1.5 h-3.5 w-3.5" />
                )}
                Copy image
              </Button>
              <Button type="button" variant="solid" size="sm" onClick={handleDownload} disabled={!!busy || empty}>
                {busy === 'download' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ImageDown className="mr-1.5 h-3.5 w-3.5" />}
                Download PNG
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
