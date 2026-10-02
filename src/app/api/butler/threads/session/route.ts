/**
 * /api/butler/threads/session —— 「新建线程」的人设入口
 *
 * 与发消息的 /api/butler/threads 分开实现，避免把发消息那条流式链路的语义搅浑：
 *   POST  （无参）        建一条**空线程**（messages=[]），可选带 persona → { threadId }
 *                         `{ model: { modelId, thinkingLevel } }` = 连抽屉当前的会话级选型一并落盘
 *   PATCH ?threadId=xxx   覆盖该线程的人设（人设弹窗编辑态保存；传 persona:null = 清除）
 *                         `{ model: { modelId, thinkingLevel } }` = 只改模型 / 思考档位（选型器即改即存）
 *                         `{ workspace: { path, name } | null }` = 改 / 清**会话级工作区**（锁定操作范围）
 *                         `{ read: true }` = 置为已读（未读角标的清零出口，见 markThreadRead）
 *
 * 人设与线程**同行**存储（`.state/threads/<id>.json`）→ 删除线程（DELETE /api/butler/threads?threadId=）
 * 会连带删除人设，不需要任何跨表联动。模型 / 思考档位同理（会话级选型）。
 * 常驻「Recorder」是系统身份：不可改人设（它同时也不可删）；「通知助理」允许设人设
 * （首次打开该联系人时引导用户设定）。但**置已读与选型不受此限**——「我看过了」「我要用哪个模型」
 * 是读者行为，不是改它的身份。
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  createThread,
  generateThreadId,
  markThreadRead,
  readThread,
  setThreadModelSettings,
  setThreadPersona,
  setThreadWorkspace,
  type ButlerPersona,
} from '@/lib/butler/threads';
import { parseModelTag, parseThinkingLevel, parseWorkspaceFolder } from '@/lib/butler/threads-shared';
import type { ThinkingLevel } from '@/lib/types';
import { RECORDER_THREAD_ID } from '@/lib/core/butler-recorder';

/** 字段长度上限：人设是要进系统提示的，别让一屏文本把上下文吃掉 */
const FIELD_MAX = 200;

/** 清洗前端传来的 persona：白名单字段 + 逐字段截断；name 缺失即视为「无人设」 */
function sanitizePersona(raw: unknown): ButlerPersona | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = typeof o[k] === 'string' ? (o[k] as string).trim() : '';
    return v ? v.slice(0, FIELD_MAX) : undefined;
  };
  const name = str('name');
  if (!name) return null;
  return {
    name,
    personality: str('personality'),
    role: str('role'),
    style: str('style'),
    addressUser: str('addressUser'),
    template: str('template'),
  };
}

/** 清洗前端传来的会话级选型（模型 / 思考档位）：非法值一律 → null（= 自动 / 默认档） */
function sanitizeModelSettings(raw: unknown): { modelId: string | null; thinkingLevel: ThinkingLevel | null } {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { modelId: parseModelTag(o.modelId), thinkingLevel: parseThinkingLevel(o.thinkingLevel) };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { persona?: unknown; model?: unknown };
    const threadId = generateThreadId();
    // 带上抽屉当前的选型一起建 —— 新助理直接继承「我现在想用哪个模型 / 档位」，不必再选一次
    await createThread(threadId, sanitizePersona(body.persona), 'panel', sanitizeModelSettings(body.model));
    return NextResponse.json({ success: true, threadId });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : '创建会话失败' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const threadId = new URL(request.url).searchParams.get('threadId') || '';
  if (!threadId) {
    return NextResponse.json({ success: false, error: 'threadId required' }, { status: 400 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      persona?: unknown;
      read?: unknown;
      model?: unknown;
      workspace?: unknown;
    };

    // 置已读：任何线程都可以（含常驻通知助理 / Recorder）——「我看过了」不改它的身份与人设
    if (body.read === true) {
      if (!(await readThread(threadId))) {
        return NextResponse.json({ success: false, error: 'thread not found' }, { status: 404 });
      }
      await markThreadRead(threadId);
      return NextResponse.json({ success: true, threadId });
    }

    // 只改会话级选型（模型 / 思考档位）：选型器改动即存，不等下一条消息。
    // 与置已读同属「读者行为」→ 任何线程都可改（含 Recorder / 通知助理）。
    if (body.model !== undefined) {
      if (!(await readThread(threadId))) {
        return NextResponse.json({ success: false, error: 'thread not found' }, { status: 404 });
      }
      const m = sanitizeModelSettings(body.model);
      await setThreadModelSettings(threadId, m.modelId, m.thinkingLevel);
      return NextResponse.json({ success: true, threadId });
    }

    // 只改会话级**工作区**（用户指定 · 锁定操作范围）：选/清目录即存，不等下一条消息。
    // 与选型同属「读者行为」→ 任何线程都可改（含 Recorder / 通知助理）。
    // 传 workspace:null = 清除；非法对象（非绝对路径等）由 parseWorkspaceFolder 归一成 null。
    if (body.workspace !== undefined) {
      if (!(await readThread(threadId))) {
        return NextResponse.json({ success: false, error: 'thread not found' }, { status: 404 });
      }
      await setThreadWorkspace(threadId, parseWorkspaceFolder(body.workspace));
      return NextResponse.json({ success: true, threadId });
    }

    // 以下走改人设：常驻「Recorder」是系统身份，不可改（它同时也都不可删）。
    // 常驻「通知助理」自 2026-09-28 起允许用户设定人设 —— 首次打开该联系人时引导设置。
    if (threadId === RECORDER_THREAD_ID) {
      return NextResponse.json({ success: false, error: 'system-owned persona' }, { status: 400 });
    }
    // 先确认线程存在：否则会静默 no-op，前端以为存上了其实没写（人设比消息更怕这种错觉）
    if (!(await readThread(threadId))) {
      return NextResponse.json({ success: false, error: 'thread not found' }, { status: 404 });
    }
    await setThreadPersona(threadId, sanitizePersona(body.persona));
    return NextResponse.json({ success: true, threadId });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : '保存人设失败' },
      { status: 500 },
    );
  }
}