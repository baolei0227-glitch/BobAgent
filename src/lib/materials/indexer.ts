/**
 * materials 内容索引（让「文件柜」变成「可检索知识库」）
 *
 * 目标：上传到 <项目>/materials/ 的文件可被**内容**检索，且同一文件被反复引用时
 * 不重复走 OCR。
 *
 * 分层（与 .cache/parse/ 明确分离）：
 *   - .cache/parse/     = 运行时缓存，有 2000 条上限 + 归档 30 天整目录清理；
 *   - .materials-index/ = 项目资产（可检索正文），随项目长期存在，不受缓存淘汰影响。
 *
 * 落盘结构（项目根）：
 *   <项目>/.materials-index/
 *   ├── manifest.json          # { version, entries: { "<relPath>": { hash,size,mtime,pageCount,quality,indexedAt } } }
 *   └── <hash>/
 *       ├── full.txt           # 全文（多页时以 [Page N] 标记分页，与 OCR 文本格式一致）
 *       ├── pages/0001.txt …   # 逐页文本（分页读取直接命中，无需重新 OCR）
 *       ├── blocks.json        # L0' 行级坐标骨架（仅本地 OCR 产生的页；无骨架的文件不生成）
 *       └── meta.json          # { hash, quality, pageCount, textPageCount?, sourcePath, indexedAt, hasScannedPages?, pageMeta?[] }
 *                              #   pageCount = 文档真实页数（OCR 回传）；textPageCount = pages/ 下实际落盘的文本分块数，
 *                              #   整份识别（无分页结构）时 textPageCount < pageCount，读取方按它决定读几个 pages/NNNN.txt。
 *                              #   pageMeta = L0 免费页级标注（qualityScore/rotated/enhanced/upgraded/
 *                              #   skewAngle/route），抽取时顺手落盘，正文保持纯净、标注随附。
 *                              #   网页原件（.html）额外带 sourceUrl / retrievedAt（取自文件头注释）
 *
 * 识别口径（用户确认）：**质量第一位**——文本层用本地提取器（确定性、快速）；
 * 扫描件/图片走 bob-ocr-mcp 的 upgrade='auto'，由插件 ocr.source 决定引擎
 * （在线 GLM-OCR / 本地多模态），质量低或勾稽异常时自动升级视觉大模型。
 *
 * 注意：索引是「供检索与 chat 复用的正文来源」，因此识别质量与 chat 附件一致，
 * 不做能力阉割——同一文件走 materials 与走 chat 附件应得到相同质量的结果。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PageRoute } from '@/lib/pdf/shared/types';
import { extractHtmlText } from './html-text';

const INDEX_DIR_NAME = '.materials-index';
const MATERIALS_DIR_NAME = 'materials';
const ATTACHMENTS_DIR_NAME = 'attachments';
const MANIFEST_FILE = 'manifest.json';
/** L0' 行级骨架落盘文件（仅本地 OCR 产生的页；与 meta.json 分离以免拖大页级标注读取） */
const BLOCKS_FILE = 'blocks.json';
const MANIFEST_VERSION = 1;

/** 单次内容检索最多扫描的索引文件数（防 materials 体量过大时检索变慢） */
const MAX_INDEX_FILES_SCANNED = 300;

/** 判定「文字层可用」的每页平均字符数（与 read_attachment 的密度门限一致） */
const TEXT_DENSITY_CHARS_PER_PAGE = 150;

export type MaterialIndexQuality = 'text' | 'vision';

/**
 * L0 页级标注：抽取阶段本就会拿到这些字段，落盘只是「别丢」——
 * 用于让消费方（read_attachment）判断「哪几页质量低 / 是扫描页」，
 * 正文（full.txt）保持纯净不受影响。
 */
export interface MaterialPageMeta {
  /** 1-based 页码，与 pages[i] 对齐 */
  index: number;
  /** 页面质量分（文字层与 OCR 引擎各自维度，仅作相对高低提示） */
  qualityScore?: number;
  /** OCR 判定页面被旋转并已校正 */
  rotated?: boolean;
  /** OCR 对页面做过图像增强 */
  enhanced?: boolean;
  /** 该页是否经云端引擎升级重识别（upgrade=auto/always 时由插件决定） */
  upgraded?: boolean;
  /** 页面倾斜角（度） */
  skewAngle?: number | null;
  /** 文本层逐页路由（coordinate_text / hybrid / ocr / failed） */
  route?: PageRoute;
}

/**
 * L0' 行级坐标骨架：仅 OCR 引擎链路产出（原生文本层 PDF 无此数据）。
 * 归一化 0~1、左下原点 y 向上，与 pdf-ocr-status sidecar 的 blocks 同源，
 * 供 PDF 预览复用「已识别」状态与命中精确高亮，免去二次 OCR。
 */
export interface MaterialBlock {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 索引中可交付给预览的行级结果（与 lib/pdf/text-search 的 OcrPageText 对齐） */
export interface MaterialOcrPage {
  /** 1-based 页码 */
  page: number;
  text: string;
  blocks?: MaterialBlock[];
}

export interface MaterialManifestEntry {
  hash: string;
  size: number;
  /** 文件 mtime（毫秒），用于判断是否需要重建索引 */
  mtime: number;
  pageCount: number;
  quality: MaterialIndexQuality;
  indexedAt: string;
  /** 已向项目账本（`.ledger/`）登记该材料的时间戳 —— 同一内容只登记一次（防重复 raw 条目） */
  ledgerAt?: string;
}

/** 后台 OCR 进行中的登记。**必须放在 manifest 顶层，不能进 entries**——
 *  否则 listIndexedPaths / 库存检索会把还没正文的文件误报为「已索引」。 */
export interface MaterialPendingEntry {
  hash: string;
  size: number;
  mtime: number;
  startedAt: string;
  /** 插件侧任务 id，供排查 */
  taskId?: string;
}

/** 后台 OCR 失败的登记（同样在顶层，供前端提示 + 重试） */
export interface MaterialFailedEntry {
  hash: string;
  size: number;
  mtime: number;
  failedAt: string;
  error?: string;
}

/** pending / failed 两类登记的公共形状（校正时两者一起遍历） */
type MaterialOcrMarker = MaterialPendingEntry | MaterialFailedEntry;

interface MaterialManifest {
  version: number;
  entries: Record<string, MaterialManifestEntry>;
  pending?: Record<string, MaterialPendingEntry>;
  failed?: Record<string, MaterialFailedEntry>;
}

export interface MaterialIndexResult {
  indexed: boolean;
  /**
   * up-to-date=已是最新跳过 / indexed=本次建立 / ocr-queued=已转交后台异步识别（完成后再落索引）/
   * ocr-failed=该内容上次异步识别失败，等用户显式重试 /
   * unsupported-type / no-text / missing …
   */
  reason: string;
  pageCount?: number;
  quality?: MaterialIndexQuality;
}

export interface IndexedMaterial {
  relPath: string;
  hash: string;
  quality: MaterialIndexQuality;
  /** 文档真实页数 */
  pageCount: number;
  /** pages/ 下实际落盘的文本分块数；< pageCount 表示上游只回整份文本、无分页结构 */
  textPageCount: number;
  fullText: string;
  /** 1-based：pages[i] 为第 i+1 页 */
  pages: string[];
  /** L0 页级标注（无标注的页可缺席） */
  pageMeta: MaterialPageMeta[];
  /** 任有一页为扫描/OCR 页（混合型 PDF：多数页有文字层但夹杂扫描页） */
  hasScannedPages: boolean;
  size: number;
  mtime: number;
}

export interface MaterialIndexHit {
  relPath: string;
  name: string;
  /** 命中页码（1-based） */
  page: number;
  pageCount: number;
  snippet: string;
  size: number;
  mtime: number;
}

/* ------------------------------- 可索引类型 ------------------------------- */

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.xml', '.html', '.css', '.svg',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.go', '.rs',
  '.yaml', '.yml', '.ini', '.conf', '.log',
]);

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif',
]);

/** Office 文档（Word/Excel）：无真实页码 → 整份当一个「页」，质量标 text（与 .txt 同口径） */
const OFFICE_EXTS = new Set(['.docx', '.xlsx']);

export function isIndexableExt(ext: string): boolean {
  return TEXT_EXTS.has(ext) || IMAGE_EXTS.has(ext) || OFFICE_EXTS.has(ext) || ext === '.pdf';
}

/* --------------------------------- 基础路径 --------------------------------- */

function getIndexDir(projectPath: string): string {
  return path.join(projectPath, INDEX_DIR_NAME);
}

function getManifestPath(projectPath: string): string {
  return path.join(getIndexDir(projectPath), MANIFEST_FILE);
}

/** 把材料相对路径解析为绝对路径；越出 materials/ 返回 null（防穿越） */
function resolveMaterialPath(projectPath: string, relPath: string): string | null {
  const materialsRoot = path.resolve(projectPath, MATERIALS_DIR_NAME);
  const full = path.resolve(materialsRoot, relPath);
  if (full !== materialsRoot && !full.startsWith(materialsRoot + path.sep)) return null;
  return full;
}

/* --------------------------------- manifest -------------------------------- */

async function readManifest(projectPath: string): Promise<MaterialManifest> {
  try {
    const raw = await fs.readFile(getManifestPath(projectPath), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MaterialManifest>;
    const entries =
      parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {};
    const pending =
      parsed && typeof parsed.pending === 'object' && parsed.pending ? parsed.pending : undefined;
    const failed =
      parsed && typeof parsed.failed === 'object' && parsed.failed ? parsed.failed : undefined;
    return {
      version: MANIFEST_VERSION,
      entries,
      ...(pending ? { pending } : {}),
      ...(failed ? { failed } : {}),
    };
  } catch {
    return { version: MANIFEST_VERSION, entries: {} };
  }
}

async function writeManifest(projectPath: string, manifest: MaterialManifest): Promise<void> {
  const dir = getIndexDir(projectPath);
  await fs.mkdir(dir, { recursive: true });
  const target = getManifestPath(projectPath);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.rename(tmp, target);
}

/** 同 key 任务串行化（避免 manifest 读改写并发覆盖） */
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  chains.set(key, next.catch(() => undefined));
  return next;
}

/* --------------------------------- 文本抽取 --------------------------------- */

interface ExtractOutcome {
  quality: MaterialIndexQuality;
  /** 1-based 逐页文本 */
  pages: string[];
  /**
   * 文档真实页数（识别引擎回传）。pages 只是**可用的文本分块**：整份识别
   * （GLM-OCR layout_parsing 直传 PDF）只回一段连续文本时 pages.length=1，
   * 但文档可能是多页——缺省时视为 pages.length。
   */
  pageCount?: number;
  /** L0 页级标注（抽取时顺手采集；无可用元数据时省略） */
  pageMeta?: MaterialPageMeta[];
  /** L0' 行级骨架：与 pages 同下标对齐（无骨架的页为 undefined） */
  pageBlocks?: (MaterialBlock[] | undefined)[];
  /** 任有一页为扫描/OCR 页 */
  hasScannedPages?: boolean;
  /** 网页原件（.html）的出处：写在文件头注释里，随 meta.json 留痕 */
  sourceUrl?: string;
  /** 网页原件的抓取日期（YYYY-MM-DD） */
  retrievedAt?: string;
}

/** extractWithPython / extractWithPdfParse 回传中 L0 关心的页级字段 */
interface NativeExtractMeta {
  pageRoutes?: PageRoute[];
  pageQualities?: number[];
  hasScannedPages?: boolean;
}

/** 把文本层提取器已回传、过去被丢弃的页级字段整理为 L0 标注 */
function nativePageMeta(
  result: NativeExtractMeta,
  pageCount: number,
): Pick<ExtractOutcome, 'pageMeta' | 'hasScannedPages'> {
  const pageMeta: MaterialPageMeta[] = [];
  for (let i = 0; i < pageCount; i++) {
    const route = result.pageRoutes?.[i];
    const qualityScore = result.pageQualities?.[i];
    if (route === undefined && typeof qualityScore !== 'number') continue;
    const meta: MaterialPageMeta = { index: i + 1 };
    if (typeof qualityScore === 'number') meta.qualityScore = qualityScore;
    if (route) meta.route = route;
    pageMeta.push(meta);
  }
  const hasScannedPages =
    result.hasScannedPages === true ||
    (result.pageRoutes ?? []).some((r) => r === 'ocr' || r === 'hybrid');
  return {
    pageMeta: pageMeta.length > 0 ? pageMeta : undefined,
    hasScannedPages: hasScannedPages || undefined,
  };
}

async function extractTextFile(fullPath: string): Promise<ExtractOutcome> {
  const raw = await fs.readFile(fullPath);
  let content: string;
  try {
    // fatal：遇非法 UTF-8（如 GBK 中文）抛错 → 触发编码探测
    content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    try {
      content = new TextDecoder('gb18030').decode(raw);
    } catch {
      content = new TextDecoder('utf-8').decode(raw);
    }
  }
  return { quality: 'text', pages: [content.replace(/^\uFEFF/, '')] };
}

/** 网页原件抽取出的正文上限：与旧 .md 材料同口径（当时在落盘时即截到这里） */
const MAX_HTML_TEXT_CHARS = 60000;

/**
 * 网页原件（.html）→ 正文
 *
 * 落盘的是渲染后的整页 HTML（脚本已剥、链接已绝对化），直接当纯文本读会把标签灌进索引，
 * 所以这里走「剥噪声 → 主内容容器 → turndown」。正文头部保留文件头注释里的原文链接，
 * 索引与检索结果里仍能看见来源；正文为空 → null（与「无文本」同待遇，不留空页）。
 */
async function extractHtmlFile(fullPath: string): Promise<ExtractOutcome | null> {
  const raw = await fs.readFile(fullPath, 'utf-8').catch(() => '');
  const { markdown, sourceUrl, retrievedAt } = extractHtmlText(raw);
  if (!markdown) return null;
  const head = sourceUrl ? `> Source: ${sourceUrl}\n> Retrieved: ${retrievedAt ?? ''}\n\n` : '';
  return {
    quality: 'text',
    pages: [`${head}${markdown}`.slice(0, MAX_HTML_TEXT_CHARS)],
    sourceUrl,
    retrievedAt,
  };
}

/** 每页平均字符数达标 → 视为可用文字层（与 read_attachment 判定一致） */
function denseText(pages: string[]): boolean {
  if (pages.length === 0) return false;
  const total = pages.reduce((n, p) => n + (p?.length ?? 0), 0);
  return total / pages.length >= TEXT_DENSITY_CHARS_PER_PAGE;
}

function normalizeNativePages(pageTexts?: string[], text?: string): string[] {
  if (pageTexts && pageTexts.length > 0) return pageTexts;
  if (text && text.trim()) return [text];
  return [];
}

/** 归一化坐标保留 4 位小数：足够画高亮框，同时把 blocks.json 体积压到最小 */
function roundCoord(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 校验并精简 OCR 行级骨架（丢弃坐标非法/无文本的行），无有效行 → undefined */
function toBlocks(
  raw: Array<{ text?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown }> | undefined,
): MaterialBlock[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: MaterialBlock[] = [];
  for (const b of raw) {
    if (!b || typeof b.text !== 'string') continue;
    const { x, y, w, h } = b;
    if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    out.push({ text: b.text, x: roundCoord(x as number), y: roundCoord(y as number), w: roundCoord(w as number), h: roundCoord(h as number) });
  }
  return out.length > 0 ? out : undefined;
}

/** 写索引时的逐页 OCR 结果（与 ocr-client.OcrMcpPage 结构兼容），materials 与附件两侧共用 */
export interface OcrIndexPage {
  text?: string;
  qualityScore?: number;
  rotated?: boolean;
  enhanced?: boolean;
  upgraded?: boolean;
  skewAngle?: number | null;
  blocks?: Array<{ text?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown }>;
}

/** 把 MCP 逐页 OCR 结果整理为索引落盘结构（页级标注 + 行级骨架）；无结构化页时用整份文本单页兜底 */
function buildVisionOutcome(
  rawPages: OcrIndexPage[] | undefined,
  fallbackText?: string,
  /** 识别引擎回传的文档真实页数（GLM 整份解析时 pages=[] 但 pageCount=N） */
  realPageCount?: number,
): ExtractOutcome | null {
  const pages = rawPages ?? [];
  // 真实页数只在大于「已结构化页数」时才有信息量：结构化页本身就是逐页结果
  const pageCount =
    typeof realPageCount === 'number' && realPageCount > pages.length ? realPageCount : undefined;
  if (pages.length > 0) {
    const pageMeta: MaterialPageMeta[] = pages.map((p, i) => ({
      index: i + 1,
      qualityScore: typeof p?.qualityScore === 'number' ? p.qualityScore : undefined,
      rotated: !!p?.rotated,
      enhanced: !!p?.enhanced,
      upgraded: !!p?.upgraded,
      skewAngle: p?.skewAngle ?? null,
    }));
    const pageBlocks = pages.map((p) => toBlocks(p?.blocks));
    return {
      quality: 'vision',
      pages: pages.map((p) => p?.text ?? ''),
      pageCount,
      pageMeta,
      pageBlocks: pageBlocks.some(Boolean) ? pageBlocks : undefined,
    };
  }
  // 整份识别（无逐页结构）：正文只有一段连续文本，但页数必须按文档真实页数登记，
  // 否则多页文档会被记成 1 页 → read_attachment 回「1/1 pages」→ 模型误判识别被截断而重跑 OCR。
  if (fallbackText?.trim()) return { quality: 'vision', pages: [fallbackText], pageCount };
  return null;
}

/* ------------------------------- OCR 并发闸门 ------------------------------- */

/**
 * OCR 并发上限。批量上传时 POST 逐份落盘后即 fire-and-forget 起索引任务，
 * 若不加闸门 → N 份文件同时打向在线 OCR 接口（且单份 PDF 内部还有 3 路页并发），
 * 易撞在线 QPS 限制 → 部分文件识别失败 → 索引建不起来。
 * 只闸 OCR（本地文本抽取/文本文件不走这里），单文件上传时无感知。
 */
const OCR_CONCURRENCY = 2;
let ocrRunning = 0;
const ocrWaiters: Array<() => void> = [];

async function acquireOcrSlot(): Promise<void> {
  if (ocrRunning < OCR_CONCURRENCY) {
    ocrRunning++;
    return;
  }
  await new Promise<void>((resolve) => ocrWaiters.push(resolve));
  // 槽位由 releaseOcrSlot 直接移交，此处不再自增（防超发）
}

function releaseOcrSlot(): void {
  const next = ocrWaiters.shift();
  if (next) next(); // 直接移交给队首等待者，running 保持不变
  else ocrRunning--;
}

/* ------------------------------ 长 OCR 异步调度 ------------------------------ */

/**
 * 扫描件「长 OCR」阈值：整份识别且（页数 ≥ 15 或 体积 ≥ 5MB）→ 转交后台异步任务。
 *
 * 根因修复：同步 OCR 的 MCP 客户端超时是 300s，超时即失败 → 本模块返回 `no-text`，
 * 而 `no-text` 既不写 manifest、也不登记账本；上传侧又是 fire-and-forget（`.catch(()=>{})`），
 * 于是长扫描件被静默丢弃：检索面没有、账本里也没有（表现为「目录里有文件，却不算资料」）。
 * 改为异步任务后不再白等 300s，进行中/失败落 manifest 顶层 pending/failed，前端可见且可重试。
 */
const ASYNC_OCR_MIN_PAGES = 15;
const ASYNC_OCR_MIN_BYTES = 5 * 1024 * 1024;

/** 异步任务超过该时长仍未落地且进程内已无对应任务 → 判定为识别中断（应用重启/任务丢失） */
const PENDING_STALE_MS = 5 * 60 * 1000;

/** 扫描件索引上下文：同步抽取与异步回调两条链路共用（回调在任务完成时仍需知道归属与去重键） */
interface ScanQueueContext {
  projectPath: string;
  relPath: string;
  hash: string;
  size: number;
  mtime: number;
}

function manifestLockKey(projectPath: string): string {
  return `materials-manifest:${path.resolve(projectPath)}`;
}

/** 登记「后台识别中」（顶层 pending，不进 entries） */
async function markMaterialPending(ctx: ScanQueueContext, taskId?: string): Promise<void> {
  await serialize(manifestLockKey(ctx.projectPath), async () => {
    const manifest = await readManifest(ctx.projectPath);
    manifest.pending = manifest.pending ?? {};
    manifest.pending[ctx.relPath] = {
      hash: ctx.hash,
      size: ctx.size,
      mtime: ctx.mtime,
      startedAt: new Date().toISOString(),
      ...(taskId ? { taskId } : {}),
    };
    if (manifest.failed) delete manifest.failed[ctx.relPath];
    await writeManifest(ctx.projectPath, manifest);
  });
}

/** 登记「后台识别失败」（顶层 failed，前端据此提示并给出重试入口） */
async function markMaterialFailed(ctx: ScanQueueContext, error: string): Promise<void> {
  await serialize(manifestLockKey(ctx.projectPath), async () => {
    const manifest = await readManifest(ctx.projectPath);
    if (manifest.pending) delete manifest.pending[ctx.relPath];
    manifest.failed = manifest.failed ?? {};
    manifest.failed[ctx.relPath] = {
      hash: ctx.hash,
      size: ctx.size,
      mtime: ctx.mtime,
      failedAt: new Date().toISOString(),
      error,
    };
    await writeManifest(ctx.projectPath, manifest);
  });
}

/**
 * 索引原子落库：写 manifest 条目 + 清 pending/failed + 账本登记 + 触发编译。
 * 同步抽取与异步 OCR 两条链路共用，避免两处口径漂移（账本登记必须两条链路都做）。
 */
async function commitIndexEntry(
  projectPath: string,
  relPath: string,
  hash: string,
  size: number,
  mtime: number,
  outcome: ExtractOutcome,
): Promise<{ pageCount: number; quality: MaterialIndexQuality }> {
  // 页数用文档真实页数（整份识别时 pages.length=1 不代表文档只有 1 页）
  const pageCount = outcome.pageCount ?? outcome.pages.length;
  const quality = outcome.quality;
  let needRegister = false;
  await serialize(manifestLockKey(projectPath), async () => {
    const manifest = await readManifest(projectPath);
    const prev = manifest.entries[relPath];
    // 账本登记去重：同路径 + 同内容 hash 已登记过 → 本轮不再登记（内容变了才作为新条目登记）
    const prevLedgerAt = prev && prev.hash === hash ? prev.ledgerAt : undefined;
    manifest.entries[relPath] = {
      hash,
      size,
      mtime,
      pageCount,
      quality,
      indexedAt: new Date().toISOString(),
      ...(prevLedgerAt ? { ledgerAt: prevLedgerAt } : {}),
    };
    if (manifest.pending) delete manifest.pending[relPath];
    if (manifest.failed) delete manifest.failed[relPath];
    await writeManifest(projectPath, manifest);
    needRegister = !prevLedgerAt;
  });
  // 录入即登记（3.4）：材料索引落盘后向项目账本投一条 raw（确定性 1 材料 1 条，0 token）
  if (needRegister) await registerMaterialToLedger(projectPath, relPath, pageCount, quality, hash);
  return { pageCount, quality };
}

/** 异步 OCR 完成 → 落索引文件 + manifest 条目 + 账本登记（与同步路径同口径） */
async function commitOcrResult(
  ctx: ScanQueueContext,
  r: { text?: string; pageCount?: number; pages?: OcrIndexPage[] },
): Promise<void> {
  const outcome = buildVisionOutcome(r.pages, r.text, r.pageCount);
  if (!outcome || outcome.pages.length === 0) {
    await markMaterialFailed(ctx, 'OCR returned no usable text');
    return;
  }
  // 同 hash 索引可能已由 chat 附件链路写入（内容寻址，两侧共用一份）→ 不重复落盘
  if (!(await readExistingIndex(ctx.projectPath, ctx.hash))) {
    await writeIndexFiles(
      ctx.projectPath,
      ctx.hash,
      outcome.pages,
      outcome.quality,
      ctx.relPath,
      outcome.pageMeta,
      outcome.hasScannedPages,
      outcome.pageBlocks,
      outcome.pageCount,
    );
  }
  await commitIndexEntry(ctx.projectPath, ctx.relPath, ctx.hash, ctx.size, ctx.mtime, outcome);
  console.log(
    `[materials] 异步OCR完成并建索引: ${ctx.relPath} pages=${outcome.pageCount ?? outcome.pages.length}`,
  );
}

/**
 * 转交后台异步 OCR：提交任务（单飞去重）并在完成回调里写索引 + 登记账本。
 * @returns true = 已进入后台识别（本次不产出正文）；false = 未进入，调用方退回同步路径
 */
async function queueScannedOcr(fullPath: string, ctx: ScanQueueContext): Promise<boolean> {
  const { submitOcrTask, hasRunningOcrTask, getOcrTaskByHash } = await import(
    '@/lib/parse/ocr-task-manager'
  );
  if (hasRunningOcrTask(ctx.hash)) {
    await markMaterialPending(ctx, getOcrTaskByHash(ctx.hash)?.taskId);
    return true;
  }
  const rec = await submitOcrTask({
    filePath: fullPath,
    projectPath: ctx.projectPath,
    hash: ctx.hash,
    upgrade: 'auto',
    onDone: async (_rec, result) => {
      const r = result as {
        success?: boolean;
        text?: string;
        pageCount?: number;
        pages?: OcrIndexPage[];
      };
      if (!r?.success) {
        await markMaterialFailed(ctx, 'OCR engine reported failure');
        return;
      }
      await commitOcrResult(ctx, r);
    },
    onFail: async (failed) => {
      await markMaterialFailed(ctx, failed.error ?? 'OCR task failed');
    },
  });
  // 进程内已有完成结果（任务刚结束、哈希表尚未清理）→ 退回同步路径，插件识别缓存命中即可秒回
  if (rec.status === 'done') return false;
  await markMaterialPending(ctx, rec.taskId);
  return true;
}

/** 扫描件/图片 OCR（upgrade='auto' → 质量低或勾稽异常时自动升级视觉大模型；引擎由插件 ocr.source 决定）。
 *  长 OCR（页数大 / 体积大）转交后台异步任务并返回 'queued'，避免同步等待撞 300s 客户端超时。 */
async function extractScannedViaOcr(
  fullPath: string,
  ctx: ScanQueueContext,
  pageCount?: number,
): Promise<ExtractOutcome | 'queued' | null> {
  const isLongOcr = (pageCount ?? 0) >= ASYNC_OCR_MIN_PAGES || ctx.size >= ASYNC_OCR_MIN_BYTES;
  if (isLongOcr && (await queueScannedOcr(fullPath, ctx).catch(() => false))) return 'queued';
  await acquireOcrSlot();
  try {
    const { tryOcrViaMcp } = await import('@/lib/mcp/ocr-client');
    const ocr = await tryOcrViaMcp(fullPath, 'auto');
    if (!ocr?.success) return null;
    return buildVisionOutcome(ocr.pages, ocr.text, ocr.pageCount);
  } catch {
    return null;
  } finally {
    releaseOcrSlot();
  }
}

async function extractPdf(
  fullPath: string,
  ctx: ScanQueueContext,
): Promise<ExtractOutcome | 'queued' | null> {
  // 长 OCR 判定需要页数：文本层抽取器顺带回传文档真实页数（拿不到时退回体积阈值）
  let scannedPageCount: number | undefined;
  try {
    const { extractWithPython, extractWithPdfParse } = await import('@/lib/pdf/extractor');
    try {
      const py = await extractWithPython(fullPath);
      const pages = normalizeNativePages(py.pageTexts, py.text);
      if (pages.length > 0 && denseText(pages)) {
        return { quality: 'text', pages, ...nativePageMeta(py, pages.length) };
      }
      if (py.pageCount > 0) scannedPageCount = py.pageCount;
    } catch {
      /* 落到 pdf-parse */
    }
    try {
      const fb = await extractWithPdfParse(fullPath);
      const pages = normalizeNativePages(fb.pageTexts, fb.text);
      if (pages.length > 0 && denseText(pages)) {
        return { quality: 'text', pages, ...nativePageMeta(fb, pages.length) };
      }
      if (!scannedPageCount && fb.pageCount > 0) scannedPageCount = fb.pageCount;
    } catch {
      /* 落到 OCR */
    }
  } catch {
    return null;
  }
  // 扫描件：走统一 OCR 链路（与 chat 附件同口径，auto 升级；大文件转后台异步）
  return extractScannedViaOcr(fullPath, ctx, scannedPageCount);
}

/** mammoth 无内置 TS 类型：仅声明本文件用到的 convertToHtml */
interface MammothLike {
  convertToHtml: (
    input: { path?: string; buffer?: Buffer },
    options?: Record<string, unknown>,
  ) => Promise<{ value: string; messages: unknown[] }>;
}

/**
 * docx → 结构化文本（mammoth HTML 保真管线，与 read_attachment 同一套转换规则）。
 * 文档没有真实页码 → 整份当一个「页」，质量标 text；mammoth 失败时退回解 word/document.xml。
 */
async function extractDocx(fullPath: string): Promise<ExtractOutcome | null> {
  const { docxHtmlToText, docxXmlFallbackText } = await import('@/lib/parse/office-text');
  try {
    const mammoth = (await import('mammoth')) as unknown as MammothLike;
    const res = await mammoth.convertToHtml({ path: fullPath });
    const text = docxHtmlToText(res.value);
    if (text.trim()) return { quality: 'text', pages: [text] };
  } catch {
    /* 落到 document.xml 兜底 */
  }
  try {
    const AdmZip = (await import('adm-zip')).default;
    const text = docxXmlFallbackText(new AdmZip(fullPath).readAsText('word/document.xml'));
    if (text.trim()) return { quality: 'text', pages: [text] };
  } catch {
    /* 无法提取 */
  }
  return null;
}

/**
 * xlsx 是 CJS：Next 打包后命名导出挂在模块命名空间上，而在 Node/tsx 直跑时挂在 default 上
 * —— 两侧都取到真实模块（否则 readFile 为 undefined，抽取静默失败）。
 */
function unwrapXlsx(
  mod: (typeof import('xlsx')) & { default?: typeof import('xlsx') },
): typeof import('xlsx') {
  return typeof mod.readFile === 'function' ? mod : (mod.default ?? mod);
}

/**
 * xlsx → 逐 sheet 紧凑文本（SheetJS，与 read_attachment 同一套转换规则）。
 * 表格没有页码 → 整份当一个「页」，质量标 text。
 */
async function extractXlsx(fullPath: string): Promise<ExtractOutcome | null> {
  try {
    const XLSX = unwrapXlsx(await import('xlsx'));
    const { xlsxRowsToLines } = await import('@/lib/parse/office-text');
    const wb = XLSX.readFile(fullPath);
    const blocks: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false }) as unknown[][];
      const lines = xlsxRowsToLines(rows);
      if (lines.length > 0) blocks.push(`[Sheet: ${sheetName}] (${lines.length} rows)\n${lines.join('\n')}`);
    }
    if (blocks.length === 0) return null;
    return { quality: 'text', pages: [blocks.join('\n\n')] };
  } catch {
    return null;
  }
}

async function extractByExt(
  ext: string,
  fullPath: string,
  ctx: ScanQueueContext,
): Promise<ExtractOutcome | 'queued' | null> {
  // .html 也在 TEXT_EXTS 里（保证 isIndexableExt 放行），但必须走「剥标记」的抽取：
  // 网页原件是整页 HTML，当纯文本直读会把标签灌进索引
  if (ext === '.html') return extractHtmlFile(fullPath);
  if (TEXT_EXTS.has(ext)) return extractTextFile(fullPath);
  if (ext === '.pdf') return extractPdf(fullPath, ctx);
  if (IMAGE_EXTS.has(ext)) return extractScannedViaOcr(fullPath, ctx);
  if (ext === '.docx') return extractDocx(fullPath);
  if (ext === '.xlsx') return extractXlsx(fullPath);
  return null;
}

/* ---------------------------------- 落盘 ---------------------------------- */

function pageFileName(page: number): string {
  return `${String(page).padStart(4, '0')}.txt`;
}

function buildFullText(pages: string[]): string {
  if (pages.length <= 1) return pages[0] ?? '';
  return pages.map((t, i) => `[Page ${i + 1}]\n${t}`).join('\n\n');
}

function splitPages(fullText: string, pageCount: number): string[] {
  if (pageCount <= 1) return [fullText];
  const re = /\[Page (\d+)\]\n?/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  let lastPage = -1;
  while ((m = re.exec(fullText)) !== null) {
    if (lastPage > 0) out.push(fullText.slice(lastIndex, m.index).trim());
    lastPage = parseInt(m[1], 10);
    lastIndex = m.index + m[0].length;
  }
  if (lastPage > 0) out.push(fullText.slice(lastIndex).trim());
  return out.length > 0 ? out : [fullText];
}

async function writeIndexFiles(
  projectPath: string,
  hash: string,
  pages: string[],
  quality: MaterialIndexQuality,
  relPath: string,
  pageMeta?: MaterialPageMeta[],
  hasScannedPages?: boolean,
  pageBlocks?: (MaterialBlock[] | undefined)[],
  /** 文档真实页数；缺省视为 pages.length（文本层抽取/逐页 OCR 时两者本就一致） */
  pageCount?: number,
  /** 网页原件（.html）的出处：随 meta.json 留痕，正文里另有同源的一行 */
  provenance?: Pick<ExtractOutcome, 'sourceUrl' | 'retrievedAt'>,
): Promise<void> {
  const dir = path.join(getIndexDir(projectPath), hash);
  const pagesDir = path.join(dir, 'pages');
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(path.join(dir, 'full.txt'), buildFullText(pages), 'utf-8');
  await Promise.all(
    pages.map((t, i) => fs.writeFile(path.join(pagesDir, pageFileName(i + 1)), t, 'utf-8')),
  );
  // L0' 行级骨架：按页存 { "1": [...], "3": [...] }；与 full.txt/pages 分离，无骨架则不生成
  const blockMap: Record<string, MaterialBlock[]> = {};
  pageBlocks?.forEach((b, i) => {
    if (b && b.length > 0) blockMap[String(i + 1)] = b;
  });
  const blockFile = path.join(dir, BLOCKS_FILE);
  if (Object.keys(blockMap).length > 0) {
    await fs.writeFile(blockFile, JSON.stringify({ version: 1, blocks: blockMap }), 'utf-8');
  } else {
    // 同 hash 目录是复用的：本次无骨架时清掉可能残留的旧骨架，避免预览拿到过期坐标
    await fs.rm(blockFile, { force: true });
  }
  // L0 页级标注走 meta.json（key = pageMeta），正文 full.txt / pages 保持纯净
  const meta: Record<string, unknown> = {
    hash,
    quality,
    pageCount: pageCount ?? pages.length,
    // 落盘文本分块数：与 pageCount 分离，读取方据此决定读几个 pages/NNNN.txt
    textPageCount: pages.length,
    sourcePath: relPath,
    indexedAt: new Date().toISOString(),
  };
  if (hasScannedPages) meta.hasScannedPages = true;
  if (provenance?.sourceUrl) meta.sourceUrl = provenance.sourceUrl;
  if (provenance?.retrievedAt) meta.retrievedAt = provenance.retrievedAt;
  if (pageMeta && pageMeta.length > 0) meta.pageMeta = pageMeta;
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/** 已落盘的抽取元数据（含 L0 标注）；pageCount 缺失视为无效 → null */
async function readStoredMeta(dir: string): Promise<
  | (Pick<ExtractOutcome, 'quality' | 'pageMeta' | 'hasScannedPages'> & {
      pageCount: number;
      textPageCount: number;
    })
  | null
> {
  try {
    const raw = await fs.readFile(path.join(dir, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw) as {
      pageCount?: unknown;
      textPageCount?: unknown;
      quality?: unknown;
      pageMeta?: unknown;
      hasScannedPages?: unknown;
    };
    const pageCount = typeof meta.pageCount === 'number' ? meta.pageCount : 0;
    if (pageCount <= 0) return null;
    // 旧索引无 textPageCount：当时 pageCount 即落盘文本数
    const textPageCount =
      typeof meta.textPageCount === 'number' && meta.textPageCount > 0
        ? meta.textPageCount
        : pageCount;
    return {
      pageCount,
      textPageCount,
      quality: meta.quality === 'vision' ? 'vision' : 'text',
      pageMeta: Array.isArray(meta.pageMeta) ? (meta.pageMeta as MaterialPageMeta[]) : undefined,
      hasScannedPages: meta.hasScannedPages === true || undefined,
    };
  } catch {
    return null;
  }
}

/** 读取已落盘的行级骨架（页码字符串 → blocks）；无骨架/损坏 → null */
async function readStoredBlocks(dir: string): Promise<Record<string, MaterialBlock[]> | null> {
  try {
    const raw = await fs.readFile(path.join(dir, BLOCKS_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as { blocks?: unknown };
    const map = parsed?.blocks;
    if (!map || typeof map !== 'object') return null;
    const out: Record<string, MaterialBlock[]> = {};
    for (const [page, list] of Object.entries(map as Record<string, unknown>)) {
      if (Array.isArray(list) && list.length > 0) out[page] = list as MaterialBlock[];
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 同 hash（同字节）已有索引 → 直接复用，跳过抽取 */
async function readExistingIndex(
  projectPath: string,
  hash: string,
): Promise<ExtractOutcome | null> {
  const dir = path.join(getIndexDir(projectPath), hash);
  const meta = await readStoredMeta(dir);
  if (!meta) return null;
  try {
    const pages: string[] = [];
    // 按落盘文本分块数读（整份识别时 textPageCount=1 < pageCount）
    for (let i = 1; i <= meta.textPageCount; i++) {
      pages.push(await fs.readFile(path.join(dir, 'pages', pageFileName(i)), 'utf-8'));
    }
    const stored = await readStoredBlocks(dir);
    const pageBlocks = stored
      ? pages.map((_, i) => stored[String(i + 1)])
      : undefined;
    return {
      quality: meta.quality,
      pages,
      pageCount: meta.pageCount,
      pageMeta: meta.pageMeta,
      pageBlocks: pageBlocks?.some(Boolean) ? pageBlocks : undefined,
      hasScannedPages: meta.hasScannedPages,
    };
  } catch {
    return null;
  }
}

/* -------------------------------- 公共接口 -------------------------------- */

/** per-file 并发去重（同文件同时触发只跑一次） */
const inflight = new Map<string, Promise<MaterialIndexResult>>();

/**
 * 为一个 materials 文件建立内容索引（幂等）。
 * 建议异步调用（不 await），索引失败不影响上传/读取主流程。
 */
export async function indexMaterialFile(
  projectPath: string,
  relPath: string,
): Promise<MaterialIndexResult> {
  const key = `${path.resolve(projectPath)}::${relPath}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = doIndexMaterialFile(projectPath, relPath).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/** 进程内已触发过补扫的项目（每项目只扫一次：解析不出来的文件不反复重试拖慢资料页） */
const backfillStarted = new Set<string>();

/**
 * 处理幽灵条目：manifest 里有、原路径磁盘上已不存在的 key。
 *
 * 成因：材料在应用外（Finder/系统层）被移动或删除时，`renameMaterialsIndex` /
 * `removeMaterialsIndex` 都收不到通知，manifest 与盘面脱节；残影会让 search_materials
 * 吐出取不到的路径，read_attachment 必然 ENOENT（用户侧表现为「索引里有、取原件报不存在」）。
 *
 * 两类分别处理，**认领优先于删除**：
 *   - 认领：树里存在同名且内容 hash 一致的候选 → `renameMaterialsIndex` 改写键路径。
 *     索引按内容 hash 寻址，正文零成本复用、**不会重跑 OCR**，账本出处一并改写。
 *   - 删除：找不到内容一致的候选 → `removeMaterialsIndex` 回收条目、hash 目录与账本 raw 登记。
 *
 * 若只删不认领，被移动的材料会丢掉旧键、hash 目录又被回收，只能等全量重扫重新识别（整份重 OCR）。
 *
 * 安全阀：`materials/` 不存在（项目未初始化 / 外置卷未挂载）时整体跳过——
 * 否则全部 stat 都 ENOENT，会把整份索引连同 hash 目录一起误删。只认 ENOENT 为「已消失」，
 * stat 因权限/瞬时错误失败者一律保留。
 *
 * 成本：无幽灵时零成本直接返回（不扫盘、不哈希）；仅已脱节时才走一遍目录树，且只对同名候选算 sha256。
 *
 * @returns 实际处理的幽灵条目数（调用方据此判断盘面是否在应用外变过 → 是否放开本轮补扫）
 */
async function pruneGhostMaterials(projectPath: string): Promise<number> {
  const materialsRoot = path.resolve(projectPath, MATERIALS_DIR_NAME);
  try {
    if (!(await fs.stat(materialsRoot)).isDirectory()) return 0;
  } catch {
    return 0;
  }
  const manifest = await readManifest(projectPath);
  const ghosts: string[] = [];
  for (const relPath of Object.keys(manifest.entries)) {
    const full = resolveMaterialPath(projectPath, relPath);
    if (!full) {
      ghosts.push(relPath); // 越出 materials 的非法键 → 直接清掉
      continue;
    }
    try {
      await fs.stat(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') ghosts.push(relPath);
      // 非「不存在」（权限/瞬时错误）→ 保留
    }
  }
  if (ghosts.length === 0) return 0;

  // 认领候选：按 (size, mtime 毫秒) 定位 —— Finder 移动与改名都会保留这两项属性，
  // 比 basename 多覆盖「改名」场景；命中后仍用 sha256 复核内容，不凭属性下结论。
  const targets = ghosts.map((relPath) => {
    const e = manifest.entries[relPath];
    return { relPath, hash: e.hash, key: `${e.size}:${Math.round(e.mtime)}` };
  });
  const wanted = new Set(targets.map((t) => t.key));
  const candidates = new Map<string, string[]>();
  await forEachIndexableFile(materialsRoot, async (full) => {
    const relPath = path.relative(materialsRoot, full);
    if (!relPath) return;
    try {
      const st = await fs.stat(full);
      const key = `${st.size}:${Math.round(st.mtimeMs)}`;
      if (!wanted.has(key)) return;
      const bucket = candidates.get(key);
      if (bucket) bucket.push(relPath);
      else candidates.set(key, [relPath]);
    } catch { /* stat 失败 → 跳过该候选 */ }
  });

  const { computeFileHash } = await import('@/lib/parse/image-parser');
  const liveKeys = new Set(Object.keys(manifest.entries)); // 仍是有效条目的路径
  const claimed = new Set<string>(); // 已被认领的候选，防一条候选喂两条幽灵
  let handled = 0;
  for (const { relPath, hash, key } of targets) {
    let target: string | null = null;
    for (const cand of candidates.get(key) ?? []) {
      // 已认领 / 已是别的有效条目 → 不是它；属性相同者可能有多个，逐个校验内容
      if (claimed.has(cand) || liveKeys.has(cand)) continue;
      try {
        if (hash && (await computeFileHash(path.join(materialsRoot, cand))) === hash) {
          target = cand;
          break;
        }
      } catch { /* 读取失败 → 试下一个候选 */ }
    }
    if (target) {
      claimed.add(target);
      console.log(`[materials] 认领幽灵索引条目: ${relPath} → ${target}`);
      await renameMaterialsIndex(projectPath, relPath, target).catch(() => {});
    } else {
      console.log(`[materials] 剪除幽灵索引条目: ${relPath}`);
      await removeMaterialsIndex(projectPath, relPath, false).catch(() => {});
    }
    handled++;
  }
  return handled;
}

/**
 * 扫描补登：遍历 materials/ 下所有「可索引」文件，为尚无索引（或已过期）的文件补建索引；
 * 并处理原路径已不存在的幽灵条目（认领优先于删除，见 `pruneGhostMaterials`）。
 *
 * 用途：可索引白名单扩容后（如新增 .docx/.xlsx），老项目里已有的此类材料无需用户重新上传，
 * 打开资料树时即被补登记（进而登记到项目账本）。后台异步、逐个索引、失败静默，不阻断列表返回。
 */
export function kickMaterialsBackfill(projectPath: string): void {
  // 账本编译兜底（每次打开资料树都查，不受下方一次性扫描守卫限制）：
  // 触发编译靠内存里的防抖计时器，若上次「登记完 → 静默期内」就关掉应用，计时器丢失、
  // 这批 raw 会一直挂着没人编（重启后的补扫只处理未登记/索引过期者，已登记的不再触发）。
  // 这里续跑一次即可，复用同一条触发链（防抖 + 单飞 + 分批），不引入新机制。
  void (async () => {
    try {
      const { countPendingRaw } = await import('@/lib/mcp/ledger');
      if (countPendingRaw(projectPath) <= 0) return;
      const { notifyLedgerMaterialRegistered } = await import('@/lib/mcp/ledger-compile');
      notifyLedgerMaterialRegistered(projectPath);
    } catch {
      /* 账本不可用：静默，不阻断资料树 */
    }
  })();

  const materialsRoot = path.resolve(projectPath, MATERIALS_DIR_NAME);
  void (async () => {
    // 幽灵条目核对不受下方一次性守卫限制：无幽灵时只是 O(条目数) 次 stat，每次打开资料树都跑一遍，
    // 才能在应用外搬动/删除材料后立刻自愈（补扫只认新文件，管不到残影）。
    const handled = await pruneGhostMaterials(projectPath).catch(() => 0);
    // 处理过幽灵 = 盘面在应用外变过 → 本轮必须重扫：被删除的靠它回收，被改名/移动的靠它把新路径补回索引。
    // 否则旧键一删、新路径没人补，材料会静默从检索面消失，直到重启应用才恢复。
    if (backfillStarted.has(materialsRoot) && handled === 0) return;
    backfillStarted.add(materialsRoot);
    await forEachIndexableFile(materialsRoot, async (full) => {
      const relPath = path.relative(materialsRoot, full);
      if (relPath) await indexMaterialFile(projectPath, relPath).catch(() => null);
    }).catch(() => {});
  })();
}

/** 材料录入即登记（3.4）：向项目账本 `.ledger/raw/` 投一条登记（宿主确定性写入，0 token），
 *  成功后把 `ledgerAt` 写回 manifest（同一内容只登记一次）。
 *  失败静默：账本不可用 / 无激活项目绝不影响索引主流程（软规定，不阻断）。 */
async function registerMaterialToLedger(
  projectPath: string,
  relPath: string,
  pageCount: number,
  quality: MaterialIndexQuality,
  hash: string,
): Promise<void> {
  try {
    const { registerLedgerMaterial } = await import('@/lib/mcp/ledger');
    // manifest 的 key 是 **materials 相对**路径（`被告/证据.pdf`），账本出处要**项目相对**路径
    // （`materials/被告/证据.pdf`）—— agent 按它 read_attachment 才取得到原文。
    const projectRelPath = `${MATERIALS_DIR_NAME}/${relPath}`;
    if (!registerLedgerMaterial(projectPath, { relPath: projectRelPath, pageCount, quality, contentHash: hash }))
      return;
    const ledgerAt = new Date().toISOString();
    await serialize(`materials-manifest:${path.resolve(projectPath)}`, async () => {
      const manifest = await readManifest(projectPath);
      const entry = manifest.entries[relPath];
      if (entry && entry.hash === hash) {
        entry.ledgerAt = ledgerAt;
        await writeManifest(projectPath, manifest);
      }
    });
    // 材料到达即触发后台编译（防抖攒批 + 单飞 + 分批续跑，见 ledger-compile.ts）：
    // 编译不挂在任务收尾（会拖慢用户等待）也不等每日班车（积压窗口最长），后台跑、用户零等待。
    const { notifyLedgerMaterialRegistered } = await import('@/lib/mcp/ledger-compile');
    notifyLedgerMaterialRegistered(projectPath);
  } catch {
    /* 登记失败不影响索引结果 */
  }
}

/** 材料删除 → 回收账本 raw 登记（与 registerMaterialToLedger 对称：manifest 的 key 是
 *  **materials 相对**路径，账本出处是**项目相对**路径）。失败静默：账本不可用不影响删除主流程。
 *  @returns 回收的 raw 条数 */
async function recycleMaterialFromLedger(projectPath: string, relPath: string, isDir: boolean): Promise<number> {
  try {
    const { recycleLedgerMaterial } = await import('@/lib/mcp/ledger');
    return recycleLedgerMaterial(projectPath, `${MATERIALS_DIR_NAME}/${relPath}`, isDir);
  } catch {
    /* 账本回收失败不影响索引清理 */
    return 0;
  }
}

/** 材料改名/移动 → 改写账本里记录的出处路径（raw 登记与已编译 wiki 的 source/正文路径）。
 *  失败静默：账本不可用不影响改名主流程。
 *  @returns 改写的账本条目数（raw + wiki） */
async function renameMaterialInLedger(projectPath: string, relPath: string, newRelPath: string): Promise<number> {
  try {
    const { renameLedgerMaterial } = await import('@/lib/mcp/ledger');
    return renameLedgerMaterial(projectPath, `${MATERIALS_DIR_NAME}/${relPath}`, `${MATERIALS_DIR_NAME}/${newRelPath}`);
  } catch {
    /* 账本改写失败不影响索引迁移 */
    return 0;
  }
}

/** 材料增/删/改名后触发账本重编译（防抖攒批 + 单飞 + 分批，见 lib/mcp/ledger-compile.ts）。
 *  删除与改名过去只回收/改写 raw 就结束了，引用了它的 wiki 全靠事后 lint 才发现 —— lint 没人跑等于没有。
 *  失败静默：账本不可用不影响索引主流程。 */
function notifyLedgerCompile(projectPath: string): void {
  void import('@/lib/mcp/ledger-compile')
    .then(({ notifyLedgerMaterialRegistered }) => notifyLedgerMaterialRegistered(projectPath))
    .catch(() => {});
}

async function doIndexMaterialFile(
  projectPath: string,
  relPath: string,
): Promise<MaterialIndexResult> {
  const fullPath = resolveMaterialPath(projectPath, relPath);
  if (!fullPath) return { indexed: false, reason: 'invalid-path' };
  const ext = path.extname(relPath).toLowerCase();
  if (!isIndexableExt(ext)) return { indexed: false, reason: 'unsupported-type' };

  let st;
  try {
    st = await fs.stat(fullPath);
  } catch {
    return { indexed: false, reason: 'missing' };
  }
  if (!st.isFile()) return { indexed: false, reason: 'not-file' };

  const manifest0 = await readManifest(projectPath);
  const prev = manifest0.entries[relPath];
  if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
    // 账本登记补登：索引已是最新但从未登记过（老项目 / 账本后建 / 上次登记失败）→ 本次补一条 raw。
    // 确定性幂等（同出处已登记直接返回 true），失败静默，不影响索引主流程。
    if (!prev.ledgerAt) await registerMaterialToLedger(projectPath, relPath, prev.pageCount, prev.quality, prev.hash);
    return { indexed: true, reason: 'up-to-date', pageCount: prev.pageCount, quality: prev.quality };
  }

  let hash: string;
  try {
    const { computeFileHash } = await import('@/lib/parse/image-parser');
    hash = await computeFileHash(fullPath);
  } catch {
    return { indexed: false, reason: 'hash-failed' };
  }

  // 内容寻址：同字节已建索引 → 直接复用文本
  let outcome = await readExistingIndex(projectPath, hash);
  if (!outcome) {
    // 同一内容的异步 OCR 刚失败过 → 不自动重提（否则每次打开资料树都重跑一遍），等用户显式重试
    const failed = manifest0.failed?.[relPath];
    if (failed && failed.hash === hash) return { indexed: false, reason: 'ocr-failed' };

    const ctx: ScanQueueContext = { projectPath, relPath, hash, size: st.size, mtime: st.mtimeMs };
    const extracted = await extractByExt(ext, fullPath, ctx);
    // 长扫描件已转交后台异步任务：本次不产出正文，完成后回调写索引并登记账本
    if (extracted === 'queued') return { indexed: false, reason: 'ocr-queued' };
    if (!extracted || extracted.pages.length === 0) return { indexed: false, reason: 'no-text' };
    outcome = extracted;
    await writeIndexFiles(
      projectPath,
      hash,
      outcome.pages,
      outcome.quality,
      relPath,
      outcome.pageMeta,
      outcome.hasScannedPages,
      outcome.pageBlocks,
      outcome.pageCount,
      outcome,
    );
  }

  const { pageCount, quality } = await commitIndexEntry(
    projectPath, relPath, hash, st.size, st.mtimeMs, outcome,
  );
  return { indexed: true, reason: 'indexed', pageCount, quality };
}

/**
 * 把 chat 附件（attachments/ 下的扫描件、图片）的识别结果写入内容索引目录。
 *
 * 与 materials 共用 `.materials-index/<hash>/`：索引按「内容 hash」寻址，与文件放在
 * attachments/ 还是 materials/ 无关，因此同一份字节在两侧天然复用同一份索引、不重复 OCR。
 * 但**不写 manifest**——附件不进 materials 正文检索、搜索结果里仍归「附件」组，
 * 也不挤占 MAX_INDEX_FILES_SCANNED 的检索名额，更不牵连节点删除时的 manifest 清理。
 *
 * 幂等：同 hash 已有索引（materials 或附件先写入者）→ 直接跳过，不用降级结果覆盖已存索引。
 * 失败不影响识别主流程，调用方应自行 catch。
 *
 * @param input.sourcePath 附件在项目内的相对路径，仅作 meta.json.sourcePath 溯源备注
 * @returns 本次是否真正落盘
 */
export async function writeAttachmentIndex(
  projectPath: string,
  input: {
    hash: string;
    sourcePath: string;
    /** MCP 逐页结果（含页级标注 / 行级骨架） */
    pages?: OcrIndexPage[];
    /** 整份文本（无结构化页时的兜底，如 GLM-OCR 整份解析） */
    fullText?: string;
    /** 识别引擎回传的文档真实页数（整份解析时 pages 为空但页数有效） */
    pageCount?: number;
  },
): Promise<boolean> {
  if (!input.hash) return false;
  if (await readExistingIndex(projectPath, input.hash)) return false;
  const outcome = buildVisionOutcome(input.pages, input.fullText, input.pageCount);
  if (!outcome || outcome.pages.length === 0) return false;
  await writeIndexFiles(
    projectPath,
    input.hash,
    outcome.pages,
    outcome.quality,
    input.sourcePath,
    outcome.pageMeta,
    outcome.hasScannedPages,
    outcome.pageBlocks,
    outcome.pageCount,
  );
  return true;
}

/** 读取已索引材料的全文与逐页文本；未索引/索引缺失 → null */
export async function getIndexedMaterial(
  projectPath: string,
  relPath: string,
): Promise<IndexedMaterial | null> {
  const manifest = await readManifest(projectPath);
  const entry = manifest.entries[relPath];
  if (!entry) return null;

  // 陈旧校验：应用外改动（覆盖/编辑/替换）后磁盘 size/mtime 与 manifest 不符 →
  // 返回 null 让调用方重建索引，避免 read_attachment 拿到过期正文与过期 L0 标注。
  const fullPath = resolveMaterialPath(projectPath, relPath);
  if (!fullPath) return null;
  try {
    const st = await fs.stat(fullPath);
    if (st.size !== entry.size || st.mtimeMs !== entry.mtime) return null;
  } catch {
    return null;
  }

  const dir = path.join(getIndexDir(projectPath), entry.hash);
  let fullText: string;
  try {
    fullText = await fs.readFile(path.join(dir, 'full.txt'), 'utf-8');
  } catch {
    return null;
  }
  const meta = await readStoredMeta(dir);
  return {
    relPath,
    hash: entry.hash,
    quality: entry.quality,
    pageCount: entry.pageCount,
    // 落盘文本分块数 < 文档页数 → 上游只回整份文本、无分页结构（读取方据此说明，避免误判截断）
    textPageCount: meta?.textPageCount ?? entry.pageCount,
    fullText,
    pages: splitPages(fullText, entry.pageCount),
    pageMeta: meta?.pageMeta ?? [],
    hasScannedPages: meta?.hasScannedPages ?? false,
    size: entry.size,
    mtime: entry.mtime,
  };
}

/**
 * 按内容 hash 读取索引中由 OCR 产生的逐页结果（供 PDF 预览复用「已识别」状态与命中高亮，
 * 免去对同一扫描件二次 OCR）。
 *
 * 内容寻址：索引目录就是 <项目>/.materials-index/<内容hash>/，所以读取方只需知道
 * 「哪个项目 + 文件内容 hash」，**不必**再按 materials/attachments 目录名反推项目根；
 * 同一字节的 PDF 必然命中同一索引目录。
 *
 * 原生文本层材料（quality='text'）自带文本层 → null；扫描件（quality='vision'）
 * 即使未落行级骨架（上游 OCR 只回聚合文本）也返回逐页文本，否则「已解析」的扫描件
 * 会被预览端判为未识别、反复提示重新解析（高亮降级为页级）。
 */
export async function getIndexedOcrPagesByHash(
  projectPath: string,
  hash: string,
): Promise<MaterialOcrPage[] | null> {
  const dir = path.join(getIndexDir(projectPath), hash);
  const meta = await readStoredMeta(dir);
  if (!meta || meta.quality !== 'vision') return null;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= meta.textPageCount; i++) {
      pages.push(await fs.readFile(path.join(dir, 'pages', pageFileName(i)), 'utf-8'));
    }
    const blocks = await readStoredBlocks(dir);
    return pages.map((text, i) => {
      const pageBlocks = blocks?.[String(i + 1)];
      return pageBlocks && pageBlocks.length > 0
        ? { page: i + 1, text, blocks: pageBlocks }
        : { page: i + 1, text };
    });
  } catch {
    return null;
  }
}

/**
 * 读取索引 manifest，返回「已建索引」的 materials 相对路径列表。
 * 供上传后前端轮询「解析中 → 已索引」状态（只读 manifest，不触发任何抽取/OCR，零开销）。
 */
export async function listIndexedPaths(projectPath: string): Promise<string[]> {
  const manifest = await readManifest(projectPath);
  return Object.keys(manifest.entries);
}

export interface MaterialIndexStatus {
  /** 已建索引（可检索）的 materials 相对路径 */
  indexed: string[];
  /** 后台识别进行中 */
  pending: string[];
  /** 后台识别失败：materials 相对路径 → 失败原因 */
  failed: Record<string, string>;
}

/**
 * 校正 manifest 顶层的 pending/failed（只读入口调用，仅在确有变化时落盘）：
 *   ① 已建索引 / 文件已消失 / 文件被改动过的登记 → 清掉（早已失效，留着只会误导界面）；
 *   ② 陈旧 pending（进程内已无对应任务且超过 PENDING_STALE_MS）→ 落 failed，
 *      否则应用重启后这批文件会永远停在「识别中」，用户看不到失败也点不到重试。
 */
async function reconcileMaterialIndexStatus(projectPath: string): Promise<void> {
  const { hasRunningOcrTask } = await import('@/lib/parse/ocr-task-manager');
  await serialize(manifestLockKey(projectPath), async () => {
    const manifest = await readManifest(projectPath);
    let changed = false;
    const stores: Array<Record<string, MaterialOcrMarker> | undefined> = [
      manifest.pending,
      manifest.failed,
    ];
    for (const store of stores) {
      if (!store) continue;
      for (const key of Object.keys(store)) {
        const e = store[key];
        const full = resolveMaterialPath(projectPath, key);
        let stale = !full;
        if (full) {
          try {
            const st = await fs.stat(full);
            stale = st.size !== e.size || st.mtimeMs !== e.mtime;
          } catch {
            stale = true;
          }
        }
        if (!stale && manifest.entries[key]?.hash === e.hash) stale = true;
        if (stale) {
          delete store[key];
          changed = true;
        }
      }
    }
    if (manifest.pending) {
      for (const [key, e] of Object.entries(manifest.pending)) {
        if (hasRunningOcrTask(e.hash)) continue;
        if (Date.now() - Date.parse(e.startedAt) < PENDING_STALE_MS) continue;
        delete manifest.pending[key];
        manifest.failed = manifest.failed ?? {};
        manifest.failed[key] = {
          hash: e.hash,
          size: e.size,
          mtime: e.mtime,
          failedAt: new Date().toISOString(),
          error: 'Interrupted (app restarted or task lost)',
        };
        changed = true;
      }
    }
    if (changed) await writeManifest(projectPath, manifest);
  });
}

/** 索引状态（前端轮询用）：已索引 + 进行中 + 失败三态，只读 manifest、零抽取开销 */
export async function listMaterialIndexStatus(projectPath: string): Promise<MaterialIndexStatus> {
  await reconcileMaterialIndexStatus(projectPath).catch(() => {});
  const manifest = await readManifest(projectPath);
  return {
    indexed: Object.keys(manifest.entries),
    pending: Object.keys(manifest.pending ?? {}),
    failed: Object.fromEntries(
      Object.entries(manifest.failed ?? {}).map(([k, v]) => [k, v.error ?? 'OCR failed']),
    ),
  };
}

/**
 * 显式重试某材料的索引：先清掉该路径的 failed/pending 登记（解除「不自动重提」的封印），
 * 再重新走一遍索引流程（长扫描件会再次转交后台任务）。供前端失败态的 Retry 入口调用。
 */
export async function retryMaterialIndex(
  projectPath: string,
  relPath: string,
): Promise<MaterialIndexResult> {
  await serialize(manifestLockKey(projectPath), async () => {
    const manifest = await readManifest(projectPath);
    let changed = false;
    if (manifest.failed?.[relPath]) {
      delete manifest.failed[relPath];
      changed = true;
    }
    if (manifest.pending?.[relPath]) {
      delete manifest.pending[relPath];
      changed = true;
    }
    if (changed) await writeManifest(projectPath, manifest);
  });
  return indexMaterialFile(projectPath, relPath);
}

/** 材料清单条目（manifest 只读投影，供 agent「先知道有哪些资料」） */
export interface MaterialInventoryItem {
  /** 项目相对路径（materials/…） */
  relPath: string;
  name: string;
  /** 文档真实页数 */
  pageCount: number;
  /** text=文字层可用 / vision=走视觉识别（扫描件） */
  quality: MaterialIndexQuality;
  size: number;
  mtime: number;
  indexedAt: string;
}

/**
 * 材料清单：列出已建索引的材料及其页数/索引质量（只读 manifest，零开销、不触发抽取）。
 * 供 agent 在检索正文前先知道"这个项目里有哪些材料"，避免只能按文件名猜。
 * 仅含已建索引的文件——不支持索引的类型需自行 list_directory materials/ 查看。
 */
export async function listMaterialsInventory(projectPath: string): Promise<MaterialInventoryItem[]> {
  const manifest = await readManifest(projectPath);
  return Object.entries(manifest.entries)
    .map(([relPath, e]) => ({
      relPath,
      name: path.basename(relPath),
      pageCount: e.pageCount,
      quality: e.quality,
      size: e.size,
      mtime: e.mtime,
      indexedAt: e.indexedAt,
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh'));
}

/** 读取已索引材料的单页文本（1-based）；未命中 → null */
export async function getIndexedPage(
  projectPath: string,
  relPath: string,
  page: number,
): Promise<string | null> {
  const manifest = await readManifest(projectPath);
  const entry = manifest.entries[relPath];
  if (!entry) return null;
  try {
    return await fs.readFile(
      path.join(getIndexDir(projectPath), entry.hash, 'pages', pageFileName(page)),
      'utf-8',
    );
  } catch {
    return null;
  }
}

function makeSnippet(text: string, index: number, keywordLen: number, radius = 80): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + keywordLen + radius);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/**
 * 内容检索：在已索引材料正文中查找关键词，返回带页码与上下文的命中。
 * 同一文件多页命中时每页各计一条；文件按最近上传优先。
 */
export async function searchMaterialsIndex(
  projectPath: string,
  keyword: string,
  maxResults: number,
): Promise<MaterialIndexHit[]> {
  const kw = (keyword ?? '').trim();
  if (!kw || maxResults <= 0) return [];
  const lower = kw.toLowerCase();

  const manifest = await readManifest(projectPath);
  const relPaths = Object.keys(manifest.entries).sort(
    (a, b) => (manifest.entries[b].mtime ?? 0) - (manifest.entries[a].mtime ?? 0),
  );

  const hits: MaterialIndexHit[] = [];
  let scanned = 0;
  for (const relPath of relPaths) {
    if (hits.length >= maxResults || scanned >= MAX_INDEX_FILES_SCANNED) break;
    scanned++;
    const entry = manifest.entries[relPath];
    let fullText: string;
    try {
      fullText = await fs.readFile(
        path.join(getIndexDir(projectPath), entry.hash, 'full.txt'),
        'utf-8',
      );
    } catch {
      continue;
    }
    const pages = splitPages(fullText, entry.pageCount);
    for (let i = 0; i < pages.length; i++) {
      if (hits.length >= maxResults) break;
      const idx = pages[i].toLowerCase().indexOf(lower);
      if (idx < 0) continue;
      hits.push({
        relPath,
        name: path.basename(relPath),
        page: i + 1,
        pageCount: pages.length,
        snippet: makeSnippet(pages[i], idx, kw.length),
        size: entry.size,
        mtime: entry.mtime,
      });
    }
  }
  return hits;
}

/**
 * 删除/移动材料时回收索引：移除 manifest 条目（目录则整棵子树）并清理不再被引用的 hash 目录；
 * 同步回收账本 raw 登记（材料离开项目 → 账本不再登记它）。
 */
export async function removeMaterialsIndex(
  projectPath: string,
  relPath: string,
  isDir: boolean,
): Promise<void> {
  await serialize(`materials-manifest:${path.resolve(projectPath)}`, async () => {
    const manifest = await readManifest(projectPath);
    const prefix = relPath + '/';
    const doomed = Object.entries(manifest.entries).filter(
      ([k]) => k === relPath || (isDir && k.startsWith(prefix)),
    );
    // pending / failed 是同一批材料的另一面（识别中 / 识别失败），删除时一并清掉，否则界面留残影
    let markersChanged = false;
    for (const store of [manifest.pending, manifest.failed]) {
      if (!store) continue;
      for (const k of Object.keys(store)) {
        if (k === relPath || (isDir && k.startsWith(prefix))) {
          delete store[k];
          markersChanged = true;
        }
      }
    }
    if (doomed.length === 0) {
      if (markersChanged) await writeManifest(projectPath, manifest);
      return;
    }
    for (const [k] of doomed) delete manifest.entries[k];
    await writeManifest(projectPath, manifest);

    const live = new Set(Object.values(manifest.entries).map((e) => e.hash));
    const candidates = new Set(doomed.map(([, e]) => e.hash));
    for (const h of candidates) {
      if (live.has(h)) continue;
      await fs
        .rm(path.join(getIndexDir(projectPath), h), { recursive: true, force: true })
        .catch(() => {});
    }
  });
  // 账本回收放在 manifest 之外：即使该材料无索引条目（未索引/未登记），也按出处路径确定性回收
  const recycled = await recycleMaterialFromLedger(projectPath, relPath, isDir);
  // raw 被回收 → 引用了它的 wiki 条目成了断链，需要档案员复核；重编译一次把积压/受影响面收敛
  if (recycled > 0) notifyLedgerCompile(projectPath);
}

/**
 * 重命名/移动材料后迁移 manifest 条目（relPath → newRelPath；目录按前缀整棵子树迁移），
 * 并同步改写账本里记录的出处路径（raw 登记与已编译 wiki；条目 id 不变，wiki 的 raw 引用不受影响）。
 *
 * 索引按内容 hash 寻址，hash 目录无需搬迁，只需改写键路径，重命名后的文件仍可命中既有正文；
 * 无 manifest 或路径未命中时静默返回（材料可能尚未索引）。
 */
export async function renameMaterialsIndex(
  projectPath: string,
  relPath: string,
  newRelPath: string,
): Promise<void> {
  if (!relPath || !newRelPath || relPath === newRelPath) return;
  await serialize(`materials-manifest:${path.resolve(projectPath)}`, async () => {
    const manifest = await readManifest(projectPath);
    const prefix = relPath + '/';
    // 三张表（entries / pending / failed）都要迁：识别中的材料可能还没有 entries 条目
    const stores: Array<Record<string, unknown> | undefined> = [
      manifest.entries,
      manifest.pending,
      manifest.failed,
    ];
    const moves: Array<[string, string]> = [];
    for (const store of stores) {
      if (!store) continue;
      for (const key of Object.keys(store)) {
        const to = key === relPath
          ? newRelPath
          : key.startsWith(prefix) ? `${newRelPath}/${key.slice(prefix.length)}` : null;
        if (to && !moves.some(([from]) => from === key)) moves.push([key, to]);
      }
    }
    if (moves.length === 0) return;
    for (const store of stores) {
      if (!store) continue;
      for (const [from, to] of moves) {
        if (!(from in store)) continue;
        store[to] = store[from];
        delete store[from];
      }
    }
    await writeManifest(projectPath, manifest);
  });
  const touched = await renameMaterialInLedger(projectPath, relPath, newRelPath);
  // 出处路径变了 → 引用它的 wiki 需要复核/重编（与删除同理：不能只靠事后 lint）
  if (touched > 0) notifyLedgerCompile(projectPath);
}

/**
 * 回收「因附件删除而失去引用」的内容索引目录。
 *
 * 附件不写 manifest，`removeMaterialsIndex` 看不到它们贡献的 hash 目录，节点删除后会永久残留。
 * 由**删除附件目录的调用方**配对使用：rm 之前先算出待删文件的候选 hash，rm 之后再调用本函数，
 * 只做存活校验与回收：
 *   ① 仍被 materials manifest 引用 → 保留；
 *   ② 剩余 attachments/ 下仍存在同内容文件（别的节点引用了同一份字节）→ 保留；
 *   ③ 其余 → 删除索引目录。
 *
 * 之所以只收候选而非全盘扫描 `.materials-index/`：索引目录也可能由 /api/ocr 等以「项目外绝对路径」
 * 写入，全盘扫 attachments/ 覆盖不到、会误删；只回收本次确定删除的附件内容最安全。
 * 保守优先：任一存活判断命中即保留（宁可多留，不可误删）。
 *
 * @param candidateHashes 待删附件文件的内容 hash（rm 之前算好）
 * @returns 实际删除的 hash 列表（供调用方日志）
 */
export async function pruneAttachmentIndexes(
  projectPath: string,
  candidateHashes: string[],
): Promise<string[]> {
  const candidates = new Set(candidateHashes.filter((h) => typeof h === 'string' && h));
  if (candidates.size === 0) return [];
  // ① materials manifest 仍引用 → 保留
  const manifest = await readManifest(projectPath);
  for (const e of Object.values(manifest.entries)) candidates.delete(e.hash);
  // ② 剩余 attachments/ 下仍有同内容文件 → 保留（内容寻址：同字节不分路径）
  if (candidates.size > 0) {
    await dropLiveHashes(path.join(projectPath, ATTACHMENTS_DIR_NAME), candidates);
  }
  const removed: string[] = [];
  for (const h of candidates) {
    await fs
      .rm(path.join(getIndexDir(projectPath), h), { recursive: true, force: true })
      .catch(() => {});
    removed.push(h);
  }
  return removed;
}

/** 递归遍历 dir 下的「可索引文件」，逐个交给 fn（读目录/读文件失败均忽略，不中断整体） */
async function forEachIndexableFile(
  dir: string,
  fn: (fullPath: string) => Promise<void> | void,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await forEachIndexableFile(full, fn);
      continue;
    }
    if (!ent.isFile() || !isIndexableExt(path.extname(ent.name))) continue;
    await fn(full);
  }
}

/**
 * 递归收集 dir 下可索引文件的内容 hash。
 * 供附件目录删除**之前**登记候选（配合 `pruneAttachmentIndexes` 回收其独享索引）。
 */
export async function collectDirContentHashes(dir: string): Promise<string[]> {
  const { computeFileHash } = await import('@/lib/parse/image-parser');
  const out: string[] = [];
  await forEachIndexableFile(dir, async (full) => {
    try {
      out.push(await computeFileHash(full));
    } catch { /* 读取失败 → 跳过 */ }
  });
  return out;
}

/** 把磁盘上仍存在的可用文件的 hash 从 pending 中移除（命中即视为该内容仍存活） */
async function dropLiveHashes(dir: string, pending: Set<string>): Promise<void> {
  if (pending.size === 0) return;
  const { computeFileHash } = await import('@/lib/parse/image-parser');
  await forEachIndexableFile(dir, async (full) => {
    if (pending.size === 0) return;
    try {
      pending.delete(await computeFileHash(full));
    } catch { /* 读取失败 → 视为不存在 */ }
  });
}
