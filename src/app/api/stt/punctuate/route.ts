import { NextRequest, NextResponse } from 'next/server';
import { punctuateText } from '@/lib/stt/sherpa';

/**
 * /api/stt/punctuate — 给一段裸文本补标点/断句（实时语音输入的可选增强）
 *
 * POST body { text } → { success, text }
 *
 * 谁在用：renderer 的实时链路在每段定稿（is_final）与按 ✓ 收尾时各调一次，
 * 让 zipformer 输出的裸字带上标点与句读（飞书那种观感）。
 *
 * 未下载标点模型时 sherpa.punctuateText 直接原样返回——不是错误，前端无需分支判断；
 * 真正的失败（没传 text）才 400。
 */

// 单次标点含进程启动 + 模型加载（实测 0.15–0.32s），给足余量
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) throw new Error('Missing text.');
    const punctuated = await punctuateText(text);
    return NextResponse.json({ success: true, text: punctuated });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}