/**
 * /api/skills — 技能管理 API
 *
 * GET  /api/skills          — 列出所有技能及其启用状态
 * POST /api/skills          — 更新技能启用状态 { action: 'enable'|'disable'|'enableAll', skillName?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAllSkills } from '@/lib/skills/loader-server';
import {
  enableSkillForAgent,
  disableSkillForAgent,
  enableAllSkillsForAgent,
  getEnabledSkillsForAgent,
  hasAgentConfig,
} from '@/lib/skills/registry-server';

const AGENT_ID = 'default';

/** 系统默认启用的技能 */
const DEFAULT_ENABLED_SKILLS = new Set([
  'character-creator',
  'bob-plugin-creator',
  'skill-creator',
  'user-guide',
  'intern-lawyer',
  'legal-drafter',
]);

export async function GET() {
  try {
    const skills = getAllSkills();
    const hasConfig = hasAgentConfig(AGENT_ID);
    const enabled = hasConfig ? getEnabledSkillsForAgent(AGENT_ID) : DEFAULT_ENABLED_SKILLS;

    const list = skills.map((s) => ({
      name: s.meta.name,
      description: s.meta.description,
      source: s.meta.source,
      version: s.meta.version,
      // 无显式配置时：系统默认技能启用，其余关闭
      enabled: hasConfig ? enabled!.has(s.meta.name) : DEFAULT_ENABLED_SKILLS.has(s.meta.name),
    }));

    return NextResponse.json({ skills: list });
  } catch (e) {
    console.error('GET /api/skills error:', e);
    return NextResponse.json({ error: 'Failed to load skills' }, { status: 500 });
  }
}

/** 确保 Agent 有初始配置（系统默认技能） */
function ensureAgentDefaults() {
  if (!hasAgentConfig(AGENT_ID)) {
    for (const name of DEFAULT_ENABLED_SKILLS) {
      enableSkillForAgent(AGENT_ID, name);
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, skillName } = body as {
      action: 'enable' | 'disable' | 'enableAll';
      skillName?: string;
    };

    // 首次配置时先初始化默认技能，避免默认技能丢失
    ensureAgentDefaults();

    switch (action) {
      case 'enable':
        if (!skillName) {
          return NextResponse.json({ error: 'skillName required' }, { status: 400 });
        }
        enableSkillForAgent(AGENT_ID, skillName);
        break;
      case 'disable':
        if (!skillName) {
          return NextResponse.json({ error: 'skillName required' }, { status: 400 });
        }
        disableSkillForAgent(AGENT_ID, skillName);
        break;
      case 'enableAll':
        // 启用所有已发现的技能
        const allSkills = getAllSkills();
        enableAllSkillsForAgent(AGENT_ID);
        for (const s of allSkills) {
          enableSkillForAgent(AGENT_ID, s.meta.name);
        }
        break;
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('POST /api/skills error:', e);
    return NextResponse.json({ error: 'Failed to update skills' }, { status: 500 });
  }
}
