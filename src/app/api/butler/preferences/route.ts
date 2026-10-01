/**
 * /api/butler/preferences — Butler 记忆面板的读写接口
 *
 * 把「偏好/记忆」做成**可见、可改、可删**的产品对象（对齐 Today.ai 的 Memories 设计）：
 *   GET    → 列出全部偏好
 *   PATCH  → 按序号更新一条 { index, content?, type? }
 *   DELETE → 按序号删除一条 ?index=n（删除只接受明确序号，不做批量清库）
 *
 * 全部经 lib/core/preferences.ts（butler/preferences.md）落地，与 MCP 工具侧同源，
 * 避免「工具写一份、面板写一份」导致记忆分叉。
 */
import { NextRequest, NextResponse } from 'next/server';
import { listPreferences, updatePreference, removePreference } from '@/lib/core/preferences';

export async function GET() {
  try {
    const preferences = await listPreferences();
    return NextResponse.json({ success: true, count: preferences.length, preferences });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/preferences] 拉取失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { index?: number; content?: string; type?: string };
    if (typeof body.index !== 'number' || body.index < 1) {
      return NextResponse.json({ success: false, error: 'index required (1-based)' });
    }
    if (body.content === undefined && body.type === undefined) {
      return NextResponse.json({ success: false, error: 'nothing to update: provide content and/or type' });
    }
    const res = await updatePreference(body.index, {
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
    });
    // ⑧：否定式表达是规则不是偏好——偏好层拒收，提示改走规则（本版由 /api/butler/rules 承接）
    if (res.routed) return NextResponse.json({ success: false, routed: true, error: 'Negative expressions are rules, not preferences — create a rule instead.' });
    if (!res.updated) return NextResponse.json({ success: false, error: res.error ?? 'update failed' });
    return NextResponse.json({ success: true, preference: res.preference, count: res.remaining });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/preferences] 更新失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const index = Number(request.nextUrl.searchParams.get('index'));
    if (!Number.isFinite(index) || index < 1) {
      return NextResponse.json({ success: false, error: 'index required (1-based)' });
    }
    const res = await removePreference(index);
    if (!res.removed) return NextResponse.json({ success: false, error: `entry ${index} not found` });
    return NextResponse.json({ success: true, count: res.remaining });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/preferences] 删除失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
