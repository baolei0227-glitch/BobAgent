import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLocalSttBinaryInstalled, isLocalSttModelReady, sherpaTranscribe } from '@/lib/stt/sherpa';
import { readSettingsFromFile } from '@/lib/settings-server';

/**
 * /api/stt/finalize — 实时语音输入的「收尾定稿」
 *
 * POST body { data: base64(wav) } → { success, text }
 *
 * 为什么有它：实时链路用 zipformer（边说边出字），但它只出裸字，准确度也不如批量模型。
 * 按 ✓ 时把整段录音交给**本地离线引擎**（设置里选定的那个，通常是 SenseVoice small）重转一次，
 * 用它作为定稿覆盖草稿——即「实时优先 + 定稿更准」的组合，与 /api/transcribe 的录制链路各管一段。
 *
 * 三个硬约定：
 *   ① **只走本地**，完全不看云端设置：实时链路承诺音频不出网，收尾也不能例外。
 *      没选本地离线引擎 / 模型未就绪 → 409 + skipped，调用方保持已有文本即可（不是错误）。
 *   ② 音频只落临时文件、用完即删（与 /api/transcribe 同口径）。
 *   ③ **不分块、不加时间戳**：口述通常几十秒，整段一次解码的上下文最好；
 *      也避免 parseAudio 多块时加的 [mm:ss] 前缀污染草稿。
 */

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  let tmpPath = '';
  try {
    const body = await request.json().catch(() => ({}));
    const data = typeof body?.data === 'string' ? body.data : '';
    if (!data) {
      return NextResponse.json({ success: false, error: 'data is required' }, { status: 400 });
    }

    const settings = await readSettingsFromFile();
    const stt = settings.stt;
    const localModel = stt?.provider === 'sherpa-local' ? String(stt.localModel || '') : '';
    if (!localModel) {
      return NextResponse.json(
        { success: false, skipped: true, error: 'No local offline STT model selected.' },
        { status: 409 },
      );
    }
    if (!(await isLocalSttBinaryInstalled())) {
      return NextResponse.json(
        { success: false, skipped: true, error: 'Local STT engine not installed.' },
        { status: 409 },
      );
    }
    if (!(await isLocalSttModelReady(localModel))) {
      return NextResponse.json(
        { success: false, skipped: true, error: `Local STT model not ready: ${localModel}` },
        { status: 409 },
      );
    }

    const buffer = Buffer.from(data, 'base64');
    // 44 字节是 WAV 头的最小长度，小于等于它说明没带音频内容
    if (buffer.length <= 44) {
      return NextResponse.json({ success: false, error: 'Empty audio payload' }, { status: 400 });
    }
    tmpPath = path.join(os.tmpdir(), `bob-voice-final-${Date.now()}.wav`);
    await fs.writeFile(tmpPath, buffer);

    const text = (await sherpaTranscribe(tmpPath, localModel)).trim();
    if (!text) {
      return NextResponse.json({ success: false, error: 'No speech recognized' }, { status: 422 });
    }
    return NextResponse.json({ success: true, text });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  } finally {
    if (tmpPath) await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}