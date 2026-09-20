'use client';

/**
 * ExportMenu — md 阅读器统一导出入口。
 *
 * 把右键菜单里原来的单项 `Export…`（只开 DOCX 弹窗）升级为按产物类型分组的菜单：
 * 统一从 `getMarkdown()` 取当前文档快照，再交给各端产物（卡片复用已有面板）。
 *
 * 分组与落地进度见《md阅读器多端分发方案》§4.2 / §8：
 * - Image：小红书卡片、品牌分享卡（P0，复用 XhsPanel / ShareCard 的 md 输入分支）、
 *          设计稿海报（P2-2，1:1 / 3:4 / 9:16 / 长图 四规格 PNG）
 * - Article：微信文章（P1-1，剪贴板内联 HTML + 体检）、微博（P2-1，≤140 字钩子 + 方形配图）
 * - Document：HTML（P2-3，自包含单文件）
 *
 * DOCX 与打印不在此菜单：DOCX 已提升为右键菜单独立按钮（避免多一层弹窗），
 * 打印直接走右键菜单的「打印」（系统打印面板可另存 PDF，故不再单列 PDF 条目）。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AtSign, FileCode2, Frame, ImageDown, LayoutGrid, Newspaper, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { hashText, parseDoc } from '@/lib/md-export/ir';
import { renderHtmlArtifact } from '@/lib/md-export/targets/html';
import { PosterDialog } from './PosterDialog';
import { ShareCard } from './ShareCard';
import { WeChatArticleDialog } from './WeChatArticleDialog';
import { WeiboDialog } from './WeiboDialog';
import { XhsPanel } from './XhsCard';

export interface ExportMenuProps {
  open: boolean;
  onClose: () => void;
  /** 当前文档 markdown 快照（点击条目时惰性求值，避免每次渲染都序列化） */
  getMarkdown: () => string;
  /** 草稿身份（文件路径 / 节点 id）：缺省时退化为内容哈希，避免不同文档草稿互相覆盖 */
  docKey?: string;
}

/** 卡片类条目：复用已有面板，携带打开瞬间的 md 快照与草稿身份 */
type CardKind = 'xhs' | 'share';

interface CardTarget {
  kind: CardKind;
  markdown: string;
  docKey: string;
}

interface ExportItem {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  run: () => void;
}

interface ExportGroup {
  id: string;
  label: string;
  items: ExportItem[];
}

export function ExportMenu({ open, onClose, getMarkdown, docKey }: ExportMenuProps) {
  const [card, setCard] = useState<CardTarget | null>(null);
  /** 微信文章：打开瞬间的 md 快照（序列化在弹窗内完成，便于实时体检） */
  const [article, setArticle] = useState<string | null>(null);
  /** 微博：同样只带 md 快照（文案 + 方形配图都在弹窗内生成） */
  const [weibo, setWeibo] = useState<string | null>(null);
  /** 设计稿海报：只带 md 快照（规格切换 / 缩放适配都在弹窗内完成） */
  const [poster, setPoster] = useState<string | null>(null);

  /** 打开卡片：取当前文档 md 快照 + 草稿身份，交给已有面板 */
  const openCard = useCallback(
    (kind: CardKind) => {
      const markdown = getMarkdown();
      setCard({ kind, markdown, docKey: docKey || hashText(markdown) });
    },
    [getMarkdown, docKey],
  );

  /** 打开微信文章：只带 md 快照，产物是剪贴板 HTML（不涉及草稿） */
  const openArticle = useCallback(() => {
    setArticle(getMarkdown());
  }, [getMarkdown]);

  /** 打开微博：只带 md 快照，产物是文案 + 方形配图 */
  const openWeibo = useCallback(() => {
    setWeibo(getMarkdown());
  }, [getMarkdown]);

  /** 打开海报：只带 md 快照，产物是四规格 PNG */
  const openPoster = useCallback(() => {
    setPoster(getMarkdown());
  }, [getMarkdown]);

  /** HTML：自包含单文件，直接下载（无中间弹窗，不存在可调参数） */
  const downloadHtml = useCallback(() => {
    const { name, blob } = renderHtmlArtifact(parseDoc(getMarkdown()));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [getMarkdown]);

  // Esc 关闭菜单（卡片弹窗各自处理自己的 Esc）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const groups = useMemo<ExportGroup[]>(
    () => [
      {
        id: 'image',
        label: 'Image',
        items: [
          {
            id: 'xhs',
            label: 'Xiaohongshu post card',
            hint: '3:4 · PNG (pages + copy)',
            icon: <ImageDown className="h-4 w-4" />,
            run: () => openCard('xhs'),
          },
          {
            id: 'share',
            label: 'Brand share card',
            hint: 'PNG',
            icon: <LayoutGrid className="h-4 w-4" />,
            run: () => openCard('share'),
          },
          {
            id: 'poster',
            label: 'Design poster',
            hint: '1:1 / 3:4 / 9:16 / long · PNG',
            icon: <Frame className="h-4 w-4" />,
            run: openPoster,
          },
        ],
      },
      {
        id: 'article',
        label: 'Article',
        items: [
          {
            id: 'wechat',
            label: 'WeChat article',
            hint: 'Inline HTML → paste into 公众号',
            icon: <Newspaper className="h-4 w-4" />,
            run: openArticle,
          },
          {
            id: 'weibo',
            label: 'Weibo post',
            hint: '≤140-char hook + square PNG',
            icon: <AtSign className="h-4 w-4" />,
            run: openWeibo,
          },
        ],
      },
      {
        id: 'document',
        label: 'Document',
        items: [
          {
            id: 'html',
            label: 'HTML document',
            hint: 'Self-contained .html (no resources)',
            icon: <FileCode2 className="h-4 w-4" />,
            run: downloadHtml,
          },
        ],
      },
    ],
    [openCard, openArticle, openWeibo, openPoster, downloadHtml],
  );

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.25)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <div
            className="w-[440px] rounded-2xl overflow-hidden"
            style={{
              backgroundColor: 'var(--paper)',
              border: '1px solid var(--line)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.04)',
            }}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid var(--line)' }}>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                Export
              </h2>
              <Button onClick={onClose} variant="ghost" tone="neutral" size="icon" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* 分组条目 */}
            <div className="px-3 py-2.5">
              {groups.map((g, gi) => (
                <div key={g.id}>
                  {gi > 0 && <div className="mx-2 my-1.5" style={{ borderTop: '1px solid var(--line-soft)' }} />}
                  <div className="px-2 pb-1 pt-1.5 text-11 font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                    {g.label}
                  </div>
                  {g.items.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => {
                        // 先收起菜单遮罩再交给产物面板 / 弹窗，避免两层遮罩叠加
                        onClose();
                        it.run();
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--paper-hover)]"
                    >
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                        style={{ color: 'var(--ink-muted)', backgroundColor: 'color-mix(in oklab, var(--ink) 6%, transparent)' }}
                      >
                        {it.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-13" style={{ color: 'var(--ink)' }}>
                          {it.label}
                        </span>
                        <span className="block truncate text-11" style={{ color: 'var(--ink-muted)' }}>
                          {it.hint}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 卡片产物：md 快照 + 草稿身份交给已有面板（同一文档草稿复用，不同文档互不覆盖） */}
      {card?.kind === 'xhs' && (
        <XhsPanel markdown={card.markdown} docKey={card.docKey} open onClose={() => setCard(null)} />
      )}
      {card?.kind === 'share' && (
        <ShareCard markdown={card.markdown} docKey={card.docKey} open onClose={() => setCard(null)} />
      )}
      {/* 文章产物：剪贴板 HTML（公众号）+ 纯文本兜底 */}
      {article !== null && (
        <WeChatArticleDialog markdown={article} open onClose={() => setArticle(null)} />
      )}
      {/* 微博产物：≤140 字文案 + 方形配图（1:1 / 4:3） */}
      {weibo !== null && <WeiboDialog markdown={weibo} open onClose={() => setWeibo(null)} />}
      {/* 海报产物：保留完整排版，四规格 PNG */}
      {poster !== null && <PosterDialog markdown={poster} open onClose={() => setPoster(null)} />}
    </>
  );
}
