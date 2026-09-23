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

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { downloadToTemp, pdfPathFromUrl } from '@/lib/pdf/page-source';
import {
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_SPECS,
  getHippoDriver,
  getHippoPageUrl,
} from '@/lib/browser-tools';
import type { Envelope } from '@/lib/browser-tools';
import type { Tool } from './index';

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
    case 'browser_click':
      return `已点击 ${v.clicked || ''}${v.redirected ? `\n页面已跳转: ${v.url || ''}` : `\n当前页面: ${v.url || ''}`}`;
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

/** 内置 browser_* 工具定义（规格层驱动；执行统一走 HippoDriver） */
export const browserToolDefs: Tool[] = BROWSER_TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: `${spec.description}\nReturns: ${spec.returns}`,
  parameters: spec.parameters,
  category: '网络',
  // 与 MCP 浏览器工具同场景门控：网页意图才注入（browser 场景见 route.ts detectSceneHints）
  scenes: ['browser'],
  maxOutput: spec.maxOutput,
  execute: async (args: Record<string, unknown>): Promise<string> => {
    if (spec.name === 'browser_screenshot') return executeScreenshot(args);
    if (spec.name === 'browser_export_pdf') return executeExportPdf(args);
    if (spec.name === 'browser_read_pdf') return executeReadPdf(args);
    const env = await getHippoDriver().exec(spec.name, args, {});
    return renderEnvelope(spec.name, env);
  },
}));

/** 内置浏览器工具名（门控 / 来源判定 / 分层标注共用） */
export const BROWSER_BUILTIN_TOOL_NAMES: ReadonlySet<string> = BROWSER_TOOL_NAMES;