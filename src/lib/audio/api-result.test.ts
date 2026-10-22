import { describe, expect, it } from 'vitest';
import { readApiResult } from '@/lib/audio/api-result';

/**
 * `readApiResult` 的存在理由只有一个：**响应体不是 JSON 时，仍然让调用方拿到可读原因**。
 *
 * 旧写法 `resp.json()` 在这种情形下抛 → 被吞成 `null` → 打点静默丢数据。
 * 所以本测试的重点不是「正常 JSON 能解析」（那本来就没事），而是**异常体形态的兜底**，
 * 且必须验证返回的**不是 `null`、也不把整页 HTML 当错误文案抛给用户**。
 */
describe('readApiResult', () => {
  it('合法 JSON 成功体：原样透传（含业务字段）', async () => {
    const resp = new Response(JSON.stringify({ success: true, marks: [{ t: 1 }], clips: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await readApiResult(resp)).toEqual({ success: true, marks: [{ t: 1 }], clips: [] });
  });

  it('合法 JSON 业务失败体：原样透传真实原因（调用方据此显示）', async () => {
    const resp = new Response(JSON.stringify({ success: false, error: 'path is required' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await readApiResult(resp)).toEqual({ success: false, error: 'path is required' });
  });

  it('🔴 HTML 错误页（框架 500 的默认形态）：给出可读状态，而不是抛/返回 null', async () => {
    const html = '<!DOCTYPE html><html><body><h1>500 Internal Server Error</h1></body></html>';
    const resp = new Response(html, { status: 500, statusText: 'Internal Server Error', headers: { 'Content-Type': 'text/html' } });

    const r = await readApiResult(resp);

    expect(r).not.toBeNull();
    expect(r.success).toBe(false);
    expect(r.error).toBe('HTTP 500 Internal Server Error');
    // 关键负向断言：不得把整页 HTML 当成错误文案丢给用户界面
    expect(String(r.error)).not.toContain('<html');
  });

  it('空响应体：仍给出可读状态', async () => {
    const resp = new Response('', { status: 502, statusText: 'Bad Gateway' });
    const r = await readApiResult(resp);
    expect(r).toEqual({ success: false, error: 'HTTP 502 Bad Gateway' });
  });

  it('JSON 但不是对象（`123` / `"ok"` / `null`）：走兜底而非透传', async () => {
    for (const body of ['123', '"ok"', 'null']) {
      const resp = new Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });
      const r = await readApiResult(resp);
      // 透传的话调用方拿不到 `success` 字段，`d?.success` 判定会退化成「静默成功」
      expect(r.success).toBe(false);
      expect(r.error).toBe('HTTP 200 OK');
    }
  });

  it('截断的 JSON（非 JSON 体的一种）：走兜底而非抛错', async () => {
    const resp = new Response('{"success":true,"mar', { status: 200, statusText: 'OK' });
    const r = await readApiResult(resp);
    expect(r).toEqual({ success: false, error: 'HTTP 200 OK' });
  });

  it('不变式：一切失败形态都必须返回「success===false 且 error 为非空字符串」', async () => {
    const cases: Array<[string, Response]> = [
      ['html-500', new Response('<html>oops</html>', { status: 500 })],
      ['empty-504', new Response('', { status: 504 })],
      ['scalar-json', new Response('42', { status: 200 })],
      ['truncated', new Response('{"a":', { status: 200 })],
      ['html-200', new Response('<html>portal</html>', { status: 200 })],
    ];
    for (const [name, resp] of cases) {
      const r = await readApiResult(resp);
      expect(r, name).toBeTypeOf('object');
      expect(r.success, name).toBe(false);
      expect(typeof r.error, name).toBe('string');
      expect(String(r.error).length, name).toBeGreaterThan(0);
    }
  });
});
