import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import { resolveAppRoot } from '@/lib/app-root';
import { resolveFfmpegPath } from '@/lib/parse/audio-parser';

/**
 * /api/tts/local/refs — 零样本音色克隆（ZipVoice）的参考音上传
 *
 * POST（multipart/form-data）：字段 `file`（任意 ffmpeg 可解码的音频）→ 转码为
 * ZipVoice 要求的 24kHz 单声道 16-bit PCM wav，落 `<APP_ROOT>/.tts/refs/<sha256前8>.wav`，
 * 返回 { success, path }（绝对路径，调用方写入 settings.tts.localRefAudio）。
 *
 * 不落在 `butler/tts/`：该目录会被 api/tts/speak 的 pruneOldArtifacts 清理，用户资产不得放那里。
 * 同内容按 hash 去重；ffmpeg 缺失直接报错，不静默降级（否则会存下一份模型读不了的音频）。
 */

export const maxDuration = 60;

const CONVERT_TIMEOUT_MS = 60_000;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

const execFileAsync = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File) || file.size === 0) throw new Error('No audio file uploaded');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`Reference audio too large (${Math.round(file.size / 1024 / 1024)}MB > 30MB)`);
    }

    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) {
      throw new Error('ffmpeg unavailable: no bundled binary found and none on PATH — cannot convert the reference audio.');
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const refsDir = path.join(resolveAppRoot(), '.tts', 'refs');
    await fs.mkdir(refsDir, { recursive: true });
    // 内容 hash 命名：同一段音频重复上传天然去重，不会堆垃圾
    const outPath = path.join(refsDir, `${createHash('sha256').update(buf).digest('hex').slice(0, 8)}.wav`);

    if (!(await exists(outPath))) {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-tts-ref-'));
      const srcPath = path.join(tmpDir, `src${path.extname(file.name) || '.bin'}`);
      try {
        await fs.writeFile(srcPath, buf);
        await execFileAsync(
          ffmpegPath,
          ['-y', '-i', srcPath, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outPath],
          { timeout: CONVERT_TIMEOUT_MS },
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
      const size = await fs.stat(outPath).then((s) => s.size).catch(() => 0);
      if (size === 0) {
        await fs.rm(outPath, { force: true }).catch(() => undefined);
        throw new Error('Converted reference audio is empty — the file may not contain a decodable audio stream.');
      }
    }

    return NextResponse.json({ success: true, path: outPath });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
