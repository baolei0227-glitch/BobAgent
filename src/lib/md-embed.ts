/**
 * Markdown 文档嵌入 — ![[路径]] 语法展开
 *
 * 支持在文档 A 中嵌入文档 B：`![[homework/report.md]]`（Obsidian 风格）。
 * 渲染时把该语法替换为 B 的 markdown 内容（递归展开，防循环引用 / 深度限制）。
 * 路径解析与分享 API 一致（项目根 / home 目录 / cwd 上级多候选）。
 */
import { promises as fs } from 'fs';
import { isAbsolute, resolve, join, dirname } from 'path';
import { homedir } from 'os';
import { getCurrentProject } from '@/lib/project/project-manager';

/** 嵌入语法：![[路径]] */
export const EMBED_RE = /!\[\[([^\]\n]+)\]\]/g;

/** 最大嵌入深度（防 A 嵌 B、B 嵌 A 死循环） */
const MAX_EMBED_DEPTH = 5;
/** 单文档展开后内容上限（防止超大文档撑爆上下文，约 200KB） */
const MAX_EMBED_CHARS = 200_000;

/**
 * 解析嵌入目标路径为绝对路径。
 * @param raw     嵌入参数（如 `咖啡消费趋势示例/报告.md` 或 `~/x.md`）
 * @param baseDir 宿主文档所在目录（优先候选，支持 `![[同目录文件.md]]` 相对引用）
 */
export async function resolveEmbedPath(raw: string, baseDir?: string): Promise<string | null> {
  let p = raw.trim();
  if (!/\.md$/i.test(p)) return null;
  if (p.startsWith('~/')) p = join(homedir(), p.slice(2));

  const roots: string[] = [];
  if (!isAbsolute(p)) {
    if (baseDir) roots.push(baseDir);
    try {
      const project = await getCurrentProject();
      roots.push(project.path);
    } catch { /* 无活跃项目 */ }
    roots.push(homedir());
    roots.push(process.cwd());
    roots.push(resolve(process.cwd(), '..')); // dev 仓库根
  } else {
    roots.push('');
  }

  for (const root of roots) {
    const base = root ? join(root, p) : p;
    const candidates = root ? [base, join(root, 'homework', p)] : [resolve(base)];
    for (const c of candidates) {
      try {
        const st = await fs.stat(c);
        if (st.isFile()) return resolve(c);
      } catch { /* 继续尝试 */ }
    }
  }
  return null;
}

/**
 * 展开 md 中的嵌入语法为内容。
 * @param md      原始 markdown
 * @param depth   当前递归深度（内部使用）
 * @param visited 已展开过的路径集合（防循环）
 * @param baseDir 宿主文档所在目录（用于解析相对嵌入路径）
 * @returns 展开后的 markdown
 */
export async function expandEmbeds(md: string, depth = 0, visited = new Set<string>(), baseDir?: string): Promise<string> {
  if (depth > MAX_EMBED_DEPTH) return md;
  // 快速路径：无嵌入语法直接返回
  // 注意：必须用局部正则实例。共享全局正则（带 g）的 lastIndex 会被递归调用污染，
  // 导致外层 exec 重复匹配同一位置而无限循环。
  const re = new RegExp(EMBED_RE.source, 'g');
  if (!re.test(md)) return md;
  re.lastIndex = 0;

  let total = 0;
  const out: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(md)) !== null) {
    const pathArg = match[1]!.trim();
    const abs = await resolveEmbedPath(pathArg, baseDir);

    // 保留原文片段
    out.push(md.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;

    if (!abs) {
      // 目标不存在：保留语法并在其后标注（用户可看到"嵌入失败"原因，不静默丢内容）
      out.push(match[0]);
      continue;
    }

    const real = await resolve(abs);
    if (visited.has(real)) {
      out.push(`> ⚠️ 嵌入循环引用已忽略：\`${pathArg}\``);
      continue;
    }

    try {
      const content = await fs.readFile(real, 'utf-8');
      const nextVisited = new Set(visited).add(real);
      // 递归展开被嵌入文档内的子嵌入（相对路径以被嵌入文档所在目录为基准）
      let expanded = await expandEmbeds(content, depth + 1, nextVisited, dirname(real));
      if (total + expanded.length > MAX_EMBED_CHARS) {
        expanded = expanded.slice(0, MAX_EMBED_CHARS - total) + '\n\n<!-- embed truncated -->';
      }
      total += expanded.length;
      out.push(`<!-- embed: ${pathArg} -->\n\n${expanded.trim()}\n\n<!-- /embed -->`);
    } catch (e) {
      out.push(`> ⚠️ 嵌入读取失败：\`${pathArg}\`（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  out.push(md.slice(lastIndex));
  return out.join('');
}
