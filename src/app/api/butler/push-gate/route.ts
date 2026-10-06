/**
 * /api/butler/push-gate —— Butler 主动推送的**打扰闸**（B5 克制策略的唯一生产调用方）
 *
 * 背景（2026-10-02 架构评审 §2.2-8）：`lib/core/quiet-hours.ts` 早就实现了完整策略
 * （免打扰窗口 / 单日上限 / 折叠排序），但 `decidePush` 与 `recordPush` **全仓零调用方**——
 * 策略从未生效，而设置界面已把它呈现为「Butler Notify / Stay quiet」。
 *
 * 语义（与 `SettingsModal` 的文案逐条对齐）：
 *   - 免打扰窗口内的**主动推送**被**暂缓**，窗口结束再发 → 这里只回答「现在能不能打扰」，
 *     调用方据此**跳过本次打扰**；条目本身仍会落进抽屉收件箱（**报告不会丢**）。
 *   - 「用户自订日历提醒永不被静默」（`evaluatePush` 内 `kind !== 'reminder'` 才判窗口），
 *     它只受单日上限约束。
 *   - 放行时**就地计数**（`recordPush`），保证「单日上限」是真上限而不是摆设。
 *   - **失败即放行**（fail-open）：策略层故障绝不能吞掉通知，宁可多打扰一次。
 *
 * 入参 `{ kind }`：通知 kind 字符串（见 `lib/bus.ts ButlerNoticePayload.kind`），
 * 由本路由映射到策略类别 `PushKind`，避免客户端也持有一份映射表。
 */
import { NextRequest, NextResponse } from 'next/server';
import { decidePush, recordPush, type PushKind } from '@/lib/core/quiet-hours';

/** 通知 kind → 策略类别（'reminder' 是唯一免静默的类别，映射错会导致夜间闹钟被吞，务必保守） */
function toPushKind(kind: string): PushKind {
  if (kind === 'calendar' || kind === 'reminder') return 'reminder';
  if (kind === 'meeting') return 'meeting';
  if (kind === 'notes-maintenance' || kind === 'report') return 'report';
  return 'other';
}

export async function POST(request: NextRequest) {
  let kind = '';
  try {
    const body = (await request.json()) as { kind?: unknown };
    kind = typeof body.kind === 'string' ? body.kind : '';
  } catch {
    /* 空体 / 非 JSON → 按 other 处理（可静默类别） */
  }
  try {
    const decision = await decidePush(toPushKind(kind));
    if (decision.allow) {
      await recordPush();
    }
    return NextResponse.json({
      success: true,
      allow: decision.allow,
      reason: decision.reason,
      resumeAt: decision.resumeAt ?? null,
      used: decision.used,
      limit: decision.limit,
    });
  } catch (e) {
    // 失败即放行：静默掉通知比多打扰一次严重得多（与 quiet-hours 的 disabledNotifyPolicy 同一条原则）
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[butler/push-gate] 裁决失败，按放行处理:', msg);
    return NextResponse.json({ success: true, allow: true, reason: 'error', resumeAt: null, used: 0, limit: 0 });
  }
}
