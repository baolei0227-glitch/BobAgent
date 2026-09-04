import { NextRequest, NextResponse } from 'next/server';
import { AGENT_PROFILES, listAgents } from '@/lib/agents/profiles';
import { readAgentsState, setAgentDisabled, setCustomPrompt } from '@/lib/agents/store';

/**
 * Agent 设置 API
 *
 * GET  — 返回全部已注册 Agent 配置（含专属 baseSystemPrompt）+ 当前覆盖状态（禁用列表/自定义 prompt）
 * POST — action:
 *   - set_disabled：{ agentId, disabled } 启用/禁用专项 agent（chat 不可禁用）
 *   - set_prompt：{ agentId, prompt } 写入/清除自定义 base system prompt（空串清除）
 */

export async function GET() {
  const state = await readAgentsState();
  return NextResponse.json({
    success: true,
    agents: listAgents(),
    disabled: state.disabled,
    prompts: state.prompts,
  });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action;
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';

  // 校验 agentId 必须为已注册 agent
  if (!agentId || !(agentId in AGENT_PROFILES)) {
    return NextResponse.json({ success: false, error: `Unknown agent: ${agentId}` }, { status: 400 });
  }

  try {
    if (action === 'set_disabled') {
      const disabled = body.disabled === true;
      await setAgentDisabled(agentId, disabled);
      const state = await readAgentsState();
      return NextResponse.json({ success: true, disabled: state.disabled, prompts: state.prompts });
    }

    if (action === 'set_prompt') {
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      await setCustomPrompt(agentId, prompt);
      const state = await readAgentsState();
      return NextResponse.json({ success: true, disabled: state.disabled, prompts: state.prompts });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${String(action)}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
