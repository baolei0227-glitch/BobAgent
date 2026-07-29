/**
 * Agent 工具系统 — 服务端工具定义与执行器
 *
 * 基于 agent_tools.py (Python) 的设计理念，用 TypeScript 实现：
 *   - ToolRegistry：工具注册表，支持分类管理、动态注册
 *   - Tool：统一工具接口（schema + 执行函数 + 元数据）
 *   - executeTool：工具执行入口，返回结果 + 耗时 + 成功状态
 *
 * 流程：用户输入 → [思考] → [调用工具] → [执行] → [思考] → ... → 最终回答
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, unlink, readdir, stat } from 'fs/promises';
import { join, resolve, relative, isAbsolute, sep, extname } from 'path';
import { homedir } from 'os';

const execAsync = promisify(exec);

/** 工作区根路径 — 沙箱隔离在 ~/BobAgent/sandbox/ */
const WORKSPACE = (() => {
  const sandbox = join(homedir(), 'BobAgent', 'sandbox');
  try { require('fs').mkdirSync(sandbox, { recursive: true }); } catch {}
  return sandbox;
})();

/** 额外可写路径 */
const SKILLS_DIR = join(homedir(), 'BobAgent', 'skills');
const PROJECTS_DIR = join(homedir(), 'BobAgent', 'projects');

/** 所有可写根路径（沙箱 + 技能 + 项目） */
const WRITABLE_ROOTS = [WORKSPACE, SKILLS_DIR, PROJECTS_DIR];

/** 确保可写目录存在 */
try { require('fs').mkdirSync(SKILLS_DIR, { recursive: true }); } catch {}
try { require('fs').mkdirSync(PROJECTS_DIR, { recursive: true }); } catch {}

/** 检查路径是否在可写范围内 */
function isWritablePath(resolvedPath: string): boolean {
  return WRITABLE_ROOTS.some(root => resolvedPath.startsWith(root + sep) || resolvedPath === root);
}

// ============================================================
// 类型定义
// ============================================================

/** 工具分类 */
export type ToolCategory = '文件' | '系统' | '网络';

/** OpenAI function calling 格式的工具定义 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 工具执行函数签名 */
type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

/** 工具元数据 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: ToolCategory;
  execute: ToolExecutor;
  /** 最大输出长度（字符），默认 5000 */
  maxOutput: number;
  /** 执行超时（毫秒），仅对命令类工具有效 */
  timeoutMs?: number;
}

/** 工具执行结果 */
export interface ToolExecResult {
  result: string;
  durationMs: number;
  success: boolean;
}

// ============================================================
// 工具注册表
// ============================================================

/**
 * 工具注册表。管理 agent 可用的所有工具。
 *
 * 对应 Python 版 ToolRegistry：
 *   - register(tool): 注册单个工具
 *   - get(name): 按名称查找
 *   - toApiFormat(): 批量转换为 OpenAI API 格式
 *   - byCategory(cat): 按分类筛选
 */
class ToolRegistry {
  private _tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this._tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  listAll(): Tool[] {
    return Array.from(this._tools.values());
  }

  byCategory(category: ToolCategory): Tool[] {
    return this.listAll().filter((t) => t.category === category);
  }

  toApiFormat(): ToolDefinition[] {
    return this.listAll().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  count(): number {
    return this._tools.size;
  }
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 路径解析 — 对应 Python 版 Path.expanduser() + resolve()
 *
 * 支持：
 *   - ~ 展开为用户主目录
 *   - 相对路径基于 WORKSPACE
 *   - 绝对路径直接使用
 */
function resolvePath(inputPath: string): string {
  // 展开 ~ 为用户主目录（对应 Python 的 Path.expanduser()）
  let p = inputPath;
  if (p === '~') {
    p = homedir();
  } else if (p.startsWith('~/')) {
    p = join(homedir(), p.slice(2));
  }

  if (isAbsolute(p)) {
    return resolve(p);
  }
  return resolve(join(WORKSPACE, p));
}

/** 截断输出，附加字符计数 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n...(truncated, ${text.length} chars total)`;
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 应跳过的目录名 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build',
  '.cache', '__pycache__', '.venv', 'venv', '.DS_Store',
]);

/**
 * glob 模式转正则 — 对应 Python 的 fnmatch 但更强大
 *
 * 支持：* (任意字符), ? (单字符), ** (递归目录)
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
    } else if (c === '*') {
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]?';
      i++;
    } else if ('.+^${}()|[]\\'.includes(c)) {
      regex += '\\' + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp('^' + regex + '$');
}

// ============================================================
// 工具实现
// ============================================================

/** 读取文件内容 */
async function toolReadFile(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  if (!path) return 'Error: path required';

  try {
    const filePath = resolvePath(path);
    const content = await readFile(filePath, 'utf-8');
    return truncate(content, 8000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) return `File not found: ${path}`;
    if (msg.includes('EISDIR')) return `Path is a directory: ${path}`;
    return `Read failed: ${msg}`;
  }
}

/** 列出目录内容 */
async function toolListDirectory(args: Record<string, unknown>): Promise<string> {
  const dirPath = resolvePath((args.path as string) || '.');

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const lines: string[] = [];

    for (const entry of entries.sort((a, b) => {
      // 目录优先，然后按名称排序
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })) {
      const suffix = entry.isDirectory() ? '/' : '';
      let size = '';
      if (entry.isFile()) {
        try {
          const s = await stat(join(dirPath, entry.name));
          size = ` (${formatSize(s.size)})`;
        } catch { /* ignore */ }
      }
      lines.push(`  ${entry.name}${suffix}${size}`);
    }

    return lines.length > 0 ? lines.join('\n') : '(empty directory)';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) return `Directory not found: ${args.path ?? '.'}`;
    if (msg.includes('ENOTDIR')) return `Path is not a directory: ${args.path ?? '.'}`;
    return `Directory read failed: ${msg}`;
  }
}

/** 搜索匹配模式的文件 — 改进版：支持 glob 语法 */
async function toolSearchFiles(args: Record<string, unknown>): Promise<string> {
  const pattern = args.pattern as string;
  if (!pattern) return 'Error: pattern required';

  const searchDir = resolvePath((args.path as string) || '.');
  const maxResults = 50;
  const maxDepth = 8;
  const results: string[] = [];
  const regex = globToRegex(pattern);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || results.length >= maxResults) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(WORKSPACE, fullPath);

      if (entry.isFile() && regex.test(entry.name)) {
        results.push(relPath || fullPath);
        if (results.length >= maxResults) return;
      }

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  try {
    await walk(searchDir, 0);

    if (results.length === 0) {
      return `No files matching "${pattern}"`;
    }

    let output = results.join('\n');
    if (results.length >= maxResults) {
      output += `\n... ${maxResults}+ results (truncated)`;
    }
    return output;
  } catch (e) {
    return `Search failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 执行 shell 命令 */
async function toolRunCommand(args: Record<string, unknown>): Promise<string> {
  const cmd = args.cmd as string;
  if (!cmd) return 'Error: cmd required';

  const timeout = 30_000;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: WORKSPACE,
      timeout,
      maxBuffer: 1024 * 1024,
    });

    let output = stdout;
    if (stderr) {
      output += `\n[stderr]\n${stderr}`;
    }
    if (!output.trim()) {
      output = '(no output)';
    }
    return truncate(output, 5000);
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; message?: string };

    if (err.killed) {
      return `Command timed out (${timeout / 1000}s)`;
    }

    let output = err.stdout || '';
    if (err.stderr) output += `\n[stderr]\n${err.stderr}`;
    if (!output.trim()) {
      output = `Execution failed: ${err.message || String(e)}`;
    }
    return truncate(output, 5000);
  }
}

/** 自主编码解决问题 — 写脚本并执行 */
async function toolExecuteScript(args: Record<string, unknown>): Promise<string> {
  const language = (args.language as string) || 'python';
  const script = args.script as string;
  if (!script) return 'Error: script content is required';

  // 选择解释器和文件扩展名
  const isPython = language === 'python' || language === 'py';
  const ext = isPython ? '.py' : '.sh';
  const interpreter = isPython ? 'python3' : 'bash';
  const tmpFileName = `.bobagent_script_${Date.now()}${ext}`;
  const tmpPath = join(WORKSPACE, tmpFileName);
  const SCRIPT_TIMEOUT = 30_000;

  try {
    // 写入脚本文件
    await writeFile(tmpPath, script, 'utf-8');
    if (isPython) {
      try { await execAsync(`chmod +x "${tmpPath}"`); } catch { /* ignore */ }
    }

    const cmd = `${interpreter} "${tmpPath}"`;

    const { stdout, stderr } = await execAsync(cmd, {
      cwd: WORKSPACE,
      timeout: SCRIPT_TIMEOUT,
      maxBuffer: 1024 * 1024,
    });

    let output = stdout;
    if (stderr) {
      output += output ? `\n[stderr]\n${stderr}` : `[stderr]\n${stderr}`;
    }
    if (!output.trim()) {
      output = '(script executed with no output)';
    }
    return truncate(output, 8000);
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; message?: string };

    if (err.killed) {
      return `Script timed out (${SCRIPT_TIMEOUT / 1000}s)`;
    }

    let output = err.stdout || '';
    if (err.stderr) output += output ? `\n[stderr]\n${err.stderr}` : `[stderr]\n${err.stderr}`;
    if (!output.trim()) {
      output = `Script execution failed: ${err.message || String(e)}`;
    }
    return truncate(output, 8000);
  } finally {
    // 清理临时脚本文件
    try { await unlink(tmpPath); } catch { /* ignore */ }
  }
}

/** 网页搜索 — 多 provider 降级：Coze SDK → Bing HTTP → DuckDuckGo Lite */
async function toolWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  if (!query) return 'Error: query required';

  // Provider 1: Coze SDK（需要配置 API Key）
  try {
    const { SearchClient, Config } = await import('coze-coding-dev-sdk');
    const config = new Config();
    if (config.apiKey) {
      const client = new SearchClient(config);
      const response = await client.webSearch(query, 5, true);

      const parts: string[] = [];
      if (response.summary) {
        parts.push(`Summary: ${response.summary}`);
      }
      if (response.web_items && response.web_items.length > 0) {
        parts.push('Search results:');
        for (const item of response.web_items) {
          parts.push(`- ${item.title}${item.url ? ` (${item.url})` : ''}: ${item.snippet}`);
        }
      }

      const text = parts.join('\n');
      if (text) return text;
    }
  } catch {
    // SDK 不可用，降级到本地搜索
  }

  // Provider 2 & 3 & 4: 本地 HTTP 抓取（无需 API Key）
  // 百度优先（中文搜索质量最好），Bing 次之，DDG 兜底
  const providers = [
    { name: 'Baidu', search: searchBaiduHttp },
    { name: 'Bing', search: searchBingHttp },
    { name: 'DuckDuckGo', search: searchDuckDuckGoLite },
  ];
  const errors: string[] = [];

  for (const { name, search } of providers) {
    try {
      const results = await search(query, 5);
      if (results.length > 0) {
        const parts: string[] = ['Search results:'];
        for (const r of results) {
          parts.push(`- ${r.title}${r.url ? ` (${r.url})` : ''}: ${r.snippet}`);
        }
        return parts.join('\n');
      }
      errors.push(`${name}: no results`);
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return `Search failed after trying ${providers.length} providers:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\nCheck network and retry.`;
}

// ---- 本地搜索 Provider ----

interface LocalSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** Bing HTTP 抓取 */
async function searchBingHttp(query: string, maxResults: number): Promise<LocalSearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': SEARCH_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const results: LocalSearchResult[] = [];
  const blockRegex = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) && results.length < maxResults) {
    const block = match[1];
    // 从 <h2> 内提取链接
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const rawUrl = linkMatch[1];
    const title = stripHtml(linkMatch[2]).trim();
    if (!title || rawUrl.startsWith('javascript:')) continue;

    // 摘要：优先 b_caption 内的 <p>
    let snippet = '';
    const snippetMatch =
      block.match(/<div[^>]*class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (snippetMatch) {
      snippet = decodeHtmlEntities(stripHtml(snippetMatch[1])).trim();
    }

    results.push({ title, url: rawUrl, snippet });
  }

  return results;
}

/** 百度搜索 HTTP 抓取 */
async function searchBaiduHttp(query: string, maxResults: number): Promise<LocalSearchResult[]> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': SEARCH_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const results: LocalSearchResult[] = [];
  // 百度结果标题在 <h3> > <a> 中，链接是百度跳转链接
  const h3Regex = /<h3[^>]*>\s*<a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const links: Array<[string, string]> = [];
  let match: RegExpExecArray | null;
  while ((match = h3Regex.exec(html))) {
    links.push([match[1], match[2]]);
  }

  // 摘要在 result 块内的 <span class="content-right_..."> 或 c-abstract 中
  const blockRegex = /<div[^>]*class="result c-container[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="result |$)/g;
  const snippets: string[] = [];
  while ((match = blockRegex.exec(html))) {
    const block = match[1];
    const snippetMatch =
      block.match(/<span[^>]*class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/) ||
      block.match(/class="c-abstract[^"]*"[^>]*>([\s\S]*?)</);
    const snippet = snippetMatch ? decodeHtmlEntities(stripHtml(snippetMatch[1])).trim() : '';
    snippets.push(snippet);
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const [rawUrl, rawTitle] = links[i];
    const title = decodeHtmlEntities(stripHtml(rawTitle)).trim();
    // 百度链接是跳转链接，保留原样（用户可点击）
    const finalUrl = rawUrl;
    const snippet = i < snippets.length ? snippets[i] : '';
    if (title) {
      results.push({ title, url: finalUrl, snippet });
    }
  }

  return results;
}

/** DuckDuckGo Lite 抓取 */
async function searchDuckDuckGoLite(query: string, maxResults: number): Promise<LocalSearchResult[]> {
  const resp = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'User-Agent': SEARCH_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const linkRegex = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

  const links: Array<[string, string]> = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html))) {
    links.push([m[1], m[2]]);
  }
  while ((m = snippetRegex.exec(html))) {
    snippets.push(m[1]);
  }

  const results: LocalSearchResult[] = [];
  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const [rawUrl, rawTitle] = links[i];
    const title = cleanDdgTitle(rawTitle);
    const url = extractDdgUrl(rawUrl);
    const snippet = i < snippets.length ? decodeHtmlEntities(stripHtml(snippets[i])).trim() : '';
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/** 提取 DDG 跳转链接中的真实 URL */
function extractDdgUrl(rawUrl: string): string {
  if (rawUrl.includes('uddg=')) {
    const match = rawUrl.match(/uddg=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  if (rawUrl.startsWith('//')) return 'https:' + rawUrl;
  return rawUrl;
}

/** 清理 DDG Lite 标题中的 URL 残留 */
function cleanDdgTitle(rawTitle: string): string {
  let text = stripHtml(rawTitle).trim();
  // 截断混入的 URL
  text = text.split(/https?:\/\//)[0];
  // 去掉尾部残留域名
  text = text.replace(/\s*\w+\.\w{2,}\s*$/, '').trim();
  return text;
}

/** 移除 HTML 标签 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** 解码常见 HTML 实体 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&nbsp;': ' ', '&ensp;': ' ', '&emsp;': ' ',
    '&#0183;': '·', '&middot;': '·', '&mdash;': '—', '&ndash;': '–',
    '&hellip;': '…', '&ldquo;': '\u201c', '&rdquo;': '\u201d',
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.split(entity).join(char);
  }
  // 数字实体
  text = text.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10);
    return code < 0x10000 ? String.fromCharCode(code) : '';
  });
  // 合并空白
  return text.replace(/\s+/g, ' ').trim();
}

/** 写入文件内容 */
async function toolWriteFile(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  const content = args.content as string;
  if (!path) return 'Error: path required';
  if (content === undefined) return 'Error: content required';

  try {
    const { writeFile, mkdir } = await import('fs/promises');
    const filePath = resolvePath(path);
    if (!isWritablePath(filePath)) {
      return `Error: 路径 "${path}" 不在可写范围内。允许写入：~/BobAgent/sandbox/、~/BobAgent/skills/、~/BobAgent/projects/`;
    }
    const dir = filePath.substring(0, filePath.lastIndexOf(sep));
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return `Written: ${path} (${content.length} chars)`;
  } catch (e) {
    return `Write failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 读取附件内容 */
async function toolReadAttachment(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  if (!path) return 'Error: path required';

  try {
    // 附件路径是相对于项目目录的，需要获取当前项目路径
    const { getCurrentProject, buildVisionModelConfig } = await import('@/lib/project/project-manager');
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const project = await getCurrentProject();
    const filePath = join(project.path, path);
    const ext = extname(filePath).toLowerCase();

    const textExts = ['.txt', '.md', '.markdown', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.go', '.rs', '.yaml', '.yml', '.ini', '.conf', '.log'];
    const isTextFile = textExts.includes(ext);

    if (isTextFile) {
      const content = await readFile(filePath, 'utf-8');
      const fileStat = await stat(filePath);
      return truncate(
        `Attachment: ${path} (${formatSize(fileStat.size)})\n\n${content}`,
        8000,
      );
    }

    // 特殊处理 .docx（实际是 zip 格式，包含 document.xml）
    if (ext === '.docx') {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const tmpDir = `/tmp/bob-agent-docx-${Date.now()}`;
        await execAsync(`mkdir -p "${tmpDir}" && unzip -o "${filePath}" word/document.xml -d "${tmpDir}"`, { timeout: 10000 });
        const xmlContent = await readFile(`${tmpDir}/word/document.xml`, 'utf-8');
        // 简单提取纯文本（去除 XML 标签）
        const text = xmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const fileStat = await stat(filePath);
        await execAsync(`rm -rf "${tmpDir}"`).catch(() => {});
        return truncate(
          `Attachment: ${path} (${formatSize(fileStat.size)}, .docx text extracted)\n\n${text}`,
          8000,
        );
      } catch (extractErr) {
        return `Attachment: ${path}\nType: Word (.docx)\nUnable to extract text: ${extractErr instanceof Error ? extractErr.message : String(extractErr)}\n\nSuggestion: please provide .txt or .md format.`;
      }
    }

    // 特殊处理 .pdf：Python pypdf → pdfplumber → sips+VLM
    if (ext === '.pdf') {
      try {
        const { extractWithPython, extractWithPdfParse } = await import('@/lib/pdf/extractor');
        const fileStat = await stat(filePath);

        // 第1+2级：Python pypdf → pdfplumber
        const pyResult = await extractWithPython(filePath);

        if (pyResult.text && pyResult.text.length > 20) {
          const truncated = pyResult.text.length > 8000
            ? pyResult.text.slice(0, 8000) + `\n...(${pyResult.pageCount} pages, truncated)`
            : pyResult.text;
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, PDF via ${pyResult.method})\n\n${truncated}`,
            8000,
          );
        }

        // Python 提取失败，尝试 pdf-parse 兜底
        const fallback = await extractWithPdfParse(filePath);
        if (fallback.text && fallback.text.length > 20) {
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, PDF via pdf-parse)\n\n${fallback.text}`,
            8000,
          );
        }

        // 扫描件：高质量多页渲染 + 视觉模型 OCR
        const scannedPages = pyResult.pageCount || fallback.pageCount;
        if (scannedPages > 0) {
          const settings = await readSettingsFromFile();
          const visionModel = settings.vision.defaultModel;
          const visionApiKey = settings.vision.apiKey;

          if (visionModel && visionApiKey) {
            try {
              const { renderPdfToImages } = await import('@/lib/pdf/extractor');
              const { exec } = await import('child_process');
              const { promisify } = await import('util');
              const execAsync = promisify(exec);

              // pypdf 分页 + sips 200 DPI 渲染
              const imgResult = await renderPdfToImages(filePath, 200, 50);

              if (imgResult.success && imgResult.images.length > 0) {
                const modelConfig = await buildVisionModelConfig(visionModel, visionApiKey, settings.vision.baseUrl || undefined);
                const { parseImage } = await import('@/lib/parse/image-parser');

                // 并行逐页 OCR（并发上限 3，避免 API 限流）
                const concurrency = 3;
                const ocrResults: { index: number; text: string }[] = [];
                for (let batch = 0; batch < imgResult.images.length; batch += concurrency) {
                  const batchSlice = imgResult.images.slice(batch, batch + concurrency);
                  const batchResults = await Promise.all(
                    batchSlice.map(async (img, j) => {
                      const pageNum = batch + j + 1;
                      try {
                        const pageResult = await parseImage(
                          img,
                          project.path,
                          { model: modelConfig.model, apiKey: modelConfig.apiKey, baseUrl: modelConfig.baseUrl, mode: 'document' }
                        );
                        return { index: pageNum, text: `[Page ${pageNum}]\n${pageResult.extracted_text}` };
                      } catch {
                        return { index: pageNum, text: `[Page ${pageNum}] OCR failed` };
                      }
                    }),
                  );
                  ocrResults.push(...batchResults);
                }
                ocrResults.sort((a, b) => a.index - b.index);

                // 清理临时文件
                await execAsync(`rm -rf "${imgResult.tmpDir}"`).catch(() => {});

                return truncate(
                  `Attachment: ${path} (${formatSize(fileStat.size)}, Scanned PDF, ${imgResult.rendered}/${imgResult.totalPages} pages at ${imgResult.dpi} DPI)\n\n${ocrResults.map(r => r.text).join('\n\n')}`,
                  50000,
                );
              }
            } catch (ocrErr) {
              // 回退到单页 sips
            }
          }
        }

        // 回退：单页 sips + 视觉模型
        if (scannedPages > 0) {
          const settings = await readSettingsFromFile();
          const visionModel = settings.vision.defaultModel;
          const visionApiKey = settings.vision.apiKey;

          if (visionModel && visionApiKey) {
            try {
              const { exec } = await import('child_process');
              const { promisify } = await import('util');
              const { randomUUID } = await import('crypto');
              const execAsync = promisify(exec);
              const tmpPng = `/tmp/bobagent-pdf-ocr-${randomUUID()}.png`;

              await execAsync(`sips -s format png --resampleWidth 1654 "${filePath}" --out "${tmpPng}"`, { timeout: 30000 });

              const modelConfig = await buildVisionModelConfig(visionModel, visionApiKey, settings.vision.baseUrl || undefined);
              const { parseImage } = await import('@/lib/parse/image-parser');

              const imgResult = await parseImage(
                tmpPng,
                project.path,
                { model: modelConfig.model, apiKey: modelConfig.apiKey, baseUrl: modelConfig.baseUrl, mode: 'document' }
              );

              await execAsync(`rm -f "${tmpPng}"`).catch(() => {});

              return truncate(
                `Attachment: ${path} (${formatSize(fileStat.size)}, Scanned PDF, OCR via vision model)\n\n${imgResult.extracted_text}`,
                50000,
              );
            } catch (ocrErr) {
              // 也失败
            }
          }
        }

        return `Attachment: ${path}\nType: PDF (${pyResult.pageCount} pages)\nSize: ${formatSize(fileStat.size)}\n\nUnable to extract text from this PDF. It may be scanned or image-based.`;
      } catch (extractErr) {
        const fileStat = await stat(filePath);
        return `Attachment: ${path}\nType: PDF\nSize: ${formatSize(fileStat.size)}\n\nPDF text extraction failed: ${extractErr instanceof Error ? extractErr.message : String(extractErr)}`;
      }
    }

    // 图片文件：调用视觉模型分析（复用 parseImage 完整链路：附件入库 + 缓存 + vision-adapter）
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.avif'];
    const isImageFile = imageExts.includes(ext);

    if (isImageFile) {
      const fileStat = await stat(filePath);

      // 检查是否配置了视觉模型（从全局设置读取）
      const settings = await readSettingsFromFile();
      const visionModel = settings.vision.defaultModel;
      const visionApiKey = settings.vision.apiKey;

      if (!visionModel || !visionApiKey) {
        return `Attachment: ${path}\nType: Image (${ext})\nSize: ${formatSize(fileStat.size)}\n\nNote: No vision model configured. Please configure a vision model (API Key and model) in project settings.`;
      }

      try {
        const modelConfig = await buildVisionModelConfig(visionModel, visionApiKey, settings.vision.baseUrl || undefined);
        const { parseImage } = await import('@/lib/parse/image-parser');

        const result = await parseImage(
          filePath,
          project.path,
          {
            model: modelConfig.model,
            apiKey: modelConfig.apiKey,
            baseUrl: modelConfig.baseUrl,
            mode: 'general',
          }
        );

        return truncate(
          `Attachment: ${path} (${formatSize(fileStat.size)}, image)\n\n[Image Analysis]\n${result.extracted_text}`,
          8000,
        );
      } catch (visionErr) {
        return `Attachment: ${path}\nType: Image (${ext})\nSize: ${formatSize(fileStat.size)}\n\nImage analysis failed: ${visionErr instanceof Error ? visionErr.message : String(visionErr)}`;
      }
    }

    const fileStat = await stat(filePath);
    return `Attachment: ${path}\nType: Binary file (${ext || 'unknown'})\nSize: ${formatSize(fileStat.size)}\n\nThis is a non-text file and cannot be read directly. Please provide a text version of the content.`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) return `Attachment not found: ${path}`;
    if (msg.includes('EISDIR')) return `Path is a directory, not a file: ${path}`;
    return `Attachment read failed: ${msg}`;
  }
}

/** 读取 materials 文件夹中的参考资料 */
async function toolReadMaterial(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  if (!path) return 'Error: path required';

  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const project = await getCurrentProject();
    const filePath = join(project.path, path);
    const ext = extname(filePath).toLowerCase();

    // 安全检查：确保在 materials 目录内
    if (!filePath.startsWith(join(project.path, 'materials'))) {
      return 'Error: Invalid material path';
    }

    const textExts = ['.txt', '.md', '.markdown', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.go', '.rs', '.yaml', '.yml', '.ini', '.conf', '.log'];
    const isTextFile = textExts.includes(ext);

    if (isTextFile) {
      const content = await readFile(filePath, 'utf-8');
      const fileStat = await stat(filePath);
      return truncate(
        `Material: ${path} (${formatSize(fileStat.size)})\n\n${content}`,
        8000,
      );
    }

    // .docx 提取
    if (ext === '.docx') {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const tmpDir = `/tmp/bob-agent-docx-${Date.now()}`;
        await execAsync(`mkdir -p "${tmpDir}" && unzip -o "${filePath}" word/document.xml -d "${tmpDir}"`, { timeout: 10000 });
        const xmlContent = await readFile(`${tmpDir}/word/document.xml`, 'utf-8');
        const text = xmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const fileStat = await stat(filePath);
        await execAsync(`rm -rf "${tmpDir}"`).catch(() => {});
        return truncate(
          `Material: ${path} (${formatSize(fileStat.size)}, .docx text extracted)\n\n${text}`,
          8000,
        );
      } catch {
        return `Material: ${path}\nType: Word (.docx)\nUnable to extract text.`;
      }
    }

    // PDF
    if (ext === '.pdf') {
      try {
        const { extractWithPython, extractWithPdfParse } = await import('@/lib/pdf/extractor');
        const fileStat = await stat(filePath);
        const pyResult = await extractWithPython(filePath);
        if (pyResult.text && pyResult.text.length > 20) {
          return truncate(
            `Material: ${path} (${formatSize(fileStat.size)}, PDF via ${pyResult.method})\n\n${pyResult.text}`,
            8000,
          );
        }
        const fallback = await extractWithPdfParse(filePath);
        if (fallback.text && fallback.text.length > 20) {
          return truncate(
            `Material: ${path} (${formatSize(fileStat.size)}, PDF via pdf-parse)\n\n${fallback.text}`,
            8000,
          );
        }
        return `Material: ${path}\nType: PDF (scanned/image-based)\nUnable to extract text automatically.`;
      } catch {
        return `Material: ${path}\nType: PDF\nUnable to extract text.`;
      }
    }

    // Images - return basic info
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    if (imageExts.includes(ext)) {
      const fileStat = await stat(filePath);
      return `Material: ${path}\nType: Image (${ext})\nSize: ${formatSize(fileStat.size)}\nImages in materials are for reference.`;
    }

    // 其他二进制文件
    const fileStat = await stat(filePath);
    return `Material: ${path}\nType: Binary (${ext})\nSize: ${formatSize(fileStat.size)}\nCannot read binary file content.`;
  } catch (e) {
    return `Error reading material: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 读取上游连线节点的完整 .md 文档 */
async function toolReadUpstreamNode(args: Record<string, unknown>): Promise<string> {
  const title = args.title as string;
  if (!title) return 'Error: title required';

  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const { readdir } = await import('fs/promises');
    const { join } = await import('path');

    const project = await getCurrentProject();
    const nodesDir = join(project.path, 'nodes');

    // 读取所有节点的 .md 文件，按标题匹配
    const files = await readdir(nodesDir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));

    for (const file of mdFiles) {
      const content = await import('fs/promises').then((m) => m.readFile(join(nodesDir, file), 'utf-8'));
      // 从 frontmatter 中提取标题
      const titleMatch = content.match(/^---\n[\s\S]*?title:\s*(.+?)[\n\r]/);
      const extractedTitle = titleMatch ? titleMatch[1].trim() : '';
      if (extractedTitle === title) {
        return truncate(
          `Node document: ${title}\nFile: ${file}\n\n${content}`,
          8000,
        );
      }
    }

    return `No upstream node found with title "${title}". Check the title matches the upstream node index exactly.`;
  } catch (e) {
    return `Upstream node read failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ============================================================
// 构建工具注册表
// ============================================================

/** 工具定义：name + schema + executor + 元数据 */
const toolDefs: Tool[] = [
  {
    name: 'read_file',
    description: 'Read file content. Supports text files like source code, configs, documents etc. Supports relative paths (based on workspace root), absolute paths, and ~ for home directory.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path. Relative paths based on workspace root. Also supports absolute paths or ~/ paths. e.g. "src/main.ts" or "~/.bashrc"',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolReadFile,
    maxOutput: 8000,
  },
  {
    name: 'write_file',
    description: 'Write or create a file. Parent directories are auto-created. Use for code generation, config editing, document creation etc.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path. Relative paths based on workspace root.',
        },
        content: {
          type: 'string',
          description: 'Full file content to write.',
        },
      },
      required: ['path', 'content'],
    },
    category: '文件',
    execute: toolWriteFile,
    maxOutput: 500,
  },
  {
    name: 'list_directory',
    description: 'List directory contents including files and subdirectories. Directories first, then files with sizes shown. Use for exploring project structure, finding files etc.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path, defaults to workspace root. Supports relative, absolute and ~/ paths.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolListDirectory,
    maxOutput: 5000,
  },
  {
    name: 'search_files',
      description: 'Search for files matching a pattern. Supports glob: * matches any chars, ? matches single char, ** matches recursively. Skips node_modules, .git etc.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search pattern. e.g. "*.ts" matches TypeScript files, "*.py" matches Python files, "test*" matches files starting with test.',
        },
        path: {
          type: 'string',
          description: 'Search root directory, defaults to workspace root.',
        },
      },
      required: ['pattern'],
    },
    category: '文件',
    execute: toolSearchFiles,
    maxOutput: 3000,
  },
  {
    name: 'run_command',
    description: 'Execute a shell command and return output. Use for running tests, building, git operations, process inspection etc. Runs in workspace root, 30s timeout.',
    parameters: {
      type: 'object',
      properties: {
        cmd: {
          type: 'string',
          description: 'Command to execute. e.g. "ls -la", "git status", "npm test", "python script.py"',
        },
      },
      required: ['cmd'],
    },
    category: '系统',
    execute: toolRunCommand,
    maxOutput: 5000,
    timeoutMs: 30_000,
  },
  {
    name: 'execute_script',
    description: 'Write and execute a script (Python or Shell) to solve problems autonomously. When encountering issues not solvable by other tools, write a script to analyze, fix, or automate the solution. Supports Python (python3) and Shell (bash). Script runs in workspace sandbox with 30s timeout. Use this for data processing, file manipulation, automation, analysis etc.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'shell'],
          description: 'Script language. "python" for Python3, "shell" for Bash.',
        },
        script: {
          type: 'string',
          description: 'Full script content to execute. Python: use print() for output. Shell: use echo or stdout.',
        },
      },
      required: ['language', 'script'],
    },
    category: '系统',
    execute: toolExecuteScript,
    maxOutput: 8000,
    timeoutMs: 30_000,
  },
  {
    name: 'web_search',
    description: 'Search the web for information. Use when you need latest info, facts, or real-time content. Multiple search engines with auto-fallback.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords. e.g. "Next.js 16 standalone mode", "Python asyncio tutorial"',
        },
      },
      required: ['query'],
    },
    category: '网络',
    execute: toolWebSearch,
    maxOutput: 5000,
  },
  {
    name: 'read_attachment',
    description: 'Read user-uploaded attachment content. Supports text files (txt, md, json, csv, code files etc.), .docx auto text extraction, and image files (.png, .jpg, .jpeg, .gif, .webp etc.) auto analyzed by vision model. When user questions involve attachment content, proactively call this tool.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Attachment path, format: assets/{nodeId}/{filename}. Get from the attachment list in user message.',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolReadAttachment,
    maxOutput: 8000,
  },
  {
    name: 'read_upstream_node',
    description: 'Read the full .md document of an upstream connected node. When user questions involve upstream nodes, pass the node title from the upstream node index to read its full content. Can be called multiple times for multiple nodes. Note: only reads nodes within the current project.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the upstream node (from the upstream node index in system prompt). Must match exactly the title in the index table.',
        },
      },
      required: ['title'],
    },
    category: '文件',
    execute: toolReadUpstreamNode,
    maxOutput: 8000,
  },
  {
    name: 'read_material',
    description: 'Read a material file from the project materials folder. Materials are files uploaded by the user as reference documents (e.g. PDFs, reports, images, code files). When user refers to "@filename" in their message, use this tool to read the referenced material. Pass the material file path from the user message.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Material file path, format: materials/{filename}. Get from the material reference list in user message.',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolReadMaterial,
    maxOutput: 8000,
  },
];

/** 工具注册表实例 */
const registry = new ToolRegistry();
registry.registerAll(toolDefs);

// ============================================================
// 导出接口（保持与 route.ts 兼容）
// ============================================================

/** OpenAI API 格式的工具列表 */
export const TOOL_DEFINITIONS: ToolDefinition[] = registry.toApiFormat();

/**
 * 根据工具名称执行工具
 *
 * 对应 Python 版 ToolCallLoop 中的工具执行逻辑：
 *   1. 解析参数 JSON
 *   2. 从注册表查找工具
 *   3. 执行并记录耗时
 *   4. 判断成功/失败
 */
export async function executeTool(
  toolName: string,
  argumentsJson: string,
): Promise<ToolExecResult> {
  const start = Date.now();

  // 解析参数
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return {
      result: 'Argument JSON parse failed',
      durationMs: 0,
      success: false,
    };
  }

  // 查找工具
  const tool = registry.get(toolName);
  if (!tool) {
    return {
      result: `Unknown tool: ${toolName}. Available: ${registry.listAll().map((t) => t.name).join(', ')}`,
      durationMs: 0,
      success: false,
    };
  }

  // 执行工具
  try {
    const rawResult = await tool.execute(args);
    const result = truncate(rawResult, tool.maxOutput);
    const durationMs = Date.now() - start;

    // 成功判断：不以错误前缀开头
    const errorPrefixes = [
      'Error:', 'Read failed:', 'Write failed:', 'Directory read failed:',
      'Search failed:', 'Execution failed:', 'Argument', 'Unknown tool:',
      'Command timed out', 'File not found', 'Directory not found', 'Path is',
    ];
    const success = !errorPrefixes.some((p) => result.startsWith(p));

    return { result, durationMs, success };
  } catch (e) {
    return {
      result: `Tool execution error: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - start,
      success: false,
    };
  }
}

/** 获取工具列表摘要（调试用） */
export function getToolSummary(): string {
  const categories = new Map<ToolCategory, string[]>();
  for (const tool of registry.listAll()) {
    const list = categories.get(tool.category) || [];
    list.push(tool.name);
    categories.set(tool.category, list);
  }

  const parts: string[] = [];
  for (const [cat, names] of categories) {
    parts.push(`[${cat}] ${names.join(', ')}`);
  }
  return `${registry.count()} tools: ${parts.join(' | ')}`;
}
