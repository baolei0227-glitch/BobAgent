/**
 * /api/skills — 技能管理 API
 *
 * GET  /api/skills          — 列出所有技能及其启用状态
 * POST /api/skills          — 更新技能启用状态 / 安装技能 / 卸载技能
 *   { action: 'enable'|'disable'|'enableAll'|'install'|'uninstall', ... }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAllSkills, getDownloadableSkills, hasUserSkill, invalidateSkillsCache } from '@/lib/skills/loader-server';
import { installSkill, installBuiltinSkill, uninstallSkill } from '@/lib/skills/installer-server';
import {
  enableSkillForAgent,
  disableSkillForAgent,
  enableAllSkillsForAgent,
  getEnabledSkillsForAgent,
  hasAgentConfig,
} from '@/lib/skills/registry-server';

const AGENT_ID = 'default';

export async function GET() {
  try {
    const skills = getAllSkills();
    const hasConfig = hasAgentConfig(AGENT_ID);
    const enabled = getEnabledSkillsForAgent(AGENT_ID);

    const list = skills.map((s) => ({
      name: s.meta.name,
      description: s.meta.description,
      source: s.meta.source,
      version: s.meta.version,
      scenes: s.meta.scenes,
      // 无显式配置时：所有已发现技能默认启用
      enabled: hasConfig ? enabled.has(s.meta.name) : true,
    }));

    // 下载制技能（随包源，未下载不可用）：附 installed 状态供客户端列表展示
    const downloadable = getDownloadableSkills().map((s) => ({
      name: s.meta.name,
      description: s.meta.description,
      source: s.meta.source,
      version: s.meta.version,
      scenes: s.meta.scenes,
      installed: hasUserSkill(s.meta.name),
    }));

    return NextResponse.json({ skills: list, downloadable });
  } catch (e) {
    console.error('GET /api/skills error:', e);
    return NextResponse.json({ error: 'Failed to load skills' }, { status: 500 });
  }
}

/** 确保 Agent 有初始配置（首次操作时把所有已发现技能写入持久化） */
function ensureAgentDefaults() {
  if (!hasAgentConfig(AGENT_ID)) {
    for (const s of getAllSkills()) {
      enableSkillForAgent(AGENT_ID, s.meta.name);
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, skillName } = body as {
      action: 'enable' | 'disable' | 'enableAll' | 'install' | 'installBuiltin' | 'uninstall';
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
      case 'install': {
        const { source, url, localPath, autoEnable, force } = body as any;
        if (!source) {
          return NextResponse.json({ success: false, error: '"source" is required (github|local|url)' }, { status: 400 });
        }
        const result = await installSkill({ source, url, localPath, autoEnable, force });
        if (!result.success) {
          const status = result.detail?.includes('already installed') ? 409 : 400;
          return NextResponse.json(result, { status });
        }
        // 安装成功后自动启用
        if (result.skill && (autoEnable !== false)) {
          enableSkillForAgent(AGENT_ID, result.skill.name);
        }
        invalidateSkillsCache(); // 磁盘技能集合已变，失效快照缓存
        return NextResponse.json(result);
      }
      case 'installBuiltin': {
        // 下载制技能物化：从随包源复制到用户本地，下载即启用；
        // force=true 仅在用户确认覆盖本地自定义副本时由 UI 发起
        if (!skillName) {
          return NextResponse.json({ success: false, error: 'skillName required' }, { status: 400 });
        }
        const force = (body as any).force === true;
        const result = await installBuiltinSkill(skillName, { force });
        if (!result.success) {
          const status = result.detail?.includes('already installed') ? 409 : 400;
          return NextResponse.json(result, { status });
        }
        if (result.skill) {
          enableSkillForAgent(AGENT_ID, result.skill.name); // 下载即启用
        }
        invalidateSkillsCache();
        return NextResponse.json(result);
      }
      case 'uninstall': {
        if (!skillName) {
          return NextResponse.json({ success: false, error: 'skillName required' }, { status: 400 });
        }
        const result = uninstallSkill(skillName);
        if (!result.success) {
          return NextResponse.json(result, { status: 400 });
        }
        // 卸载后从注册表中移除
        disableSkillForAgent(AGENT_ID, skillName);
        invalidateSkillsCache(); // 磁盘技能集合已变，失效快照缓存
        return NextResponse.json(result);
      }
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('POST /api/skills error:', e);
    return NextResponse.json({ error: 'Failed to update skills' }, { status: 500 });
  }
}
