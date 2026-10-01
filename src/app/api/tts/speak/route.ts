import { NextRequest } from 'next/server';
import { readFile, readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import { readSettingsFromFile } from '@/lib/settings-server';
import { synthesizeSpeech, TtsNotConfiguredError } from '@/lib/tts';

/**
 * POST /api/tts/speak —— 「朗读这段文字」(Read aloud)
 *
 * 与 /api/tts/local（只读探测）不同，这里是**真正出声**的那一步：按设置里已选中的那一款
 * TTS 引擎（cloud / 本地神经 sherpa-onnx，互斥单选，不做自动兜底）合成，
 * 然后把音频字节**直接回给客户端**播放。
 *
 * 为什么不走 /api/attachments?path=：那条路只服务**项目相对路径**（materials/ 等），
 * 而 TTS 产物落在 <APP_ROOT>/butler/tts（应用根下的绝对路径），播不了。
 *
 * 请求：{ text: string }（≤ 2000 字符，超长由调用方分段——见 lib/tts/plain-text.ts 的 chunkForSpeech）
 * 响应：200 → 音频二进制（Content-Type 按**实际**格式给：云端 mp3 / 本地神经引擎 wav）
 *       400 → { code: 'empty' | 'too_long' | 'not_configured', error }（客户端就地提示，不静默失败）
 *       500 → { code: 'failed', error }
 *
 * 产物保留（同文本重复播放由客户端会话内缓存 blob 兜住），并按 TTL 顺手清理旧文件：
 * 本目录历史上只增不减，长跑会把磁盘啃穿。
 */

/** TTS 产物目录（与 lib/tts 落盘口径一致） */
function ttsDir(): string {
  return join(resolveAppRoot(), 'butler', 'tts');
}

/** 保留期：超过则下次调用时顺手删掉 */
const ARTIFACT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** 实际格式 → MIME（按引擎返回的实际格式映射，不能假设 mp3） */
function mimeOf(format: string): string {
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    flac: 'audio/flac',
  };
  return map[format.toLowerCase()] || 'application/octet-stream';
}

/** 顺手清理过期产物（best-effort：单条失败不影响本次播放，keep = 本次刚生成的文件不动） */
async function pruneOldArtifacts(keep: string): Promise<void> {
  try {
    const dir = ttsDir();
    const entries = await readdir(dir);
    const now = Date.now();
    await Promise.all(
      entries.map(async (name) => {
        const full = join(dir, name);
        if (full === keep) return;
        try {
          const st = await stat(full);
          if (st.isFile() && now - st.mtimeMs > ARTIFACT_KEEP_MS) await unlink(full);
        } catch {
          /* 已被并发清理或不存在：忽略 */
        }
      }),
    );
  } catch {
    /* 目录不存在等：忽略 */
  }
}

function jsonError(code: string, error: string, status: number): Response {
  return new Response(JSON.stringify({ code, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(request: NextRequest) {
  let text = '';
  try {
    const body = (await request.json()) as { text?: unknown };
    if (typeof body?.text === 'string') text = body.text;
  } catch {
    return jsonError('empty', 'Invalid request body — expected JSON { text }.', 400);
  }
  if (!text.trim()) return jsonError('empty', 'Nothing to speak.', 400);

  try {
    // 引擎 = 设置里那一个（用户选哪个用哪个）；未配置时 synthesizeSpeech 抛 TtsNotConfiguredError
    const settings = await readSettingsFromFile();
    const result = await synthesizeSpeech(text, settings.tts);
    const buf = await readFile(result.filePath);
    void pruneOldArtifacts(result.filePath);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': mimeOf(result.format),
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof TtsNotConfiguredError || (e instanceof Error && e.name === 'TtsNotConfiguredError')) {
      return jsonError(
        'not_configured',
        'No speech engine is configured. Pick one in Settings → Roles → Audio TTS Model: a cloud model (API key required) or an offline neural model.',
        400,
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    // 超长（调用方应已分段，这里兜底，别让 2000 字上限以 500 的面目出现）
    if (/too long/i.test(msg)) return jsonError('too_long', msg, 400);
    return jsonError('failed', msg, 500);
  }
}