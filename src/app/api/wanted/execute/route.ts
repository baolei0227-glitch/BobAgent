/**
 * POST /api/wanted/execute
 *
 * WANTED 指令统一执行入口（服务端）：
 * 面板端提交也走这里，保证 Node 模式等进程内状态与微信桥共享同一份，
 * 避免浏览器端/服务端双份状态导致的跨端不一致。
 */
import { NextRequest, NextResponse } from 'next/server';
import { executeWantedCommand } from '@/lib/wanted/executor';
import { getProjectById } from '@/lib/project/project-manager';

export async function POST(request: NextRequest) {
  try {
    const { text, project_id } = (await request.json()) as { text?: string; project_id?: string };
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
    const result = await executeWantedCommand(text, { baseUrl: base, projectName });

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.reply, command: result.command });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wanted/execute] 执行失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}
