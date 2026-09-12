/**
 * Audio 场景工具：音频转写（transcribe_audio）。
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

export const audioToolDefs: Tool[] = [
  {
    name: 'transcribe_audio',
    description: 'Transcribe audio (mp3/wav/m4a/aac/ogg/flac/opus/amr) to text via the configured STT engine (cloud Volcengine Doubao / Alibaba DashScope / SiliconFlow / OpenAI-compatible, optional local whisper fallback). Use when the user uploads audio or asks to transcribe a voice memo/recording/meeting. Returns the full transcript (chunked with timestamps >60s). Path: attachments/{nodeId}/{filename} or project-relative.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Audio file path. Format: attachments/{nodeId}/{filename}, or a project-relative path. Get from the attachment list in user message.',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolTranscribeAudio,
    maxOutput: 20000,
  },
];
