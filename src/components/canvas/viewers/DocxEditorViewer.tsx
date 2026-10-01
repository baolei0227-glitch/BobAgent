'use client';

/**
 * DocxEditorViewer —— 预览面板内的 docx / doc 编辑器宿主
 *
 * 2026-09-30：docx 从「Hippo 内置整页 /docx-editor」迁回预览面板。
 *
 * 与旧的 DocxViewer（1633 行自研渲染器，已删）完全不同：这里只是一个**薄宿主**，
 * 把调度层（UnifiedViewer）已经准备好的 proxyUrl / fileInfo 原样交给宿主无关内核
 * DocxTiptapEditor —— 内核源码零改动即可换宿主（它的注释本来就写着「宿主无关」）。
 *
 * 迁移收益（整页里是坏的，面板里自动恢复）：
 *   · 「外部打开」走 desktop.openFile —— Hippo guest 无 preload 时静默失败，面板内 desktop 可用；
 *   · 「转 MD」后的 bus.publish(file.open) 在 Hippo 沙箱页无订阅者，面板内就是本组件所在的应用。
 *
 * 写回原稿仍走同一套 HTTP 通道（/api/local-files save_to_original + X-File-Mtime 哨兵），
 * 依赖 fileInfo.full_path —— 调度层的 read_file 响应已带该字段。
 */
import type { ViewerRenderProps } from './types';
import { DocxTiptapEditor } from '@/components/canvas/docx-editor/DocxTiptapEditor';

/** .doc 是 Word 97-2003 二进制格式（OLE 复合文档），内核只支持 OOXML（.docx） */
function LegacyDocNotice({ fileName }: { fileName: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-13 font-semibold">无法编辑：{fileName}</p>
      <p className="max-w-[420px] text-11 leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        .doc 是 Word 97-2003 的老式二进制格式（OLE 复合文档），当前编辑器内核只支持 OOXML（.docx）。
        请先用 Word 或 WPS 另存为 .docx 后再打开。
      </p>
    </div>
  );
}

export function DocxEditorViewer(props: ViewerRenderProps) {
  const { fileInfo, proxyUrl, fileName, source, onError } = props;
  const name = fileName || fileInfo.name || 'document.docx';
  const dot = name.lastIndexOf('.');
  const ext = (fileInfo.extension || (dot > 0 ? name.slice(dot) : '')).toLowerCase();

  if (ext === '.doc') return <LegacyDocNotice fileName={name} />;

  return (
    <DocxTiptapEditor fileInfo={fileInfo} proxyUrl={proxyUrl} fileName={name} source={source} onError={onError} />
  );
}
