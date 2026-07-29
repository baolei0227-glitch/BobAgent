/**
 * skills/loader-server.ts — 服务端技能加载器
 *
 * 仅在 Next.js 服务端运行，不可被客户端组件导入。
 * 使用 Node.js fs/path/os 读取文件系统。
 */
import 'server-only';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SkillMeta, SkillDefinition, SkillFrontmatter } from './types';
import { resolveAppRoot } from '../app-root';

const SKILL_REQUIRED_FILE = 'SKILL.md';

// 内置技能：随应用打包，位于 projects/assets/skills/
const BUILTIN_SKILLS_DIR = path.resolve(process.cwd(), 'assets', 'skills');

// 用户技能：用户可拖拽安装，位于 <APP_ROOT>/skills/
const USER_SKILLS_DIR = path.join(resolveAppRoot(), 'skills');

// 外部兼容源
const EXTERNAL_DIRS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.cursor', 'skills'),
];

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

  return {
    fm: { name: fm['name'] || '', description: fm['description'] || '', version: fm['version'] },
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

  const meta: SkillMeta = {
    name: fm.name,
    description: fm.description,
    path: dirPath,
    source: 'user',
    version: fm.version || '1.0.0',
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

export function getAllSkills(): SkillDefinition[] {
  const result: SkillDefinition[] = [];
  const seen = new Set<string>();

  // 1. 内置技能（随应用打包）
  for (const s of discoverSkills(BUILTIN_SKILLS_DIR, 'builtin')) {
    seen.add(s.meta.name);
    result.push(s);
  }

  // 2. 用户技能（拖拽安装，覆盖同名内置技能）
  for (const s of discoverSkills(USER_SKILLS_DIR, 'user')) {
    // 移除同名内置技能
    const idx = result.findIndex(r => r.meta.name === s.meta.name);
    if (idx >= 0) result.splice(idx, 1);
    seen.add(s.meta.name);
    result.push(s);
  }

  // 3. 外部兼容源
  for (const extDir of EXTERNAL_DIRS) {
    for (const s of discoverSkills(extDir, 'external')) {
      if (!seen.has(s.meta.name)) {
        seen.add(s.meta.name);
        result.push(s);
      }
    }
  }

  return result;
}

export { loadSkill, discoverSkills };
