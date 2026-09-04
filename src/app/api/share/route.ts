/**
 * 文档分享链接 API
 *
 * POST /api/share  { path, title } → 创建/复用分享 token，返回 { token, url }
 * DELETE /api/share?token=<token>   → 删除分享
 * GET   /api/share?path=<abs>       → 查询某路径的分享 token（没有则创建）
 *
 * 仅本机调用（生成链接给局域网他人阅读）；token 即访问凭证，不额外鉴权。
 */
import { NextRequest, NextResponse } from 'next/server';
import { existsSync, statSync } from 'fs';
import { isAbsolute, resolve, join } from 'path';
import { homedir } from 'os';
import { getCurrentProject } from '@/lib/project/project-manager';
import { createShareLink, deleteShareLink, getShareLink } from '@/lib/share-links';

/** 服务端口：与 server.ts 的 PORT 一致（dev=5005 等由环境变量注入） */
function baseUrl(request: NextRequest): string {
  const { protocol, host } = new URL(request.url);
  return `${protocol}//${host}`;
}

/** 解析分享路径为绝对路径：支持绝对路径、~/ 前缀、相对路径（homework/ 前缀可选）。
 *  相对路径按「候选根 × (直接拼接 | homework/ 拼接)」枚举，兼容：
 *   - 活跃项目根（生产）
 *   - ~/BobWork（默认工作区）
 *   - cwd 及其上级（dev：服务 cwd=projects，homework 在仓库根）
 *   - 用户传 homework/xxx.md 或 xxx.md 两种写法 */
async function resolveSharePath(raw: string): Promise<string | null> {
  let p = raw.trim();
  if (!/\.md$/i.test(p)) return null;
  if (p.startsWith('~/')) p = join(homedir(), p.slice(2));

  const roots: string[] = [];
  if (!isAbsolute(p)) {
    try {
      const project = await getCurrentProject();
      roots.push(project.path);
    } catch { /* 无活跃项目 */ }
    roots.push(homedir());
    roots.push(process.cwd());
    roots.push(resolve(process.cwd(), '..')); // dev 仓库根
  } else {
    roots.push('');
  }

  // 相对路径：对每个根尝试「根/p」与「根/homework/p」；绝对路径直接校验
  for (const root of roots) {
    const base = root ? join(root, p) : p;
    const candidates = root ? [base, join(root, 'homework', p)] : [resolve(base)];
    for (const c of candidates) {
      try {
        if (existsSync(c) && statSync(c).isFile()) return resolve(c);
      } catch { /* 继续尝试 */ }
    }
  }
  return null;
}

/** 校验路径是存在的 .md 文件（防任意读：仅允许绝对路径 .md） */
function isValidMdPath(p: unknown): p is string {
  return typeof p === 'string' && p.trim().length > 0;
}

function readBody(req: NextRequest): Promise<{ path?: unknown; title?: unknown }> {
  return req.json().catch(() => ({}));
}

export async function POST(request: NextRequest) {
  try {
    const body = await readBody(request);
    if (!isValidMdPath(body.path)) {
      return NextResponse.json({ success: false, error: 'path 必须是 .md 文件路径' }, { status: 400 });
    }
    const absPath = await resolveSharePath(body.path);
    if (!absPath) {
      return NextResponse.json({ success: false, error: '文件不存在或不是 .md 文件' }, { status: 400 });
    }
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : 'document';
    const entry = await createShareLink(absPath, title);
    const origin = baseUrl(request);
    const url = `${origin}/share/${entry.token}`;
    return NextResponse.json({ success: true, token: entry.token, url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token') ?? '';
    if (!token) {
      return NextResponse.json({ success: false, error: 'Missing token' }, { status: 400 });
    }
    const entry = await getShareLink(token);
    if (!entry) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    const origin = baseUrl(request);
    return NextResponse.json({ success: true, token, path: entry.path, title: entry.title, url: `${origin}/share/${token}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token') ?? '';
    if (!token) {
      return NextResponse.json({ success: false, error: 'Missing token' }, { status: 400 });
    }
    await deleteShareLink(token);
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
