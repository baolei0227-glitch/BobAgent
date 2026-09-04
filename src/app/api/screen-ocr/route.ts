import { NextResponse } from 'next/server';

/**
 * POST /api/screen-ocr — 全局截图 OCR 的 HTTP 入口（dev/web 模式测试用）
 *
 * 与 Electron 主进程的 Cmd+Shift+O 全局快捷键共用同一核心模块（src/lib/screen-ocr/capture.ts）：
 * 触发系统选区截屏（用户拖拽区域，Esc 取消）→ OCR → 返回纯文本。
 *
 * 注意：请求会阻塞直到用户完成选区（最长 120s），仅供手动测试/调试；
 * 正式使用请走 Electron 全局快捷键（无需 HTTP 往返）。
 */

export const runtime = 'nodejs';

export async function POST() {
  try {
    const { captureRegionAndOcr } = await import('@/lib/screen-ocr/capture');
    const result = await captureRegionAndOcr();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
