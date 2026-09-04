import { listAllToolDefs } from '@/app/api/chat/tools';

/**
 * 全量工具清单接口（含分类），供工具管理界面的「确认名单」设置使用。
 * 返回当前注册的所有工具：内置 + 自定义 + MCP（与模型可见列表一致）。
 */
export async function GET() {
  try {
    const tools = listAllToolDefs();
    return Response.json({ tools });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
