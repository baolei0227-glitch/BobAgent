import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { resolveAppRoot } from '@/lib/app-root';

/**
 * Markdown 批注 + 修订 sidecar API
 *
 * 批注与修订历史不写入 md 原文，而是存到全局独立 JSON 文件：
 *   ~/BobWork/md-annotations/<sha256(key) 前 24 位>.json
 *
 * key 由前端提供（nodeMdId 或 filePath 或 `projectId:filePath`），跨三种保存通道统一。
 * 这样批注/修订不污染 md 正文、可独立导出，且无需解析节点 md 的实际文件路径。
 *
 * - GET  ?key=<标识>          读取批注 + 修订历史（不存在返回空 + exists:false）
 * - POST body { key, annotations, revisionRounds }  原子写入（tmp + rename，避免写一半损坏）
 */

export interface MdAnnotation {
  id: string;
  /** 选中的文字（用于定位到正文位置；文档编辑后 range 会漂移，quote 更稳定） */
  quote: string;
  /** 批注内容 */
  content: string;
  /** ProseMirror 位置（可选，辅助精确定位，文档变化后可能失效） */
  from?: number;
  to?: number;
  /** 是否已通过修订解决 */
  resolved?: boolean;
  createdAt: string;
}

const ANNOTATIONS_DIR = () => join(resolveAppRoot(), 'md-annotations');

function sidecarPathFor(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return join(ANNOTATIONS_DIR(), `${hash}.json`);
}

function isValidAnnotation(a: unknown): a is MdAnnotation {
  if (!a || typeof a !== 'object') return false;
  const o = a as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.quote === 'string' &&
    typeof o.content === 'string' &&
    (o.from === undefined || typeof o.from === 'number') &&
    (o.to === undefined || typeof o.to === 'number')
  );
}

/** 修订段（与前端 RevSegment 结构一致） */
interface RevSegmentDto {
  kind: 'text' | 'delete' | 'insert';
  content: string;
  revIndex?: number;
}

function isValidRevision(r: unknown): boolean {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    (o.type === 'delete' || o.type === 'insert') &&
    typeof o.text === 'string' &&
    (o.status === 'pending' || o.status === 'accepted' || o.status === 'rejected')
  );
}

function isValidRevisionRound(r: unknown): r is { id: string; createdAt: string; segments: RevSegmentDto[]; revisions: unknown[] } {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.createdAt === 'string' &&
    Array.isArray(o.revisions) &&
    o.revisions.every(isValidRevision) &&
    Array.isArray(o.segments) &&
    o.segments.every((s) => {
      if (!s || typeof s !== 'object') return false;
      const seg = s as Record<string, unknown>;
      return (
        (seg.kind === 'text' || seg.kind === 'delete' || seg.kind === 'insert') &&
        typeof seg.content === 'string' &&
        (seg.revIndex === undefined || typeof seg.revIndex === 'number')
      );
    })
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if (!key) {
    return NextResponse.json({ success: false, error: 'key is required' }, { status: 400 });
  }
  const sidecar = sidecarPathFor(key);
  try {
    const content = await fs.readFile(sidecar, 'utf-8');
    const data = JSON.parse(content) as { annotations?: unknown[]; revisionRounds?: unknown[]; updatedAt?: string };
    return NextResponse.json({
      success: true,
      exists: true,
      annotations: Array.isArray(data.annotations) ? data.annotations.filter(isValidAnnotation) : [],
      revisionRounds: Array.isArray(data.revisionRounds) ? data.revisionRounds.filter(isValidRevisionRound) : [],
      updatedAt: data.updatedAt || '',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) {
      return NextResponse.json({ success: true, exists: false, annotations: [], revisionRounds: [] });
    }
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if (!key) {
    return NextResponse.json({ success: false, error: 'key is required' }, { status: 400 });
  }
  const sidecar = sidecarPathFor(key);
  try {
    await fs.unlink(sidecar);
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 文件不存在视为已删除
    if (msg.includes('ENOENT')) return NextResponse.json({ success: true });
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { key?: string; annotations?: unknown[]; revisionRounds?: unknown[] };
    const key = body.key;
    if (!key) {
      return NextResponse.json({ success: false, error: 'key is required' }, { status: 400 });
    }
    if (!Array.isArray(body.annotations) || !body.annotations.every(isValidAnnotation)) {
      return NextResponse.json({ success: false, error: 'annotations must be a valid array' }, { status: 400 });
    }
    const revisionRounds = Array.isArray(body.revisionRounds)
      ? body.revisionRounds.filter(isValidRevisionRound)
      : [];
    const sidecar = sidecarPathFor(key);
    const payload = {
      version: 1,
      key,
      updatedAt: new Date().toISOString(),
      annotations: body.annotations,
      revisionRounds,
    };
    // 原子写入：先写临时文件再 rename，避免进程中断导致 sidecar 损坏
    await fs.mkdir(dirname(sidecar), { recursive: true });
    const tmp = sidecar + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    await fs.rename(tmp, sidecar);
    return NextResponse.json({ success: true, updatedAt: payload.updatedAt });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
