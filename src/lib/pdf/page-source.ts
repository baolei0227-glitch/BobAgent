/**
 * 页面 URL → 可提取的 PDF 源
 *
 * Hippo Browser 打开 PDF 时地址栏保持原始 URL（Chromium 用内置查看器渲染，不改 URL），
 * 所以三种形态在这里归一：本地查看页（/pdf-viewer?path=）/ file: / http(s)。
 * 能直接给出本地路径的走本地，远端的下载到临时目录再交给提取器。
 *
 * 由两条链路共用：模型侧工具 browser_read_pdf（chat/tools/browser.ts）
 * 与右侧对话栏的「内容」按钮（/api/hippo/pdf-text）。
 */
import { writeFile, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

/** 当前页面地址 → 本地 PDF 路径（本地查看页 / file:）或远程 URL */
export function pdfPathFromUrl(url: string): { local?: string; remote?: string } {
  try {
    const u = new URL(url);
    if (u.pathname === '/pdf-viewer') {
      const p = u.searchParams.get('path');
      return { local: p ? decodeURIComponent(p) : undefined };
    }
    if (u.protocol === 'file:' && /\.pdf$/i.test(u.pathname)) return { local: fileURLToPath(u) };
    if (/^https?:$/.test(u.protocol) && /\.pdf($|[?#])/i.test(url)) return { remote: url };
  } catch { /* 非 URL 形态 */ }
  return {};
}

/** 远程 PDF 下载到临时目录，返回本地路径（下载失败抛错，由调用方决定怎么报） */
export async function downloadToTemp(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 PDF 失败 (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), 'hippo-pdf-'));
  const abs = join(dir, 'document.pdf');
  await writeFile(abs, buf);
  return abs;
}