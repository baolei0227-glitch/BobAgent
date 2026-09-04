/**
 * /api/notebook — 笔记宿主转发门面（bob-notes-mcp）
 *
 * 与 /api/team 同构：笔记实现全部在 bob-notes-mcp 插件域，本路由只做
 * HTTP 契约 → notes_* 工具的语义转发，宿主零笔记实现代码。
 *
 * 前端 / executor / 微信桥均经此路由访问笔记库：
 *   GET    /api/notebook?q&tag&type&from&to&mode → notes_query（分层检索）
 *   POST   { text, title?, source?, raw_only? }  → notes_add_raw（URL 自动抓正文）
 *                                                   非 raw_only 追加 notes_ingest 编译
 *   POST   { entry_id, content }                 → notes_update（仅改正文，保留标题/类型/标签）
 *   POST   { action: 'ingest', ids? }            → notes_ingest
 *   POST   { action: 'review' }                  → notes_review
 *   POST   { action: 'lint' }                    → notes_lint
 *   POST   { action: 'backfill', title, content, tags, links, type } → notes_backfill
 *   DELETE /api/notebook?id=                     → notes_delete
 *
 * 响应结构尽量保持与宿主流一致：{ success, total, matched, parsed, groups, entries, reply }
 */

import { NextRequest, NextResponse } from 'next/server';
import { callNotes } from '@/lib/mcp/notes-bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 从 notes_* 工具返回 JSON 里安全取值 */
function pick<T>(data: Record<string, unknown> | undefined, key: string, fallback: T): T {
  if (!data) return fallback;
  const v = data[key];
  return v === undefined || v === null ? fallback : (v as T);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const action = String((body as Record<string, unknown>).action || '').trim();
    if (action === 'ingest') {
      const idsRaw = (body as Record<string, unknown>).ids;
      const ids = Array.isArray(idsRaw) ? idsRaw.map(String).filter(Boolean) : undefined;
      const r = await callNotes('ingest', ids && ids.length > 0 ? { ids } : {});
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }
    if (action === 'raw_list') {
      const status = String((body as Record<string, unknown>).status || '').trim() || 'all';
      const r = await callNotes('raw_list', { status, limit: 500 });
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }
    if (action === 'review') {
      const r = await callNotes('review', {});
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }
    if (action === 'lint') {
      const r = await callNotes('lint', {});
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }
    if (action === 'history') {
      const id = String((body as Record<string, unknown>).id || '').trim();
      if (!id) return NextResponse.json({ success: false, error: 'Missing note id for history (?id=)' }, { status: 400 });
      const r = await callNotes('history', { id });
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }
    if (action === 'restore') {
      const id = String((body as Record<string, unknown>).id || '').trim();
      const time = Number((body as Record<string, unknown>).time);
      if (!id || !Number.isFinite(time) || time <= 0) {
        return NextResponse.json({ success: false, error: 'Missing valid id + time for restore' }, { status: 400 });
      }
      const r = await callNotes('restore', { id, time });
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }
    if (action === 'log') {
      const limit = Number((body as Record<string, unknown>).limit);
      const r = await callNotes('log', Number.isFinite(limit) && limit > 0 ? { limit } : {});
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }
    if (action === 'schema_get') {
      const r = await callNotes('schema_get', {});
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }
    if (action === 'schema_set') {
      const content = String((body as Record<string, unknown>).content || '').trim();
      if (!content) return NextResponse.json({ success: false, error: 'Missing content for schema_set' }, { status: 400 });
      const append = (body as Record<string, unknown>).append === true || (body as Record<string, unknown>).append === 'true';
      const r = await callNotes('schema_set', { content, ...(append ? { append: true } : {}) });
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }
    if (action === 'backfill') {
      const title = String((body as Record<string, unknown>).title || '').trim();
      const content = String((body as Record<string, unknown>).content || '').trim();
      if (!title && !content) {
        return NextResponse.json({ success: false, error: 'Missing title/content for backfill' }, { status: 400 });
      }
      const tags = Array.isArray((body as Record<string, unknown>).tags)
        ? ((body as Record<string, unknown>).tags as unknown[]).filter((s) => typeof s === 'string')
        : [];
      const links = Array.isArray((body as Record<string, unknown>).links)
        ? ((body as Record<string, unknown>).links as unknown[]).filter((s) => typeof s === 'string')
        : [];
      const type = String((body as Record<string, unknown>).type || '').trim() || 'note';
      const mergeInto = String((body as Record<string, unknown>).merge_into || '').trim();
      const r = await callNotes('backfill', { title, content, tags, links, type, ...(mergeInto ? { merge_into: mergeInto } : {}) });
      if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, ...r.data });
    }

    // 更新模式：entry_id + content → 仅更新正文（保留标题/类型/标签）
    const entryId = String((body as Record<string, unknown>).entry_id || '').trim();
    if (entryId) {
      const content = String((body as Record<string, unknown>).content || '').trim();
      const r = await callNotes('update', { id: entryId, ...(content ? { content } : {}) });
      if (!r.ok) {
        // 条目不存在 → 404（StickyThought 依赖 404 判定条目已被外部删除，降级新建）
        const isNotFound = /not found|不存在/i.test(r.error || '');
        return NextResponse.json(
          { success: false, error: r.error },
          { status: isNotFound ? 404 : 500 },
        );
      }
      return NextResponse.json({ success: true, ...r.data });
    }

    // 投放模式：text → raw 素材（raw_only=true 只投放不编译；URL 由插件 add_raw 自动抓正文）
    const text = String((body as Record<string, unknown>).text || (body as Record<string, unknown>).content || '').trim();
    if (!text) {
      return NextResponse.json({ success: false, error: 'Missing content (body.text)' }, { status: 400 });
    }
    const title = String((body as Record<string, unknown>).title || '').trim() || undefined;
    const source = (body as Record<string, unknown>).source ? String((body as Record<string, unknown>).source) : undefined;
    const addRaw = await callNotes('add_raw', { text, ...(title ? { title } : {}), ...(source ? { source } : {}) });
    if (!addRaw.ok) return NextResponse.json({ success: false, error: addRaw.error }, { status: 500 });

    const rawEntry = (addRaw.data as Record<string, unknown> | undefined)?.raw as
      | { id?: string; title?: string }
      | undefined;

    if ((body as Record<string, unknown>).raw_only) {
      return NextResponse.json({
        success: true,
        message: pick(addRaw.data, 'reply', '已投放素材（待编译）。用 /note ingest 编译。'),
        entry: { id: rawEntry?.id ?? '', title: rawEntry?.title ?? title ?? text.slice(0, 30) },
      });
    }

    // 投放 + 编译（/note 语义）
    const ing = await callNotes('ingest', {});
    if (!ing.ok) return NextResponse.json({ success: false, error: ing.error }, { status: 500 });
    return NextResponse.json({
      success: true,
      message: pick(ing.data, 'reply', '已编译。'),
      entries: pick(ing.data, 'entries', []),
    });
  } catch (e) {
    console.error('notes API error:', e);
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Failed to process notes' }, { status: 500 });
  }
}

/** 查询：q / tag / type / from / to / mode（全部语义转发到插件 notes_query） */
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const q = sp.get('q') || '';
    const tag = sp.get('tag') || '';
    const type = sp.get('type') || '';
    const from = sp.get('from') || '';
    const to = sp.get('to') || '';
    const mode = sp.get('mode') || 'all';

    const args: Record<string, unknown> = { mode };
    if (q.trim()) args.q = q.trim();
    if (tag.trim()) args.tag = tag.trim();
    if (type.trim()) args.type = type.trim();
    if (from.trim()) args.from = from.trim();
    if (to.trim()) args.to = to.trim();

    const r = await callNotes('query', args);
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });

    return NextResponse.json({ success: true, ...r.data });
  } catch (e) {
    console.error('notes GET error:', e);
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Read failed' }, { status: 500 });
  }
}

/** 删除一条 wiki 笔记 */
export async function DELETE(request: NextRequest) {
  try {
    const id = String(request.nextUrl.searchParams.get('id') || '').trim();
    if (!id) {
      return NextResponse.json({ success: false, error: 'Missing note id (?id=)' }, { status: 400 });
    }
    const r = await callNotes('delete', { id });
    if (!r.ok) {
      const isNotFound = /not found|不存在/i.test(r.error || '');
      return NextResponse.json(
        { success: false, error: r.error },
        { status: isNotFound ? 404 : 500 },
      );
    }
    return NextResponse.json({ success: true, ...r.data });
  } catch (e) {
    console.error('notes DELETE error:', e);
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Delete failed' }, { status: 500 });
  }
}
