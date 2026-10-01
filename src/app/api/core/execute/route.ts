/**
 * POST /api/core/execute
 *
 * @deprecated P2 收敛：斜杠命令的统一落点已是会话层（`/api/chat`，identity='butler'，
 * 入口只做 normalizeSlashInput 翻译）。本路由仅保留兼容，**不再是对话入口**。
 * 仓内唯一调用方是 ProjectBoardView（便签行「加入日历」→ `/todo <text>`），
 * 它只用 `/todo` 与返回的 eventIds，属程序化调用而非对话。新代码请勿依赖本路由。
 */
import { NextRequest, NextResponse } from 'next/server';
import { executeButlerCommand } from '@/lib/core/executor';
import { getProjectById } from '@/lib/project/project-manager';

export async function POST(request: NextRequest) {
  try {
    const { text, project_id } = (await request.json()) as {
      text?: string;
      project_id?: string;
    };
    if (!text || !text.trim()) {
      return NextResponse.json({ success: false, error: 'Please enter task content' });
    }

    // 便签一键添加日历场景：按 project_id 解析项目名，拼进日历事件 description
    let projectName: string | undefined;
    if (project_id) {
      try {
        const p = await getProjectById(project_id);
        projectName = p.name;
      } catch {
        projectName = undefined;
      }
    }

    // 服务端调用必须带绝对 baseUrl（Node fetch 不支持相对路径）
    const base = new URL(request.url).origin;
    const result = await executeButlerCommand(text, { baseUrl: base, projectName });

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.reply, command: result.command });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[core/execute] 执行失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
