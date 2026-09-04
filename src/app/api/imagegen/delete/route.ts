import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';

/** 删除 homework/ 下的磁盘文件（单张或批量）
 *  body: { filename?: string; filenames?: string[] }
 *  - filename（单删）或 filenames[]（批量）至少提供一个
 *  - 安全检查：路径必须锚定在 {project}/homework/ 内，防止穿越
 *  - 图片产物平铺存 homework/ 根目录（不生成 kind 子文件夹），与展示分组口径一致
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { filename, filenames } = body as {
      filename?: string;
      filenames?: string[];
    };
    const targets: string[] = [];
    if (filename) targets.push(filename);
    if (Array.isArray(filenames)) targets.push(...filenames);
    if (targets.length === 0) {
      return NextResponse.json({ success: false, error: 'filename or filenames[] is required' }, { status: 400 });
    }

    const project = await getCurrentProject();
    const homeworkDir = join(project.path, 'homework');
    const rootPrefix = join(project.path, 'homework');

    const deleted: string[] = [];
    const failed: Array<{ file: string; error: string }> = [];

    for (const raw of targets) {
      if (!raw || typeof raw !== 'string') continue;
      const safeName = raw.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
      const fullPath = join(homeworkDir, safeName);
      if (!fullPath.startsWith(rootPrefix + '/')) {
        failed.push({ file: raw, error: 'Path escapes homework directory' });
        continue;
      }
      try {
        await fs.rm(fullPath, { force: true, maxRetries: 2 });
        deleted.push(safeName);
      } catch (e) {
        failed.push({ file: raw, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return NextResponse.json({
      success: failed.length === 0,
      deleted,
      failed: failed.length > 0 ? failed : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
