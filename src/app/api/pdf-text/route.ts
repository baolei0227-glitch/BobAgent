/**
 * POST /api/pdf-text —— 取 PDF 的正文文本
 *
 * 右侧对话栏的「内容」按钮在 PDF 页上走这条：面板在渲染进程里，调不到模型侧的
 * browser_read_pdf，所以由这里复用同一套 Python → pdf-parse 两级提取管线，
 * 把正文回注上下文（地址解析与下载与 browser_read_pdf 共用 @/lib/pdf/page-source）。
 *
 * 请求：{ url }  响应：{ ok, text, chars, truncated, method, pages } | { ok:false, error }
 */
import { downloadToTemp, pdfPathFromUrl } from '@/lib/pdf/page-source';

export const dynamic = 'force-dynamic';

/** 单次返回上限（字符）：面板侧还会按上下文预算再截断，这里只防超大文件撑爆响应 */
const MAX_CHARS = 40000;
/** 页数上限：与 browser_read_pdf 同口径 */
const MAX_PAGES = 500;

export async function POST(req: Request) {
  let url = '';
  try {
    url = String(((await req.json()) as { url?: unknown })?.url ?? '');
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const { local, remote } = pdfPathFromUrl(url);
  if (!local && !remote) return Response.json({ ok: false, error: `not a PDF URL: ${url}` });

  try {
    const abs = local || (await downloadToTemp(remote as string));
    const { extractWithPython, extractWithPdfParse } = await import('@/lib/pdf/core/extractor');
    const py = await extractWithPython(abs, MAX_PAGES);
    let text = py.text || '';
    let method = py.method;
    let pages = py.pageCount || 0;
    // Python 管线拿到的是空/碎片时，退到 pdf-parse 再试一次（两级提取，与 read_pdf 一致）
    if (text.trim().length <= 20) {
      const fb = await extractWithPdfParse(abs);
      if (fb.text && fb.text.trim().length > 20) {
        text = fb.text;
        method = fb.method;
        pages = fb.pageCount || pages;
      }
    }
    if (!text.trim()) {
      return Response.json({ ok: false, error: `no extractable text (${method || 'empty'}) — likely a scanned PDF` });
    }
    return Response.json({
      ok: true,
      text: text.slice(0, MAX_CHARS),
      chars: text.length,
      truncated: text.length > MAX_CHARS,
      method,
      pages,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}