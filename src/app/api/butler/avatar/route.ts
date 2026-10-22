/**
 * GET /api/butler/avatar?path=<绝对路径> —— 回读**自定义头像**（人设里 persona.avatarImage 指向的图）
 *
 * 为什么不复用 /api/local-files：那条链路按「**用户授权根目录**」放行，而 `butler/` 是 App 自己的
 * 存储空间、不在任何授权根里；为它单开一条根会把「用户授权目录」的语义冲淡（授权 = 用户把某个
 * 目录交给 AI 读写，与「App 自家目录」不是一回事）。
 *
 * 为什么不内联 dataURL：头像会在联系人列、中栏工具行、每条气泡各渲染一次，内联 base64 等于
 * 每次列表刷新都塞几百 KB 进 JSON；走 URL 还能白拿一层破缓存 —— **路径即内容指纹**
 * （换图必换路径，见 /api/butler/attachments 的同名冲突加后缀），所以可以配长效不可变缓存。
 *
 * 安全边界：**只服务 `<APP_ROOT>/butler/` 内的图片**。越界路径一律拒（见 isInButlerRoot：
 * 先 resolve 归一掉 `..` 再比前缀），非图片后缀也拒（别把自家目录变成任意文件服务）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { isInButlerRoot } from '@/lib/butler/storage';

/** 只认这几种图片后缀。刻意不收 svg：SVG 可内嵌脚本，同源直开时能执行，没必要时开这个口子 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

/** 头像体积上限：上传侧不限（与附件同档），读取侧兜住——头像要反复渲染，不该长驻一张几十 MB 的原图 */
const MAX_BYTES = 8 * 1024 * 1024;

export async function GET(request: NextRequest) {
  const p = new URL(request.url).searchParams.get('path') || '';
  if (!p.startsWith('/') || !isInButlerRoot(p)) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }
  const mime = MIME_BY_EXT[extname(p).toLowerCase()];
  if (!mime) {
    return NextResponse.json({ error: 'unsupported image type' }, { status: 415 });
  }
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'not a file' }, { status: 404 });
    }
    if (stat.size > MAX_BYTES) {
      return NextResponse.json({ error: 'image too large' }, { status: 413 });
    }
    const buffer = await fs.readFile(p);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(buffer.length),
        // 路径即内容指纹 → 可长缓存；private 因为这是本机 App 的本地数据，不该进共享缓存
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}
