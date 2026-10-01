import { describe, expect, it } from 'vitest';
import { isBrowserDoc, matchRenderer } from '@/components/canvas/viewers/registry';
import type { FileInfo } from '@/lib/files/types';

/** 构造最小二进制 FileInfo（docx/doc 的 read_file 返回 type='binary'） */
function bin(name: string): FileInfo {
  const dot = name.lastIndexOf('.');
  return {
    name,
    type: 'binary',
    extension: dot > 0 ? name.slice(dot) : '',
    size: 1024,
  };
}

/**
 * docx 分发回归（2026-09-30：从「Hippo 内置整页 /docx-editor」迁回预览面板）
 *
 * 这两条断言是迁移的核心不变量：一旦有人把 docx 加回 BROWSER_DOC_RE，
 * 或把 docx 注册项挪到 binary 之后，docx 就会静默回到错误的分发路径。
 */
describe('docx 分发', () => {
  it('docx/doc 不再交给 Hippo（否则会落到已下线的 /docx-editor）', () => {
    expect(isBrowserDoc('a.docx')).toBe(false);
    expect(isBrowserDoc('a.doc')).toBe(false);
  });

  it('其余浏览器文档仍交 Hippo（回归保护）', () => {
    expect(isBrowserDoc('a.pdf')).toBe(true);
    expect(isBrowserDoc('a.html')).toBe(true);
    expect(isBrowserDoc('a.png')).toBe(true);
    expect(isBrowserDoc('a.md')).toBe(false);
  });

  it('docx/doc 命中 docx 渲染器，而不是 binary 兜底', () => {
    expect(matchRenderer('docx', bin('a.docx'))?.id).toBe('docx');
    expect(matchRenderer('doc', bin('a.doc'))?.id).toBe('docx');
  });

  it('docx 渲染器声明自持缩放（外层不再套 CSS zoom，避免双重缩放）', () => {
    expect(matchRenderer('docx', bin('a.docx'))?.ownsZoom).toBe(true);
  });

  it('未知二进制类型仍回落到 binary 渲染器', () => {
    expect(matchRenderer('bin', bin('a.bin'))?.id).toBe('binary');
  });
});
