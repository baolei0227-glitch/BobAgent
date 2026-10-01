/**
 * 链接导入材料 —— 落盘「渲染后的整页 HTML 原件」
 *
 * 一级：Hippo 真实浏览器（新开后台标签，不抢焦点）——拿到的是渲染后的整页 HTML，
 *       脚本已剥、链接已绝对化、懒加载图已兑现，并天然复用用户在 Hippo 里的登录态；
 * 二级：桥不可用（未启动桌面端 / Hippo 未初始化）时退回服务端直抓静态 HTML。
 *
 * 抓取链路落盘一律 .html：原件本身可离线打开、可回溯，正文由索引链路从 HTML 里抽
 * （见 html-text.ts），不另存一份已成正文的 .md 副本。
 *
 * 两处例外都落 .md，且都在出处头注明来源性质：
 *   - importReadTextAsMaterial：复用研究中已读到的正文（agent 本轮的返回），
 *     保证入库版本与回答里的引用同版，但不是重新抓取的原件快照；
 *   - importResearchReportAsMaterial：把本轮研究结论固化成语料（派生材料，
 *     出处头列出所依据的来源 URL）—— 由用户在来源卡片上勾选，不自动入库。
 *
 * 「Hippo 一键保存当前页」复用同一落盘函数，差别只在抓的是活动标签而非新开标签。
 */

import { promises as fs } from 'fs';
import { join, extname, resolve as resolvePath, sep } from 'path';
import { getHippoDriver, getHippoPageUrl } from '@/lib/browser-tools/hippo-driver';
import { extractHtmlText, formatProvenance } from './html-text';

/** 可接受的最小正文长度：短于此长度视为「没抓到真内容」（PDF 阅读器 / 登录墙 / 空壳页） */
const MIN_TEXT_CHARS = 400;
/** 直抓单次请求超时 */
const DIRECT_TIMEOUT_MS = 15000;
/** 整页原件字符上限（与 browser_get_html clean 快照的上限一致） */
const MAX_HTML_CHARS = 4_000_000;
/** 纯文本读取上限（收件箱要的是正文，不需要搬运整页原件） */
const MAX_TEXT_CHARS = 60000;
/** 文件名主干上限（超长标题截断，避免撑爆路径） */
const MAX_STEM = 80;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface LinkImportInput {
  projectRoot: string;
  url: string;
  /** materials 根相对的目标子目录（'' = materials 根） */
  folder?: string;
}

/** 可复用正文的最小长度：短于此长度视为「没读到真内容」，调用方应回落抓取链路 */
export const REUSABLE_TEXT_MIN_CHARS = 200;

/** 落盘结果（链接导入与「Hippo 一键保存当前页」共用） */
export type MaterialWriteResult =
  | { ok: true; path: string; name: string; title: string; bytes: number; extension: '.html' | '.md' }
  | { ok: false; error: string };

export type LinkImportResult =
  | { ok: true; via: 'hippo' | 'fetch' | 'captured' | 'report' | 'share'; path: string; name: string; title: string; bytes: number; extension: '.html' | '.md' }
  | { ok: false; error: string };

interface CapturedPage {
  html: string;
  title: string;
}

/* --------------------------------- 输入归一 -------------------------------- */

/** 归一化用户输入：缺协议补 https://，只接受 http/https */
function normalizeUrl(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Untitled';
  }
}

/**
 * 从 URL 里取出本机分享页的 token（`/share/<token>`）。
 *
 * 为什么只看路径不看 host：分享链接是局域网地址（本机 IP / localhost 都可能），
 * 判定「是不是本机的分享」交给 token 能否在本地 store 命中——命中就说明这条链接
 * 指向的就是本机某份文档；别人机器发来的链接 token 在本地查不到，自然返回 null，
 * 由调用方回落抓取链路。token 是 12 字节随机串，误命中概率可忽略。
 */
export function extractShareToken(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/share\/([^/?#]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/* ------------------------------ Hippo 原件抓取 ----------------------------- */

/**
 * 读 Hippo 标签的整页 HTML 原件（clean 快照）。
 *
 * tabId 缺省读活动标签；后台标签必须显式给 id —— 否则读到的是旧的活动标签
 * （旧实现就是栽在这里：「后台新开 + 读活动标签」永远读不到刚开的那一页）。
 */
async function captureHippoHtml(
  tabId?: number,
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  const driver = getHippoDriver();
  const args: Record<string, unknown> = { outer: true, clean: true, maxChars: MAX_HTML_CHARS };
  if (tabId !== undefined) args.tabId = tabId;
  const r = await driver.exec('browser_get_html', args, {});
  if (!r.ok) return { ok: false, reason: r.error?.message || 'Hippo Browser is not available' };
  const v = (r.value ?? {}) as { html?: unknown };
  const html = String(v.html || '');
  if (!html.trim()) return { ok: false, reason: 'Hippo Browser returned an empty page' };
  return { ok: true, html };
}

/** 新开后台标签（不抢焦点）→ 等该标签网络静默 → 读整页原件 → 关掉该标签 */
async function captureUrlViaHippo(
  url: string,
): Promise<{ ok: true; page: CapturedPage } | { ok: false; reason: string }> {
  const driver = getHippoDriver();
  const opened = await driver.exec('browser_open_tab', { url, activate: false }, {});
  if (!opened.ok) {
    return { ok: false, reason: opened.error?.message || 'Hippo Browser is not available' };
  }
  const ov = (opened.value ?? {}) as { id?: unknown; title?: unknown };
  const tabId = Number(ov.id);
  if (!Number.isFinite(tabId)) return { ok: false, reason: 'Hippo Browser did not return a tab id' };
  try {
    // 静默等待也必须指向这个后台标签：等活动标签会立刻返回（它早就静默了）
    await driver.exec('browser_wait_network_idle', { idleMs: 600, timeoutMs: 10000, tabId }, {});
    const cap = await captureHippoHtml(tabId);
    if (!cap.ok) return cap;
    const text = extractHtmlText(cap.html);
    if (text.markdown.length < MIN_TEXT_CHARS) {
      return { ok: false, reason: 'Hippo Browser captured no readable text (PDF viewer, login wall or empty page)' };
    }
    return {
      ok: true,
      page: { html: cap.html, title: text.title || String(ov.title || '') || hostOf(url) },
    };
  } finally {
    // 窗口始终保留至少一个标签；按 id 关掉本次开的临时标签
    await driver.exec('browser_close_tab', { id: tabId }, {});
  }
}

/* ------------------------------ 服务端直抓兜底 ------------------------------ */

/** 静态直抓（只取 HTML 原文，不做渲染）：桥不可用时的兜底，JS 渲染页 / 登录墙抓不到 */
async function fetchDirect(
  url: string,
): Promise<{ ok: true; page: CapturedPage } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: `direct fetch failed (${e instanceof Error ? e.name : 'error'})` };
  }
  if (!res.ok) return { ok: false, reason: `direct fetch HTTP ${res.status}` };

  const type = (res.headers.get('content-type') || '').toLowerCase();
  // 非 HTML（PDF / 二进制）在这里落不了 .html 原件，交回 Hippo 通道处理
  if (!type.includes('html')) return { ok: false, reason: `non-HTML content (${type || 'unknown'})` };

  const raw = (await res.text()).slice(0, MAX_HTML_CHARS);
  const text = extractHtmlText(raw);
  if (text.markdown.length < MIN_TEXT_CHARS) {
    return { ok: false, reason: 'page content too short (JS-rendered or login wall?)' };
  }
  return { ok: true, page: { html: raw, title: text.title || hostOf(url) } };
}

/* --------------------------- Hippo 活动标签读正文 --------------------------- */

/**
 * 读「Hippo 当前活动标签」的**正文**（URL + 标题 + Markdown）。
 *
 * 只服务 bobnotes 收件箱：那条链路要的是可直接入库的文本，PDF 也在这里被
 * 读成文字（read_article → extract_text → read_pdf 三级）。
 * materials 的落盘不再走这里 —— 那边要的是 HTML 原件。
 */
export async function readCurrentHippoPage(): Promise<
  { ok: true; url: string; title: string; markdown: string } | { ok: false; error: string }
> {
  const url = await getHippoPageUrl();
  if (!url) return { ok: false, error: 'Hippo Browser is not showing a web page' };
  const read = await readCurrentTab();
  if (!read.ok) return { ok: false, error: read.reason };
  return { ok: true, url, title: read.title || hostOf(url), markdown: read.markdown };
}

/** 活动标签正文：article → extract_text → pdf 三级（页面已渲染、登录态天然在手） */
async function readCurrentTab(): Promise<{ ok: true; title: string; markdown: string } | { ok: false; reason: string }> {
  const driver = getHippoDriver();
  let title = '';
  let markdown = '';
  const art = await driver.exec('browser_read_article', { maxChars: MAX_TEXT_CHARS }, {});
  if (art.ok) {
    const v = (art.value ?? {}) as { title?: string; markdown?: string };
    title = String(v.title || '');
    markdown = String(v.markdown || '');
  }
  if (markdown.trim().length >= MIN_TEXT_CHARS) {
    return { ok: true, title, markdown: markdown.trim() };
  }
  // 正文抽取不到时退一步看页面类型：登录墙 / 未渲染 / PDF
  const ex = await driver.exec('browser_extract_text', { format: 'markdown' }, {});
  const v = (ex.value ?? {}) as { title?: string; markdown?: string; kind?: string };
  title = title || String(v.title || '');
  if (v.kind === 'pdf') {
    const pdf = await driver.exec('browser_read_pdf', { maxChars: MAX_TEXT_CHARS }, {});
    if (pdf.ok) {
      const pv = (pdf.value ?? {}) as { title?: string; text?: string };
      title = title || String(pv.title || '');
      markdown = String(pv.text || '');
    }
  } else if (String(v.markdown || '').trim().length > markdown.trim().length) {
    markdown = String(v.markdown || '');
  }
  if (markdown.trim().length < MIN_TEXT_CHARS) {
    const kind = v.kind ? ` (page type: ${v.kind})` : '';
    return {
      ok: false,
      reason: `Hippo Browser could not read the page text${kind}. Sign in inside Hippo Browser first, then try again.`,
    };
  }
  return { ok: true, title, markdown: markdown.trim() };
}

/** Hippo 一键保存当前页到 materials：抓活动标签的整页原件后落盘 */
export async function saveCurrentHippoPage(input: { projectRoot: string; folder?: string }): Promise<LinkImportResult> {
  const url = await getHippoPageUrl();
  if (!url) return { ok: false, error: 'Hippo Browser is not showing a web page' };
  const cap = await captureHippoHtml();
  if (!cap.ok) return { ok: false, error: cap.reason };
  const text = extractHtmlText(cap.html);
  if (text.markdown.length < MIN_TEXT_CHARS) {
    return { ok: false, error: 'This page has no readable HTML to save (PDF viewer, login wall or empty page)' };
  }
  const written = await writeHtmlMaterial({
    projectRoot: input.projectRoot,
    url,
    title: text.title || hostOf(url),
    html: cap.html,
    folder: input.folder,
  });
  if (!written.ok) return written;
  return { ...written, via: 'hippo' };
}

/* ---------------------------------- 落盘 ---------------------------------- */

function sanitizeFileName(title: string, ext: '.html' | '.md'): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  const stem = cleaned.slice(0, MAX_STEM).trim() || 'Untitled';
  return `${stem}${ext}`;
}

/** 目标目录解析（materials 根 + 清洗后的子目录段，越出 materials 一律拒绝） */
function resolveTargetDir(
  projectRoot: string,
  folder?: string,
): { dirAbs: string; rel: string } | null {
  const segs = (folder || '')
    .split('/')
    .map((s) => s.replace(/\.\./g, '').replace(/[\\/:*?"<>|]/g, '_').trim())
    .filter((s) => s.length > 0);
  const materialsRoot = resolvePath(projectRoot, 'materials');
  const dirAbs = resolvePath(materialsRoot, ...segs);
  if (dirAbs !== materialsRoot && !dirAbs.startsWith(materialsRoot + sep)) return null;
  return { dirAbs, rel: segs.join('/') };
}

/** 同名冲突追加 " (1)" / " (2)"（与上传行为一致） */
async function resolveTarget(dirAbs: string, fileName: string): Promise<{ abs: string; name: string }> {
  const ext = extname(fileName);
  const stem = fileName.slice(0, -ext.length);
  let name = fileName;
  let abs = join(dirAbs, name);
  for (let i = 1; i < 100; i++) {
    if (!(await fs.stat(abs).catch(() => null))) break;
    name = `${stem} (${i})${ext}`;
    abs = join(dirAbs, name);
  }
  return { abs, name };
}

/**
 * 把抓到的整页 HTML 落成 materials 下的 .html 原件。
 * 返回的 path 为 materials 根相对路径，调用方据此触发内容索引。
 */
async function writeHtmlMaterial(input: {
  projectRoot: string;
  url: string;
  title: string;
  html: string;
  folder?: string;
}): Promise<MaterialWriteResult> {
  const target = resolveTargetDir(input.projectRoot, input.folder);
  if (!target) return { ok: false, error: 'Invalid target folder' };
  await fs.mkdir(target.dirAbs, { recursive: true });

  const { abs, name } = await resolveTarget(target.dirAbs, sanitizeFileName(input.title, '.html'));
  const retrievedAt = new Date().toISOString().slice(0, 10);
  // 原件保持 HTML：这就是这一版页面的快照，索引与正文都从它抽，不再另存 .md；
  // 出处写在最前的注释里，浏览器解析时直接跳过、人读时一眼可见
  const body = `${formatProvenance(input.url, retrievedAt)}\n${input.html.trim()}\n`;
  await fs.writeFile(abs, body, 'utf-8');

  const stat = await fs.stat(abs);
  const rel = target.rel ? `${target.rel}/${name}` : name;
  return { ok: true, path: rel, name, title: input.title, bytes: stat.size, extension: '.html' };
}

/**
 * 把「研究中已读到的正文」直接落成 materials 下的 .md，**不重新抓取**。
 *
 * 与 writeHtmlMaterial 的差别：内容是 agent 本轮实际读到的正文（extract_text /
 * read_article / read_pdf 的返回），因此入库版本与回答里的引用必然同版 —— 这正是
 * NotebookLM 的口径（读到什么就沉淀什么）。代价是它不是「重新抓取的原件快照」，
 * 故出处头里显式标注来源性质，避免与真原件混淆。
 */
export async function importReadTextAsMaterial(input: {
  projectRoot: string;
  url: string;
  title?: string;
  markdown: string;
  folder?: string;
}): Promise<LinkImportResult> {
  const url = normalizeUrl(input.url);
  if (!url) return { ok: false, error: 'Enter a valid http(s) link' };
  const markdown = (input.markdown || '').trim();
  if (markdown.length < REUSABLE_TEXT_MIN_CHARS) {
    return { ok: false, error: 'Captured text is too short to save' };
  }

  const target = resolveTargetDir(input.projectRoot, input.folder);
  if (!target) return { ok: false, error: 'Invalid target folder' };
  await fs.mkdir(target.dirAbs, { recursive: true });

  const title = (input.title || '').trim() || hostOf(url);
  const { abs, name } = await resolveTarget(target.dirAbs, sanitizeFileName(title, '.md'));
  const retrievedAt = new Date().toISOString().slice(0, 10);
  const note = '<!-- Captured: text read by the agent during research (not a re-fetched snapshot) -->';
  await fs.writeFile(abs, `${formatProvenance(url, retrievedAt)}\n${note}\n\n${markdown}\n`, 'utf-8');

  const stat = await fs.stat(abs);
  const rel = target.rel ? `${target.rel}/${name}` : name;
  return {
    ok: true,
    via: 'captured',
    path: rel,
    name,
    title,
    bytes: stat.size,
    extension: '.md',
  };
}

/**
 * 把「本机分享链接指向的那份 md」复制成当前项目 materials 的一份素材。
 *
 * 与前两条链接导入的区别：正文不来自网络，而是直接读原始文件——分享链接只在局域网
 * 可达、渲染版还会丢原文格式，复制原件既保真又离线可用。出处头记下分享链接，
 * 便于日后回溯「这份是从哪条链接收来的」。sourcePath 由调用方从 share-links store 取
 * （token 命中本机才有值），所以这里只需保证文件还在、且是 md。
 */
export async function importSharedDocAsMaterial(input: {
  projectRoot: string;
  /** 分享链接（写进出处头，非抓取目标） */
  url: string;
  /** 标题，缺省用源文件名 */
  title?: string;
  folder?: string;
  /** 分享 token 解析出的**本机绝对路径** */
  sourcePath: string;
}): Promise<LinkImportResult> {
  const url = normalizeUrl(input.url);
  if (!url) return { ok: false, error: 'Enter a valid http(s) link' };
  if (extname(input.sourcePath).toLowerCase() !== '.md') {
    return { ok: false, error: 'Only Markdown documents can be received from a share link' };
  }
  const markdown = await fs.readFile(input.sourcePath, 'utf-8').catch(() => null);
  if (markdown === null) return { ok: false, error: 'Shared document is missing on this machine' };

  const target = resolveTargetDir(input.projectRoot, input.folder);
  if (!target) return { ok: false, error: 'Invalid target folder' };
  await fs.mkdir(target.dirAbs, { recursive: true });

  const base = input.sourcePath.split(/[\\/]/).pop() || '';
  const title = (input.title || '').trim() || base.slice(0, -extname(base).length) || 'Shared document';
  const { abs, name } = await resolveTarget(target.dirAbs, sanitizeFileName(title, '.md'));
  const retrievedAt = new Date().toISOString().slice(0, 10);
  await fs.writeFile(abs, `${formatProvenance(url, retrievedAt)}\n\n${markdown.trim()}\n`, 'utf-8');

  const stat = await fs.stat(abs);
  const rel = target.rel ? `${target.rel}/${name}` : name;
  return { ok: true, via: 'share', path: rel, name, title, bytes: stat.size, extension: '.md' };
}

/**
 * 把「本轮研究结论」落成 materials 下的 .md，**不抓取**。
 *
 * 与 importReadTextAsMaterial 的区别在性质：正文不是别人写的网页内容，而是模型本轮的综述，
 * 属**派生**材料 —— 出处头显式标注（Derived），并把结论所依据的来源 URL 逐条列出，
 * 日后回溯时能看清「这条结论是从哪几页推出来的」。
 */
export async function importResearchReportAsMaterial(input: {
  projectRoot: string;
  nodeId?: string;
  title?: string;
  markdown: string;
  /** 结论所依据的来源 URL（写进出处头，便于回溯） */
  sources?: string[];
  folder?: string;
}): Promise<LinkImportResult> {
  const markdown = (input.markdown || '').trim();
  if (markdown.length < REUSABLE_TEXT_MIN_CHARS) {
    return { ok: false, error: 'The report is too short to save' };
  }
  const target = resolveTargetDir(input.projectRoot, input.folder);
  if (!target) return { ok: false, error: 'Invalid target folder' };
  await fs.mkdir(target.dirAbs, { recursive: true });

  const retrievedAt = new Date().toISOString().slice(0, 10);
  const title = (input.title || '').trim() || `Research report - ${retrievedAt}`;
  const { abs, name } = await resolveTarget(target.dirAbs, sanitizeFileName(title, '.md'));
  const origin = `Research report · session ${input.nodeId || 'unknown'}`;
  const head = [
    formatProvenance(origin, retrievedAt),
    '<!-- Derived: model-written synthesis, not a primary source -->',
  ];
  const urls = (input.sources || []).map((u) => u.trim()).filter(Boolean);
  if (urls.length > 0) head.push(`<!-- Sources: ${urls.join(' ')} -->`);
  await fs.writeFile(abs, `${head.join('\n')}\n\n${markdown}\n`, 'utf-8');

  const stat = await fs.stat(abs);
  const rel = target.rel ? `${target.rel}/${name}` : name;
  return { ok: true, via: 'report', path: rel, name, title, bytes: stat.size, extension: '.md' };
}

/**
 * 抓取链接并落成 materials 下的 .html。
 * 返回的 path 为 materials 根相对路径，调用方据此触发内容索引。
 */
export async function importUrlAsMaterial(input: LinkImportInput): Promise<LinkImportResult> {
  const url = normalizeUrl(input.url);
  if (!url) return { ok: false, error: 'Enter a valid http(s) link' };

  // 一级：Hippo 真实浏览器 —— 渲染后的整页 HTML，登录态在手
  const hippo = await captureUrlViaHippo(url);
  if (hippo.ok) {
    const written = await writeHtmlMaterial({
      projectRoot: input.projectRoot,
      url,
      title: hippo.page.title,
      html: hippo.page.html,
      folder: input.folder,
    });
    if (!written.ok) return written;
    return { ...written, via: 'hippo' };
  }

  // 二级：桥不可用，或 Hippo 也没抓到正文 → 服务端直抓静态 HTML
  const direct = await fetchDirect(url);
  if (!direct.ok) {
    return { ok: false, error: `${hippo.reason} — direct fetch: ${direct.reason}` };
  }
  const written = await writeHtmlMaterial({
    projectRoot: input.projectRoot,
    url,
    title: direct.page.title,
    html: direct.page.html,
    folder: input.folder,
  });
  if (!written.ok) return written;
  return { ...written, via: 'fetch' };
}