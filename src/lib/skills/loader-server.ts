/**
 * skills/loader-server.ts — 服务端技能加载器
 *
 * 仅在 Next.js 服务端路由 handler（app/api/* / route.ts）内部 import，
 * 不会进入客户端 bundle。服务端保护由调用点位置保证，不额外依赖
 * `server-only` 哨兵包（避免生产环境缺包导致 500）。
 *
 * 使用 Node.js fs/path/os 读取文件系统。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SkillMeta, SkillDefinition, SkillFrontmatter, SkillScene } from './types';
import { resolveAppRoot } from '../app-root';

const SKILL_REQUIRED_FILE = 'SKILL.md';

// 技能名校验：只允许 a-z, 0-9, -, _（与 installer-server 的 VALID_NAME_RE 一致）
const VALID_SKILL_NAME_RE = /^[a-z0-9_-]+$/;

// 内置技能源：随应用打包，位于 projects/assets/skills/
// 作为「下载制」的随包安装源；未下载的技能不进入可用技能库
export const BUILTIN_SKILLS_DIR = path.resolve(process.cwd(), 'assets', 'skills');

// 用户技能：用户可拖拽安装 / 从随包源下载物化，位于 <APP_ROOT>/skills/
export const USER_SKILLS_DIR = path.join(resolveAppRoot(), 'skills');

/**
 * 系统内置技能（随包即用，无需下载）：官方维护、加载器始终加载、UI 仅可启停。
 * assets/skills 下其余技能 = 下载制（随包作为源，用户点击下载物化到 USER_SKILLS_DIR 才可用）。
 */
export const SYSTEM_BUILTIN_SKILLS: ReadonlySet<string> = new Set([
  'bob-ui',
  'skill-creator',
  'user-guide',
]);

// 外部兼容源
const EXTERNAL_DIRS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.cursor', 'skills'),
];

/** 技能名称 → 场景兜底映射（frontmatter 未声明 scenes 时使用；未列出 = general） */
const SKILL_SCENES: Record<string, SkillScene[]> = {
  // legal 法律
  'intern-lawyer': ['legal'],
  'legal-drafter': ['legal'],
  'legal-statute-search': ['legal'],
  // video（视频处理：录屏切页等；专属 scene 与文档/图片识别场景隔离，避免 OCR/PDF 请求误加载）
  'video-split': ['video'],
  // office 办公文档
  docx: ['office'],
  pdf: ['office'],
  pptx: ['office'],
  xlsx: ['office'],
  // docs 文档处理
  'pdf-splitter': ['docs'],
  'pdf-keyword-extract': ['docs'],
  // design 设计/Web 产物
  'bob-html-artifact': ['design'],
  'slide-craft': ['design'],
  'slack-gif-creator': ['design'],
  // dev 开发工具
  'mcp-builder': ['dev'],
  'webapp-testing': ['dev'],
  'using-coze-cli': ['dev'],
  'skill-creator': ['dev'],
  template: ['dev'],
  'user-guide': ['general'],
};

function parseFrontmatter(content: string): { fm: SkillFrontmatter; body: string } {
  const stripped = content.replace(/^\ufeff/, '');
  if (!stripped.startsWith('---')) {
    return { fm: { name: '', description: '' }, body: content };
  }
  const endIdx = stripped.indexOf('---', 3);
  if (endIdx === -1) {
    return { fm: { name: '', description: '' }, body: content };
  }
  const yamlBlock = stripped.slice(3, endIdx).trim();
  const body = stripped.slice(endIdx + 3).trim();

  const fm: Record<string, string> = {};
  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([\w_-]+)\s*:\s*(.+)$/);
    if (m) fm[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  // 解析 scenes：支持 "scenes: legal,office" 或 "scenes: [legal, office]" 或单值
  let scenes: string[] | undefined;
  const rawScenes = fm['scenes'];
  if (rawScenes) {
    const cleaned = rawScenes.replace(/^\[|\]$/g, '');
    scenes = cleaned
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    fm: {
      name: fm['name'] || '',
      description: fm['description'] || '',
      version: fm['version'],
      scenes,
    },
    body,
  };
}

function loadSkill(dirPath: string): SkillDefinition | null {
  const skillMd = path.join(dirPath, SKILL_REQUIRED_FILE);
  if (!fs.existsSync(skillMd)) return null;
  let content: string;
  try { content = fs.readFileSync(skillMd, 'utf-8'); } catch { return null; }

  const { fm, body } = parseFrontmatter(content);
  if (!fm.name || !fm.description) return null;

  // 场景解析优先级：frontmatter scenes > 名称映射表 > general
  const scenes: SkillScene[] =
    fm.scenes && fm.scenes.length > 0
      ? (fm.scenes as SkillScene[])
      : (SKILL_SCENES[fm.name] ?? ['general']);

  const meta: SkillMeta = {
    name: fm.name,
    description: fm.description,
    path: dirPath,
    source: 'user',
    version: fm.version || '1.0.0',
    scenes,
  };
  return { meta, body };
}

function discoverSkills(dirPath: string, source: 'builtin' | 'user' | 'external' = 'user'): SkillDefinition[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const skills: SkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skill = loadSkill(path.join(dirPath, entry.name));
    if (skill) { skill.meta.source = source; skills.push(skill); }
  }
  return skills;
}

/**
 * 技能快照缓存（目录签名校验）：
 * chat 热路径每轮都会调用 getAllSkills() 构建「可用技能目录」，若每轮都重新
 * readFileSync + parse 全部 SKILL.md，在技能增多的场景下形成无谓磁盘 IO。
 * 策略：缓存一次快照，每次读取前用轻量签名（两目录顶层技能名 + 各 SKILL.md 的
 * size/mtimeMs）比对；签名不变 → 命中缓存，签名变（下载/卸载/编辑/增删）→ 自动重建。
 * 另提供 invalidateSkillsCache() 供写路径（API install/uninstall）显式失效，避免极端
 * 时序下依赖 mtime 的边界。load_skill 编辑即时生效由签名驱动，不改行为语义。
 */
interface SkillsSnapshot {
  sig: string;
  all: SkillDefinition[];
  downloadable: SkillDefinition[];
}

let skillsSnapshot: SkillsSnapshot | null = null;

/** 轻量签名：仅覆盖影响加载结果的文件（各技能目录下的 SKILL.md） */
function computeSkillSignature(): string {
  const parts: string[] = [];
  const roots: Array<[string, string]> = [
    [BUILTIN_SKILLS_DIR, 'B'],
    [USER_SKILLS_DIR, 'U'],
  ];
  for (const [root, tag] of roots) {
    let names: string[] = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    names.sort();
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const md = path.join(root, name, SKILL_REQUIRED_FILE);
      let st: fs.Stats;
      try { st = fs.statSync(md); } catch { continue; }
      parts.push(`${tag}/${name}:${st.size}:${st.mtimeMs}`);
    }
  }
  return parts.join('|');
}

/** 构建（或重建）技能快照：all = 系统内置 + 用户已下载；downloadable = 随包源待下载清单 */
function buildSkillsSnapshot(): SkillsSnapshot {
  const all: SkillDefinition[] = [];
  const seen = new Set<string>();

  // 1. 系统内置技能（随应用打包、随包即用：仅 SYSTEM_BUILTIN_SKILLS 名单；
  //    其余 assets/skills 目录为「下载制」源，未下载不进入可用技能库）
  for (const s of discoverSkills(BUILTIN_SKILLS_DIR, 'builtin')) {
    if (!SYSTEM_BUILTIN_SKILLS.has(s.meta.name)) continue;
    seen.add(s.meta.name);
    all.push(s);
  }

  // 2. 用户技能（拖拽安装 / 随包源下载物化，覆盖同名内置技能）
  for (const s of discoverSkills(USER_SKILLS_DIR, 'user')) {
    // 移除同名内置技能
    const idx = all.findIndex(r => r.meta.name === s.meta.name);
    if (idx >= 0) all.splice(idx, 1);
    seen.add(s.meta.name);
    all.push(s);
  }

  // 3. 外部兼容源（已停用：2026-08 起仅内置 + 用户技能，外部 ~/.claude、~/.cursor 技能不再自动加载）
  //    如需恢复 Claude Code / Cursor 技能兼容，取消下方循环注释即可。
  // for (const extDir of EXTERNAL_DIRS) {
  //   for (const s of discoverSkills(extDir, 'external')) {
  //     if (!seen.has(s.meta.name)) {
  //       seen.add(s.meta.name);
  //       result.push(s);
  //     }
  //   }
  // }

  // 下载制清单（随包源；builtin 全量过滤系统内置）
  const downloadable = discoverSkills(BUILTIN_SKILLS_DIR, 'builtin').filter(
    (s) => !SYSTEM_BUILTIN_SKILLS.has(s.meta.name),
  );

  return { sig: computeSkillSignature(), all, downloadable };
}

/** 获取可用技能快照（系统内置 + 用户已下载；命中目录签名缓存） */
export function getAllSkills(): SkillDefinition[] {
  const sig = computeSkillSignature();
  if (!skillsSnapshot || skillsSnapshot.sig !== sig) {
    skillsSnapshot = buildSkillsSnapshot();
  }
  return skillsSnapshot.all;
}

/**
 * 下载制技能清单（随包源）：assets/skills 中除系统内置外的技能。
 * 仅作「客户端可下载列表」与物化安装源展示，未下载时不参与加载/注入/load_skill。
 */
export function getDownloadableSkills(): SkillDefinition[] {
  const sig = computeSkillSignature();
  if (!skillsSnapshot || skillsSnapshot.sig !== sig) {
    skillsSnapshot = buildSkillsSnapshot();
  }
  return skillsSnapshot.downloadable;
}

/** 显式失效技能快照缓存（写路径：API 安装/卸载后调用；下次读取自动重建） */
export function invalidateSkillsCache(): void {
  skillsSnapshot = null;
}

/** 用户是否已下载某技能（USER_SKILLS_DIR 下存在有效 SKILL.md 即视为已下载） */
export function hasUserSkill(name: string): boolean {
  if (!VALID_SKILL_NAME_RE.test(name)) return false;
  return fs.existsSync(path.join(USER_SKILLS_DIR, name, SKILL_REQUIRED_FILE));
}

export { loadSkill, discoverSkills, parseFrontmatter, SKILL_SCENES };
