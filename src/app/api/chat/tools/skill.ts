/**
 * Agent 工具系统 — skill 场景（技能库加载 / 技能 L3 资源读取）
 * 从 tools/index.ts 抽出：2 个 skill 场景工具的定义与 executor
 * （load_skill / read_skill_resource）及其专属助手
 * （SKILLS_DIR / getBuiltinSkillsRoot / resolveSkillResource / extractSkillResourceSection）。
 * 依赖方向单向：import 通用依赖 + 仅以 import type 依赖 index.ts 的类型（编译期擦除），
 * 不产生运行时循环依赖；SKILLS_DIR 仍被 index.ts 的路径守卫（isWritablePath）复用，故此处 export。
 */

import { join, isAbsolute, relative } from 'path';
import { readFile } from 'fs/promises';
import { resolveAppRoot } from '@/lib/app-root';
import type { Tool } from './index';

/** 技能目录（用户级，支持 BOBWORK_HOME 覆盖） */
export const SKILLS_DIR = join(resolveAppRoot(), 'skills');

/** 确保可写目录存在 */
try { require('fs').mkdirSync(SKILLS_DIR, { recursive: true }); } catch {}

/** 内建技能根目录（应用打包自带）—— 优先使用，找不到再回退用户目录 SKILLS_DIR */
let _builtinSkillsRoot: string | undefined;
function getBuiltinSkillsRoot(): string {
  if (_builtinSkillsRoot !== undefined) return _builtinSkillsRoot;
  // 在 src/app/api/chat/tools.ts 中向上回溯到 projects/ 再找 assets/skills
  try {
    const candidates = [
      join(process.cwd(), 'assets', 'skills'),
      join(process.cwd(), 'projects', 'assets', 'skills'),
    ];
    // 基于当前文件路径推断（编译后 dist 中位置不同，以 cwd 为准更稳）
    for (const c of candidates) {
      try {
        const fs = require('fs');
        if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
          _builtinSkillsRoot = c;
          return _builtinSkillsRoot;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  _builtinSkillsRoot = '';
  return _builtinSkillsRoot;
}

/**
 * L3 资源目录命名约定：`resources/` 与 `references/` 两种历史写法都存在（如 bob-ui 用 resources/，
 * legal-drafter / slide-craft / intern-lawyer 用 references/），故二者都作为资源根；
 * 再把技能根目录本身作为兜底（可读 SKILL.md、scripts/xxx.py 等技能内任意相对路径）。
 */
const RESOURCE_DIR_NAMES = ['resources', 'references'];

/** 技能目录候选（已存在者）：builtin 内置优先，其次用户目录 SKILLS_DIR */
function skillDirCandidates(skillName: string): string[] {
  const fs = require('fs');
  const dirs: string[] = [];
  const builtinRoot = getBuiltinSkillsRoot();
  if (builtinRoot) dirs.push(join(builtinRoot, skillName));
  dirs.push(join(SKILLS_DIR, skillName));
  return dirs.filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

/** 技能内实际存在的资源根目录（绝对路径）：约定目录优先，技能根目录兜底 */
function listSkillResourceRoots(skillName: string): string[] {
  const fs = require('fs');
  const out: string[] = [];
  for (const dir of skillDirCandidates(skillName)) {
    for (const name of RESOURCE_DIR_NAMES) {
      const sub = join(dir, name);
      try {
        if (fs.statSync(sub).isDirectory() && !out.includes(sub)) out.push(sub);
      } catch { /* 该约定目录不存在 */ }
    }
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * 列举技能全部 L3 资源文件（相对技能目录路径 + 绝对路径），供索引与「未找到」时自纠。
 * 递归一层子目录（如 scripts/、templates/），否则 scripts/generate_docx.py 这类附属脚本
 * 不会出现在索引里，模型只能靠猜（历史故障：猜成 /Users/xxx/.trae-cn/skills/... 被 read_file 拒绝）。
 */
function listSkillResourceFiles(skillName: string): Array<{ rel: string; abs: string }> {
  const fs = require('fs');
  const base = skillDirCandidates(skillName)[0];
  if (!base) return [];
  const out: Array<{ rel: string; abs: string }> = [];

  const walk = (dir: string, depth: number) => {
    let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) walk(abs, depth - 1);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(base, abs).split('\\').join('/');
      if (rel.startsWith('..')) continue;
      if (!out.some((x) => x.rel === rel)) out.push({ rel, abs });
    }
  };

  for (const root of listSkillResourceRoots(skillName)) walk(root, 1);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 解析 skill 内的 L3 资源路径：resourceFile 为「相对技能目录」的路径
 * （如 `references/document-templates.md` / `01-style-rulers.md` / `scripts/gen.py`），
 * 依次在 resources/、references/、技能根目录下查找（兼容两种目录命名）。
 *  - resourceFile 为空时返回首个资源根目录（用于列目录）
 *  - 优先 builtin 内置目录，其次用户目录
 *  - 强制防穿越：resourceFile 不得含 ".."、不得绝对路径
 */
function resolveSkillResource(skillName: string, resourceFile: string | undefined): { path: string; isDir: boolean } | null {
  const safeName = (skillName || '').trim();
  if (!safeName) return null;
  // skillName 本身也防穿越：只允许字母/数字/-/_/.，避免 skillName 里带路径
  if (!/^[\w.\-]+$/.test(safeName)) return null;

  let rel: string | undefined;
  if (resourceFile && resourceFile.trim().length > 0) {
    const rf = resourceFile.trim();
    // 硬穿越防护
    if (isAbsolute(rf) || rf.includes('..')) return null;
    // 规范化：用 / 分隔符统一后再 join，保证不允许用反斜杠拼接 Windows 风格
    const norm = rf.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm) return null;
    const parts = norm.split('/');
    if (parts.some((p) => p === '..' || p === '.')) return null;
    rel = parts.join('/');
  }

  const fs = require('fs');
  for (const root of listSkillResourceRoots(safeName)) {
    const target = rel ? join(root, rel) : root;
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) return { path: target, isDir: true };
      if (st.isFile()) return { path: target, isDir: false };
    } catch { /* 换下一个根目录 */ }
  }
  return null;
}

/**
 * load_skill 工具执行器（DSH 模式）：按名称加载技能库中某技能的完整 SKILL.md 正文。
 * 系统提示只列出技能名称+一句话简介，完整操作指令由模型按需调用本工具获取。
 */
async function toolLoadSkill(args: Record<string, unknown>): Promise<string> {
  const skillName = String(args.skill_name ?? '').trim();
  if (!skillName) return 'Error: skill_name is required';
  try {
    const { getAllSkills } = await import('@/lib/skills/loader-server');
    const all = await getAllSkills();
    const def = all.find((s) => s.meta.name === skillName);
    if (!def) {
      const names = all.map((s) => s.meta.name).join(', ');
      return `Error: skill "${skillName}" not found in the skill library. Available skills: ${names}`;
    }
    const body = def.body || '(empty)';
    return `## 技能完整指令：${skillName}\n\n${body}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * read_skill_resource 工具：读取技能 L3 资源文件（结构化分块文档）
 * - resource 传文件名：读取并返回该文件原始内容（Markdown，直接注入上下文即可阅读）
 * - resource 不传：返回 resources/ 目录下所有文件名 + 每个文件的首段 # / ## / 首段文本摘要（作为索引给 LLM 决策读哪份）
 * - 全程防路径穿越（skillName 正则白名单 + resource 禁止 .. / 绝对路径）
 */
/** 按 ## / ### 段落标题从 Markdown 资源中提取指定节（宽松匹配：精确标题 / 标题包含关键词 / 编号前缀）。
 *  用于 read_skill_resource 的 section 参数：只读所需的某一节，避免整份大文件全量进上下文。
 *  命中多个段落时优先更深的子节（### > ##），内容更精确、更省 token。 */
function extractSkillResourceSection(content: string, section: string): string | null {
  const target = section.trim().replace(/^#+\s*/, '');
  const norm = (s: string) => s.toLowerCase().replace(/[.·:：]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(target);
  if (!t) return null;

  // 按 `## ` / `### ` 标题切分（### 子节默认归属其父 ## 段；直接命中 ### 时单独返回）
  const sections = content.split(/\n(?=(?:#{2,3})\s+)/);
  let best: { sec: string; depth: number } | null = null;
  for (const sec of sections) {
    const head = (sec.match(/^#{2,3}\s+(.+)$/m)?.[1] ?? '').trim();
    const h = norm(head);
    if (!h) continue; // 文件头（单 # 或非标题段）跳过，避免空字符串 includes 误命中
    const core = h.split(/[·:：]/)[0].trim();
    // 完全相等 / 标题包含目标 / 目标包含标题冒号/斜杠前的核心词（如 "2.2" 命中 "### 2.2 字号梯度…"）
    if (h === t || h.includes(t) || (core && t.includes(core))) {
      const depth = /^###\s/.test(sec.trim()) ? 3 : 2;
      if (!best || depth > best.depth) best = { sec, depth };
    }
  }
  return best ? best.sec : null;
}

async function toolReadSkillResource(args: Record<string, unknown>): Promise<string> {
  try {
    const skillName = String(args.skill_name ?? '').trim();
    const resourceRaw = args.resource === undefined || args.resource === null ? undefined : String(args.resource);
    if (!skillName) return JSON.stringify({ ok: false, error: 'skill_name 必填' });

    // 1) 无 resource → 返回索引（resources/ + references/ + 技能根目录内的文件一次列全）
    if (resourceRaw === undefined || resourceRaw.trim() === '') {
      const fs = require('fs');
      if (skillDirCandidates(skillName).length === 0) {
        return JSON.stringify({ ok: false, error: `技能 ${skillName} 不存在（内建/用户技能库均未找到该目录）` });
      }
      const index: Array<{ file: string; size_chars: number; preview: string }> = [];
      for (const f of listSkillResourceFiles(skillName)) {
        try {
          const content = fs.readFileSync(f.abs, 'utf-8') as string;
          // 预览：首段 280 字符（优先取第一条 # / ## 标题 + 首段非空行）
          const lines = content.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
          const headings = lines.filter((l: string) => /^#{1,3}\s+/.test(l)).slice(0, 2);
          const firstBody = lines.filter((l: string) => !/^#{1,3}\s+/.test(l)).slice(0, 2).join(' ');
          const rawPreview = [...headings, firstBody].join('  ·  ');
          const preview =
            rawPreview.length > 320 ? rawPreview.slice(0, 317) + '...' : rawPreview;
          index.push({ file: f.rel, size_chars: content.length, preview });
        } catch {
          index.push({ file: f.rel, size_chars: 0, preview: '(读取失败)' });
        }
      }
      return JSON.stringify({
        ok: true,
        skill: skillName,
        note: 'resource 传 index 里的 file 值（相对技能目录路径，如 "references/document-templates.md"）；可带 section 只读某段（如 resource="01-style-rulers.md" section="字号梯度"）。bob-ui 类技能资源映射：样式标尺→01-style-rulers；布局/密度/对齐→02-density-layout；组件与图表示例→03-widget-examples；自检→04-quality-checklist；信息图海报→05-infographic-poster；审美→06-aesthetic-design；数据图原则→07-dataviz-principles。',
        resources_count: index.length,
        index,
      }, null, 2);
    }

    // 2) 有 resource → 读单个文件
    const resolved = resolveSkillResource(skillName, resourceRaw);
    if (!resolved) {
      const available = listSkillResourceFiles(skillName).map((f) => f.rel);
      return JSON.stringify({
        ok: false,
        error: `未找到资源：${resourceRaw}`,
        available_resources: available,
        hint: available.length
          ? '请从 available_resources 中选一个（相对技能目录的路径）重新调用，不要再猜文件名；省略 resource 参数可看带摘要的索引。'
          : '该技能没有可读资源文件（细节全在 L2 正文），直接用 load_skill 返回的内容即可，不必再读资源。',
      });
    }
    if (resolved.isDir) {
      // 指向目录（resource 以 / 结尾或 资源名是子目录）：返回该子目录下的 index（与空 resource 类似但限定子目录）
      const fs = require('fs');
      const entries = fs.readdirSync(resolved.path, { withFileTypes: true }) as Array<{ name: string; isFile: () => boolean }>;
      const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).sort();
      return JSON.stringify({
        ok: true,
        skill: skillName,
        subdir: resourceRaw.trim().replace(/\/+$/, ''),
        files,
      });
    }
    const content = await readFile(resolved.path, 'utf-8');
    const sectionRaw = args.section === undefined || args.section === null ? undefined : String(args.section).trim();

    // 2b) 指定了 section → 只读匹配的段落（避免整份大文件全量进上下文）
    if (sectionRaw) {
      const extracted = extractSkillResourceSection(content, sectionRaw);
      if (extracted) {
        return (
          `<!-- skill: ${skillName} | resource: ${resourceRaw.trim()} | section: ${sectionRaw} | chars: ${extracted.length}（整文件 ${content.length}） -->\n` +
          `<!-- 已按 section 只返回「${sectionRaw}」节；如需其他节，再次调用并换 section 关键词。 -->\n\n` +
          extracted
        );
      }
      // 未匹配 → 列出该文件全部段落标题，引导重新指定
      const headings = content
        .split(/\r?\n/)
        .filter((l: string) => /^#{2,3}\s+/.test(l.trim()))
        .map((l: string) => l.trim().replace(/^#{2,3}\s+/, ''))
        .join('\n');
      return (
        `<!-- 未找到匹配 section「${sectionRaw}」的段落。${resourceRaw.trim()} 可用 section（关键词或编号）： -->\n` +
        headings + '\n\n' +
        '（可再次调用 read_skill_resource 指定以上任一 section；或省略 section 读取整个文件。）'
      );
    }

    // 2c) 无 section → 返回整个文件
    // 结果直接返回 Markdown 原文（不用 JSON 包），方便 LLM 直接读入上下文；但加个头部标识
    const head =
      `<!-- skill: ${skillName} | resource: ${resourceRaw.trim()} | chars: ${content.length} -->\n` +
      `<!-- 用法：直接当作该技能 L3 文档内容阅读，不要重复读取。完成对应章节输出后无需再读。 -->\n\n`;
    return head + content;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const skillToolDefs: Tool[] = [
  {
    name: 'load_skill',
    description: 'Load the full SKILL.md instructions of a locally available skill by name. Only skills in the available-skills directory can be loaded — others are not downloaded yet; tell the user to download in Settings → Skills first. The system prompt lists only names + one-liners: call this BEFORE performing a task in a skill\'s domain and follow it strictly. Skills the user force-injected (已触发技能) are already fully included — do NOT load. Read smaller resources (palettes, font tables) with read_skill_resource if the body references them.',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '技能名（与技能目录名一致），如 "bob-ui"、"slide-craft"、"intern-lawyer"、"docx"、"pdf"、"skill-creator"。',
        },
      },
      required: ['skill_name'],
    },
    category: '技能',
    execute: toolLoadSkill,
    maxOutput: 50000,
  },
  {
    name: 'read_skill_resource',
    description: '读取已加载/内建技能的 L3「按需资源」文件（结构化分块文档：色板/字号表/组件类/示例代码/自检清单/附属脚本等），在 L2 正文（规则层）注入后需精确细节时按需读取。不传 resource 返回索引表（相对技能目录的文件名+摘要，兼容 resources/ 与 references/ 两种目录命名，子目录一层也会列出）。传 resource + 可选 section 只读某节（按 ##/### 切分），避免整份大文件进上下文。资源名来自 SKILL.md 正文里的相对路径（如 "references/xxx.md"、"scripts/generate_docx.py"）；未命中时会返回 available_resources 清单，按清单重试即可，不要凭猜测改文件名。技能文件只能用本工具读取：不要用 read_file/list_directory 拼技能目录的绝对路径（如 ~/.trae-cn/skills/…），那不在可读范围会被直接拒绝。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '技能名（如 "bob-ui"、"slide-craft"、"docx"），与技能目录名一致。',
        },
        resource: {
          type: 'string',
          description: '资源文件相对技能目录的路径（如 "01-style-rulers.md"、"references/document-templates.md"）。留空/省略=返回全部资源索引（文件名+首段摘要）。',
        },
        section: {
          type: 'string',
          description: '可选：只读资源文件中的一节，按 `##`/`###` 标题关键词匹配（如 "字号梯度"、"HTML 组件类"）；省略=整个文件。例：resource="01-style-rulers.md" + section="字号梯度"。',
        },
      },
      required: ['skill_name'],
    },
    category: '技能',
    execute: toolReadSkillResource,
    maxOutput: 20000,
  },
];
