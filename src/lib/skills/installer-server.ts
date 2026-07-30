/**
 * skills/installer-server.ts — 技能安装与卸载
 *
 * 仅在 Next.js 服务端运行，不可被客户端组件导入。
 */

import 'server-only';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveAppRoot } from '../app-root';
import type { SkillMeta, SkillFrontmatter } from './types';

const USER_SKILLS_DIR = path.join(resolveAppRoot(), 'skills');

/** 简易 frontmatter 解析（避免依赖 loader-server 的未导出函数） */
function parseFrontmatter(content: string): { fm: SkillFrontmatter; body: string } {
  const stripped = content.replace(/^\ufeff/, '');
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { fm: { name: '', description: '' }, body: stripped };
  }
  const fm: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm: fm as unknown as SkillFrontmatter, body: match[2].trimStart() };
}

export interface InstallOptions {
  source: 'github' | 'local' | 'url';
  url?: string;
  localPath?: string;
  autoEnable?: boolean;
  force?: boolean;
}

export interface InstallResult {
  success: boolean;
  skill?: SkillMeta;
  error?: string;
  detail?: string;
}

/** 技能名校验：只允许 a-z, 0-9, -, _ */
const VALID_NAME_RE = /^[a-z0-9_-]+$/;

/** 从 GitHub URL 提取 owner/repo */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '').replace(/\/$/, '') };
}

/** 从 ZIP 中解压并找到技能根目录（包含 SKILL.md 的那一层） */
async function extractFromZip(zipBuffer: Buffer, tmpDir: string): Promise<string> {
  // 动态导入 unzipper（避免浏览器端加载时报错）
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(zipBuffer);

  // 安全检查：过滤路径穿越
  const entries = zip.getEntries();
  for (const entry of entries) {
    if (entry.entryName.includes('..')) {
      throw new Error('Security: path traversal detected in zip');
    }
  }

  zip.extractAllTo(tmpDir, true);

  // GitHub zipball 格式：解压后有一个顶层目录 <owner>-<repo>-<hash>/
  const topEntries = fs.readdirSync(tmpDir, { withFileTypes: true });
  for (const entry of topEntries) {
    if (entry.isDirectory()) {
      // 检查这个目录或其子目录是否包含 SKILL.md
      const skillMd = findSkillMd(path.join(tmpDir, entry.name));
      if (skillMd) return path.dirname(skillMd);
    }
  }

  // 直接的 zip：检查根目录是否有 SKILL.md
  const skillMd = findSkillMd(tmpDir);
  if (skillMd) return path.dirname(skillMd);

  throw new Error('SKILL.md not found in archive');
}

/** 递归查找 SKILL.md（最多两层深度） */
function findSkillMd(dir: string, depth = 0): string | null {
  if (depth > 2) return null;
  const direct = path.join(dir, 'SKILL.md');
  if (fs.existsSync(direct)) return direct;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const found = findSkillMd(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** 解析技能 frontmatter 并返回元数据 */
function parseSkillMeta(skillDir: string): SkillMeta | null {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;

  const content = fs.readFileSync(skillMd, 'utf-8');
  const { fm } = parseFrontmatter(content);

  if (!fm.name || !fm.description) return null;

  return {
    name: fm.name,
    description: fm.description,
    path: skillDir,
    source: 'user',
    version: fm.version || '1.0.0',
  };
}

/**
 * 安装技能包
 *
 * @param opts 安装选项
 * @returns 安装结果
 */
export async function installSkill(opts: InstallOptions): Promise<InstallResult> {
  const tmpDir = path.join(os.tmpdir(), `bob-skill-${Date.now()}`);

  try {
    // ── 1. 获取技能包到临时目录 ──
    fs.mkdirSync(tmpDir, { recursive: true });

    if (opts.source === 'local' && opts.localPath) {
      // 本地路径：验证存在 + 复制
      if (!fs.existsSync(opts.localPath)) {
        return { success: false, error: 'Local path does not exist', detail: opts.localPath };
      }
      const stat = fs.statSync(opts.localPath);
      if (!stat.isDirectory()) {
        return { success: false, error: 'Local path must be a directory' };
      }
      fs.cpSync(opts.localPath, tmpDir, { recursive: true });
    } else if (opts.source === 'github' && opts.url) {
      // GitHub：通过 API 下载 zip
      const gh = parseGitHubUrl(opts.url);
      if (!gh) {
        return { success: false, error: 'Invalid GitHub URL', detail: opts.url };
      }

      const apiUrl = `https://api.github.com/repos/${gh.owner}/${gh.repo}/zipball/main`;
      const resp = await fetch(apiUrl, {
        headers: { Accept: 'application/vnd.github+json' },
      });

      if (!resp.ok) {
        if (resp.status === 403 || resp.status === 429) {
          return { success: false, error: 'GitHub API rate limit exceeded. Try again later.' };
        }
        return { success: false, error: `GitHub download failed (HTTP ${resp.status})` };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const rootDir = await extractFromZip(buffer, tmpDir);

      // 把技能根目录的内容移到 tmpDir 根
      const files = fs.readdirSync(rootDir);
      for (const file of files) {
        fs.renameSync(path.join(rootDir, file), path.join(tmpDir, file));
      }
    } else if (opts.source === 'url' && opts.url) {
      // 直接 URL：下载 zip
      const resp = await fetch(opts.url);
      if (!resp.ok) {
        return { success: false, error: `Download failed (HTTP ${resp.status})` };
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('zip') && !opts.url.endsWith('.zip')) {
        return { success: false, error: 'URL must point to a zip file' };
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const rootDir = await extractFromZip(buffer, tmpDir);

      const files = fs.readdirSync(rootDir);
      for (const file of files) {
        fs.renameSync(path.join(rootDir, file), path.join(tmpDir, file));
      }
    } else {
      return { success: false, error: 'Invalid install source' };
    }

    // ── 2. 校验技能包 ──
    const meta = parseSkillMeta(tmpDir);
    if (!meta) {
      return {
        success: false,
        error: 'Invalid skill package',
        detail: 'SKILL.md not found or missing required fields (name, description)',
      };
    }

    // 名称校验
    if (!VALID_NAME_RE.test(meta.name)) {
      return {
        success: false,
        error: `Invalid skill name: "${meta.name}"`,
        detail: 'Skill name must only contain lowercase letters, numbers, hyphens, and underscores',
      };
    }

    // ── 3. 冲突检测 ──
    const targetDir = path.join(USER_SKILLS_DIR, meta.name);
    if (fs.existsSync(targetDir) && !opts.force) {
      return {
        success: false,
        error: `Skill "${meta.name}" is already installed`,
        detail: 'Use force: true to overwrite',
      };
    }

    // ── 4. 安装 ──
    fs.mkdirSync(USER_SKILLS_DIR, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, targetDir);

    return {
      success: true,
      skill: {
        ...meta,
        path: targetDir,
      },
    };
  } catch (err: any) {
    // 清理临时目录
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { success: false, error: err?.message || 'Unknown install error' };
  }
}

/**
 * 卸载用户安装的技能
 *
 * @param skillName 技能名称
 * @returns 是否成功
 */
export function uninstallSkill(skillName: string): { success: boolean; error?: string } {
  if (!VALID_NAME_RE.test(skillName)) {
    return { success: false, error: `Invalid skill name: "${skillName}"` };
  }

  const targetDir = path.join(USER_SKILLS_DIR, skillName);

  if (!fs.existsSync(targetDir)) {
    return { success: false, error: `Skill "${skillName}" is not installed` };
  }

  // 安全检查：确保删除的是用户技能目录的子目录
  const realTarget = fs.realpathSync(targetDir);
  const realUserDir = fs.realpathSync(USER_SKILLS_DIR);
  if (!realTarget.startsWith(realUserDir + path.sep) && realTarget !== realUserDir) {
    return { success: false, error: 'Security: cannot delete outside user skills directory' };
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  return { success: true };
}

/**
 * 列出所有用户安装的技能
 */
export function listInstalledSkills(): SkillMeta[] {
  if (!fs.existsSync(USER_SKILLS_DIR)) return [];

  const skills: SkillMeta[] = [];
  const entries = fs.readdirSync(USER_SKILLS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = parseSkillMeta(path.join(USER_SKILLS_DIR, entry.name));
    if (meta) skills.push(meta);
  }

  return skills;
}
