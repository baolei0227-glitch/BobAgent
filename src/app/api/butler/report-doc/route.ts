/**
 * /api/butler/report-doc — Butler 报告文档（只读；赋能 ButlerDocPanel 预览）
 *
 * 背景：日报等回执原本只以邮件正文形式躺在收件箱里，长文难读、无法沉淀。
 * 改为**落成真实文档**后（<butler>/<角色>/<日期>/docs/），助理面板点击即可在右侧展开阅读
 * （渲染器复用 viewers/registry）。
 *
 * GET ?action=list          → 列出报告文档（新→旧，默认 20 条）
 * GET ?action=read&path=... → 读取单个文档内容（返回 FileInfo，供渲染器分发）
 *
 * 安全：路径必须解析后位于 APP_ROOT/butler 内（防 ../ 穿越），且排除内部状态目录 .state；
 *      只允许读取白名单扩展名（纯文本类；二进制文档不走这条通道）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile, stat } from 'fs/promises';
import { basename, extname, resolve, join, sep } from 'path';
import { butlerRoot, STATE_DIR } from '@/lib/butler/storage';

const TEXT_EXTS = ['.md', '.markdown', '.txt'];

/** 遍历 <butler>/<角色>/<YYYY-MM-DD>/docs/ 收集报告文档（跳过 .state 等隐藏目录） */
async function listDocFiles(limit: number): Promise<{ name: string; path: string; size: number; mtime: number }[]> {
  const root = butlerRoot();
  let roles: string[] = [];
  try {
    roles = await readdir(root);
  } catch {
    return [];
  }
  const docs: { name: string; path: string; size: number; mtime: number }[] = [];
  for (const role of roles) {
    if (role.startsWith('.')) continue; // .state / .backup-* 等内部目录
    const rolePath = join(root, role);
    const roleStat = await stat(rolePath).catch(() => null);
    if (!roleStat?.isDirectory()) continue;
    let days: string[] = [];
    try {
      days = await readdir(rolePath);
    } catch {
      continue;
    }
    for (const day of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const docsDir = join(rolePath, day, 'docs');
      let files: string[] = [];
      try {
        files = await readdir(docsDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!TEXT_EXTS.includes(extname(f).toLowerCase())) continue;
        try {
          const p = join(docsDir, f);
          const s = await stat(p);
          if (s.isFile()) docs.push({ name: f, path: p, size: s.size, mtime: s.mtimeMs });
        } catch { /* 单个文件读不到则跳过 */ }
      }
    }
  }
  return docs.sort((a, b) => b.mtime - a.mtime).slice(0, Number.isFinite(limit) ? limit : 20);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') ?? 'list';

    if (action === 'list') {
      const limit = Number(searchParams.get('limit') ?? '20');
      const docs = await listDocFiles(limit);
      return NextResponse.json({ success: true, count: docs.length, docs });
    }

    if (action === 'read') {
      const rawPath = searchParams.get('path') ?? '';
      if (!rawPath) return NextResponse.json({ success: false, error: 'path required' }, { status: 400 });

      // 路径安全：resolve 后必须仍在 butler 目录内，且不在内部状态目录 .state 下
      const root = resolve(butlerRoot());
      const stateRoot = resolve(STATE_DIR);
      const target = resolve(rawPath);
      const insideRoot = target === root || target.startsWith(root + sep);
      const insideState = target === stateRoot || target.startsWith(stateRoot + sep);
      if (!insideRoot || insideState) {
        return NextResponse.json({ success: false, error: '路径越界：只能读取 Butler 存储目录下的文档' }, { status: 403 });
      }
      const ext = extname(target).toLowerCase();
      if (!TEXT_EXTS.includes(ext)) {
        return NextResponse.json({ success: false, error: `不支持的扩展名: ${ext}` }, { status: 400 });
      }
      const st = await stat(target);
      if (!st.isFile()) return NextResponse.json({ success: false, error: '目标不是文件' }, { status: 400 });
      // 单文档上限 2MB，避免把超大文本读进内存
      if (st.size > 2 * 1024 * 1024) {
        return NextResponse.json({ success: false, error: '文档超过 2MB，暂不支持预览' }, { status: 413 });
      }
      const content = await readFile(target, 'utf-8');
      return NextResponse.json({
        success: true,
        file: {
          name: basename(target),
          type: 'text' as const,
          content,
          size: st.size,
          extension: ext,
          full_path: target,
        },
      });
    }

    return NextResponse.json({ success: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/report-doc] 读取失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}