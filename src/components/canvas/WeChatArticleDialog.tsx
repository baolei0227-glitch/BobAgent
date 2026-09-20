'use client';

/**
 * WeChatArticleDialog — 微信文章导出（P1-1）。
 *
 * 产物不是图片而是「序列化器」：公众号编辑器剥离 `<style>`/class，只认 inline style，
 * 因此这里用 `renderWechatArticle` 把 DocIR 转成全内联样式的白名单 HTML，
 * 再用 `ClipboardItem` 双格式（text/html + text/plain）写入剪贴板，用户直接粘进公众号编辑器。
 *
 * 外链图片在公众号不显示 → 面板内单独提示，首版由用户手动上传替换（方案 §9）。
 */

import { useCallback, useMemo, useState } from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseDoc } from '@/lib/md-export/ir';
import { WECHAT_SPEC, renderWechatArticle } from '@/lib/md-export/targets/wechat';
import { checkDoc } from '@/lib/md-export/check';
import { CheckReport } from './CheckReport';

export interface WeChatArticleDialogProps {
  open: boolean;
  onClose: () => void;
  /** 当前文档 markdown 快照（打开瞬间取，避免编辑过程中途变化） */
  markdown: string;
}

export function WeChatArticleDialog({ open, onClose, markdown }: WeChatArticleDialogProps) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');

  const { ir, article, checks, imageCount } = useMemo(() => {
    const doc = parseDoc(markdown, { source: 'md-file' });
    return {
      ir: doc,
      article: renderWechatArticle(doc),
      checks: checkDoc(doc, WECHAT_SPEC),
      imageCount: doc.blocks.filter((b) => b.t === 'image').length,
    };
  }, [markdown]);

  const empty = ir.blocks.length === 0;

  /** 双格式写入剪贴板；不支持 ClipboardItem 时退化为纯文本 */
  const handleCopyHtml = useCallback(async () => {
    if (busy || empty) return;
    setBusy(true);
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          'text/html': new Blob([article.html], { type: 'text/html' }),
          'text/plain': new Blob([article.text], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([item]);
      } else {
        await navigator.clipboard.writeText(article.text);
      }
      setFlash('copy');
      setTimeout(() => setFlash(''), 1500);
    } catch (e) {
      console.warn('[WeChatArticleDialog] clipboard write failed:', e);
      setFlash('error');
      setTimeout(() => setFlash(''), 2500);
    } finally {
      setBusy(false);
    }
  }, [busy, empty, article]);

  const handleCopyText = useCallback(async () => {
    if (busy || empty) return;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(article.text);
      setFlash('copy');
      setTimeout(() => setFlash(''), 1500);
    } catch (e) {
      console.warn('[WeChatArticleDialog] clipboard writeText failed:', e);
      setFlash('error');
      setTimeout(() => setFlash(''), 2500);
    } finally {
      setBusy(false);
    }
  }, [busy, empty, article]);

  if (!open) return null;

  return (
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
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>WeChat article</h2>
            <p className="text-11" style={{ color: 'var(--ink-muted)' }}>
              Inline-styled HTML → copy and paste into the 公众号 editor
            </p>
          </div>
          <Button onClick={onClose} variant="ghost" tone="neutral" size="icon" aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* 主体：左预览 / 右体检 */}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-auto p-5" style={{ backgroundColor: 'var(--paper-soft)' }}>
            <div
              className="mx-auto"
              style={{ width: 375, backgroundColor: '#FFFFFF', borderRadius: 12, padding: '20px 16px', color: '#3f3f3f' }}
              // 产物由本模块自行转义生成（esc），不含外部 HTML
              dangerouslySetInnerHTML={{ __html: article.html }}
            />
          </div>

          <div className="w-[300px] shrink-0 overflow-auto p-4" style={{ borderLeft: '1px solid var(--line)' }}>
            <CheckReport items={checks} />
            {imageCount > 0 && (
              <p className="mt-3 text-11 leading-snug" style={{ color: 'var(--ink-muted)' }}>
                {imageCount} image{imageCount > 1 ? 's' : ''}: external images won&apos;t render on 公众号 —
                re-upload them in the editor after pasting.
              </p>
            )}
            {empty && (
              <p className="mt-3 text-11" style={{ color: 'var(--ink-muted)' }}>Nothing to export — the document is empty.</p>
            )}
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between gap-3 px-5 py-3" style={{ borderTop: '1px solid var(--line)' }}>
          <span className="text-11" style={{ color: flash === 'error' ? '#D9534F' : 'var(--ink-muted)' }}>
            {flash === 'copy' ? 'Copied to clipboard' : flash === 'error' ? 'Copy failed — check clipboard permission' : 'Paste into the editor, then re-upload images.'}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" tone="neutral" size="sm" onClick={handleCopyText} disabled={busy || empty}>
              Copy plain text
            </Button>
            <Button type="button" variant="solid" size="sm" onClick={handleCopyHtml} disabled={busy || empty}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : flash === 'copy' ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              Copy for WeChat
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
