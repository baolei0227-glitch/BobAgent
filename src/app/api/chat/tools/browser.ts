/**
 * Agent 工具系统 — browser 场景（应用内 Hippo 通道）
 *
 * 内置 `browser_*` 工具定义：由规格层（@/lib/browser-tools/specs）驱动，
 * 执行经 HippoDriver → 主进程桥 /exec → CDP 自动化。
 *
 * 注入门控：本组工具**仅在通道解析为 hippo（缺省即 hippo）时注册**（见 runtime/tools.ts），
 * 与 MCP 通道 `mcp__bob-browser-mcp__browser_*` 互斥（仅显式 aiBrowser='chrome' 才走后者）；
 * 未选中的通道对模型完全不可见。
 *
 * 工具面 = A 档全量（P0 十个核心 + P1 补齐的等待/监控/数据/标签/脚本/阅读）；
 * 规格层（@/lib/browser-tools/specs）加条目即自动注册，本文件只负责「结果渲染」
 * 与两个需要宿主侧落盘的工具（screenshot / export_pdf）和 read_pdf 的文本提取。
 */

import { copyFile, mkdir, stat, writeFile } from 'fs/promises';
import { basename, join, relative } from 'path';
import { downloadToTemp, pdfPathFromUrl } from '@/lib/pdf/page-source';
import {
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_SPECS,
  getHippoDriver,
  getHippoPageUrl,
} from '@/lib/browser-tools';
import type { Envelope } from '@/lib/browser-tools';
import type { EnhancedToolResult, Tool } from './index';

/** 证据目录：<项目>/homework/.evidence/（与法律证据卡管线同目录，Finder 可见、可复核） */
async function evidenceDir(): Promise<string> {
  const { getProjectRootPath } = await import('./shared');
  const dir = join(await getProjectRootPath(), 'homework', '.evidence');
  const { mkdir } = await import('fs/promises');
  await mkdir(dir, { recursive: true });
  return dir;
}

function stamp(): string {
  return `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 元素清单渲染（snapshot）：每行 `[ref] tag "名称" value=… → href` */
function renderElements(value: Record<string, unknown>): string {
  const list = Array.isArray(value.elements) ? (value.elements as Array<Record<string, unknown>>) : [];
  const head = `页面: ${value.title || ''} ${value.url || ''}${value.ready === false ? '（页面可能未加载完）' : ''}`;
  if (!list.length) return `${head}\n未发现可交互元素（页面可能未加载完，或需要先滚动/等待）。`;
  const lines = list.map((el) => {
    const parts = [`[${el.ref}]`, String(el.tag || '')];
    if (el.role) parts.push(`role=${el.role}`);
    if (el.name) parts.push(`"${el.name}"`);
    if (el.value) parts.push(`value="${el.value}"`);
    if (el.disabled) parts.push('(disabled)');
    if (el.href) parts.push(`→ ${el.href}`);
    return parts.join(' ');
  });
  return `${head}\n${lines.join('\n')}\n\n用 ref 调用 browser_click / browser_type / browser_fill_form。`;
}

/** 字节数 → 人读大小（下载进度展示用） */
function formatBytes(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '大小未知';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/** 下载记录 → 模型可读文本 */
function renderDownload(rec: Record<string, unknown>): string {
  const state = String(rec.state || 'progressing');
  const got = Number(rec.receivedBytes) || 0;
  const total = Number(rec.totalBytes) || 0;
  const progress = total > 0 ? `${formatBytes(got)} / ${formatBytes(total)}` : formatBytes(got);
  return `[${rec.id ?? '?'}] ${state} ${String(rec.fileName || '')}（${progress}）\n保存到: ${String(rec.savePath || '')}`;
}

/** 卡片文本转义（文件名 / 路径来自网页与系统，不能直接拼进 HTML） */
function escapeCardText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 下载结果卡片（仅前端展示，不进模型上下文） */
function renderDownloadCard(rec: Record<string, unknown>): string {
  const state = String(rec.state || 'progressing');
  const label = state === 'completed' ? '已下载'
    : state === 'progressing' ? '下载中'
      : state === 'cancelled' ? '已取消' : '已中断';
  const got = Number(rec.receivedBytes) || 0;
  const total = Number(rec.totalBytes) || 0;
  const progress = total > 0 ? `${formatBytes(got)} / ${formatBytes(total)}` : formatBytes(got);
  const name = escapeCardText(String(rec.fileName || '文件'));
  const savePath = escapeCardText(String(rec.savePath || ''));
  return `<div class="ai-card ai-card-download"><div class="ai-card-title">${label}：${name}</div>`
    + `<div class="ai-card-meta">${progress} · 保存到系统下载目录</div>`
    + `<div class="ai-card-body">${savePath}</div></div>`;
}

/** 工具结果里带下载记录时，给前端一张卡（文本仍保持原样，模型看不到 HTML） */
function withDownloadCard(text: string, value: Record<string, unknown>): string | EnhancedToolResult {
  const single = value.download as Record<string, unknown> | undefined;
  if (single && typeof single === 'object') {
    return { text, cardHtml: `<div class="ai-card-list">${renderDownloadCard(single)}</div>` };
  }
  const list = Array.isArray(value.downloads) ? (value.downloads as Array<Record<string, unknown>>) : [];
  if (list.length) {
    return { text, cardHtml: `<div class="ai-card-list">${list.slice(0, 3).map(renderDownloadCard).join('')}</div>` };
  }
  return text;
}

/** Envelope → 模型可读文本（统一返回面） */
function renderEnvelope(name: string, env: Envelope): string {
  if (!env.ok) {
    const phase = env.error?.phase ?? 'driver';
    const hint = env.error?.hint ? `\n提示: ${env.error.hint}` : '';
    // 前缀必须是 'Error:' —— 宿主据此判定执行失败（见 tools/index.ts executeTool）
    return `Error: [${phase}] ${env.error?.message || '未知错误'}${hint}`;
  }
  const v = (env.value ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'browser_navigate':
      return `已打开: ${v.url || ''}${v.title ? `\n标题: ${v.title}` : ''}`;
    case 'browser_snapshot':
      return renderElements(v);
    case 'browser_click': {
      const head = `已点击 ${v.clicked || ''}${v.redirected ? `\n页面已跳转: ${v.url || ''}` : `\n当前页面: ${v.url || ''}`}`;
      const dl = v.download as Record<string, unknown> | undefined;
      const revealed = v.revealed === true ? '\n已在 Finder 中显示' : '';
      return dl ? `${head}\n下载已开始:\n${renderDownload(dl)}${revealed}\n用 browser_downloads 传 id=${dl.id} 查询进度/完成。` : head;
    }
    case 'browser_download': {
      const dl = (v.download ?? {}) as Record<string, unknown>;
      const revealed = v.revealed === true ? '\n已在 Finder 中显示' : '';
      return `下载已开始:\n${renderDownload(dl)}${revealed}\n用 browser_downloads 传 id=${dl.id} 查询进度/完成。`;
    }
    case 'browser_find_downloads': {
      const list = Array.isArray(v.candidates) ? (v.candidates as Array<Record<string, unknown>>) : [];
      const pending = v.ready === false ? '\n[!] 页面可能未加载完，以下是当前 DOM 的扫描结果' : '';
      if (!list.length) {
        return `未找到明显的下载入口。${pending}\n可改用 browser_snapshot 查看全部可交互元素，或直接传已知的文件 url。`;
      }
      const lines = list.map((c, i) => {
        const href = c.href ? `\n    href: ${c.href}` : '';
        return `[${i + 1}] ${c.tag || ''} "${c.text || ''}"（${c.kind || 'download'}）\n    selector: ${c.selector || ''}${href}`;
      });
      return `找到 ${list.length} 个下载候选：${pending}\n${lines.join('\n')}\n\n用 browser_download 传 selector 或 url 下载。`;
    }
    case 'browser_downloads': {
      const single = v.download as Record<string, unknown> | undefined;
      if (single) return renderDownload(single);
      const list = Array.isArray(v.downloads) ? (v.downloads as Array<Record<string, unknown>>) : [];
      if (!list.length) return '本次会话还没有下载记录。';
      return `共 ${list.length} 条下载（最新在前）:\n\n${list.map(renderDownload).join('\n\n')}`;
    }
    case 'browser_type':
      return `已输入到 ${v.filled || ''}：${v.value ?? ''}`;
    case 'browser_fill_form': {
      const filled = Array.isArray(v.filled) ? (v.filled as Array<Record<string, unknown>>) : [];
      const failed = Array.isArray(v.failed) ? (v.failed as Array<Record<string, unknown>>) : [];
      const lines = filled.map((f) => `✓ ${f.target} = ${f.value ?? ''}`);
      for (const f of failed) lines.push(`✗ ${f.target}: ${f.error || '写入失败'}`);
      return lines.length ? lines.join('\n') : '未填写任何字段';
    }
    case 'browser_press_key':
      return `已发送按键 ${v.key || ''}`;
    case 'browser_scroll':
      return `已滚动至 ${v.scrollY ?? 0} / ${v.pageHeight ?? 0}${v.atBottom ? '（已到底部）' : ''}`;
    case 'browser_extract_text': {
      const head = `标题: ${v.title || ''}\nURL: ${v.url || ''}`;
      const body = String(v.markdown || v.text || '');
      const pending = v.ready === false ? '\n[!] 页面可能未加载完，以上为当前 DOM 骨架' : '';
      // note：正文不可用时的成因与下一步（PDF / 登录墙 / 空壳未渲染）；带 kind 前缀让模型按类分流（换 read_pdf / 告知登录 / 等渲染）
      const note = v.note ? `\n[${v.kind ? String(v.kind).toUpperCase() : 'NOTE'}] ${String(v.note)}` : '';
      return `${head}${pending}${note}\n\n${body}`;
    }
    case 'browser_run_js':
      return `结果:\n${JSON.stringify(v.result ?? null, null, 2)}`;
    case 'browser_list_tabs': {
      const list = Array.isArray(v.tabs) ? (v.tabs as Array<Record<string, unknown>>) : [];
      const lines = list.map((t) => `${t.active ? '●' : '○'} [${t.id}] ${t.title || ''} — ${t.url || ''}`);
      return `共 ${list.length} 个标签（● = 当前）:\n${lines.join('\n')}`;
    }
    case 'browser_active_tab':
      return `当前标签 [${v.id}] ${v.title || ''}\n${v.url || ''}`;
    case 'browser_get_cookies': {
      const list = Array.isArray(v.cookies) ? (v.cookies as Array<Record<string, unknown>>) : [];
      if (!list.length) return '当前作用域没有 cookie。';
      return `${list.length} 条 cookie:\n${list
        .map((c) => `${c.name} = ${String(c.value ?? '').slice(0, 80)}  (${c.domain || ''}${c.path || ''})`)
        .join('\n')}`;
    }
    case 'browser_get_storage': {
      const list = Array.isArray(v.items) ? (v.items as Array<Record<string, unknown>>) : [];
      if (!list.length) return `${v.type} 存储为空。`;
      return `${v.type} 存储 ${list.length} 项:\n${list
        .map((i) => `${i.key} = ${String(i.value ?? '').slice(0, 120)}`)
        .join('\n')}`;
    }
    case 'browser_network_requests': {
      const list = Array.isArray(v.requests) ? (v.requests as Array<Record<string, unknown>>) : [];
      if (!list.length) return '未捕获到网络请求（Network 域开启后才会记录）。';
      return `${list.length} 条请求（在途 ${v.inflight ?? 0}）:\n${list
        .map((r) => `${r.failed ? '✗' : String(r.status || '—')} ${r.method} ${String(r.url ?? '').slice(0, 160)} (${r.ms}ms)`)
        .join('\n')}`;
    }
    case 'browser_console_logs': {
      const list = Array.isArray(v.logs) ? (v.logs as Array<Record<string, unknown>>) : [];
      if (!list.length) return '未捕获到 console 输出。';
      return `${list.length} 条日志:\n${list
        .map((l) => `[${l.level}] ${String(l.text ?? '').slice(0, 300)}`)
        .join('\n')}`;
    }
    case 'browser_page_script':
      return `脚本结果:\n${JSON.stringify(v.result ?? null, null, 2)}`;
    case 'browser_get_html':
      return `HTML（${v.bytes ?? 0} 字符${v.truncated ? '，已截断' : ''}）:\n${String(v.html ?? '')}`;
    case 'browser_get_viewport':
      return `视口 ${v.width}×${v.height}（页面高 ${v.pageHeight}，滚动 ${v.scrollY}，DPR ${v.devicePixelRatio}）`;
    case 'browser_read_article':
      return `标题: ${v.title || ''}\nURL: ${v.url || ''}\n\n${String(v.markdown ?? '')}`;
    case 'browser_pick_element_ref':
      return `已选中 ${v.tag || ''} "${v.name || ''}"\nref=${v.ref}  selector=${v.selector}`;
    case 'browser_handle_dialog':
      return v.handled
        ? `已${v.accepted ? '确认' : '取消'} ${v.type} 对话框：${String(v.message ?? '').slice(0, 200)}`
        : `当前没有待处理的对话框。${v.reason ? `（${v.reason}）` : ''}`;
    default:
      return JSON.stringify(v, null, 2);
  }
}

/** 截图特化：桥返回 dataUrl → 落盘 homework/.evidence/（与既有 hippo_browser_capture 同口径） */
async function executeScreenshot(args: Record<string, unknown>): Promise<string> {
  const env = await getHippoDriver().exec('browser_screenshot', args, {});
  if (!env.ok) return renderEnvelope('browser_screenshot', env);
  const v = (env.value ?? {}) as { dataUrl?: string; fullPage?: boolean };
  if (!v.dataUrl) return 'Error: [driver] 截图结果缺少图像数据';
  const b64 = v.dataUrl.replace(/^data:image\/png;base64,/, '');
  const abs = join(await evidenceDir(), `raw-web-${stamp()}.png`);
  await writeFile(abs, Buffer.from(b64, 'base64'));
  const bytes = Math.floor(b64.length * 0.75);
  return v.fullPage
    ? `已生成整页长截图并落盘证据：${abs}（${bytes} 字节，纵向全页，适合裁判文书/长合同留证）`
    : `已截图并落盘证据：${abs}（${bytes} 字节）`;
}

/** 导出特化：桥返回 PDF base64 → 落盘 homework/.evidence/ */
async function executeExportPdf(args: Record<string, unknown>): Promise<string> {
  const env = await getHippoDriver().exec('browser_export_pdf', args, {});
  if (!env.ok) return renderEnvelope('browser_export_pdf', env);
  const v = (env.value ?? {}) as { dataUrl?: string; bytes?: number; pageSize?: string; title?: string };
  if (!v.dataUrl) return 'Error: [driver] 导出结果缺少 PDF 数据';
  const b64 = v.dataUrl.replace(/^data:application\/pdf;base64,/, '');
  const abs = join(await evidenceDir(), `raw-web-${stamp()}.pdf`);
  await writeFile(abs, Buffer.from(b64, 'base64'));
  const bytes = v.bytes ?? Math.floor(b64.length * 0.75);
  return `已导出 PDF 并落盘证据：${abs}（${bytes} 字节，${v.pageSize || 'A4'}${v.title ? `，${v.title}` : ''}）`;
}

/** read_pdf：在 Next 侧取 PDF 文本（复用既有 Python → pdf-parse 两级提取管线）
 *  地址解析与下载见 @/lib/pdf/page-source（与 /api/hippo/pdf-text 共用同一份） */
async function executeReadPdf(args: Record<string, unknown>): Promise<string> {
  const url = await getHippoPageUrl();
  if (!url) return 'Error: [driver] 无法获取当前页面地址（Hippo Browser 未运行或当前不是网页）';
  const { local, remote } = pdfPathFromUrl(url);
  try {
    const abs = local || (remote ? await downloadToTemp(remote) : '');
    if (!abs) return `Error: [inject] 当前页面不是 PDF（${url}）`;
    const { extractWithPython, extractWithPdfParse } = await import('@/lib/pdf/core/extractor');
    const maxChars = Math.max(1000, Number(args.maxChars) || 40000);
    const maxPages = Number(args.maxPages) > 0 ? Number(args.maxPages) : 500;
    const py = await extractWithPython(abs, maxPages);
    let text = py.text || '';
    let method = py.method;
    let pages = py.pageCount || 0;
    if (text.trim().length <= 20) {
      const fb = await extractWithPdfParse(abs);
      if (fb.text && fb.text.trim().length > 20) {
        text = fb.text;
        method = fb.method;
        pages = fb.pageCount || pages;
      }
    }
    if (!text.trim()) {
      return `PDF 未提取到可读文本（${method || 'empty'}）。可能是扫描件，请改用 ocr_document 工具做 OCR。`;
    }
    const truncated = text.length > maxChars;
    return `PDF: ${url}\n提取方式: ${method}  页数: ${pages}${truncated ? `  已截断至 ${maxChars} 字符` : ''}\n\n${text.slice(0, maxChars)}`;
  } catch (e) {
    return `Error: [script] ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 把已完成的下载复制到项目 materials/：侧栏没有 write_file，但仍需要「下载落到项目里」的通道。 */
async function executeSaveDownload(args: Record<string, unknown>): Promise<string> {
  const id = Number(args.id);
  if (!Number.isFinite(id) || id <= 0) return 'Error: [syntax] id 必填（browser_download 返回的 download.id）';
  const env = await getHippoDriver().exec('browser_downloads', { id }, {});
  if (!env.ok) return renderEnvelope('browser_downloads', env);
  const rec = ((env.value ?? {}) as { download?: Record<string, unknown> }).download;
  if (!rec) return `Error: [download] 找不到下载 ${id}（可能已被清空）`;
  const state = String(rec.state || '');
  if (state !== 'completed') {
    return `Error: [download] 下载尚未完成（state=${state || 'unknown'}），请先用 browser_downloads 等到 completed 再保存。`;
  }
  const src = String(rec.savePath || '');
  if (!src) return 'Error: [download] 下载记录缺少保存路径';
  try {
    const s = await stat(src);
    if (!s.isFile()) return 'Error: [download] 下载路径不是文件';
  } catch {
    return `Error: [download] 下载文件不存在：${src}`;
  }
  // 必须落到真实项目：getProjectRootPath 在无项目时会回退到 ~/BobWork/.sandbox，
  // 那会把「保存到项目」写成沙箱文件，误导用户；这里显式要求激活项目。
  const { getCurrentProject } = await import('@/lib/project/project-manager');
  let projectRoot = '';
  try {
    const project = await getCurrentProject();
    projectRoot = project?.path || '';
  } catch {
    projectRoot = '';
  }
  if (!projectRoot) return 'Error: [project] 当前没有激活项目，无法保存到 materials/；请先在画布顶部选择/创建项目。';
  const rawFolder = String(args.folder ?? '').trim();
  const folder = (rawFolder
    ? rawFolder.replace(/[\\/]+/g, '-').replace(/[^0-9A-Za-z._\-\u4e00-\u9fa5]+/g, '-').replace(/^\.+/, '').slice(0, 60)
    : '') || 'downloads';
  const dir = join(projectRoot, 'materials', folder);
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    return `Error: [fs] 创建目录失败：${e instanceof Error ? e.message : String(e)}`;
  }
  const base = basename(String(rec.fileName || '')) || 'download';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  const stem = ext ? base.slice(0, -ext.length) : base;
  let target = join(dir, base);
  for (let n = 1; n < 1000; n++) {
    try {
      await stat(target);
      target = join(dir, `${stem} (${n})${ext}`);
    } catch {
      break;
    }
  }
  try {
    await copyFile(src, target);
  } catch (e) {
    return `Error: [fs] 复制失败：${e instanceof Error ? e.message : String(e)}`;
  }
  const size = (await stat(target)).size;
  return `已保存到项目：${relative(projectRoot, target)}\n来源: ${src}（${formatBytes(size)}）`;
}

/** 内置 browser_* 工具定义（规格层驱动；执行统一走 HippoDriver） */
export const browserToolDefs: Tool[] = BROWSER_TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: `${spec.description}\nReturns: ${spec.returns}`,
  parameters: spec.parameters,
  category: '网络',
  // 与 MCP 浏览器工具同场景门控：网页意图才注入（browser 场景见 route.ts detectSceneHints）
  scenes: ['browser'],
  maxOutput: spec.maxOutput,
  execute: async (args: Record<string, unknown>): Promise<string | EnhancedToolResult> => {
    if (spec.name === 'browser_save_download') return executeSaveDownload(args);
    if (spec.name === 'browser_screenshot') return executeScreenshot(args);
    if (spec.name === 'browser_export_pdf') return executeExportPdf(args);
    if (spec.name === 'browser_read_pdf') return executeReadPdf(args);
    const env = await getHippoDriver().exec(spec.name, args, {});
    const text = renderEnvelope(spec.name, env);
    if (!env.ok) return text;
    return withDownloadCard(text, (env.value ?? {}) as Record<string, unknown>);
  },
}));

/** 内置浏览器工具名（门控 / 来源判定 / 分层标注共用） */
export const BROWSER_BUILTIN_TOOL_NAMES: ReadonlySet<string> = BROWSER_TOOL_NAMES;