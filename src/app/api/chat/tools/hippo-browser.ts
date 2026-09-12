/**
 * Agent 工具系统 — browser 场景（Hippo Browser 侧边栏桥调用）
 *
 * 从 tools/index.ts 按 ToolScene 抽出，零行为变更。
 * Agent 工具 ⇄ 主进程：主进程起 127.0.0.1:随机端口+token 的 HTTP 服务，把地址写
 * <BOBWORK_HOME|~>/BobWork/.runtime/hippo-bridge.json；此处运行时读文件再 fetch（dev/打包逻辑同构）。
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
import type { Tool } from './index';
import { getProjectRootPath } from './shared';

const HIPPO_BRIDGE_REL = join('.runtime', 'hippo-bridge.json');

async function readHippoBridge(): Promise<{ url: string; token: string }> {
  try {
    const raw = await readFile(join(resolveAppRoot(), HIPPO_BRIDGE_REL), 'utf-8');
    const parsed = JSON.parse(raw) as { url?: string; token?: string };
    if (!parsed || !parsed.url) throw new Error('桥文件缺 url');
    return { url: parsed.url, token: parsed.token || '' };
  } catch {
    throw new Error('Hippo Browser 未运行（未找到桥文件，请先启动 BobWork 桌面端）');
  }
}

async function hippoBridgeCall<T>(action: string, body?: unknown): Promise<T> {
  const bridge = await readHippoBridge();
  const base = (bridge.url || 'http://127.0.0.1/').replace(/\/+$/, '');
  const url = `${base}${action}?token=${encodeURIComponent(bridge.token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Hippo Browser 桥异常 (HTTP ${res.status})`);
  return (await res.json()) as T;
}

/** 证据目录：<项目>/homework/.evidence/（与法律证据卡管线同目录，Finder 可见、可复核） */
async function hippoEvidenceDir(): Promise<string> {
  const dir = join(await getProjectRootPath(), 'homework', '.evidence');
  await mkdir(dir, { recursive: true });
  return dir;
}

function hippoStamp(): string {
  return `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function toolHippoBrowserNavigate(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim();
  if (!url) return 'Error: url 必填（http/https/file 链接）';
  try {
    const r = await hippoBridgeCall<{ ok: boolean; error?: string }>('/navigate', { url });
    return r.ok ? `已在 Hippo Browser 侧边栏打开：${url}` : `Error: ${r.error || '导航失败'}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolHippoBrowserExtract(_args: Record<string, unknown>): Promise<string> {
  try {
    const r = await hippoBridgeCall<{ ok: boolean; ready?: boolean; title?: string; url?: string; markdown?: string; error?: string }>('/extract');
    if (!r.ok) return `Error: ${r.error || '提取失败'}`;
    const md = r.markdown || '';
    const abs = join(await hippoEvidenceDir(), `raw-web-${hippoStamp()}.md`);
    await writeFile(abs, md, 'utf-8');
    const pending = r.ready ? '' : '\n[!] 页面可能未加载完，以上为当前 DOM 骨架（ready=false）';
    const head = `已提取页面并落盘证据：${abs}`;
    const meta = `\n标题: ${r.title || ''}\nURL: ${r.url || ''}`;
    return `${head}${meta}${pending}\n\n${md}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolHippoBrowserCapture(args: Record<string, unknown>): Promise<string> {
  const fullPage = args.fullPage !== false;
  try {
    const r = await hippoBridgeCall<{ ok: boolean; dataUrl?: string; error?: string }>('/capture', { fullPage });
    if (!r.ok || !r.dataUrl) return `Error: ${r.error || '截图失败'}`;
    const abs = join(await hippoEvidenceDir(), `raw-web-${hippoStamp()}.png`);
    const b64 = r.dataUrl.replace(/^data:image\/png;base64,/, '');
    await writeFile(abs, Buffer.from(b64, 'base64'));
    return fullPage
      ? `已生成整页长截图并落盘证据：${abs}（纵向全页，适合裁判文书/长合同留证）`
      : `已截图并落盘证据：${abs}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolHippoBrowserScreenshot(_args: Record<string, unknown>): Promise<string> {
  try {
    const r = await hippoBridgeCall<{ ok: boolean; dataUrl?: string; error?: string }>('/capture', { fullPage: false });
    if (!r.ok || !r.dataUrl) return `Error: ${r.error || '截图失败'}`;
    const byteLen = Math.floor(r.dataUrl.replace(/^data:image\/png;base64,/, '').length * 0.75);
    return `已获取视口截图（base64 PNG，约 ${byteLen} 字节，不落盘）。如需整页/证据留档请用 hippo_browser_capture。`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

interface HippoSearchResult {
  ok: boolean;
  engine?: string;
  query?: string;
  results?: Array<{ title: string; url: string; snippet: string }>;
  error?: string;
}

async function toolHippoBrowserSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim();
  if (!query) return 'Error: query 必填（搜索关键词）';
  const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 5));
  try {
    const r = await hippoBridgeCall<HippoSearchResult>('/search', { query, maxResults });
    if (!r.ok) return `Error: ${r.error || '搜索失败'}`;
    const list = r.results || [];
    if (!list.length) return `未搜索到"${query}"的结果`;
    const lines = [`在 ${r.engine || 'Bing'} 搜索 "${query}"（${list.length} 条）：`];
    list.forEach((it, i) => {
      lines.push(`\n[${i + 1}] ${it.title}\nURL: ${it.url}${it.snippet ? `\n摘要: ${it.snippet}` : ''}`);
    });
    lines.push('\n如需打开某条结果，请用 hippo_browser_navigate 打开其 URL。');
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** browser 场景工具定义（由 tools/index.ts 聚合进 toolDefs） */
export const hippoBrowserToolDefs: Tool[] = [
  {
    name: 'hippo_browser_navigate',
    description:
      '在 BobWork Hippo Browser 侧边栏中导航到指定 URL（http/https/file）。用于展示网页、配合登录态持久化浏览、收编 HTML 预览。打开后侧边栏可见。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的完整 URL（http/https/file 协议）' } },
      required: ['url'],
    },
    category: '网络',
    scenes: ['browser'],
    execute: toolHippoBrowserNavigate,
    maxOutput: 600,
  },
  {
    name: 'hippo_browser_extract',
    description:
      '提取 Hippo Browser 侧边栏当前页面的正文，转为 Markdown 骨架（含 SPA 智能等待；未加载完时标注 ready=false）。结果自动落盘 homework/.evidence/ 供证据固证。返回 Markdown 摘要 + 落盘路径。',
    parameters: {
      type: 'object',
      properties: {},
    },
    category: '网络',
    scenes: ['browser'],
    execute: toolHippoBrowserExtract,
    maxOutput: 8000,
  },
  {
    name: 'hippo_browser_capture',
    description:
      '捕获 Hippo Browser 侧边栏当前页面截图。默认整页长截图（纵向全页，适合裁判文书/长合同），落盘 homework/.evidence/ 供证据固证。',
    parameters: {
      type: 'object',
      properties: { fullPage: { type: 'boolean', description: '是否整页长截图，默认 true' } },
    },
    category: '网络',
    scenes: ['browser'],
    execute: toolHippoBrowserCapture,
    maxOutput: 800,
  },
  {
    name: 'hippo_browser_screenshot',
    description:
      '获取 Hippo Browser 侧边栏当前页面的视口截图（仅当前第一屏，base64 PNG，不落盘）。如需整页/留证请用 hippo_browser_capture。',
    parameters: {
      type: 'object',
      properties: {},
    },
    category: '网络',
    scenes: ['browser'],
    execute: toolHippoBrowserScreenshot,
    maxOutput: 800,
  },
  {
    name: 'hippo_browser_search',
    description:
      '用 Hippo Browser 的网页搜索能力检索关键词（免 API key，走 Bing），返回结构化结果列表（标题/链接/摘要）。不改变当前页面。适合先搜索再决定导航到哪个链接。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（中文/英文均可）' },
        maxResults: { type: 'number', description: '返回条数，默认 5，最多 10' },
      },
      required: ['query'],
    },
    category: '网络',
    scenes: ['browser'],
    execute: toolHippoBrowserSearch,
    maxOutput: 4000,
  },
];
