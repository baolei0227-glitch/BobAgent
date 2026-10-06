/**
 * /api/butler/preferences — Butler 记忆面板的读写接口
 *
 * 把「偏好/记忆」做成**可见、可改、可删、可新增**的产品对象（对齐 Today.ai 的 Memories 设计）：
 *   GET    → 列出全部偏好
 *   POST   → 新增一条 { content, type? }（2026-10-02 新增：此前**用户没有手写入口**，
 *            记忆只能由模型在对话里 remember_preference 代写 —— 用户想「记住这个」没有兜底）
 *   PATCH  → 按序号更新一条 { index, content?, type? }
 *   DELETE → 按序号删除一条 ?index=n（删除只接受明确序号，不做批量清库）
 *
 * 全部经 lib/core/preferences.ts（butler/preferences.md）落地，与 MCP 工具侧同源，
 * 避免「工具写一份、面板写一份」导致记忆分叉 —— **POST 与 remember_preference 复用同一套闸**：
 * 敏感信息拒写 / 否定式转规则 / 精确去重 / 同类型相似度倒逼 update。
 */
import { NextRequest, NextResponse } from 'next/server';
import { addPreference, listPreferences, updatePreference, removePreference } from '@/lib/core/preferences';

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

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { content?: unknown; type?: unknown };
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) return NextResponse.json({ success: false, error: 'content required' });
    const type = typeof body.type === 'string' && body.type.trim() ? body.type.trim() : undefined;
    // source 记 'panel'：与模型抽取（chat[:<threadId>]）区分，用户能看到「这条是我自己写的」
    const res = await addPreference(content, { ...(type ? { type } : {}), source: 'panel' });

    // ① 敏感信息：拒写（明文落盘 + 每轮注入），把命中的特征回给界面，但**不回显原文**
    if (res.blocked) {
      return NextResponse.json({
        success: true,
        added: false,
        blocked: res.blocked,
        reason: 'sensitive',
        message: 'Looks like credentials or ID numbers — memory is stored as plain text and injected every turn, so it was not saved.',
        count: res.total,
      });
    }
    // ② 否定式表达：不是偏好而是硬约束 → 与模型链路同一路由（转成一条规则）
    if (res.routed) {
      const { createRuleFromNegation } = await import('@/lib/butler/rules');
      const rule = await createRuleFromNegation(res.routed.content);
      return NextResponse.json({
        success: true,
        added: false,
        routed: true,
        ruleId: rule.id,
        commitment: rule.commitment,
        reason: 'negation',
        message:
          'That is a hard constraint, not a preference — saved as a rule instead (rules are promises: always/never).',
        count: res.total,
      });
    }
    // ③ 精确重复 / ④ 同类型高相似：都不直接落盘。相似时界面给出「改成更新第 N 条」的出口
    if (res.duplicate) {
      return NextResponse.json({
        success: true,
        added: false,
        duplicate: res.duplicate,
        reason: 'duplicate',
        message: 'Already remembered, word for word.',
        count: res.total,
      });
    }
    if (res.conflict) {
      return NextResponse.json({
        success: true,
        added: false,
        conflict: res.conflict,
        reason: 'conflict',
        message: `Very close to entry #${res.conflict.index} — update that one instead, or rephrase if it is genuinely new.`,
        count: res.total,
      });
    }
    return NextResponse.json({ success: true, added: true, count: res.total });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/preferences] 新增失败:', msg);
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
