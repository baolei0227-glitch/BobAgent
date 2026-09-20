'use client';

import { FileText, Film, Folder, Link2, Music, Paperclip, X } from 'lucide-react';
import type { MessageAttachment } from '@/lib/types';
import { formatFileSize, type ComposerLink } from './useComposer';

/**
 * 输入框上方的待发标签：附件（本地添加/粘贴/拖拽）与链接材料（粘贴 URL 自动识别）。
 * chat 与 team 输入栏共用；compact = team 侧窄栏的小字号形态。
 */
export default function ComposerChips({
  attachments,
  links,
  onRemoveAttachment,
  onRemoveLink,
  compact = false,
  className = 'mb-1.5',
}: {
  attachments: MessageAttachment[];
  links: ComposerLink[];
  onRemoveAttachment: (id: string) => void;
  onRemoveLink: (url: string) => void;
  compact?: boolean;
  className?: string;
}) {
  if (attachments.length === 0 && links.length === 0) return null;
  const nameCls = compact ? 'text-10' : 'text-xs';

  return (
    <>
      {attachments.length > 0 && (
        <div className={`${className} flex flex-wrap gap-0.5`}>
          {attachments.map((att) => (
            <span
              key={att.id}
              className="group inline-flex items-center gap-0.5 rounded-full px-1 py-px"
              style={{
                backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
                border: '1px solid var(--primary-soft)',
              }}
              title={`${att.name} (${formatFileSize(att.size)})`}
            >
              {att.type === 'image' && att.dataUrl ? (
                <img src={att.dataUrl} alt={att.name} className="h-3 w-3 rounded-sm object-cover" />
              ) : att.type === 'text' ? (
                <FileText className="h-2.5 w-2.5" style={{ color: '#537D96' }} />
              ) : att.type === 'folder' ? (
                <Folder className="h-2.5 w-2.5" style={{ color: 'var(--info)' }} />
              ) : att.type === 'video' ? (
                <Film className="h-2.5 w-2.5" style={{ color: 'var(--warn)' }} />
              ) : att.type === 'audio' ? (
                <Music className="h-2.5 w-2.5" style={{ color: 'var(--success)' }} />
              ) : (
                <Paperclip className="h-2.5 w-2.5" style={{ color: '#7a7260' }} />
              )}
              <span className={`max-w-[48px] truncate ${nameCls}`} style={{ color: 'var(--ink)' }}>
                {att.name}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveAttachment(att.id);
                }}
                className="ml-0 rounded-full p-px opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: 'var(--ink-muted)' }}
              >
                <X className="h-2 w-2" />
              </button>
            </span>
          ))}
        </div>
      )}

      {links.length > 0 && (
        <div className={`${className} flex flex-wrap gap-0.5`}>
          {links.map((link) => (
            <span
              key={link.url}
              className="group inline-flex items-center gap-0.5 rounded-full px-1.5 py-px"
              style={{
                backgroundColor: 'color-mix(in oklab, var(--info) 8%, transparent)',
                border: '1px solid color-mix(in oklab, var(--info) 25%, transparent)',
              }}
              title={link.url}
            >
              <Link2 className="h-2.5 w-2.5" style={{ color: 'var(--info)' }} />
              <span className={`max-w-[160px] truncate ${nameCls}`} style={{ color: 'var(--ink)' }}>
                {link.url}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveLink(link.url);
                }}
                className="ml-0.5 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)' }}
              >
                <X className="h-2 w-2" />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
