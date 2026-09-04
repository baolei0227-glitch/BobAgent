'use client';

import { useEffect, useState } from 'react';
import { DocEditor } from '../DocEditor';
import type { ViewerRenderProps } from './types';

/** 剥离 YAML frontmatter */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return raw;
  return raw.slice(end + 4).replace(/^\s*\n/, '');
}

/** 嵌入语法检测：只读预览需要服务端展开（![[路径]]）时触发 */
function hasEmbed(raw: string): boolean {
  return /!\[\[[^\]\n]+\]\]/.test(raw);
}

/**
 * Markdown 渲染器：封装 DocEditor 为渲染器插件。
 * 处理节点模式（nodeMdId）与文件模式（filePath）两种场景。
 * 只读预览（阅读展开）：文件含嵌入语法时，从服务端拉取展开后的内容（expand=1）。
 */
export function MdViewer({
  fileInfo,
  source,
  nodeMdId,
  filePath,
  projectId,
}: ViewerRenderProps) {
  const editable = !!(nodeMdId || (filePath && (source === 'project' || source === 'local')));
  const [content, setContent] = useState<string>(() => stripFrontmatter(fileInfo?.content ?? ''));

  useEffect(() => {
    const raw = fileInfo?.content ?? '';
    // 编辑态保留嵌入卡片；无文件或未含嵌入语法时直接用原始内容
    if (editable || !filePath || !hasEmbed(raw)) {
      setContent(stripFrontmatter(raw));
      return;
    }
    let cancelled = false;
    // 只读阅读：服务端展开嵌入后渲染，相对路径以本文档所在目录为基准
    fetch(`/api/local-files?action=read_file&expand=1&path=${encodeURIComponent(filePath)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.success) setContent(stripFrontmatter(d.content as string));
      })
      .catch(() => { /* 展开失败则回退原始内容 */ });
    return () => {
      cancelled = true;
    };
  }, [editable, filePath, fileInfo?.content]);

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      data-reader-content
    >
      <DocEditor
        content={content}
        nodeMdId={nodeMdId || null}
        filePath={filePath}
        projectId={projectId}
        source={source}
        editable={editable}
      />
    </div>
  );
}
