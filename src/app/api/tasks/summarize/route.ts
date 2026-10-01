import { NextRequest, NextResponse } from 'next/server';
import { resolveTaskModel } from '@/lib/core/task-model';
import { parseTasksWithModel, type SummarizedTask } from '@/lib/core/task-summarize';

/**
 * 文本 → 结构化任务（/todo 指令、Butler 面板）。
 * 解析内核已抽到 lib/core/task-summarize.ts，与便签行自动入日历共用同一口径（single=true 一行一任务）。
 */
interface SummarizeResponse {
  success: boolean;
  tasks: SummarizedTask[];
  ambiguous_items?: string[]; // 无法解析的条目，提示用户确认
  model_used?: string;
}

export async function POST(req: NextRequest) {
  try {
    let rawText: string;
    let single: boolean = false;
    try {
      const body = await req.json();
      rawText = String(body.text || body.content || '').trim();
      single = body.single === true;
    } catch {
      rawText = '';
    }
    if (!rawText) {
      return NextResponse.json(
        { success: false, error: '缺少待解析的文本内容（body.text）' },
        { status: 400 },
      );
    }
    if (rawText.length > 20000) {
      return NextResponse.json(
        { success: false, error: '文本过长，请拆分后重新上传（单次不超过 20000 字）' },
        { status: 400 },
      );
    }

    const cfg = await resolveTaskModel();
    if (!cfg) {
      return NextResponse.json(
        { success: false, error: '尚未配置任何模型。请在【设置 → Models】中添加 API Key 并勾选聊天模型，或在【Role Assignment → Chat Model】把模型加入候选池（首个模型作为默认主对话模型）。' },
        { status: 400 },
      );
    }

    const { tasks, ambiguous_items } = await parseTasksWithModel(cfg, rawText, single);

    const result: SummarizeResponse = {
      success: true,
      tasks,
      ambiguous_items,
      model_used: cfg.model,
    };
    return NextResponse.json(result);
  } catch (e) {
    console.error('tasks/summarize error:', e);
    return NextResponse.json(
      { success: false, error: e instanceof Error && e.message ? e.message : '任务归纳失败' },
      { status: 500 },
    );
  }
}