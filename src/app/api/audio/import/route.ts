/**
 * 音频导入 API：把用户选中的本地音频**复制**进应用自有音频库，返回库内绝对路径。
 *
 * 与 /api/materials 的上传刻意分开：那条路把文件落进**项目**（materials/homework），
 * 而音频编辑器要的是「不进 workspace 的私有音频库」（见 lib/audio/library.ts）。
 *
 * 请求：multipart/form-data，字段 `file` = 音频文件。
 * 响应：{ success, file: { path, name, size } }；文件非音频 / 缺失 → { success:false, error }。
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { saveToLibrary } from '@/lib/audio/library';

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ success: false, error: 'expected multipart form data' });
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ success: false, error: 'no audio file provided' });
  }

  let abs: string;
  try {
    abs = await saveToLibrary(file.name, Buffer.from(await file.arrayBuffer()));
  } catch {
    return NextResponse.json({ success: false, error: 'only audio files are supported' });
  }
  const stat = await fs.stat(abs).catch(() => null);
  return NextResponse.json({
    success: true,
    file: { path: abs, name: file.name, size: stat?.size ?? file.size },
  });
}