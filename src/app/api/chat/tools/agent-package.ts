/**
 * Agent 工具系统 — agent-package 场景（coding 造包：创建 / 校验 / 更新子 agent 包）
 * 从 tools/index.ts 抽出：3 个 coding 场景工具的定义与 executor
 * （create_agent_package / validate_agent_package / update_agent_package）及专属助手
 * （AGENT_ID_RE / strArg / buildAgentBasePrompt）。
 * 依赖方向单向：import 通用依赖 + 仅以 import type 依赖 index.ts 的类型（编译期擦除）。
 * 内核工具名集合 agentCoreToolNames 由 index.ts 装配完 toolDefs 后经 setAgentCoreToolNames 注入，
 * 避免 index ⇄ agent-package 的运行时循环依赖。
 */

import { join } from 'path';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import {
  USER_AGENTS_DIR,
  ALLOWED_AGENT_SCENES,
  listInstalledPackages,
  listMarketSource,
  manifestToProfile,
  type AgentPackageManifest,
} from '@/lib/agents/market-server';
import { AGENT_PROFILES } from '@/lib/agents/profiles';
import type { Tool } from './index';

// ==================== Agent 包 创建 / 校验（coding 造包工具，2026-09-06） ====================
// 架构：由 AI Coding（coding 场景）统一生产新子 agent 包。create 校验 id/场景，
// 自动生成自含机制的 base prompt，落盘 <APP_ROOT>/agents/<id>/agent.json → 立即成为已装市场 agent
// （Extensions Store → Agents + 左侧 ＋ Add session 菜单，无需重启）。
const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

/** 常驻内核工具名集合：无场景标注且未在 SCENED_TOOLS 表 = core 层（coreExclusions 只对这类工具生效）。
 *  由 index.ts 在装配 toolDefs 后注入，故此处为可变状态而非自行计算（避免循环依赖）。 */
let agentCoreToolNames: Set<string> = new Set();
export function setAgentCoreToolNames(names: Set<string>): void {
  agentCoreToolNames = names;
}

function strArg(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

/** 生成自含机制的专属 base system prompt（与既有市场包同一套约定） */
function buildAgentBasePrompt(name: string, description: string, role: string): string {
  const roleLines = role
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join('\n');
  return [
    `You are ${name} — a dedicated sub-agent of BobWork (BobAgent), specialized in: ${description}.`,
    roleLines ? `\n## Role\n${roleLines}` : '',
    `\n## Standing rules`,
    `- Keep every reply precise, professional, and auditable; state assumptions and cite sources where relevant.`,
    `- If the user's intent is ambiguous or inputs are missing, ask targeted questions first (ask_user_questions) instead of guessing.`,
    `- Stay in your lane: only do the specialized job above; do not wander into unrelated domains.`,
    `\n## Workflow`,
    `- For any multi-step task, first call todo_write to publish the full todo list (goal + all steps as status=pending), then call todo_write again at every step boundary (pending→in_progress→completed/failed) so the side panel reflects real progress.`,
    `- Use your available tools only when needed; never call a tool "just in case".`,
    `- Finish by writing your final answer directly in the reply body: the body itself is the deliverable and the turn ends there naturally. finish_task is OPTIONAL (an explicit completion signal only) — never call it as a ritual, and never append empty "task done" closers.`,
    `\n## Deliverables & output`,
    `- To save a deliverable file, write it under the homework/ directory (path "homework/<filename>") and end your reply with the marker line \`OutputFile: homework/<filename>\` so it is shown to the user as an output card.`,
    `- The final reply after all tools finish MUST contain the actual answer text in its body; the \`OutputFile:\` line is appended after the answer — never reply with a bare \`OutputFile:\` line and no body. Text emitted in the same turn as the write_file tool call is not retained as your answer, so restate the conclusion in the final post-tool message.`,
    `- When quoting law articles, judgments or other materials, give the source and version date.`,
    `\n## Communication`,
    `- Reply in the same language the user writes in.`,
    ``,
  ]
    .filter((s) => s.trim())
    .join('\n')
    .trim();
}

async function toolCreateAgentPackage(args: Record<string, unknown>): Promise<string> {
  try {
    const rawId = strArg(args.id, '');
    const id = rawId.toLowerCase();
    if (!AGENT_ID_RE.test(id)) {
      return 'Error: invalid id. Use lowercase [a-z][a-z0-9-]*, start with a letter, max 48 chars (e.g. "contract-review").';
    }
    if (id in AGENT_PROFILES) {
      return `Error: id "${id}" conflicts with a built-in agent (${Object.keys(AGENT_PROFILES).join(', ')}). Pick another id.`;
    }
    const name = strArg(args.name, '');
    const description = strArg(args.description, '');
    const role = strArg(args.role, '');
    if (!name) return 'Error: name is required.';
    if (!description) return 'Error: description is required (what this agent does).';

    // 场景解析：白名单过滤；提供但全非法 → 报错提示
    const allowed = new Set(ALLOWED_AGENT_SCENES);
    const requested = Array.isArray(args.scenes)
      ? args.scenes.map((s) => String(s).toLowerCase()).filter((s) => allowed.has(s))
      : [];
    if (Array.isArray(args.scenes) && requested.length === 0) {
      return `Error: none of the requested scenes is valid. Allowed: ${ALLOWED_AGENT_SCENES.join(', ')}.`;
    }
    const fixedScenes = requested.length > 0 ? requested : ['general'];

    // 内核剔除：未知项保留但提示（可能为后续新增工具）
    const requestedExclusions = Array.isArray(args.coreExclusions)
      ? Array.from(new Set(args.coreExclusions.map((s) => String(s).trim()).filter((s) => !!s)))
      : [];
    const unknownExclusions = requestedExclusions.filter((s) => !agentCoreToolNames.has(s));

    const skillPool = Array.isArray(args.skillPool)
      ? Array.from(new Set(args.skillPool.map((s) => String(s).trim()).filter((s) => !!s)))
      : [];
    const version = strArg(args.version, '1.0.0');

    const prompt = buildAgentBasePrompt(name, description, role);
    const dir = join(USER_AGENTS_DIR, id);
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'agent.json');
    const exists = await (async () => {
      try { await access(target); return true; } catch { return false; }
    })();
    if (exists) {
      return `Error: agent "${id}" already installed at ${dir}. Edit agent.json directly or pick another id.`;
    }

    const manifest: AgentPackageManifest = {
      id,
      name,
      description,
      version,
      fixedScenes,
      coreExclusions: requestedExclusions.length > 0 ? requestedExclusions : undefined,
      skillPool: skillPool.length > 0 ? skillPool : undefined,
      prompt,
    };
    await writeFile(target, JSON.stringify(manifest, null, 2), 'utf-8');

    // round-trip：写盘后从已装目录回读解析（readManifest 校验），失败即删除并报错
    const back = listInstalledPackages().find((m) => m.id === id);
    if (!back) {
      try { await mkdir(USER_AGENTS_DIR, { recursive: true }); } catch { /* ignore */ }
      await writeFile(target, JSON.stringify(manifest, null, 2), 'utf-8');
      const again = listInstalledPackages().find((m) => m.id === id);
      if (!again) {
        await (async () => { try { await (await import('fs/promises')).rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } })();
        return 'Error: written manifest failed validation (check required fields).';
      }
    }
    const profile = manifestToProfile(back ?? manifest);

    // 独立技能池
    if (skillPool.length > 0) {
      const { enableSkillForAgent } = await import('@/lib/skills/registry-server');
      for (const s of skillPool) enableSkillForAgent(id, s);
    }

    const exclusionsKept = (profile.coreExclusions ?? []);
    const resolvedScenes = profile.fixedScenes ?? fixedScenes;
    const summary = [
      `Agent "${name}" (${id}) created and installed at ${dir}/agent.json.`,
      `- Scenes (fixed): ${resolvedScenes.join(', ')}`,
      exclusionsKept.length > 0 ? `- Kernel tools removed: ${exclusionsKept.join(', ')}` : '- Kernel tools removed: none',
      skillPool.length > 0 ? `- Skill pool: ${skillPool.join(', ')}` : '- Skill pool: none (falls back to global default)',
      unknownExclusions.length > 0 ? `- Note: unknown coreExclusions entries kept but not verified: ${unknownExclusions.join(', ')}` : '',
      `- System prompt: ${prompt.length} chars (auto-generated with todo_write / ask_user_questions / finish_task / OutputFile mechanics).`,
      '',
      'The agent is live now — it appears in Extensions Store → Agents and the sidebar ＋ Add session menu. Have the user dispatch an agents-changed event (or reopen) to refresh open UIs.',
    ].filter((l) => !!l).join('\n');
    return summary;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolValidateAgentPackage(args: Record<string, unknown>): Promise<string> {
  try {
    const id = strArg(args.id, '').toLowerCase();
    if (!AGENT_ID_RE.test(id)) return 'Error: invalid agent id.';
    const installed = listInstalledPackages().find((m) => m.id === id);
    const bundled = installed ? undefined : listMarketSource().find((m) => m.id === id);
    const m = installed ?? bundled;
    if (!m) return `Error: no agent package found for "${id}" (checked installed dir and bundled market source).`;
    const profile = manifestToProfile(m);
    const exclusions = profile.coreExclusions ?? [];
    const unknown = exclusions.filter((s) => !agentCoreToolNames.has(s));
    const resolvedScenes = profile.fixedScenes ?? ['general'];
    const where = installed ? `installed (${join(USER_AGENTS_DIR, id)})` : 'bundled market source';
    return [
      `Agent "${m.name}" (${m.id}) — ${where}`,
      `- Version: ${m.version || '1.0.0'}`,
      `- Scenes (fixed, resolved): ${resolvedScenes.join(', ')}`,
      `- Core exclusions: ${exclusions.length > 0 ? exclusions.join(', ') : 'none'}`,
      unknown.length > 0 ? `  (unknown/unverified: ${unknown.join(', ')})` : '',
      `- Skill pool: ${m.skillPool?.length ? m.skillPool.join(', ') : 'none (global default)'}`,
      `- Prompt: ${m.prompt.length} chars`,
      id in AGENT_PROFILES ? `- Note: conflicts with a built-in id (should never happen for market packages).` : '',
    ].filter((l) => !!l).join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolUpdateAgentPackage(args: Record<string, unknown>): Promise<string> {
  try {
    const id = strArg(args.id, '').toLowerCase();
    if (!AGENT_ID_RE.test(id)) return 'Error: invalid agent id.';
    if (id in AGENT_PROFILES) return `Error: "${id}" is a system built-in (chat/coding) and cannot be edited via packages.`;
    const target = join(USER_AGENTS_DIR, id, 'agent.json');
    let raw: Partial<AgentPackageManifest>;
    try {
      raw = JSON.parse(await readFile(target, 'utf-8')) as Partial<AgentPackageManifest>;
    } catch {
      return `Error: no installed agent package "${id}" found at ${USER_AGENTS_DIR}/${id}/agent.json — install it first (Market → Agents), then update.`;
    }

    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : (raw.name ?? id);
    const description = typeof args.description === 'string' ? args.description.trim() : (raw.description ?? '');
    const version = typeof args.version === 'string' && args.version.trim() ? args.version.trim() : (raw.version ?? '1.0.0');

    // scenes：以已装包当前 fixedScenes 为基准做差集/并集（白名单过滤）
    const allowed = new Set(ALLOWED_AGENT_SCENES);
    const currentScenes = Array.isArray(raw.fixedScenes) && raw.fixedScenes.length > 0
      ? raw.fixedScenes.map(String)
      : ['general'];
    const addScenes = Array.isArray(args.addScenes)
      ? Array.from(new Set(args.addScenes.map((s) => String(s).toLowerCase()).filter((s) => allowed.has(s))))
      : [];
    const unknownAdd = Array.isArray(args.addScenes)
      ? Array.from(new Set(args.addScenes.map((s) => String(s).toLowerCase()).filter((s) => !allowed.has(s))))
      : [];
    const removeScenes = Array.isArray(args.removeScenes)
      ? new Set(args.removeScenes.map((s) => String(s).toLowerCase()))
      : new Set<string>();
    const nextScenes = [...new Set([...currentScenes, ...addScenes])].filter((s) => !removeScenes.has(s));
    if (nextScenes.length === 0) return 'Error: scene update would leave the agent with no scenes (keep at least one).';

    // prompt：全量替换 or 追加 instructions 段（未指定则保持原文）
    const promptArg = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : '';
    let prompt = (raw.prompt ?? '').trim();
    if (promptArg) prompt = promptArg;
    else if (instructions) prompt = `${prompt}\n\n## Update requested by user\n${instructions}`;
    if (!prompt) return 'Error: resulting system prompt is empty (provide prompt or instructions).';

    // coreExclusions：数组即全量替换（空数组 = 清空）
    const exclusionWarnings: string[] = [];
    let coreExclusions: string[] | undefined;
    if (Array.isArray(args.coreExclusions)) {
      coreExclusions = Array.from(new Set(args.coreExclusions.map((s) => String(s).trim()).filter((s) => !!s)));
      exclusionWarnings.push(...coreExclusions.filter((s) => !agentCoreToolNames.has(s)));
      if (coreExclusions.length === 0) coreExclusions = undefined;
    }

    const manifest: AgentPackageManifest = {
      id,
      name,
      description,
      version,
      fixedScenes: nextScenes,
      ...(coreExclusions ? { coreExclusions } : {}),
      ...(raw.skillPool ? { skillPool: raw.skillPool } : {}), // 未指定时保持原清单记录
      prompt,
    };

    // skillPool：显式传入即全量替换（含技能池副作用：清旧 + 启新）
    if (Array.isArray(args.skillPool)) {
      const skillPool = Array.from(new Set(args.skillPool.map((s) => String(s).trim()).filter((s) => !!s)));
      if (skillPool.length > 0) manifest.skillPool = skillPool;
      else delete manifest.skillPool;
      const reg = await import('@/lib/skills/registry-server');
      reg.clearAgentSkills(id);
      for (const s of skillPool) reg.enableSkillForAgent(id, s);
    }

    await writeFile(target, JSON.stringify(manifest, null, 2), 'utf-8');
    const back = listInstalledPackages().find((m) => m.id === id);
    if (!back) return `Error: updated agent.json failed validation (${id}).`;
    const profile = manifestToProfile(back);
    const resolvedScenes = profile.fixedScenes ?? nextScenes;
    const kept = profile.coreExclusions ?? [];

    return [
      `Agent "${back.name}" (${back.id}) updated.`,
      `- Scenes (fixed): ${resolvedScenes.join(', ')}`,
      kept.length > 0 ? `- Core exclusions: ${kept.join(', ')}` : '- Core exclusions: none',
      `- Skill pool: ${(back.skillPool ?? []).length > 0 ? back.skillPool!.join(', ') : 'none (global default)'}`,
      `- Prompt: ${back.prompt.length} chars${instructions ? ' (appended instructions)' : ''}${promptArg ? ' (full replace)' : ''}`,
      unknownAdd.length > 0 ? `- Note: ignored unknown scenes: ${unknownAdd.join(', ')} (allowed: ${ALLOWED_AGENT_SCENES.join(', ')})` : '',
      exclusionWarnings.length > 0 ? `- Note: unknown coreExclusions kept unverified: ${exclusionWarnings.join(', ')}` : '',
      'Takes effect on the agent\'s next conversation (loaded from agent.json each request).',
    ].filter((l) => !!l).join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const agentPackageToolDefs: Tool[] = [
  {
    name: 'create_agent_package',
    description: 'Create and instantly install a new specialized sub-agent package. Call when the user asks to build a dedicated agent (e.g. "创建一个合同审核 agent"). Inputs: id, name, description, optional scenes (fixed list), coreExclusions (kernel tools to hide), skillPool, version. Validates the id, resolves scenes, auto-generates the complete base system prompt (persona + standing rules + todo_write/ask_user_questions/finish_task/OutputFile mechanics), writes agent.json to the installed agents dir, and verifies. The agent appears immediately in Extensions Store → Agents and the sidebar ＋ Add session menu.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Unique lowercase agent id, [a-z0-9-], starts with a letter, max 48 chars. Must not collide with built-ins (chat/coding/note/butler).',
        },
        name: {
          type: 'string',
          description: 'Display name, e.g. "Contract Review".',
        },
        description: {
          type: 'string',
          description: 'One-sentence description of the specialized job this agent does; shown in market cards and used to write the persona.',
        },
        role: {
          type: 'string',
          description: 'Optional richer role/persona text the user described (responsibilities, boundaries, style). Appended into the system prompt.',
        },
        scenes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional fixed scenes that decide which scened tools/MCP this agent can call. Allowed: general, coding, legal, node, audio, skill, design, ocr, admin, office, browser, company, local, notebook, butler. Defaults to ["general"]. Scene "notebook" grants the full note domain (Kar-like); "legal" grants pkulaw. Scene "team" is NOT allowed (multi-agent is switch-only).',
        },
        coreExclusions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional names of always-on kernel tools to remove for this agent (e.g. read_file, write_file, run_command, execute_script, web_search, web_fetch). Use to make a pure-specialist agent that never roams files/network.',
        },
        skillPool: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional skill names to enable for this agent only (its own skill pool).',
        },
        version: {
          type: 'string',
          description: 'Optional package version, defaults "1.0.0".',
        },
      },
      required: ['id', 'name', 'description'],
    },
    category: '系统',
    scenes: ['coding'],
    execute: toolCreateAgentPackage,
    maxOutput: 2000,
  },
  {
    name: 'validate_agent_package',
    description: 'Validate an existing agent package (installed in the user agents directory or the bundled market source) before/after editing its agent.json. Reports resolved scenes, active core exclusions, skill pool, prompt length, and id conflicts. Call to diagnose why an agent misbehaves or to check a hand-written manifest.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Agent id to inspect.',
        },
      },
      required: ['id'],
    },
    category: '系统',
    scenes: ['coding'],
    execute: toolValidateAgentPackage,
    maxOutput: 1500,
  },
  {
    name: 'update_agent_package',
    description: 'Update an already-installed sub-agent package (created via create_agent_package or installed from the Agent Market, e.g. Kar/Butler). Call when the user asks to change a running agent: add/remove scenes, change persona, replace core exclusions, adjust its skill pool. Only the fields you pass change; omitted ones are preserved. The installed agent.json is rewritten and takes effect on the agent\'s next conversation (Settings → Agents → Edit Prompt edits an override, not the package).',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Agent id of an installed package to update (must exist under the user agents directory).',
        },
        name: {
          type: 'string',
          description: 'Optional new display name.',
        },
        description: {
          type: 'string',
          description: 'Optional new one-line description (market card text).',
        },
        version: {
          type: 'string',
          description: 'Optional new version string.',
        },
        addScenes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional scenes to ADD to the current fixedScenes (whitelisted). e.g. add "notebook" to grant the full note domain, or "legal" for pkulaw.',
        },
        removeScenes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional scenes to REMOVE from the current fixedScenes. Keep at least one scene.',
        },
        coreExclusions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional FULL replacement list of kernel tool names to exclude for this agent. Pass [] to clear all exclusions. Unknown names are kept but reported.',
        },
        skillPool: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional FULL replacement skill pool for this agent. Pass [] to clear (agent falls back to global default). Omit to leave unchanged.',
        },
        prompt: {
          type: 'string',
          description: 'Optional FULL replacement of the base system prompt. Use only when regenerating; prefer instructions for small tweaks.',
        },
        instructions: {
          type: 'string',
          description: 'Optional additional persona/standing-rule text APPENDED to the current prompt as a new section (keeps the existing prompt intact).',
        },
      },
      required: ['id'],
    },
    category: '系统',
    scenes: ['coding'],
    execute: toolUpdateAgentPackage,
    maxOutput: 2000,
  },
];
