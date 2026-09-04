'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Share2, ClipboardCopy, Check, X, Download, Loader2, ImageDown, Pencil } from 'lucide-react';
import { toPng } from 'html-to-image';
import { XhsPanel } from './XhsCard';

/** 小红薯图标：红色土豆 + 顶部嫩芽（小红书分享卡入口） */
function XhsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* 土豆身 */}
      <path
        d="M6.6 9.6 C 6 4.6, 18 4.6, 17.4 9.6 C 21 11, 21.4 18, 17.4 20 C 13.4 22, 10.6 22, 6.6 20 C 2.6 18, 3 11, 6.6 9.6 Z"
        fill="#FF2442"
      />
      {/* 嫩芽叶 */}
      <path d="M12 4.9 C 11.1 3.1, 9.4 2.4, 8 2.9 C 9.7 2.4, 11.4 3.3, 12 4.9 Z" fill="#4CAF50" />
      <path d="M12 4.9 C 12.9 3.1, 14.6 2.4, 16 2.9 C 14.3 2.4, 12.6 3.3, 12 4.9 Z" fill="#66BB6A" />
      {/* 高光 */}
      <ellipse cx="9.4" cy="11.2" rx="2.2" ry="1.5" fill="#fff" opacity="0.35" transform="rotate(-18 9.4 11.2)" />
    </svg>
  );
}
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { HtmlRenderer } from './HtmlRenderer';
import { WidgetRenderer, parseWidgetBlocks } from './WidgetRenderer';

/**
 * ShareCard — 将当次 Q+A 以 Markdown 渲染预览的形式展示，支持一键复制文本 / 复制图片，
 * 并可将卡片导出为带 BobWork 品牌标识 + 时间戳水印的 PNG 图片（走 html-to-image 的
 * toPng 克隆序列化；分享模式下的 widget 已由 WidgetRenderer 提供静态 DOM 供导出）。
 * 与聊天气泡渲染对齐：含 widget（```widget:svg / mermaid / chart / antv）时
 * 拆分为文本 + 非交互 widget 渲染，纯 Markdown 走 HtmlRenderer。
 */

export interface ShareCardProps {
  /** 用户问题文本（纯文本或 Markdown） */
  question: string;
  /** AI 回答内容（Markdown） */
  answer: string;
  /** 消息时间戳（用于弹窗头部显示） */
  timestamp?: string;
  /** 模型标签（如 "doubao-seed"） */
  modelLabel?: string;
  /** 思考等级字母（L / M / H） */
  levelLetter?: string;
  /** 弹窗 open 状态 */
  open: boolean;
  onClose: () => void;
}

/** 分享内容渲染：widget 分块 + 纯 Markdown */
function ShareContent({ content }: { content: string }) {
  const blocks = useMemo(() => parseWidgetBlocks(content), [content]);
  const widgetCount = useMemo(
    () => blocks.filter((b) => b.kind === 'widget').length,
    [blocks],
  );

  if (widgetCount === 0) {
    return <HtmlRenderer content={content} />;
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {blocks.map((block, i) =>
        block.kind === 'text' ? (
          <HtmlRenderer key={i} content={block.content} />
        ) : (
          <WidgetRenderer key={i} widget={block.widget} interactive={false} />
        ),
      )}
    </div>
  );
}

/**
 * BrandCard — 带品牌外框的分享卡（预览与导出共用同一结构）：
 * 品牌色细边框 + 顶部品牌横幅 + 品牌头（logo + BobWork + 模型徽章 + 时间戳）
 * + Question / Answer + 底部 "Share via BobWork" 水印。
 */
function BrandCard({
  brandLogo,
  modelLabel,
  levelLetter,
  timestamp,
  question,
  answer,
  stamp,
  width,
}: {
  brandLogo: string;
  modelLabel?: string;
  levelLetter?: string;
  timestamp?: string;
  question: string;
  answer: string;
  stamp: Date;
  width?: number | string;
}) {
  return (
    <div
      style={{
        width,
        backgroundColor: 'var(--panel-bg)',
        color: 'var(--ink-strong)',
        fontFamily: "ui-sans-serif, system-ui, 'SF Pro', 'PingFang SC', sans-serif",
        border: '1px solid color-mix(in oklab, var(--primary) 35%, transparent)',
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)',
      }}
    >
      {/* 顶部品牌色横幅 */}
      <div style={{ height: 8, backgroundColor: 'var(--primary)' }} />
      <div style={{ padding: 20 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img
              src={brandLogo}
              alt="BobWork"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                objectFit: 'contain',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: '1.066667rem', fontWeight: 700, letterSpacing: 0.2 }}>BobWork</span>
          </div>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: '0.733333rem',
              color: 'var(--ink-muted)',
            }}
          >
            {modelLabel && (
              <span
                style={{
                  borderRadius: 999,
                  padding: '2px 8px',
                  fontSize: '0.666667rem',
                  fontWeight: 500,
                  backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)',
                  color: 'var(--primary)',
                }}
              >
                {modelLabel}
                {levelLetter ? ` · ${levelLetter}` : ''}
              </span>
            )}
            {timestamp && <span>{timestamp}</span>}
          </span>
        </div>

        {question && (
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                marginBottom: 6,
                fontSize: '0.666667rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 1,
                color: 'var(--primary)',
              }}
            >
              Question
            </div>
            <div
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                borderRadius: 10,
                padding: 12,
                fontSize: '0.933333rem',
                lineHeight: 1.7,
                color: 'var(--ink)',
                backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
              }}
            >
              {question}
            </div>
          </div>
        )}

        <div>
          <div
            style={{
              marginBottom: 6,
              fontSize: '0.666667rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 1,
              color: 'var(--primary)',
            }}
          >
            Answer
          </div>
          <div style={{ fontSize: '0.933333rem', lineHeight: 1.7, color: 'var(--ink)' }}>
            <ShareContent content={answer} />
          </div>
        </div>

        {/* 底部品牌水印行 */}
        <div
          style={{
            marginTop: 20,
            paddingTop: 12,
            borderTop: '1px solid color-mix(in oklab, var(--line) 40%, transparent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.733333rem',
            color: 'var(--ink-muted)',
          }}
        >
          <span>Share via BobWork</span>
          <span>
            Generated{' '}
            {stamp.toLocaleString('zh-CN', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

export function ShareCard({ question, answer, timestamp, modelLabel, levelLetter, open, onClose }: ShareCardProps) {
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copyingImage, setCopyingImage] = useState(false);
  const [copiedImg, setCopiedImg] = useState(false);
  const [xhsOpen, setXhsOpen] = useState(false);
  const [stamp, setStamp] = useState(() => new Date());
  const [brandLogo, setBrandLogo] = useState('/bobwork-logo.png');
  const [mounted, setMounted] = useState(false);
  const exportCardRef = useRef<HTMLDivElement>(null);
  /** 编辑态：点击铅笔后进入，弹窗内直接改 Question / Answer（Markdown 原文），预览/复制/导出均用编辑后内容 */
  const [editing, setEditing] = useState(false);
  const [editQ, setEditQ] = useState(question);
  const [editA, setEditA] = useState(answer);

  // 打开弹窗时重置编辑内容，默认预览态（点铅笔进入编辑）
  useEffect(() => {
    if (open) {
      setEditQ(question);
      setEditA(answer);
      setEditing(false);
    }
  }, [open, question, answer]);

  // 导出卡通过 portal 挂到 document.body（避开祖先 transform 对 position:fixed 的干扰）
  useEffect(() => {
    setMounted(true);
  }, []);

  /** 品牌标识：默认 /bobwork-logo.png；设置自定义 brandLogo 时从头像池匹配 dataUrl（与 Sidebar 一致） */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const api = (window as unknown as { api?: { settings?: { load: () => Promise<{ brandLogo?: string } | null> }; avatar?: { list: () => Promise<Array<{ id: string; dataUrl: string }>> } } }).api;
        const s = await api?.settings?.load();
        if (cancelled) return;
        const brandId = s?.brandLogo;
        if (!brandId) { setBrandLogo('/bobwork-logo.png'); return; }
        if (api?.avatar?.list) {
          const list = await api.avatar.list();
          setBrandLogo(list.find((x) => x.id === brandId)?.dataUrl ?? '/bobwork-logo.png');
          return;
        }
        setBrandLogo('/bobwork-logo.png');
      } catch {
        if (!cancelled) setBrandLogo('/bobwork-logo.png');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleCopyText = useCallback(async () => {
    const text = [editQ, editA].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 不可用时静默忽略 */
    }
  }, [editQ, editA]);

  /** 捕获品牌卡 PNG：刷新水印时间 → 等待 React 重渲染 → html-to-image 序列化导出卡。
   *  实测教训：html-to-image 会把原节点（fixed left:-9999 离屏容器）的定位样式复制到克隆体，
   *  克隆体进入 SVG foreignObject 后仍被定位在画布外 → 整张 PNG 全空白；
   *  仅靠 style 覆盖为 position:fixed/absolute 也无效（foreignObject 里 positioned 根节点不绘制）。
   *  因此直接捕获内部静态 BrandCard（自然文档流），克隆体自 foreignObject 原点排布，内容完整可见；
   *  真实节点始终留在屏幕外，无闪烁。 */
  const capturePng = useCallback(async (): Promise<string | null> => {
    const wrapper = exportCardRef.current;
    const node = (wrapper?.firstElementChild ?? wrapper) as HTMLElement | null;
    if (!node) return null;
    setStamp(new Date());
    await new Promise((r) => setTimeout(r, 120));
    await (document.fonts?.ready ?? Promise.resolve());
    // 不传 backgroundColor，导出 PNG 四角透明（圆角外无底色残留）
    return await toPng(node, {
      pixelRatio: 2,
      cacheBust: true,
    });
  }, []);

  /** 导出品牌化 PNG 并触发下载 */
  const handleDownloadImage = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const link = document.createElement('a');
      link.download = `bobwork-share-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.warn('[ShareCard] 导出分享图片失败:', err);
    } finally {
      setExporting(false);
    }
  }, [capturePng, exporting]);

  /** 复制品牌化 PNG 到剪贴板（ClipboardItem，便于直接粘贴到聊天/文档） */
  const handleCopyImage = useCallback(async () => {
    if (copyingImage) return;
    setCopyingImage(true);
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopiedImg(true);
      setTimeout(() => setCopiedImg(false), 1500);
    } catch (err) {
      console.warn('[ShareCard] 复制分享图片失败:', err);
    } finally {
      setCopyingImage(false);
    }
  }, [capturePng, copyingImage]);

  return (
    <>
      {/* 导出用品牌卡：portal 到 document.body 离屏渲染，供 html-to-image 序列化为 PNG。
          真实节点始终留在屏幕外（fixed left:-9999，无闪烁）；导出时捕获内部静态 BrandCard，
          克隆体在 foreignObject 原点自然排布（离屏定位根节点会被 html-to-image 复制导致全空白）。 */}
      {mounted &&
        createPortal(
          <div
            ref={exportCardRef}
            aria-hidden
            style={{ position: 'fixed', left: -9999, top: 0, zIndex: 2147483647 }}
          >
            <BrandCard
              brandLogo={brandLogo}
              modelLabel={modelLabel}
              levelLetter={levelLetter}
              timestamp={timestamp}
              question={editQ}
              answer={editA}
              stamp={stamp}
              width={800}
            />
          </div>,
          document.body,
        )}

    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[620px] max-h-[85vh] p-0 flex flex-col" showCloseButton={false}>
        {/* Header — 固定不滚动 */}
        <DialogHeader className="px-5 py-3 flex flex-row items-center justify-between gap-2 shrink-0" style={{ borderBottom: '1px solid color-mix(in oklab, var(--line) 30%, transparent)' }}>
          <div className="flex min-w-0 items-center gap-2">
            <Share2 className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--primary)' }} />
            <DialogTitle className="text-sm font-semibold leading-none" style={{ color: 'var(--ink-strong)' }}>
              Share
            </DialogTitle>
            {modelLabel && (
              <span
                className="flex-shrink-0 rounded-full px-2 py-0.5 text-10 font-medium"
                style={{ backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)' }}
              >
                {modelLabel}
                {levelLetter ? ` · ${levelLetter}` : ''}
              </span>
            )}
            {timestamp && (
              <span className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                {timestamp}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded-md p-1.5 transition-colors hover:bg-black/5"
            style={{ color: 'var(--ink-muted)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </DialogHeader>
        <DialogDescription className="sr-only">Share content preview</DialogDescription>

        {/* Body — 独立滚动；编辑态显示 Q/A 文本编辑区，预览态即品牌卡（与导出 PNG 同结构） */}
        {editing ? (
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5" style={{ backgroundColor: 'var(--paper-soft)' }}>
            <div>
              <div className="mb-1.5 text-10 font-bold uppercase tracking-wide" style={{ color: 'var(--primary)' }}>
                Question
              </div>
              <textarea
                value={editQ}
                onChange={(e) => setEditQ(e.target.value)}
                rows={3}
                placeholder="Question…"
                className="w-full resize-y rounded-lg p-3 text-sm leading-relaxed outline-none"
                style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--ink)', border: '1px solid color-mix(in oklab, var(--line) 50%, transparent)' }}
              />
            </div>
            <div>
              <div className="mb-1.5 text-10 font-bold uppercase tracking-wide" style={{ color: 'var(--primary)' }}>
                Answer (Markdown)
              </div>
              <textarea
                value={editA}
                onChange={(e) => setEditA(e.target.value)}
                rows={16}
                placeholder="Answer…"
                className="w-full resize-y rounded-lg p-3 text-sm leading-relaxed outline-none"
                style={{ backgroundColor: 'var(--panel-bg)', color: 'var(--ink)', border: '1px solid color-mix(in oklab, var(--line) 50%, transparent)' }}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5" style={{ backgroundColor: 'var(--paper-soft)' }}>
            <BrandCard
              brandLogo={brandLogo}
              modelLabel={modelLabel}
              levelLetter={levelLetter}
              timestamp={timestamp}
              question={editQ}
              answer={editA}
              stamp={stamp}
              width="100%"
            />
          </div>
        )}

        {/* 操作按钮栏 — 固定不滚动（仅图标 + tooltip） */}
        {answer && (
          <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-3" style={{
            borderTop: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
            backgroundColor: 'var(--panel-bg)',
          }}>
            <button
              type="button"
              onClick={handleDownloadImage}
              disabled={exporting}
              title={exporting ? 'Exporting…' : 'Save image'}
              className="flex items-center justify-center rounded-md p-2 transition-colors hover:opacity-90 disabled:opacity-50"
              style={{ border: '1px solid color-mix(in oklab, var(--primary) 45%, transparent)', color: 'var(--ink-strong)' }}
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              title={editing ? 'Done editing' : 'Edit content'}
              className="flex items-center justify-center rounded-md p-2 transition-colors hover:opacity-90"
              style={{
                border: editing
                  ? '1px solid var(--primary)'
                  : '1px solid color-mix(in oklab, var(--primary) 45%, transparent)',
                color: editing ? 'var(--primary)' : 'var(--ink-strong)',
              }}
            >
              {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={handleCopyImage}
              disabled={copyingImage}
              title={copyingImage ? 'Copying…' : copiedImg ? 'Image copied' : 'Copy image'}
              className="flex items-center justify-center rounded-md p-2 transition-colors hover:opacity-90 disabled:opacity-50"
              style={{ border: '1px solid color-mix(in oklab, var(--primary) 45%, transparent)', color: 'var(--ink-strong)' }}
            >
              {copyingImage ? <Loader2 className="h-4 w-4 animate-spin" /> : copiedImg ? <Check className="h-4 w-4" /> : <ImageDown className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setXhsOpen(true)}
              title="3:4 post card"
              className="flex items-center justify-center rounded-md p-2 transition-colors hover:opacity-90"
              style={{ border: '1px solid color-mix(in oklab, var(--primary) 45%, transparent)', color: 'var(--ink-strong)' }}
            >
              <XhsIcon size={16} />
            </button>
            <button
              type="button"
              onClick={handleCopyText}
              title={copied ? 'Copied' : 'Copy text'}
              className="flex items-center justify-center rounded-md p-2 transition-colors hover:opacity-90"
              style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
            >
              {copied ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>

    {/* 3:4 竖版小红书风格分享卡 */}
    {xhsOpen && (
      <XhsPanel
        question={editQ}
        answer={editA}
        open={xhsOpen}
        onClose={() => setXhsOpen(false)}
      />
    )}
    </>
  );
}

/** Share 按钮（供父组件直接渲染） */
export function ShareButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className="flex min-w-6 min-h-6 items-center justify-center rounded-md p-1.5 transition-colors hover:bg-black/5 disabled:opacity-30"
      style={{ color: 'color-mix(in oklab, var(--ink-muted) 75%, transparent)' }}
      title="Share"
    >
      <Share2 className="h-3.5 w-3.5" />
    </button>
  );
}