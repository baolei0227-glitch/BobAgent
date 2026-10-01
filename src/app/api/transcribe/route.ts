import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, extname, basename } from 'path';
import { homedir, tmpdir } from 'os';
import { getCurrentProject } from '@/lib/project/project-manager';
import { SANDBOX_DIRNAME } from '@/lib/app-root';

/**
 * POST /api/transcribe — 语音转写（录音字节 → 纯文字）
 *
 * body: { data: string(base64), fileName: string }
 *
 * 用途：聊天输入框「语音输入」录音结束即转文字并回填输入框。
 * 转写引擎与 transcribe_audio 工具同源（settings.stt，见 lib/parse/audio-parser）；
 * 音频只落临时文件、用完即删，不进 materials/ 也不进附件列表。
 *
 * 返回: { success: true, text } | { success: false, error }
 */

export const maxDuration = 120;

/** 当前项目根路径（无激活项目时回退 ~/BobWork/.sandbox；仅用于转写缓存目录） */
async function projectRootPath(): Promise<string> {
  try {
    const project = await getCurrentProject();
    return project.path;
  } catch {
    return join(homedir(), 'BobWork', SANDBOX_DIRNAME);
  }
}

export async function POST(request: NextRequest) {
  let tmpPath = '';
  try {
    const body = await request.json().catch(() => ({}));
    const data = typeof body?.data === 'string' ? body.data : '';
    const fileName = typeof body?.fileName === 'string' ? basename(body.fileName) : '';
    if (!data || !fileName) {
      return NextResponse.json({ success: false, error: 'data and fileName are required' }, { status: 400 });
    }
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) {
      return NextResponse.json({ success: false, error: 'Empty audio payload' }, { status: 400 });
    }

    // parseAudio 以文件路径为输入（并按内容 hash 缓存转写结果），故先落临时文件；
    // 扩展名必须保留：音频容器/编码由扩展名推断
    tmpPath = join(tmpdir(), `bob-voice-${Date.now()}${extname(fileName) || '.webm'}`);
    await fs.writeFile(tmpPath, buffer);

    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const { parseAudio } = await import('@/lib/parse/audio-parser');
    const settings = await readSettingsFromFile();
    const result = await parseAudio(tmpPath, await projectRootPath(), { stt: settings.stt });
    const text = (result.plain_text ?? '').trim();
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