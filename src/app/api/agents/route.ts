import { NextRequest, NextResponse } from 'next/server';
import { AGENT_PROFILES, listAgents } from '@/lib/agents/profiles';
import { readAgentsState, setAgentDisabled, setHiddenFromMenu, setCustomPrompt } from '@/lib/agents/store';
import {
  loadInstalledAgentProfiles,
  getAgentMarketCatalog,
  installAgentPackage,
  uninstallAgentPackage,
  type AgentMarketEntry,
} from '@/lib/agents/market-server';

/**
 * Agent 设置 + 市场 API
 *
 * GET  — 返回：
 *   - agents：全部内置画像 + 已安装市场画像（供启停/改 prompt）
 *   - market：Agent 市场目录（随包源 + installed 状态，供安装/卸载列表）
 *   - disabled / prompts：当前覆盖状态
 * POST — action:
 *   - set_disabled：{ agentId, disabled } 启用/禁用专项 agent（chat 不可禁用；market agent 可禁用）
 *   - set_prompt：{ agentId, prompt } 写入/清除自定义 base system prompt（空串清除）
 *   - install_agent：{ agentId } 从市场源安装到 ~/<appRoot>/agents/
 *   - uninstall_agent：{ agentId } 卸载（删除用户副本并清理该 agent 技能池）
 */

export async function GET() {
  const state = await readAgentsState();
  const installedMarket = loadInstalledAgentProfiles();
  const market: Array<AgentMarketEntry & { description: string; version?: string }> =
    getAgentMarketCatalog().map((e) => ({
      manifest: e.manifest,
      installed: e.installed,
      description: e.manifest.description,
      version: e.manifest.version,
    }));
  return NextResponse.json({
    success: true,
    // 内置 + 已装市场 画像（结构同 AgentProfile，设置 UI 可直接展示启停/改 prompt）
    agents: [...listAgents(), ...installedMarket],
    market,
    disabled: state.disabled,
    hiddenMenu: state.hiddenMenu,
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

  try {
    if (action === 'install_agent' || action === 'uninstall_agent') {
      if (!agentId) {
        return NextResponse.json({ success: false, error: 'agentId required' }, { status: 400 });
      }
      if (agentId in AGENT_PROFILES) {
        return NextResponse.json({ success: false, error: `Builtin agent cannot be managed here: ${agentId}` }, { status: 400 });
      }
      if (action === 'install_agent') {
        await installAgentPackage(agentId);
      } else {
        await uninstallAgentPackage(agentId);
      }
      const state = await readAgentsState();
      return NextResponse.json({ success: true, market: getAgentMarketCatalog(), disabled: state.disabled, prompts: state.prompts });
    }

    // set_disabled / set_prompt：校验 agentId 必须是内置或已安装市场 agent
    if (!agentId) {
      return NextResponse.json({ success: false, error: 'agentId required' }, { status: 400 });
    }
    const isKnown = agentId in AGENT_PROFILES || loadInstalledAgentProfiles().some((a) => a.id === agentId);
    if (!isKnown) {
      return NextResponse.json({ success: false, error: `Unknown agent: ${agentId}` }, { status: 400 });
    }

    if (action === 'set_disabled') {
      const disabled = body.disabled === true;
      await setAgentDisabled(agentId, disabled);
      const state = await readAgentsState();
      return NextResponse.json({ success: true, disabled: state.disabled, prompts: state.prompts });
    }

    if (action === 'set_hidden_menu') {
      // 菜单可见性 ≠ 禁用：隐藏后 agent 仍已装、能力与身份解析保留（未来可被其他入口调用）
      const hidden = body.hidden === true;
      await setHiddenFromMenu(agentId, hidden);
      const state = await readAgentsState();
      return NextResponse.json({ success: true, hiddenMenu: state.hiddenMenu, prompts: state.prompts });
    }

    if (action === 'set_prompt') {
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      await setCustomPrompt(agentId, prompt);
      const state = await readAgentsState();
      return NextResponse.json({ success: true, disabled: state.disabled, prompts: state.prompts });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${String(action)}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
