/**
 * OCR 派生文件二级索引（修复方案 1a）
 *
 * 背景：主缓存以「文件字节 SHA256」为键。从同一源文档再渲染出的派生件
 * （如 agent 用脚本把 328 页母档切成 p51-p100 片段）字节必变 → 主键必失配，
 * 导致明明整份 OCR 结果就在缓存里、却被迫对每个片段重新跑一遍昂贵的 MCP OCR。
 *
 * 原理：物理字节不可靠，改用「语义指纹」。任何一次全量 OCR 成功后，对每个页面的
 * 文本做【去空白字符流 + 定长滑窗】指纹登记 → {来源记录hash, 页号}。
 * 去空白使指纹对再渲染造成的换行/缩进漂移免疫；定长窗口使长文档可分片比对。
 * 之后读取一个陌生的衍生 PDF 时（主缓存 MISS），用本地已提取的文字层做同样采样反查；
 * 命中即说明该文件是某份已有全量 OCR 记录的同源派生件，直接复用其全文切片免二次 OCR。
 *
 * 局限（诚实记录）：文字层完全提取不出真实正文的纯扫描衍生件，首次读取物理上
 * 无信息可匹配，只能正常走一次 OCR；结果入主缓存后同字节文件永久免费复用。
 *
 * 存储：{projectPath}/.cache/parse/derive/index.json（随 .cache 归档清理策略一起覆盖）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CACHE_DIR_NAME = '.cache';
const PARSE_CACHE_DIR_NAME = 'parse';
const DERIVE_DIR_NAME = 'derive';
const INDEX_FILE_NAME = 'index.json';
const INDEX_VERSION = 2;

/** 指纹表容量上限，超限丢弃最早插入的一半 */
const FINGERPRINT_MAX_KEYS = 300_000;
/** 登记侧滑窗步进（远小于窗长 → 派生件内任意连续 32 字段均可被覆盖） */
const SHINGLE_STEP_REG = 4;
/** 登记时单页最多采样的窗口数（超长页均匀稀疏化） */
const REGISTER_WINDOWS_PER_PAGE = 320;
/** 探测时单页最多采样的窗口数（近稠密，超长页均匀稀疏化） */
const PROBE_WINDOWS_PER_PAGE = 2048;
/** 探测页参与计票的最少窗口数（过短视为噪声页） */
const PROBE_MIN_PAGE_WINDOWS = 6;
/** 高频样板过滤：同一指纹在索引中出现的页面引用超过该值则视为页眉/页脚类样文 */
const BOILERPLATE_REF_LIMIT = 24;
/** 判定同源的最低门槛：独立命中页数 */
const MIN_MATCHED_PAGES = 3;
/** 判定同源的最低门槛：总窗口命中率 */
const MATCH_RATIO_THRESHOLD = 0.06;

export interface OcrPageLike {
  index: number;
  text: string;
}

interface PageRef {
  /** 来源 parse-cache 记录 hash（完整 sha256） */
  h: string;
  /** 该窗口来自源文档的第几页（1 起） */
  p: number;
}

export interface DeriveLink {
  parent: string;
  start: number;
  end: number;
  linked_at: string;
}

interface DeriveIndexFile {
  v: number;
  updated_at: string;
  fingerprints: Record<string, PageRef[]>;
  links: Record<string, DeriveLink>;
}

const emptyIndex = (): DeriveIndexFile => ({ v: INDEX_VERSION, updated_at: '', fingerprints: {}, links: {} });

function getDeriveIndexPath(projectPath: string): string {
  return path.join(projectPath, CACHE_DIR_NAME, PARSE_CACHE_DIR_NAME, DERIVE_DIR_NAME, INDEX_FILE_NAME);
}

async function loadIndex(projectPath: string): Promise<DeriveIndexFile> {
  try {
    const raw = await fs.readFile(getDeriveIndexPath(projectPath), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DeriveIndexFile>;
    if (!parsed || typeof parsed !== 'object') return emptyIndex();
    return {
      v: INDEX_VERSION,
      updated_at: parsed.updated_at ?? '',
      fingerprints: typeof parsed.fingerprints === 'object' && parsed.fingerprints ? parsed.fingerprints : {},
      links: typeof parsed.links === 'object' && parsed.links ? parsed.links : {},
    };
  } catch {
    return emptyIndex();
  }
}

async function saveIndex(projectPath: string, index: DeriveIndexFile): Promise<void> {
  const filePath = getDeriveIndexPath(projectPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  index.updated_at = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(index), 'utf-8');
}

/* ------------------------------ 纯函数（便于离线校验） ------------------------------ */

/** 窗口长度。配合远小于窗长的步进实现位置无关集合匹配。 */
const WINDOW_LEN = 32;

/**
 * 内容签名流：小写、剔除全部非字母/数字/汉字字符（含所有空白、标点、[Page N] 标记）。
 * 由此衍生文件的换行、缩进、空格漂移不再影响比对。
 */
export function signatureStream(text: string | null | undefined): string {
  if (!text) return '';
  return text.toLowerCase().replace(/\[page\s*\d+\]/g, '').replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/**
 * 从单页文本取内容滑窗集合（位置无关匹配的原子单元）。
 * 步进远小于窗长：只要派生件与源页共享任意一段连续 ≥WINDOW_LEN 的归一化字符，
 * 该段必然同时出现在两侧窗口集合中——不依赖任何绝对偏移对齐。
 * 超长页按均匀跨度稀疏化采样（保证首尾覆盖），total ≤ cap。
 */
export function pageWindows(text: string | null | undefined, cap: number, step: number): string[] {
  const s = signatureStream(text);
  if (!s) return [];
  if (s.length <= WINDOW_LEN) return [s];
  const span = s.length - WINDOW_LEN + 1;
  const stride = Math.max(step, Math.ceil(span / Math.max(1, cap)));
  const out: string[] = [];
  for (let i = 0; i < span; i += stride) out.push(s.slice(i, i + WINDOW_LEN));
  const lastIdx = span - 1;
  if ((lastIdx % stride) !== 0) out.push(s.slice(lastIdx, lastIdx + WINDOW_LEN));
  return out;
}

/** 窗口指纹（16 位 hex；30 万条规模碰撞概率 ~1e-13） */
export function windowFingerprint(w: string): string {
  return createHash('sha256').update(w, 'utf-8').digest('hex').slice(0, 16);
}

/* ---------------------------------- 公共 API ---------------------------------- */

/** 全量 OCR 成功后按页登记内容滑窗指纹（注意：分页/片段识别请勿调用，见 tools.ts 注释） */
export async function registerOcrPages(
  projectPath: string,
  recordHash: string,
  pages: OcrPageLike[],
): Promise<void> {
  if (!recordHash || !pages?.length) return;
  try {
    const index = await loadIndex(projectPath);
    let dirty = false;
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      if (!pg || typeof pg.index !== 'number') continue;
      for (const w of new Set(pageWindows(pg?.text ?? '', REGISTER_WINDOWS_PER_PAGE, SHINGLE_STEP_REG))) {
        const fp = windowFingerprint(w);
        const refs = index.fingerprints[fp];
        if (refs && refs.some((r) => r.h === recordHash && r.p === pg.index)) continue;
        if (refs) refs.push({ h: recordHash, p: pg.index });
        else index.fingerprints[fp] = [{ h: recordHash, p: pg.index }];
        dirty = true;
      }
    }
    // 容量守护：超限裁剪一半
    const keys = Object.keys(index.fingerprints);
    if (keys.length > FINGERPRINT_MAX_KEYS) {
      const drop = keys.slice(0, keys.length - Math.floor(FINGERPRINT_MAX_KEYS / 2));
      for (const k of drop) delete index.fingerprints[k];
      dirty = true;
    }
    if (dirty) await saveIndex(projectPath, index);
  } catch (e) {
    // 索引登记失败不影响 OCR 主流程，但需告警暴露（历史教训：EPERM 曾被静默吞掉）
    console.warn(`[derive-index] 登记指纹失败 project=${projectPath} hash=${recordHash.slice(0, 10)}…`, e);
  }
}

export interface SourceProbeHit {
  /** 同源的全量 OCR 记录 hash（可作为普通 getCache 键使用） */
  parent: string;
  /** 匹配命中的父文档页区间 */
  start: number;
  end: number;
  /** 采样窗口命中率 0~1 */
  ratio: number;
  matchedWindows: number;
}

/**
 * 探测：给定候选文本，判断其是否为某份已登记全量 OCR 文档的同源派生件。
 *
 * 每个候选项可为整篇纯文本（无分页信息时按单一伪页处理）或页数组。
 * 匹配采用【位置无关的 shingle 集合包含度】：对每页文本枚举去空白滑窗，
 * 统计在索引中命中的窗口数。任何绝对偏移漂移（水印注入、页序变化、
 * 页边界重组）都不影响结果；仅当窗内字符本身发生逐字变动（如二次 OCR 形近字）
 * 才会失配。索引中出现过于频繁的样板指纹（页眉/页脚类）自动跳过，
 * 防止重复样文把无关文档投给所有源。
 *
 * 命中门槛：独立命中源页 ≥3 且 总窗口命中率 ≥6%；多个候选取质量最好者。
 */
export async function findSourceByFingerprints(
  projectPath: string,
  ...candidates: Array<string | OcrPageLike[] | null | undefined>
): Promise<SourceProbeHit | null> {
  try {
    const index = await loadIndex(projectPath);
    let best: SourceProbeHit | null = null;
    let bestScore = 0;
    for (const cand of candidates) {
      const pages: OcrPageLike[] =
        typeof cand === 'string'
          ? [{ index: 1, text: cand }]
          : Array.isArray(cand)
            ? cand.filter((p): p is OcrPageLike => !!p && typeof p.index === 'number' && typeof p.text === 'string')
            : [];
      const hit = probePages(index, pages);
      if (!hit) continue;
      // 打分：独立命中源页为主、命中率为辅
      const distinct = Math.max(hit.end - hit.start + 1, 1);
      const score = distinct * 1000 + hit.ratio * 100 + Math.min(hit.matchedWindows, 999);
      if (score > bestScore) { bestScore = score; best = hit; }
    }
    return best;
  } catch (e) {
    console.warn(`[derive-index] 反查指纹失败 project=${projectPath}`, e);
    return null;
  }
}

interface SourceVoteRec {
  pages: Map<number, number>;
  total: number;
}

function probePages(index: DeriveIndexFile, pages: OcrPageLike[]): SourceProbeHit | null {
  let totalProbe = 0;
  let totalMatch = 0;
  const bySource = new Map<string, SourceVoteRec>();
  for (const pg of pages) {
    const ws = [...new Set(pageWindows(pg.text, PROBE_WINDOWS_PER_PAGE, 1))];
    if (ws.length < PROBE_MIN_PAGE_WINDOWS) continue;
    totalProbe += ws.length;
    const local = new Map<string, Map<number, number>>();
    for (const w of ws) {
      const refs = index.fingerprints[windowFingerprint(w)];
      if (!refs?.length || refs.length > BOILERPLATE_REF_LIMIT) continue;
      totalMatch++;
      for (const r of refs) {
        let pm = local.get(r.h);
        if (!pm) { pm = new Map<number, number>(); local.set(r.h, pm); }
        pm.set(r.p, (pm.get(r.p) ?? 0) + 1);
      }
    }
    for (const [h, pm] of local) {
      let rec = bySource.get(h);
      if (!rec) { rec = { pages: new Map<number, number>(), total: 0 }; bySource.set(h, rec); }
      for (const [p, c] of pm) {
        rec.pages.set(p, (rec.pages.get(p) ?? 0) + c);
        rec.total += c;
      }
    }
  }
  if (totalProbe === 0 || totalMatch === 0) return null;
  const ratio = totalMatch / totalProbe;
  if (ratio < MATCH_RATIO_THRESHOLD) return null;

  // 取命中最多的源；并列时取独立命中页更多者
  let bestH = '';
  let bestTotal = 0;
  let bestPages = new Map<number, number>();
  for (const [h, rec] of bySource) {
    if (rec.total > bestTotal || (rec.total === bestTotal && bestH && rec.pages.size > bestPages.size)) {
      bestH = h;
      bestTotal = rec.total;
      bestPages = rec.pages;
    }
  }
  if (!bestH || bestPages.size < MIN_MATCHED_PAGES) return null;

  const pageNumbers = [...bestPages.keys()].sort((a, b) => a - b);
  return {
    parent: bestH,
    start: pageNumbers[0],
    end: pageNumbers[pageNumbers.length - 1],
    ratio,
    matchedWindows: bestTotal,
  };
}

/** 登记学习到的溯源链接：childHash 是 parent 某片段的派生件 */
export async function linkDerivedToFile(
  projectPath: string,
  childHash: string,
  parentHash: string,
  start: number,
  end: number,
): Promise<void> {
  if (!childHash || !parentHash) return;
  try {
    const index = await loadIndex(projectPath);
    const prev = index.links[childHash];
    if (prev && prev.parent === parentHash && prev.start === start && prev.end === end) return;
    index.links[childHash] = { parent: parentHash, start, end, linked_at: new Date().toISOString() };
    const keys = Object.keys(index.links);
    if (keys.length > 500) {
      for (const k of keys.slice(0, 100)) delete index.links[k];
    }
    await saveIndex(projectPath, index);
  } catch (e) {
    console.warn(`[derive-index] 写入溯源链接失败 child=${childHash.slice(0, 10)}… parent=${parentHash.slice(0, 10)}…`, e);
  }
}
