/**
 * 自定义插画图库（XHS 卡片 Built-in 装饰库的扩充）：
 *  - GET   列出 {appRoot}/.xhs-doodles/ 下的图片 → [{ name, dataUrl }]
 *  - POST  保存一张 dataUrl 图片 → { success, name }
 *  - DELETE 按 name 删除一张
 * 存应用根目录（BOBWORK_HOME，与设置同级），全局跨项目持久。
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { resolveAppRoot } from '@/lib/app-root';

const DIR_NAME = '.xhs-doodles';
const MAX_FILES = 12;

function doodleDir(): string {
  return join(resolveAppRoot(), DIR_NAME);
}

/** 安全文件名：仅保留字母数字、中划线、下划线、点、中文，限长防路径注入 */
function safeName(name: string): string {
  return name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
}

export async function GET() {
  try {
    const dir = doodleDir();
    await fs.mkdir(dir, { recursive: true });
    const files = (await fs.readdir(dir))
      .filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f))
      .sort();
    const items: Array<{ name: string; dataUrl: string }> = [];
    for (const f of files) {
      try {
        const buf = await fs.readFile(join(dir, f));
        const ext = f.split('.').pop()?.toLowerCase() || 'png';
        const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        items.push({ name: f, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
      } catch { /* 跳过损坏文件 */ }
    }
    return NextResponse.json({ success: true, items });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { dataUrl, name } = body as { dataUrl?: string; name?: string };
    if (!dataUrl) {
      return NextResponse.json({ success: false, error: 'dataUrl is required' }, { status: 400 });
    }
    const comma = dataUrl.indexOf(',');
    if (comma < 0) {
      return NextResponse.json({ success: false, error: 'Invalid dataUrl' }, { status: 400 });
    }
    const dir = doodleDir();
    await fs.mkdir(dir, { recursive: true });
    const existing = (await fs.readdir(dir)).filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
    if (existing.length >= MAX_FILES) {
      return NextResponse.json(
        { success: false, error: `Custom library is full (max ${MAX_FILES})` },
        { status: 400 },
      );
    }
    const filename = `${Date.now()}-${safeName(name || 'custom.png')}`;
    const fullPath = resolve(dir, filename);
    if (!fullPath.startsWith(resolve(dir))) {
      return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 403 });
    }
    await fs.writeFile(fullPath, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
    return NextResponse.json({ success: true, name: filename });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { name } = body as { name?: string };
    if (!name) {
      return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 });
    }
    const dir = doodleDir();
    const fullPath = resolve(dir, safeName(name));
    if (!fullPath.startsWith(resolve(dir))) {
      return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 403 });
    }
    await fs.rm(fullPath, { force: true });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
