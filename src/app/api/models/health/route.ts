import { NextRequest, NextResponse } from 'next/server';
import { sanitizeBaseUrl } from '@/lib/types';

interface HealthRequest {
  baseUrl?: string;
  apiKey?: string;
}

const HEALTH_TIMEOUT_MS = 3000;

/**
 * 轻量连接探测（模型下拉"本地未连接"标注用）：
 * 仅接受本地回环 baseUrl（localhost / 127.0.0.1 / [::1] / 0.0.0.0），避免服务端 SSRF 到内网/公网地址。
 * 判定口径：只要网络层拿到任意 HTTP 响应（含 401/404）即视为"在线"——用户关闭本地服务通常是
 * 连接被拒/超时（ECONNREFUSED），而不是 HTTP 状态码异常；404 可能只是路径不含 /models（如原生 Ollama）。
 */
export async function POST(request: NextRequest) {
  let body: HealthRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const finalBaseUrl = sanitizeBaseUrl(body.baseUrl || '');
  if (!finalBaseUrl) {
    return NextResponse.json({ ok: false, error: 'Missing baseUrl' });
  }

  const isLocalLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|[/])/i.test(finalBaseUrl) ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(finalBaseUrl);
  if (!isLocalLoopback) {
    return NextResponse.json({ ok: false, error: 'Not a local endpoint' });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Aborted', 'AbortError')), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${finalBaseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: body.apiKey ? `Bearer ${body.apiKey}` : '',
        'Content-Type': 'application/json',
      },
      signal: ctrl.signal,
    });
    return NextResponse.json({ ok: true, status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message });
  } finally {
    clearTimeout(timer);
  }
}