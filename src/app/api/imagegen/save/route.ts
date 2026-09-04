import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';

/** 生成的图片保存到当前项目的 homework/ 根目录（存储平铺，不生成 kind 子文件夹；
 *  侧边栏按 Images 类别标签分组展示）
 *  body: { dataUrl: string; filename: string }
 *  dataUrl 形如 data:image/png;base64,xxxx
 *  图片产物统一落 homework/<filename>，侧边栏按 Images 类别分组展示。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { dataUrl, filename } = body as { dataUrl?: string; filename?: string };
    if (!dataUrl || !filename) {
      return NextResponse.json({ success: false, error: 'dataUrl and filename are required' }, { status: 400 });
    }

    const comma = dataUrl.indexOf(',');
    if (comma < 0) {
      return NextResponse.json({ success: false, error: 'Invalid dataUrl' }, { status: 400 });
    }
    const base64 = dataUrl.slice(comma + 1);

    // 安全文件名：仅保留字母数字、中划线、下划线、点、中文
    const safeName = filename.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');

    const project = await getCurrentProject();
    const homeworkDir = join(project.path, 'homework');
    await fs.mkdir(homeworkDir, { recursive: true });
    const fullPath = join(homeworkDir, safeName);
    if (!fullPath.startsWith(join(project.path, 'homework'))) {
      return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 403 });
    }
    await fs.writeFile(fullPath, Buffer.from(base64, 'base64'));

    const relPath = `homework/${safeName}`;
    return NextResponse.json({
      success: true,
      path: relPath,
      full_path: fullPath,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
