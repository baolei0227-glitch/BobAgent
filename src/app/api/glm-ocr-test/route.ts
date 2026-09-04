import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = 'glm-ocr';
// 测试用 PNG：640×240 白底黑字 "GLM OCR 2026 / Invoice 8848"（PIL 生成）。
// 智谱 layout_parsing 对纯色/过小图返回 1214「图片/PDF 非法」，必须用带文字内容的有效图。
// 此图已实测：HTTP 200，md_results 含 "GLM OCR"。
// PNG 以文件形式存放 public/，运行时读取，避免 base64 在源码中被截断/篡改。
let cachedTestPng: string | null = null;
function getTestPngDataUrl(): string {
  if (cachedTestPng) return cachedTestPng;
  const paths = [
    join(process.cwd(), 'public', 'glm-ocr-test.png'),
    join(process.cwd(), '..', 'public', 'glm-ocr-test.png'),
  ];
  for (const p of paths) {
    try {
      const buf = readFileSync(p);
      cachedTestPng = `data:image/png;base64,${buf.toString('base64')}`;
      return cachedTestPng;
    } catch { /* try next */ }
  }
  throw new Error('测试图片 glm-ocr-test.png 未找到');
}

export async function POST(request: NextRequest) {
  let body: { apiKey?: string; baseUrl?: string; runSample?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON body' }, { status: 400 });
  }

  const apiKey = (body.apiKey || '').trim();
  if (!apiKey) {
    return NextResponse.json({ ok: false, message: 'Missing API Key' }, { status: 400 });
  }

  const baseUrl = (body.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (/[\u0080-\uFFFF]/.test(baseUrl)) {
    return NextResponse.json(
      { ok: false, message: 'Base URL 包含非法字符（如中文），请检查后重试。' },
      { status: 400 }
    );
  }

  const isSample = body.runSample === true;
  const timeoutMs = isSample ? 25000 : 20000;

  let filePayload: string;
  try {
    filePayload = getTestPngDataUrl();
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : 'Failed to load test image' }, { status: 500 });
  }

  try {
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/layout_parsing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, file: filePayload, need_layout_visualization: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - t0;

    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ ok: false, message: 'API Key 无效（401/403），请检查智谱 API Key。' });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json({
        ok: false,
        message: `请求失败（${res.status}）：${text.slice(0, 200)}`,
        ms,
      });
    }

    const data = (await res.json()) as { md_results?: string; data_info?: { num_pages?: number } };
    const markdown = (data.md_results || '').trim();
    const charCount = [...markdown].length;

    if (isSample) {
      return NextResponse.json({
        ok: true,
        message: charCount > 0
          ? `Sample OCR 成功 - 识别到 ${charCount} 字符，耗时 ${ms}ms。前 60 字：${markdown.slice(0, 60)}${markdown.length > 60 ? '…' : ''}`
          : `Sample OCR 返回为空（可能 sample 图过小未能识别），但 HTTP 200 - 模型确实被调用了，耗时 ${ms}ms。`,
        ms,
        charCount,
        preview: markdown.slice(0, 200),
        numPages: data.data_info?.num_pages ?? 1,
      });
    }

    return NextResponse.json({ ok: true, message: `Connection OK - API Key 有效（${ms}ms）。` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, message: `连接失败: ${message}` }, { status: 500 });
  }
}
