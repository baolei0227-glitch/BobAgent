/**
 * Audio 场景工具：音频转写（transcribe_audio）+ 语音合成（text_to_speech）。
 * 从 tools/index.ts 抽出，导入路径保持不变（index.ts 通过 ...audioToolDefs 聚合）。
 */
import { resolve, join, sep } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';
import type { Tool } from './index';
import { truncate } from './shared';

/** 转写音频为文本（STT 引擎由设置决定；见 audio-parser） */
export async function toolTranscribeAudio(args: Record<string, unknown>): Promise<string> {
  const p = (args.path as string) || '';
  if (!p) return 'Error: 缺少 path 参数';
  try {
    const project = await getCurrentProject();
    // 防 ../ 穿越：resolve 后必须仍在 project.path 内
    const projectRoot = resolve(project.path);
    const filePath = resolve(join(projectRoot, p));
    if (!(filePath === projectRoot || filePath.startsWith(projectRoot + sep))) {
      return `Error: 音频路径 "${p}" 越出项目目录，拒绝访问。`;
    }
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    const { parseAudio } = await import('@/lib/parse/audio-parser');
    const result = await parseAudio(filePath, project.path, { stt: settings.stt });
    return truncate(result.extracted_text, 20000);
  } catch (e) {
    return `Error: 音频转写失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 合成语音并落盘（TTS 引擎由设置决定；见 lib/tts）——供"用语音回复/生成朗读版"场景 */
export async function toolTextToSpeech(args: Record<string, unknown>): Promise<string> {
  const text = (args.text as string) || '';
  if (!text.trim()) return 'Error: 缺少 text 参数（要合成的文本）';
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    const { synthesizeSpeech, TtsNotConfiguredError } = await import('@/lib/tts');
    const result = await synthesizeSpeech(text, settings.tts);
    return truncate(
      `语音已生成：${result.filePath}（${Math.max(1, Math.round(result.bytes / 1024))} KB，${result.format}，耗时 ${result.durationMs}ms）。` +
        `回复用户时告知该音频文件路径，桌面端可点击收听；需要推送到微信时结合附件/发送链路使用。`,
      2000,
    );
  } catch (e) {
    if (e instanceof Error && e.name === 'TtsNotConfiguredError') {
      return 'TTS is not configured. Pick one engine in Settings → Roles → Audio TTS Model: a cloud model (API key required) or the built-in macOS voice. Until then, reply in plain text.';
    }
    return `Error: 语音合成失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const audioToolDefs: Tool[] = [
  {
    name: 'transcribe_audio',
    description: 'Transcribe audio (mp3/wav/m4a/aac/ogg/flac/opus/amr/webm voice notes) to text via the configured STT engine — whichever single engine the user picked in Settings → Roles → Audio STT Model: a cloud model (Volcengine Doubao / Alibaba DashScope / SiliconFlow / OpenAI-compatible) or a local offline model (sherpa-onnx). No automatic fallback. Use when the user uploads audio or asks to transcribe a voice memo/recording/meeting. Returns the full transcript (chunked with timestamps >60s). Path: materials/{attachmentFolder}/{filename} (legacy attachments/{nodeId}/{filename}) or project-relative.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Audio file path. Format: materials/{attachmentFolder}/{filename} (legacy attachments/{nodeId}/{filename}), or a project-relative path. Get from the attachment list in user message.',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolTranscribeAudio,
    maxOutput: 20000,
  },
  {
    name: 'text_to_speech',
    description:
      'Synthesize speech from text via the configured TTS engine: either a cloud model (OpenAI-compatible /audio/speech — OpenAI tts-1, SiliconFlow fishaudio, or custom baseUrl) or, on macOS, the built-in system voice (offline, no API key; output is m4a). The engine is whichever one the user picked in Settings → Roles → Audio TTS Model — there is no automatic fallback. Use when the user asks for a voice reply, a spoken/read-aloud version of a summary or report, or wants the answer as audio. Returns the saved file path — tell the user the path (desktop can play it) and keep the text reply too. Max 2000 chars per call; for longer content split into multiple calls. If TTS is not configured the tool says so — then reply in plain text instead.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to synthesize. Keep it speakable (no markdown, no code, no long numbers). Max 2000 characters per call.',
        },
      },
      required: ['text'],
    },
    category: '文件',
    execute: toolTextToSpeech,
    maxOutput: 2000,
  },
];
