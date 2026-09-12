/**
 * agents/market-server.ts — Agent 市场服务端（server-only）
 *
 * Agent 市场对齐 skill 市场（下载制分发包）：
 *   - 随包源：<cwd>/assets/agents/<id>/agent.json （未安装不进运行时画像）
 *   - 用户已装：<APP_ROOT>/agents/<id>/agent.json （物化副本，安装后才可用）
 *   - 市场 agent = 纯配置（专属 prompt + scenes + coreExclusions + skillPool 建议），
 *     不需要新增 host 代码即可成为画布可用节点（agent-<id>，ChatNodeKernel 通用壳）。
 *
 * manifest（agent.json）字段：
 *   id/name/description/version/prompt(专属 base system prompt)
 *   fixedScenes（可选，缺省 ['general']）、coreExclusions（可选）、skillPool（可选，装时写入该 agent 技能池）
 *
 * 注：本模块只在服务端路由/工具内 import，不进客户端 bundle。
 */
import * as fs from 'fs';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { resolveAppRoot } from '@/lib/app-root';
import { AGENT_PROFILES } from './profiles';
import type { AgentProfile } from './profiles';
import type { ToolScene } from '@/app/api/chat/tools';
import { OFFICIAL_PACKAGE_BY_ID } from './official-packages';

/** 已安装 Agent 包目录：<APP_ROOT>/agents/<id>/（与 skills 同级） */
export const USER_AGENTS_DIR = path.join(resolveAppRoot(), 'agents');
/** 随包市场源目录：<cwd>/assets/agents/<id>/（下载制的安装源） */
export const BUILTIN_AGENTS_SRC_DIR = path.resolve(process.cwd(), 'assets', 'agents');

const AGENT_FILE = 'agent.json';
const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

/** 允许在 manifest 中声明的场景白名单（与 tools.ts ToolScene 对齐；未知场景会在转换时丢弃并告警） */
export const ALLOWED_AGENT_SCENES: readonly string[] = [
  'general', 'coding', 'butler', 'legal', 'node', 'audio', 'skill', 'design',
  'ocr', 'admin', 'office', 'browser', 'company', 'team', 'local', 'notebook',
];

export interface AgentPackageManifest {
  id: string;
  name: string;
  description: string;
  version?: string;
  /** 现阶段固定场景画像（与 AGENT_PROFILES 的 scenes:'fixed' 对齐） */
  fixedScenes?: string[];
  /** 常驻内核剔除名单（可选） */
  coreExclusions?: string[];
  /** 安装时写入该 agent 的独立技能池（agentSkills[id]）；缺省 = 回退全局默认技能池 */
  skillPool?: string[];
  /** 专属 base system prompt（缓存头，必须字节稳定） */
  prompt: string;
  icon?: string;
}

export interface AgentMarketEntry {
  manifest: AgentPackageManifest;
  installed: boolean;
}

// ==================== 读取与校验 ====================

function readManifest(dirPath: string): AgentPackageManifest | null {
  try {
    const file = path.join(dirPath, AGENT_FILE);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AgentPackageManifest>;
    const id = String(raw.id ?? '').trim();
    if (!ID_RE.test(id)) return null;
    if (id in AGENT_PROFILES) return null; // 与内置画像重名 → 非市场包
    if (!raw.name || !String(raw.prompt ?? '').trim()) return null;
    return {
      id,
      name: String(raw.name).trim(),
      description: String(raw.description ?? '').trim(),
      version: raw.version ? String(raw.version) : undefined,
      fixedScenes: Array.isArray(raw.fixedScenes) ? raw.fixedScenes.map(String) : undefined,
      coreExclusions: Array.isArray(raw.coreExclusions) ? raw.coreExclusions.map(String) : undefined,
      skillPool: Array.isArray(raw.skillPool) ? raw.skillPool.map(String) : undefined,
      prompt: String(raw.prompt),
      icon: raw.icon ? String(raw.icon) : undefined,
    };
  } catch (e) {
    console.warn('[agents-market] 解析 agent.json 失败:', dirPath, e instanceof Error ? e.message : String(e));
    return null;
  }
}

function listPackageDirs(rootDir: string): string[] {
  try {
    if (!fs.existsSync(rootDir)) return [];
    return fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(rootDir, d.name))
      .filter((dir) => fs.existsSync(path.join(dir, AGENT_FILE)));
  } catch {
    return [];
  }
}

/** manifest → AgentProfile（丢弃非法场景并告警；过滤后为空则回退 ['general']） */
export function manifestToProfile(m: AgentPackageManifest): AgentProfile {
  const allowed = new Set(ALLOWED_AGENT_SCENES);
  const raw = (m.fixedScenes ?? ['general']).filter((s): s is ToolScene => {
    const ok = allowed.has(s);
    if (!ok) console.warn(`[agents-market] ${m.id} 丢弃非法场景: ${s}`);
    return ok;
  });
  const fixedScenes = raw.length > 0 ? raw : (['general'] as ToolScene[]);
  return {
    id: m.id,
    label: m.name,
    scenes: 'fixed',
    fixedScenes,
    forceBrowserTools: false,
    coreExclusions: m.coreExclusions?.length ? m.coreExclusions : undefined,
    baseSystemPrompt: m.prompt,
  };
}

// ==================== 市场/已装 目录 ====================

/** 随包市场源全部包（官方包 + assets/agents 磁盘源；未装+已装 统一 catalog，官方 id 优先防重） */
export function listMarketSource(): AgentPackageManifest[] {
  const seen = new Set<string>();
  const entries: AgentPackageManifest[] = [];
  for (const m of OFFICIAL_PACKAGE_BY_ID.values()) {
    entries.push(m);
    seen.add(m.id);
  }
  for (const m of listPackageDirs(BUILTIN_AGENTS_SRC_DIR)
    .map((d) => readManifest(d))
    .filter((m): m is AgentPackageManifest => !!m)) {
    if (!seen.has(m.id)) {
      entries.push(m);
      seen.add(m.id);
    }
  }
  return entries;
}

/** 已安装包清单（含自定义安装的） */
export function listInstalledPackages(): AgentPackageManifest[] {
  return listPackageDirs(USER_AGENTS_DIR)
    .map((d) => readManifest(d))
    .filter((m): m is AgentPackageManifest => !!m);
}

/** 已安装包 → 运行时 AgentProfile（未知 agentId 的 resolve 用） */
export function loadInstalledAgentProfiles(): AgentProfile[] {
  return listInstalledPackages().map(manifestToProfile);
}

/** 市场目录（随包源 + installed 状态）；不含只存在于用户目录的私有安装？一并列出便于管理 */
export function getAgentMarketCatalog(): AgentMarketEntry[] {
  const installed = new Map(listInstalledPackages().map((m) => [m.id, true]));
  const seen = new Set<string>();
  const entries: AgentMarketEntry[] = [];
  for (const m of listMarketSource()) {
    entries.push({ manifest: m, installed: installed.has(m.id) });
    seen.add(m.id);
  }
  // 用户目录中非随包源的自定义安装（如 Coding 本地造的包）
  for (const m of listInstalledPackages()) {
    if (!seen.has(m.id)) entries.push({ manifest: m, installed: true });
  }
  return entries;
}

/** 按 identity 查已装市场画像；未安装/未找到返回 null（由调用方回退 chat） */
export async function getInstalledAgentProfile(identity: string | undefined): Promise<AgentProfile | null> {
  if (!identity || identity in AGENT_PROFILES) return null;
  const target = listInstalledPackages().find((m) => m.id === identity);
  return target ? manifestToProfile(target) : null;
}

// ==================== 安装 / 卸载 ====================

async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

/** 安装市场包：官方包按权威文本物化 agent.json；磁盘源从 assets/agents 复制。
 *  两者都落到 <APP_ROOT>/agents/<id>/；安装即把 skillPool 写入该 agent 技能池。 */
export async function installAgentPackage(id: string): Promise<AgentPackageManifest> {
  if (id in AGENT_PROFILES) throw new Error(`Agent id conflicts with builtin: ${id}`);
  const destDir = path.join(USER_AGENTS_DIR, id);
  if (fs.existsSync(destDir)) throw new Error(`Agent already installed: ${id}`);
  await fsp.mkdir(USER_AGENTS_DIR, { recursive: true });

  const official = OFFICIAL_PACKAGE_BY_ID.get(id);
  let manifest: AgentPackageManifest;
  if (official) {
    // 官方包（Kar/Butler 等迁市场者）：把 profiles 里的权威 prompt 物化为本地 agent.json
    manifest = official;
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.writeFile(path.join(destDir, AGENT_FILE), JSON.stringify(manifest, null, 2), 'utf-8');
  } else {
    const srcDir = path.join(BUILTIN_AGENTS_SRC_DIR, id);
    const m = readManifest(srcDir);
    if (!m) throw new Error(`Market agent not found: ${id}`);
    manifest = m;
    await copyDir(srcDir, destDir);
  }

  // 独立技能池：仅当包声明 skillPool 时建立 agentSkills[id]（缺省 = 回退全局默认池，不建 key）
  if (manifest.skillPool && manifest.skillPool.length > 0) {
    const { enableSkillForAgent } = await import('@/lib/skills/registry-server');
    for (const s of manifest.skillPool) enableSkillForAgent(id, s);
  }
  return manifest;
}

/** 卸载：删除用户目录副本并清理该 agent 技能池 key（prompts/disabled 覆盖残留无害，可留作回滚） */
export async function uninstallAgentPackage(id: string): Promise<void> {
  const destDir = path.join(USER_AGENTS_DIR, id);
  if (!fs.existsSync(destDir)) throw new Error(`Agent not installed: ${id}`);
  await fsp.rm(destDir, { recursive: true, force: true });
  const { clearAgentSkills } = await import('@/lib/skills/registry-server');
  clearAgentSkills(id);
}
