/**
 * /api/outbox —— 管家产物暂存区（Outbox）面板的数据与动作入口
 *
 * GET  ：列出待处理批次（pending / kept），带剩余天数（临期由前端提示，不做静默删除）
 * POST ：action = keep（保留，免自动清理）| discard（整批丢弃）| assign（归口到某项目）
 *
 * 与 lib/outbox/store.ts 同口径；归口的目标项目解析复用 resolveProjectWithFallback（显式优先，不猜测）。
 */
import { NextResponse } from 'next/server';
import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { join, relative, sep, extname } from 'path';
import { listBatches, assignBatch, keepBatch, discardBatch } from '@/lib/outbox/store';
import { resolveOutboxRoot } from '@/lib/app-root';
import { fileMime } from '@/lib/files/mime';
import { parseRange, rangeHeaders, unsatisfiableHeaders } from '@/lib/files/range';
import { OUTBOX_MAX_AGE_DAYS } from '@/lib/cleanup/intermediate-cleanup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 文本类扩展名（与 /api/local-files 的只读口径一致） */
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.xml', '.html', '.css',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c',
  '.h', '.go', '.rs', '.yaml', '.yml', '.ini', '.conf', '.log',
  '.env', '.sh', '.bash', '.zsh',
]);
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/**
 * 把 Outbox 路径解析为绝对路径（仅限暂存区内）。
 * 接受 `outbox/<批次>/homework/x.md` 与绝对路径两种形态；越界/穿越一律 null。
 */
function resolveOutboxFile(raw: string): string | null {
  const root = resolveOutboxRoot();
  const p = String(raw ?? '').replace(/\\/g, '/');
  let rel: string;
  if (p.startsWith('/')) {
    if (p !== root && !p.startsWith(root + '/')) return null;
    rel = relative(root, p);
  } else if (p.startsWith('outbox/')) {
    rel = p.slice('outbox/'.length);
  } else {
    return null;
  }
  const segs = rel.split('/').filter(Boolean);
  if (segs.length === 0 || segs.some((s) => s === '.' || s === '..')) return null;
  const abs = join(root, ...segs);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** 计算批次剩余保留天数（created_at 不可解析时返回 null，前端不显示倒计时） */
function daysLeft(createdAt: string, now: number): number | null {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;
  return Math.max(0, OUTBOX_MAX_AGE_DAYS - Math.floor((now - created) / 86400000));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  // 读取单个暂存文件（对话产物卡片在归口前点开预览：outbox/<批次>/homework/x.md）
  if (action === 'read_file' || action === 'stat' || action === 'file_proxy') {
    const abs = resolveOutboxFile(url.searchParams.get('path') ?? '');
    if (!abs) return NextResponse.json({ success: false, error: 'invalid_path' }, { status: 400 });

    if (action === 'stat') {
      try {
        const st = await fs.stat(abs);
        return NextResponse.json({ success: true, exists: true, size: st.size, mtime: st.mtimeMs });
      } catch {
        return NextResponse.json({ success: false, exists: false, error: 'File not found' }, { status: 404 });
      }
    }

    if (action === 'file_proxy') {
      try {
        const st = await fs.stat(abs);
        const ext = extname(abs).toLowerCase();
        const baseHeaders: Record<string, string> = {
          'Content-Type': fileMime(ext),
          'X-File-Mtime': String(st.mtimeMs),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
        };
        const range = parseRange(request.headers.get('range'), st.size);
        if (range === 'unsatisfiable') {
          return new NextResponse(null, { status: 416, headers: { ...baseHeaders, ...unsatisfiableHeaders(st.size) } });
        }
        if (range) {
          const nodeStream = createReadStream(abs, { start: range.start, end: range.end });
          return new NextResponse(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
            status: 206,
            headers: { ...baseHeaders, ...rangeHeaders(range, st.size) },
          });
        }
        const buffer = await fs.readFile(abs);
        return new NextResponse(buffer, {
          status: 200,
          headers: { ...baseHeaders, 'Content-Length': String(st.size) },
        });
      } catch {
        return new NextResponse('File not found', { status: 404 });
      }
    }

    try {
      const ext = extname(abs).toLowerCase();
      if (TEXT_EXTS.has(ext)) {
        const content = await fs.readFile(abs, 'utf-8');
        const st = await fs.stat(abs);
        return NextResponse.json({
          success: true,
          type: 'text',
          content,
          size: st.size,
          extension: ext,
          name: abs.split(sep).pop() || abs,
          full_path: abs,
        });
      }
      if (IMAGE_MIME[ext]) {
        const buffer = await fs.readFile(abs);
        return NextResponse.json({
          success: true,
          type: 'image',
          content: `data:${IMAGE_MIME[ext]};base64,${buffer.toString('base64')}`,
          size: buffer.length,
          extension: ext,
          name: abs.split(sep).pop() || abs,
          full_path: abs,
        });
      }
      const st = await fs.stat(abs);
      return NextResponse.json({
        success: true,
        type: 'binary',
        size: st.size,
        extension: ext,
        name: abs.split(sep).pop() || abs,
        full_path: abs,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ success: false, error: msg }, { status: msg.includes('ENOENT') ? 404 : 500 });
    }
  }

  const now = Date.now();
  const batches = (await listBatches()).filter(
    (b) => (b.status === 'pending' || b.status === 'kept') && b.files.length > 0,
  );
  return NextResponse.json({
    ok: true,
    max_age_days: OUTBOX_MAX_AGE_DAYS,
    batches: batches.map((b) => ({
      batch_id: b.batch_id,
      status: b.status,
      label: b.origin_label || '',
      created_at: b.created_at,
      days_left: daysLeft(b.created_at, now),
      files: b.files.map((f) => ({ rel: f.rel, name: f.name, size: f.size, kind: f.kind })),
      note: b.note ?? null,
    })),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; batch_id?: string; project?: string };
  const action = String(body?.action ?? '');
  const batchId = String(body?.batch_id ?? '').trim();
  if (!batchId) return NextResponse.json({ ok: false, error: 'batch_id_required' }, { status: 400 });

  if (action === 'keep') {
    const b = await keepBatch(batchId);
    if (!b) return NextResponse.json({ ok: false, error: 'batch_not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, message: '已保留：该批次不再被自动清理，可随时归口或丢弃。' });
  }

  if (action === 'discard') {
    const ok = await discardBatch(batchId);
    return NextResponse.json({ ok, message: ok ? '已丢弃该批次及其全部暂存产物。' : '丢弃失败（目录可能已被清理）。' });
  }

  if (action === 'assign') {
    const project = String(body?.project ?? '').trim();
    if (!project) return NextResponse.json({ ok: false, error: 'project_required' }, { status: 400 });
    const res = await assignBatch({ batchId, target: project });
    return NextResponse.json(res);
  }

  return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
}
