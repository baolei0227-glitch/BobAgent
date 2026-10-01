import { promises as fs } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { SPEECH_CHUNK_CHARS } from '@/lib/tts/plain-text';
import {
  getLocalTtsStatus,
  isLocalTtsSupported,
  removeLocalTtsModel,
  startLocalTtsJob,
  synthesizeWithSherpa,
} from '@/lib/tts/sherpa-local';
import { readSettingsFromFile } from '@/lib/settings-server';

/**
 * /api/tts/local — 本地 TTS 能力探测与管理（本地神经 sherpa-onnx）
 *
 * GET ：返回平台是否支持、本地神经模型安装状态、当前下载任务，
 *       以及按当前已配置引擎给出的**建议分段长度**（本地神经合成较慢，分段更小以压低首字延迟）。
 * POST：body { action: 'binary' }                                    下载共享引擎（sherpa-onnx shared 包）
 *       body { action: 'model', modelId: '...' }                     下载指定本地神经模型
 *       body { action: 'delete', modelId: '...' }                    删除已下载模型（释放磁盘）
 *       body { action: 'preview', modelId, voiceId?, referenceAudio?, referenceText? }
 *                                                                    试听：合成一句样例，直接回 WAV 二进制
 *                                                                    （voiceId 仅多音色预置模型用；reference* 仅零样本克隆模型需要；缺省均回落到已保存设置）
 *
 * 下载在后台进行（大文件耗时较长），POST 立即返回，由 GET 轮询进度；
 * 删除/试听是同步操作。
 */

export const maxDuration = 120;

/** 本地神经引擎（预置模型）的建议分段长度：段太长会让首字等待明显 */
const LOCAL_NEURAL_CHUNK_CHARS = 800;
/** 零样本克隆（ZipVoice）每段都要重跑参考音编码，首字等待更明显，故再降一档 */
const ZERO_SHOT_CHUNK_CHARS = 400;

/** 试听样例（中文为主，兼顾音色辨识度） */
const PREVIEW_TEXT = '你好，这是本地神经网络语音合成的试听效果。';

export async function GET() {
  try {
    const supported = isLocalTtsSupported();
    const status = await getLocalTtsStatus();
    // 建议分段长度取决于**当前已配置的引擎**：只有本地神经引擎才需要更小的段
    let provider = '';
    let localModelId = '';
    try {
      const tts = (await readSettingsFromFile()).tts;
      provider = tts?.provider || '';
      localModelId = tts?.localModel || '';
    } catch {
      /* 读取失败按默认分段，不阻断探测 */
    }
    // 零样本克隆每段都要重跑参考音编码，分段再降一档
    const zeroShot = status.models.find((m) => m.id === localModelId)?.kind === 'zero-shot';
    const suggestedChunkChars =
      provider !== 'sherpa-local'
        ? SPEECH_CHUNK_CHARS
        : zeroShot
          ? ZERO_SHOT_CHUNK_CHARS
          : LOCAL_NEURAL_CHUNK_CHARS;
    return NextResponse.json({
      success: true,
      supported,
      provider,
      suggestedChunkChars,
      engine: status.engine,
      models: status.models,
      job: status.job,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    if (body?.action === 'delete') {
      const modelId = typeof body?.modelId === 'string' ? body.modelId : '';
      if (!modelId) throw new Error('modelId is required to delete a model');
      await removeLocalTtsModel(modelId);
      return NextResponse.json({ success: true, ...(await getLocalTtsStatus()) });
    }

    if (body?.action === 'preview') {
      const modelId = typeof body?.modelId === 'string' ? body.modelId : '';
      if (!modelId) throw new Error('modelId is required for a preview');
      // 零样本克隆的参考音：优先用 UI 传来的当前表单值（可能尚未保存）；字段缺省时回落到已保存设置
      const persisted = await readSettingsFromFile().catch(() => null);
      const reference = {
        audio: typeof body?.referenceAudio === 'string' ? body.referenceAudio : persisted?.tts?.localRefAudio,
        text: typeof body?.referenceText === 'string' ? body.referenceText : persisted?.tts?.localRefText,
      };
      // 多音色预置的音色：同上，优先 UI 当前值
      const voice = typeof body?.voiceId === 'string' ? body.voiceId : persisted?.tts?.localVoice;
      const result = await synthesizeWithSherpa(PREVIEW_TEXT, { modelId, voice, reference });
      const buf = await fs.readFile(result.filePath);
      await fs.rm(result.filePath, { force: true }).catch(() => undefined);
      return new NextResponse(new Uint8Array(buf), {
        headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
      });
    }

    const action = body?.action === 'model' ? 'model' : 'binary';
    const modelId = typeof body?.modelId === 'string' ? body.modelId : undefined;
    const job = startLocalTtsJob(action, modelId);
    return NextResponse.json({ success: true, job });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}