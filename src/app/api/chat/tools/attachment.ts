/**
 * 附件读取场景工具：read_attachment（附件全文解析）+ read_material（项目参考资料读取）。
 * 从 tools/index.ts 抽出，导入路径保持不变（index.ts 通过 ...attachmentToolDefs 聚合）。
 * 依赖方向单向：./shared（formatSize / auditLog / isReadablePath / READ_CAPACITY / OCR_MAX_LENGTH / truncate）+
 * 仅以 import type 依赖 index.ts 的类型。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, stat, mkdir } from 'fs/promises';
import { join, resolve, isAbsolute, sep, extname, basename, dirname } from 'path';
import { homedir } from 'os';
import { formatSize, auditLog, isReadablePath, READ_CAPACITY, OCR_MAX_LENGTH, truncate } from './shared';
import type { Tool, ToolExecContext } from './index';

const execFileAsync = promisify(execFile);

/** 附件/文档文本的通用分片返回：从 offset 处截取单次上限，头部标注实际区间；发生截断时给出续读 offset。
 *  读取类工具的内层上限按 1M 模型设定，外层仍会按模型上下文二次截断——
 *  因此只要触发截断就提示模型携带 offset 续读，避免长文档后半内容拿不到。 */
function chunkedAttachmentReturn(
  path: string,
  size: number,
  typeLabel: string,
  fullText: string,
  offset: number,
  cap = READ_CAPACITY,
): string {
  const total = fullText.length;
  if (total === 0) return `Attachment: ${path} (${formatSize(size)}, ${typeLabel}, empty)\n\n(文件内容为空)`;
  const start = Math.max(0, Math.min(offset, total));
  const end = Math.min(total, start + cap);
  const part = fullText.slice(start, end);
  const header = `Attachment: ${path} (${formatSize(size)}, ${typeLabel}, chars ${start}-${end} of ${total})`;
  if (end >= total) return `${header}\n\n${part}`;
  return `${header}\n\n${part}\n\n...(本段 ${part.length} 字符，共 ${total} 字符；继续读取后半部分请再次调用本工具并携带 offset="${end}")`;
}

/** mammoth 无内置 TS 类型：仅声明 read_attachment 用到的 convertToHtml */
interface MammothLike {
  convertToHtml: (
    input: { path?: string; buffer?: Buffer },
    options?: Record<string, unknown>,
  ) => Promise<{ value: string; messages: unknown[] }>;
}

/** 把「已用 \n（段落/行尾）与 \u0001（单元格分隔）标记过的 XML/HTML」收敛成紧凑文本行 */
function collapseMarkedLines(marked: string): string {
  const s = marked
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
  const lines: string[] = [];
  for (const raw of s.split('\n')) {
    const cells = raw.split('\u0001').map((c) => c.replace(/\s+/g, ' ').trim());
    // 去掉行尾空列与行首空列标记，避免悬挂分隔符
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    const line = cells.join(' | ').replace(/^\s*\|\s*/, '').trim();
    if (line.length > 0) lines.push(line);
  }
  return lines.join('\n');
}

/** docx → 结构化文本：mammoth HTML（保留段落/标题/有序列表编号/表格行列）→ 紧凑文本 */
function docxHtmlToText(html: string): string {
  let s = html;
  // 有序列表编号（支持 start 属性），避免列表退化为无编号的 "- "
  s = s.replace(/<ol([^>]*)>([\s\S]*?)<\/ol>/gi, (_m, attrs: string, inner: string) => {
    const start = Number((/start="(\d+)"/i.exec(String(attrs)) ?? [])[1] ?? 1);
    let n = start;
    const numbered = inner.replace(/<li([^>]*)>([\s\S]*?)<\/li>/gi, (_lm, _la: string, body: string) => `${n++}. ${body}`);
    return `\n${numbered}`;
  });
  s = s.replace(/<table[^>]*>/gi, '\n');
  s = s.replace(/<\/table>/gi, '\n');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/td>|<\/th>/gi, '\u0001');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/h([1-6])>/gi, '\n');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/div>/gi, '\n');
  return collapseMarkedLines(s);
}

/** docx 兜底（无 mammoth 时）：直接解 document.xml 做轻量结构提取 */
function docxXmlFallbackText(xml: string): string {
  return collapseMarkedLines(
    xml
      .replace(/<w:tab\/>/g, '\u0001')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:tc>/g, '\u0001')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:p>/g, '\n'),
  );
}

/**
 * 单页密集阈值：页转录字符数超过该值时，视为"接近单页转录上限（max_tokens 8192）"，
 * 页内数据可能被视觉模型静默截断（无应用层截断标记）。此时在页首标注警示。
 */
const OCR_DENSE_PAGE_THRESHOLD = 6000;

/** OCR 页块：index 为 1-based 页码 */
interface OcrPageBlock {
  index: number;
  text: string;
}

/**
 * 解析 read_attachment 的 pages 参数：'1-5'、'3'、'6,8-10' → 页码数组（1-based）。
 * 返回 null 表示"未指定/非法 → 读取全部页"。
 */
function parsePageRange(spec: string | undefined, maxPage: number): number[] | null {
  if (!spec || !spec.trim()) return null;
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null; // 非法格式 → 忽略参数
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let p = a; p <= Math.min(b, maxPage); p++) {
      if (p >= 1 && !out.includes(p)) out.push(p);
    }
  }
  return out.length > 0 ? out.sort((x, y) => x - y) : null;
}

/** 解析 read_attachment 的 frame_range 参数：'0-2'、'1'、'0,2-3' → 帧索引数组（0-based，用于视频帧段分片）。
 *  返回 null 表示"未指定/非法 → 分析全部帧"。 */
function parseFrameRange(spec: string | undefined, maxFrame: number): number[] | null {
  if (!spec || !spec.trim()) return null;
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null; // 非法格式 → 忽略参数
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let p = a; p <= Math.min(b, maxFrame); p++) {
      if (p >= 0 && !out.includes(p)) out.push(p);
    }
  }
  return out.length > 0 ? out.sort((x, y) => x - y) : null;
}

/**
 * 从合并的 OCR 文本中按 [Page N] 块切分为页数组（用于命中缓存的全文重新分页）。
 * 无 [Page N] 标记时返回空数组（调用方原样返回）。
 */
function splitOcrTextToPages(text: string): OcrPageBlock[] {
  const re = /\[Page (\d+)\]\n?/g;
  const pages: OcrPageBlock[] = [];
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  let lastPage = -1;
  while ((m = re.exec(text)) !== null) {
    if (lastPage > 0) {
      pages.push({ index: lastPage, text: text.slice(lastIndex, m.index).trim() });
    }
    lastPage = parseInt(m[1], 10);
    lastIndex = m.index + m[0].length;
  }
  if (lastPage > 0) pages.push({ index: lastPage, text: text.slice(lastIndex).trim() });
  return pages;
}

/**
 * 组装扫描件 OCR 的 read_attachment 返回：
 * 1. 按 pages 参数筛选页（未指定则读全部）；
 * 2. 超过 OCR_MAX_LENGTH 时按页边界截断，并在**头部**标注已返回的页码区间与续读方式
 *    （头部而非尾部：外层 maxOutput 会二次截断，标注放尾部会被切掉）。
 */
function buildOcrAttachmentOutput(
  path: string,
  fileSize: number,
  meta: string,
  pages: OcrPageBlock[],
  opts: { pagesArg?: string; totalPages?: number; rendered?: number },
): string {
  const maxPage = opts.totalPages && opts.totalPages > 0
    ? opts.totalPages
    : Math.max(0, ...pages.map((p) => p.index));
  const wanted = parsePageRange(opts.pagesArg, maxPage);
  const ordered = (wanted ? pages.filter((p) => wanted.includes(p.index)) : pages)
    .slice()
    .sort((a, b) => a.index - b.index);

  let body = '';
  let truncatedAt = -1; // 首个放不下的页号（1-based），其之前的内容已包含
  for (const p of ordered) {
    const pageText = p.text.trim();
    // 单页密集警示：转录字符接近单页上限时，页内数据可能被视觉模型静默截断
    const denseNote = pageText.length > OCR_DENSE_PAGE_THRESHOLD
      ? `⚠ 本页内容密集（约 ${pageText.length} 字符，接近单页转录上限），转录可能不完整，建议分页复核。\n`
      : '';
    const block = `[Page ${p.index}]\n${denseNote}${pageText}`;
    if (body.length + block.length + 2 > OCR_MAX_LENGTH) {
      truncatedAt = p.index;
      break;
    }
    body += (body ? '\n\n' : '') + block;
  }

  const firstShown = ordered.length > 0 ? ordered[0].index : 1;
  const shownCount = truncatedAt > 0 ? Math.max(0, truncatedAt - firstShown) : ordered.length;
  const header = `Attachment: ${path} (${formatSize(fileSize)}, ${meta}, ${shownCount}/${opts.rendered ?? maxPage} pages)`;

  if (truncatedAt > 0) {
    // 续读提示放头部，确保外层 maxOutput 截断后仍可见
    const lastShown = truncatedAt - 1;
    return (
      `${header}\n` +
      `⚠ INCOMPLETE: pages ${firstShown}-${lastShown} of ${maxPage} (truncated)\n` +
      `⚠ 内容已截断：单次读取上限 ${OCR_MAX_LENGTH} 字符，本次返回第 ${firstShown}-${lastShown} 页（共 ${maxPage} 页）。` +
      `如需继续，调用 read_attachment(path="${path}", pages="${truncatedAt}-${maxPage}") 读取剩余页。\n\n${body}`
    );
  }

  return `${header}\n\n${body}`;
}

/** 读取附件内容 */
async function toolReadAttachment(args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string> {
  const path = args.path as string;
  if (!path) return 'Error: path required';
  // 可选：仅扫描件 PDF 生效，按页读取（如 "1-5"、"3"、"6,8-10"），用于长 PDF 分片读取
  const pagesArg = typeof args.pages === 'string' ? args.pages.trim() : undefined;
  // 可选：文本/docx/xls/pptx/doc/rtf 类通用续读偏移——内容超单次上限被截断时，返回头会标注下一次 offset，原样传回即可续读
  const offset = Math.max(0, Math.trunc(Number(args.offset))) || 0;
  // 可选：仅 Excel(.xls/.xlsx) 生效，按 sheet 名过滤（不传=全部 sheet）
  const sheetArg = typeof args.sheet === 'string' ? args.sheet.trim() : undefined;

  try {
    // 附件路径是相对于项目目录的，需要获取当前项目路径
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const project = await getCurrentProject();
    // 防 ../ 穿越：resolve 后必须仍在 project.path 内
    const projectRoot = resolve(project.path);

    // 支持授权目录的绝对路径直通：~ 展开 + 绝对路径 + 相对路径三种形态
    // 1) 绝对路径 / ~ 路径：必须命中用户授权目录（isReadablePath 校验）才放行
    // 2) 相对路径（attachments/...）：基于项目根解析，仍须在项目根内（防穿越）
    let filePath: string;
    if (path === '~') {
      filePath = resolve(homedir());
    } else if (path.startsWith('~/')) {
      filePath = resolve(join(homedir(), path.slice(2)));
    } else if (isAbsolute(path)) {
      filePath = resolve(path);
    } else {
      filePath = resolve(join(projectRoot, path));
    }

    const withinProject =
      filePath === projectRoot || filePath.startsWith(projectRoot + sep);
    if (!withinProject) {
      // 越出项目根：若命中授权目录则放行，否则拒绝
      const authorized = await isReadablePath(filePath);
      if (!authorized) {
        auditLog({ tool: 'read_attachment', blocked: true, reason: 'path-traversal', path, project: projectRoot, resolved: filePath });
        return `Error: 附件路径 "${path}" 越出项目目录且不在授权目录内，拒绝访问。请勿猜测其他个人目录路径（如文稿/下载/桌面/相册）反复尝试；若用户未提供该文件，直接请用户提供路径或将文件放入项目目录。`;
      }
    }
    auditLog({ tool: 'read_attachment', path, project: projectRoot, resolved: filePath });
    const ext = extname(filePath).toLowerCase();

    const textExts = ['.txt', '.md', '.markdown', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.go', '.rs', '.yaml', '.yml', '.ini', '.conf', '.log'];
    const isTextFile = textExts.includes(ext);

    if (isTextFile) {
      const fileStat = await stat(filePath);
      const raw = await readFile(filePath);
      let content: string;
      let encNote = '';
      try {
        // fatal: true → 遇到非法 UTF-8 序列（如 GBK 中文）直接抛错，触发编码探测
        content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        try {
          content = new TextDecoder('gb18030').decode(raw);
          encNote = ' (GB18030)';
        } catch {
          content = new TextDecoder('utf-8').decode(raw);
        }
      }
      content = content.replace(/^\uFEFF/, ''); // 去 BOM
      return chunkedAttachmentReturn(path, fileStat.size, `${ext.slice(1)} text${encNote}`, content, offset);
    }

    // .doc / .rtf / .rtfd（老版 Office）：macOS 自带 textutil 转纯文本
    if (ext === '.doc' || ext === '.rtf' || ext === '.rtfd') {
      const fileStat = await stat(filePath);
      try {
        const { stdout } = await execFileAsync(
          'textutil',
          ['-convert', 'txt', '-stdout', filePath],
          { timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
        );
        if (!stdout || !stdout.trim()) {
          return `Attachment: ${path}\nType: ${ext} (${formatSize(fileStat.size)})\n\ntextutil 未能提取到文本（文档可能为空或为图片型）。请另存为 .docx 或 .txt 后重试。`;
        }
        return chunkedAttachmentReturn(path, fileStat.size, `${ext.slice(1)} via textutil`, stdout, offset);
      } catch (tuErr) {
        return `Attachment: ${path}\nType: ${ext} (${formatSize(fileStat.size)})\n\ntextutil 转换失败：${tuErr instanceof Error ? tuErr.message : String(tuErr)}。请另存为 .docx 或 .txt 后重试。`;
      }
    }

    // .docx：mammoth HTML 保真管线（段落/标题/列表编号/表格行列结构）→ 紧凑文本
    if (ext === '.docx') {
      const fileStat = await stat(filePath);
      try {
        const mammoth = (await import('mammoth')) as unknown as MammothLike;
        const res = await mammoth.convertToHtml({ path: filePath });
        const fullText = docxHtmlToText(res.value);
        if (!fullText.trim()) {
          return `Attachment: ${path}\nType: Word (.docx) (${formatSize(fileStat.size)})\n\nmammoth 解析成功但未提取到文本（文档可能为空或内容均在文本框/图片中）。`;
        }
        return chunkedAttachmentReturn(path, fileStat.size, '.docx text', fullText, offset);
      } catch (extractErr) {
        // 兜底：直接解 document.xml 做轻量结构提取（不再退化为纯文本时，也要先试一遍）
        try {
          const AdmZipMod = await import('adm-zip');
          const AdmZip = AdmZipMod.default;
          const zip = new AdmZip(filePath);
          const xmlContent = zip.readAsText('word/document.xml');
          const fallbackText = docxXmlFallbackText(xmlContent);
          if (fallbackText.trim()) {
            return chunkedAttachmentReturn(path, fileStat.size, '.docx text (fallback)', fallbackText, offset);
          }
        } catch { /* 兜底失败 → 走下方错误 */ }
        return `Attachment: ${path}\nType: Word (.docx)\nUnable to extract text: ${extractErr instanceof Error ? extractErr.message : String(extractErr)}\n\nSuggestion: please provide .txt or .md format.`;
      }
    }

    // .pptx：解包按页提取文本（PPT 是 zip，文本在 ppt/slides/slideN.xml 的 a:t 内）
    if (ext === '.pptx') {
      const fileStat = await stat(filePath);
      try {
        const AdmZipMod = await import('adm-zip');
        const AdmZip = AdmZipMod.default;
        const zip = new AdmZip(filePath);
        const slideNames = zip
          .getEntries()
          .map((e) => e.entryName)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
          .sort((a, b) => {
            const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
            const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
            return na - nb;
          });
        if (slideNames.length === 0) {
          return `Attachment: ${path}\nType: PowerPoint (.pptx) (${formatSize(fileStat.size)})\n\n未在压缩包中找到 ppt/slides/slideN.xml（可能不是标准 PPTX 或纯图型模板）。`;
        }
        const parts: string[] = [];
        for (const name of slideNames) {
          const slideNo = name.match(/slide(\d+)\.xml/i)?.[1] ?? name;
          const body = collapseMarkedLines(
            zip.readAsText(name).replace(/<a:br\/>/g, '\n').replace(/<\/a:p>/g, '\n').replace(/<a:tab\/>/g, '\t'),
          );
          if (body.trim()) parts.push(`[Slide ${slideNo}]\n${body}`);
        }
        if (parts.length === 0) {
          return `Attachment: ${path}\nType: PowerPoint (.pptx) (${formatSize(fileStat.size)})\n\n各页未提取到文本（可能为全图型 PPT）。`;
        }
        return chunkedAttachmentReturn(path, fileStat.size, '.pptx text', parts.join('\n\n'), offset);
      } catch (pptxErr) {
        return `Attachment: ${path}\nType: PowerPoint (.pptx)\n解析失败：${pptxErr instanceof Error ? pptxErr.message : String(pptxErr)}。`;
      }
    }

    // 特殊处理 .xls / .xlsx（Excel 二进制表格）：SheetJS 解析，按 sheet 输出为紧凑文本行
    // （read_attachment 原本不支持表格附件，agent 只能绕道脚本；此处补齐直读能力）
    if (ext === '.xls' || ext === '.xlsx') {
      try {
        const XLSX = await import('xlsx');
        const wb = XLSX.readFile(filePath);
        const fileStat = await stat(filePath);
        // sheet 名过滤：sheetArg 命中则只读该表；未命中返回可用清单让模型修正
        let sheetNames = wb.SheetNames;
        if (sheetArg) {
          const matched = wb.SheetNames.filter((n) => n.toLowerCase() === sheetArg.toLowerCase());
          if (matched.length === 0) {
            return `Attachment: ${path}\nType: Excel (${ext})\n\n指定 sheet "${sheetArg}" 不存在。可用 sheet：${wb.SheetNames.map((n) => `"${n}"`).join('、')}。请用 sheet 参数指定其一，或不传 sheet 读取全部。`;
          }
          sheetNames = matched;
        }
        const sheetBlocks: string[] = [];
        for (const sheetName of sheetNames) {
          const ws = wb.Sheets[sheetName];
          if (!ws) continue;
          const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false }) as unknown[][];
          const lines = rows
            .filter((r) => r.some((c) => c !== '' && c !== null && c !== undefined))
            .map((r) => {
              const cells = r.map((c) => String(c ?? '').replace(/[\r\n\t]+/g, ' ').trim());
              // 去掉行尾空列，避免出现悬挂的分隔符
              while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
              return cells.join(' | ');
            })
            .filter((l) => l.length > 0);
          if (lines.length > 0) sheetBlocks.push(`[Sheet: ${sheetName}] (${lines.length} rows)\n${lines.join('\n')}`);
        }
        if (sheetBlocks.length === 0) {
          return `Attachment: ${path}\nType: Excel (${ext})\nSize: ${formatSize(fileStat.size)}\n\n解析成功但未读到有效内容（表格为空或无数据行）。`;
        }
        const fullText = sheetBlocks.join('\n\n');
        const sheetsLabel = sheetArg ? `sheet ${sheetArg}` : `${sheetBlocks.length} sheet${sheetBlocks.length > 1 ? 's' : ''}`;
        return chunkedAttachmentReturn(path, fileStat.size, `Excel ${ext.slice(1)} (${sheetsLabel})`, fullText, offset);
      } catch (excelErr) {
        const fileStat = await stat(filePath);
        return `Attachment: ${path}\nType: Excel (${ext})\nSize: ${formatSize(fileStat.size)}\n\nExcel 解析失败：${excelErr instanceof Error ? excelErr.message : String(excelErr)}。若为旧版加密 .xls 或格式损坏，请另存为 .xlsx 或 .csv 后重试。`;
      }
    }

    // 特殊处理 .pdf：Python pypdf → pdfplumber → sips+VLM
    if (ext === '.pdf') {
      try {
        const { extractWithPython, extractWithPdfParse } = await import('@/lib/pdf/extractor');
        const fileStat = await stat(filePath);

        // 第1+2级：Python pypdf → pdfplumber
        const pyResult = await extractWithPython(filePath);

        // 方案2（文字层密度门限）：水印/信笺头类 PDF 的文字层只有满页重复装饰字，
        // 绝对长度可轻松超过 20 字符却不含正文，导致此前被误判为"有文字层"而直接短路返回。
        // 改按"平均每页字符数"判断：页数未知时退回原来的长度判断，行为完全兼容。
        const TEXT_DENSITY_CHARS_PER_PAGE = 150;
        const denseLayer = (len: number, pageCount?: number): boolean => {
          if (!pageCount || pageCount <= 0) return len > 20;
          return len / Math.max(1, pageCount) >= TEXT_DENSITY_CHARS_PER_PAGE;
        };

        if (pyResult.text && denseLayer(pyResult.text.length, pyResult.pageCount)) {
          const truncated = pyResult.text.length > READ_CAPACITY
            ? pyResult.text.slice(0, READ_CAPACITY) + `\n...(${pyResult.pageCount} pages, truncated)`
            : pyResult.text;
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, PDF via ${pyResult.method})\n\n${truncated}`,
            READ_CAPACITY,
          );
        }

        // Python 提取失败，尝试 pdf-parse 兜底
        const fallback = await extractWithPdfParse(filePath);
        if (fallback.text && denseLayer(fallback.text.length, fallback.pageCount)) {
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, PDF via pdf-parse)\n\n${fallback.text}`,
            READ_CAPACITY,
          );
        }

        // 扫描件：OCR 识别完全走 bob-ocr-mcp（MCP 优先，不可用时返回明确错误）
        // 注意：不依赖 pageCount 来判断是否需要 OCR，因为提取器在某些情况下可能返回 pageCount=0
        // 方案2判定：只要两种提取器都没有产出"有密度的"文字层（稀疏≠可用），就进入 OCR 缓存分支
        const scannedPages = pyResult.pageCount || fallback.pageCount;
        const needsOcr = !denseLayer(pyResult?.text?.length ?? 0, pyResult?.pageCount)
          && !denseLayer(fallback?.text?.length ?? 0, fallback?.pageCount);

        if (needsOcr) {
          // PDF 级缓存：同一扫描件重复解析直接命中（法律文档常被反复检索引用）
          let pdfHash = '';
          const cacheT0 = Date.now();
          try {
            const { computeFileHash } = await import('@/lib/parse/image-parser');
            const { getCache, waitForPdfWarmOrTimeout } = await import('@/lib/parse/cache');
            pdfHash = await computeFileHash(filePath);
            let pdfCached = await getCache(pdfHash, project.path);
            if (!pdfCached?.result?.extracted_text && !pagesArg) {
              // 缓存未命中：若 PDF Bridge 后台预热正在进行（且非分页读取），等最多 1.2s 收尾，
              // 避免预热快写完时工具又从头开始整份 OCR——典型时预热 10-20s vs 等 1s 换命中，收益远大于代价。
              const waited = await waitForPdfWarmOrTimeout(pdfHash, project.path, 1200);
              if (waited) pdfCached = await getCache(pdfHash, project.path);
            }
            // 方案1a（二级索引）：主缓存 MISS 后，用本地已提取到的文字层做内容指纹反查（位置无关集合匹配）。
            // 若该文件是某份已做过全量 OCR 的文档的再渲染/切片派生件（字节已变、主键必失配），
            // 直接复用父记录全文切片返回，跳过整轮昂贵的 MCP 重 OCR。失败则照常进入 OCR。
            if (!pdfCached?.result?.extracted_text) {
              try {
                const { findSourceByFingerprints } = await import('@/lib/parse/derive-index');
                const probe = await findSourceByFingerprints(
                  project.path,
                  pyResult?.text ? [{ index: 1, text: pyResult.text }] : [],
                  fallback?.text ? [{ index: 1, text: fallback.text }] : [],
                );
                if (probe) {
                  const parentRec = await getCache(probe.parent, project.path);
                  const parentPages = parentRec?.result?.extracted_text
                    ? splitOcrTextToPages(parentRec.result.extracted_text)
                    : [];
                  if (parentPages.length > 0) {
                    console.log(`[read-attachment] PDF 二级索引命中: ${basename(filePath)} hash=${pdfHash.slice(0, 10)}… ← 源=${probe.parent.slice(0, 10)}… 页区间p${probe.start}-${probe.end} 窗口命中率=${Math.round(probe.ratio * 100)}%`);
                    return buildOcrAttachmentOutput(
                      path,
                      fileStat.size,
                      'Scanned PDF, cached OCR (secondary index)',
                      parentPages,
                      { pagesArg, totalPages: parentPages[parentPages.length - 1].index, rendered: parentPages.length },
                    );
                  }
                }
              } catch { /* 二级索引不可用时静默降级到正常 OCR */ }
            }
            if (pdfCached?.result?.extracted_text) {
              const cachedPages = splitOcrTextToPages(pdfCached.result.extracted_text);
              const waitMs = Date.now() - cacheT0;
              console.log(`[read-attachment] PDF cache HIT: ${basename(filePath)} chars=${pdfCached.result.extracted_text.length} pages=${cachedPages.length || '?'} wait=${waitMs}ms`);
              if (cachedPages.length > 0) {
                return buildOcrAttachmentOutput(
                  path,
                  fileStat.size,
                  'Scanned PDF, cached OCR',
                  cachedPages,
                  { pagesArg, totalPages: cachedPages[cachedPages.length - 1].index, rendered: cachedPages.length },
                );
              }
              return truncate(
                `Attachment: ${path} (${formatSize(fileStat.size)}, Scanned PDF, cached OCR)\n\n${pdfCached.result.extracted_text}`,
                OCR_MAX_LENGTH,
              );
            }
            console.log(`[read-attachment] PDF cache MISS: ${basename(filePath)} hash=${pdfHash.slice(0, 10)}… wait=${Date.now() - cacheT0}ms → start full OCR`);
            // 异步调度（调度层落地）：整份扫描件大 PDF 走异步任务，避免同步等待撞 MCP 客户端超时
            // （本地 VLM 分钟级 / 整份大 PDF 20-74s × 多片）。模型立即拿到进度提示，下轮命中缓存。
            // 阈值：整份读取（非分页）且页数 ≥ ASYNC_OCR_MIN_PAGES 或文件较大 → 异步；否则保持同步（小文件秒回）。
            const ASYNC_OCR_MIN_PAGES = 15;
            const ASYNC_OCR_MIN_BYTES = 5 * 1024 * 1024;
            const isLongOcr =
              !pagesArg &&
              (scannedPages >= ASYNC_OCR_MIN_PAGES || fileStat.size >= ASYNC_OCR_MIN_BYTES);
            if (isLongOcr) {
              const { submitOcrTask, getOcrTaskByHash, hasRunningOcrTask } = await import('@/lib/parse/ocr-task-manager');
              if (!hasRunningOcrTask(pdfHash)) {
                const existing = getOcrTaskByHash(pdfHash);
                if (!existing || existing.status === 'done') {
                  try {
                    await submitOcrTask({
                      filePath,
                      projectPath: project.path,
                      hash: pdfHash,
                      upgrade: 'auto',
                      onDone: async (_rec, result) => {
                        // 任务完成：写主缓存 + 二级索引（与同步路径一致），模型下轮直接命中
                        const r = result as { success?: boolean; text?: string; pages?: Array<{ index: number; text: string }> };
                        if (!r?.success || !r.text?.trim()) return;
                        const { setCache } = await import('@/lib/parse/cache');
                        await setCache(pdfHash, {
                          file_name: basename(filePath),
                          file_type: 'pdf',
                          mime_type: 'application/pdf',
                          extracted_text: r.text,
                          parse_method: 'text_extract',
                          parsed_at: new Date().toISOString(),
                          file_hash: pdfHash,
                        }, project.path);
                        const ocrPages = (r.pages ?? []).map((p) => ({ index: p.index, text: p.text }));
                        if (ocrPages.length > 0) {
                          const { registerOcrPages } = await import('@/lib/parse/derive-index');
                          await registerOcrPages(project.path, pdfHash, ocrPages);
                        }
                        console.log(`[read-attachment] 异步OCR完成并写缓存: ${basename(filePath)} chars=${r.text.length} pages=${ocrPages.length}`);
                      },
                    });
                  } catch (e) {
                    console.warn(`[read-attachment] 异步OCR提交失败，回退同步: ${e instanceof Error ? e.message : String(e)}`);
                    // 提交失败 → 走下方同步 OCR（保持功能可用）
                  }
                }
              }
              // 有进行中任务（本次提交或已存在）→ 返回进度提示，模型下轮再读命中缓存
              const rec = getOcrTaskByHash(pdfHash);
              if (rec && (rec.status === 'queued' || rec.status === 'running')) {
                const posText = rec.status === 'queued' ? `排队中${typeof rec.position === 'number' ? `（第${rec.position}位）` : ''}` : `识别中${typeof rec.progress === 'number' ? ` ${rec.progress}%` : ''}`;
                console.log(`[read-attachment] PDF 异步OCR已提交: ${basename(filePath)} task=${rec.taskId.slice(0, 8)}… ${posText}`);
                return truncate(
                  `Attachment: ${path} (${formatSize(fileStat.size)}, Scanned PDF, ${scannedPages} pages)\n\n⏳ 该文件正在后台识别中（${posText}）。识别完成后会自动写入缓存，请稍后再次调用本工具读取本文件，即可秒回识别结果。`,
                  OCR_MAX_LENGTH,
                );
              }
            }
          } catch { /* 缓存不可用则忽略，正常走 OCR */ }

          // 缓存写入 helper（复用 parse cache，key 为 PDF 内容 hash）
          const cachePdf = async (text: string): Promise<void> => {
            if (!pdfHash) return;
            // 分页识别只覆盖目标页，不写入整份缓存（避免把完整 OCR 缓存污染成部分页，影响后续整份读取）
            if (pagesArg) return;
            try {
              const { setCache } = await import('@/lib/parse/cache');
              await setCache(pdfHash, {
                file_name: basename(filePath),
                file_type: 'pdf',
                mime_type: 'application/pdf',
                extracted_text: text,
                parse_method: 'text_extract',
                parsed_at: new Date().toISOString(),
                file_hash: pdfHash,
              }, project.path);
            } catch { /* 缓存写入失败忽略 */ }
          };

          // ---- MCP 优先：扫描件识别统一走 bob-ocr-mcp 常驻服务 ----
          // 可用时直接复用其识别结果（同源引擎，含质量/勾稽/升级元数据），并写入整份缓存；
          // 未配置/不可用/失败时静默回退下方本地渲染 + 视觉模型链路。
          try {
            const { tryOcrViaMcp } = await import('@/lib/mcp/ocr-client');
            const mcpResult = await tryOcrViaMcp(filePath, 'auto', ctx?.onOcrProgress);
            if (mcpResult?.success && mcpResult.text) {
              await cachePdf(mcpResult.text).catch(() => {});
              const ocrPages: OcrPageBlock[] = (mcpResult.pages ?? []).map((p) => ({
                index: p.index,
                text: p.text,
              }));
              // 方案1a 写入侧（全量识别）：把每页文本的滑窗内容指纹登记进二级索引，供之后同源派生件反查。
              // 分页识别（pagesArg）不登记——其内容与父文档重叠，登记会污染归属推断的"主流来源"投票。
              if (!pagesArg && ocrPages.length > 0) {
                try {
                  const { registerOcrPages } = await import('@/lib/parse/derive-index');
                  await registerOcrPages(project.path, pdfHash, ocrPages);
                } catch { /* 索引维护失败不影响 OCR 主流程 */ }
              }
              // 方案1a 学习侧（分页识别）：其页面若大部分命中某个已登记源 → 记 child→parent 溯源链接
              if (pagesArg && ocrPages.length >= 3) {
                try {
                  const { findSourceByFingerprints, linkDerivedToFile } = await import('@/lib/parse/derive-index');
                  const probe = await findSourceByFingerprints(project.path, ocrPages);
                  if (probe) await linkDerivedToFile(project.path, pdfHash, probe.parent, probe.start, probe.end);
                } catch { /* 学习失败忽略 */ }
              }
              if (ocrPages.length > 0) {
                const total = Math.max(0, ...ocrPages.map((p) => p.index), mcpResult.pageCount || 0);
                console.log(`[read-attachment] OCR via MCP: ${basename(filePath)} pages=${ocrPages.length} method=${mcpResult.method}`);
                return buildOcrAttachmentOutput(
                  path,
                  fileStat.size,
                  'Scanned PDF, OCR via MCP',
                  ocrPages,
                  { pagesArg, totalPages: total, rendered: ocrPages.length },
                );
              }
              // 无结构化页（如 GLM-OCR 整份解析）→ 原样返回全文
              return truncate(
                `Attachment: ${path} (${formatSize(fileStat.size)}, Scanned PDF, OCR via MCP)\n\n${mcpResult.text}`,
                OCR_MAX_LENGTH,
              );
            }
          } catch { /* MCP 不可用 → 下方返回明确错误 */ }
          return `Attachment: ${path}\nType: PDF (${scannedPages} pages)\nSize: ${formatSize(fileStat.size)}\n\n无法识别：此 PDF 为扫描件或图片型文档，且识别服务 bob-ocr-mcp 不可用。请确认 OCR 插件已安装且常驻服务在线（bob-ocr-mcp --install-daemon），并在 BobWork 设置 → MCP 中启用 "Bob OCR"。`;
        }
      } catch (extractErr) {
        const fileStat = await stat(filePath);
        return `Attachment: ${path}\nType: PDF\nSize: ${formatSize(fileStat.size)}\n\nPDF text extraction failed: ${extractErr instanceof Error ? extractErr.message : String(extractErr)}`;
      }
    }

    // 图片文件：识别统一走 bob-ocr-mcp（MCP 优先，视觉模型配置已收敛到插件）
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.avif'];
    const isImageFile = imageExts.includes(ext);

    if (isImageFile) {
      const fileStat = await stat(filePath);

      // ---- 图片级 OCR 缓存（内容 hash）：同图跨工具/跨轮次复用，消除"同一页重复识别" ----
      // 袁梦任务实测：同页被渲染成不同命名（page_0.png / p1.png）分别经 recognize / read_attachment
      // 各识别一遍 → 内容 hash 相同即可命中复用。缓存与 PDF 缓存共用 .cache/parse/（同策略：无配置指纹）。
      let imgHash = '';
      try {
        const { computeFileHash } = await import('@/lib/parse/image-parser');
        const { getCache, setCache } = await import('@/lib/parse/cache');
        imgHash = await computeFileHash(filePath);
        const imgCached = await getCache(imgHash, project.path);
        if (imgCached?.result?.extracted_text) {
          console.log(`[read-attachment] Image OCR cache HIT: ${basename(filePath)} chars=${imgCached.result.extracted_text.length}`);
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, image, OCR via MCP, cached)\n\n${imgCached.result.extracted_text.trim()}`,
            8000,
          );
        }
        // ---- MCP 优先：图片识别统一走 bob-ocr-mcp 常驻服务 ----
        // 视觉模型配置已收敛到插件；MCP 不可用/失败 → 明确错误（不再回退 BobWork 内置视觉模型）。
        const { tryOcrViaMcp } = await import('@/lib/mcp/ocr-client');
        const mcpResult = await tryOcrViaMcp(filePath, 'auto', ctx?.onOcrProgress);
        if (mcpResult?.success && (mcpResult.text || mcpResult.understanding)) {
          console.log(`[read-attachment] Image OCR via MCP: ${basename(filePath)} method=${mcpResult.method}`);
          // 剔除空页格式串（[Page 1]）与图片引用占位（![](page=0,bbox=...)），只留真实文字
          const PAGE_PLACEHOLDER_RE = /\[Page \d+\]|!\[[^\]]*\]\([^)]*\)/g;
          const ocrText = (mcpResult.text || '').replace(PAGE_PLACEHOLDER_RE, '').trim();
          if (imgHash) {
            await setCache(
              imgHash,
              {
                file_name: basename(filePath),
                file_type: 'image',
                mime_type: `image/${ext.replace(/^\./, '')}`,
                extracted_text: ocrText || (mcpResult.understanding || '').trim(),
                parse_method: 'vision',
                parsed_at: new Date().toISOString(),
                file_hash: imgHash,
              },
              project.path,
            ).catch(() => {});
          }
          // 纯照片/无文字：插件已自动降级到视觉理解（image_understand）→ 返回 [Image Analysis] 标注 + 画面描述
          if (mcpResult.understanding && !ocrText) {
            return truncate(
              `Attachment: ${path} (${formatSize(fileStat.size)}, image)\n\n[Image Analysis]${mcpResult.understandingModel ? ` (${mcpResult.understandingModel})` : ''}\n${(mcpResult.understanding || '').trim()}`,
              8000,
            );
          }
          // 纯图片/照片：顶层 text 可能只是 "[Page 1]" 这类空页格式串，真实无文字。
          // 插件会带 guidance 引导改走 ocr.image_understand 视觉理解——必须透传给模型，
          // 否则模型看到空壳文本会误判"只有图像引用/视觉不可用"，转而用 crop/HTML/脚本绕路。
          const realTexts = (mcpResult.pages ?? [])
            .map((p) => (p.text ?? '').replace(PAGE_PLACEHOLDER_RE, '').trim())
            .filter((t) => t.length > 0);
          const hasRealText = realTexts.length > 0 || ocrText.length > 20;
          if (mcpResult.guidance && !hasRealText) {
            return `Attachment: ${path} (${formatSize(fileStat.size)}, image)\n\n${mcpResult.guidance}`;
          }
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, image, OCR via MCP)\n\n${ocrText}`,
            8000,
          );
        }
      } catch { /* 缓存/识别异常 → 下方明确错误 */ }

      return `Attachment: ${path}\nType: Image (${ext})\nSize: ${formatSize(fileStat.size)}\n\n无法识别：识别服务 bob-ocr-mcp 不可用。请确认 OCR 插件常驻服务在线（bob-ocr-mcp --install-daemon，默认 http://127.0.0.1:9478）且已配置视觉模型（插件 /settings 的 Vision 区块）。`;
    }

    // 视频文件：ffmpeg 抽帧 + 帧识别（统一走 bob-ocr-mcp image_understand；配置已收敛到插件）
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv'];
    if (videoExts.includes(ext)) {
      const stat2 = await stat(filePath);
      try {
        const { parseVideo } = await import('@/lib/parse/video-parser');
        const { ocrImageUnderstandViaMcp } = await import('@/lib/mcp/ocr-client');
        // ⑤ 帧段分片：frame_range（如 "0-1"）→ 只分析该帧段（帧缓存已由主节点预热）
        //    未指定 → 分析全部帧（整视频结果缓存命中直接返回）
        const frameRange = parseFrameRange(args.frame_range as string | undefined, 7);
        const result = await parseVideo(filePath, project.path, {
          model: '',
          apiKey: '',
          baseUrl: '',
          mode: 'general',
        }, {
          ...(frameRange ? { frameRange } : {}),
          // 帧分析器：MCP-only（bob-ocr-mcp image_understand general 模式，复用插件 vision 配置）
          frameAnalyzer: async (
            framePath: string,
            projectPath: string,
            ctx: { fi: number; total: number; timeLabel: string },
          ) => {
            const r = await ocrImageUnderstandViaMcp(framePath, { mode: 'general' });
            if (!r) throw new Error('bob-ocr-mcp 视觉模型不可用');
            return {
              text: `[帧 ${ctx.fi}/${ctx.total}${ctx.timeLabel}]\n${r.understanding}`,
              tin: r.tokens?.input ?? 0,
              tout: r.tokens?.output ?? 0,
            };
          },
        });
        if (result.extracted_text && result.extracted_text.trim().length > 0) {
          const segNote = frameRange ? `（帧段 ${frameRange[0]}-${frameRange[frameRange.length - 1]}，帧缓存命中）` : '';
          return truncate(
            `Attachment: ${path} (${formatSize(stat2.size)}, video, ${result.frame_count} 帧抽帧分析，MCP 识别${segNote})\n\n${result.extracted_text}`,
            READ_CAPACITY,
          );
        }
        return `Attachment: ${path}\nType: Video (${ext})\nSize: ${formatSize(stat2.size)}\n\n视频抽帧分析返回空结果。`;
      } catch (videoErr) {
        const msg = videoErr instanceof Error ? videoErr.message : String(videoErr);
        if (msg.includes('bob-ocr-mcp 视觉模型不可用')) {
          return `Attachment: ${path}\nType: Video (${ext})\nSize: ${formatSize(stat2.size)}\n\n未能分析视频：识别服务 bob-ocr-mcp 不可用或未配置视觉模型。请确认 OCR 插件常驻服务在线（bob-ocr-mcp --install-daemon）且已配置视觉模型（插件 /settings 的 Vision 区块）。`;
        }
        return `Attachment: ${path}\nType: Video (${ext})\nSize: ${formatSize(stat2.size)}\n\n视频分析失败: ${msg}`;
      }
    }

    // 音频文件：云端 STT 转写（豆包/DashScope/SiliconFlow/OpenAI 兼容），未配置则提示
    const audioExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma', '.opus', '.amr'];
    if (audioExts.includes(ext)) {
      const stat2 = await stat(filePath);
      try {
        const { readSettingsFromFile } = await import('@/lib/settings-server');
        const settings = await readSettingsFromFile();
        const { parseAudio } = await import('@/lib/parse/audio-parser');
        const result = await parseAudio(filePath, project.path, { stt: settings.stt });
        return truncate(
          `Attachment: ${path}\nType: Audio (${ext})\nSize: ${formatSize(stat2.size)}\n\n${result.extracted_text}`,
          20000,
        );
      } catch (sttErr) {
        const msg = sttErr instanceof Error ? sttErr.message : String(sttErr);
        return `Attachment: ${path}\nType: Audio (${ext})\nSize: ${formatSize(stat2.size)}\n\n音频转写失败: ${msg}\n\n如需转写请配置音频转写模型（设置 → 角色派发 → 音频转写模型）。`;
      }
    }

    // .zip 压缩包：安全解包到 homework/.unpacks/<指纹>/，返回内部文件清单，供逐个 read_attachment 读取
    if (ext === '.zip') {
      const fileStat = await stat(filePath);
      try {
        const AdmZipMod = await import('adm-zip');
        const AdmZip = AdmZipMod.default;
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries();
        const MAX_ZIP_FILES = 300;
        const MAX_ZIP_TOTAL_BYTES = 300 * 1024 * 1024;
        if (entries.length === 0) {
          return `Attachment: ${path}\nType: Zip (${formatSize(fileStat.size)})\n\n压缩包内无文件。`;
        }
        if (entries.length > MAX_ZIP_FILES) {
          return `Attachment: ${path}\nType: Zip (${formatSize(fileStat.size)})\n\n压缩包内文件过多（${entries.length} > ${MAX_ZIP_FILES}）。请单独上传需要的文件。`;
        }
        // 解压目标：homework/.unpacks/<内容指纹>/（隐藏中间产物目录，任务结束可清理）
        const { computeFileHash } = await import('@/lib/parse/image-parser');
        const hash = (await computeFileHash(filePath)).slice(0, 12);
        const destDir = join(projectRoot, 'homework', '.unpacks', hash);
        const files: Array<{ name: string; size: number }> = [];
        let totalBytes = 0;
        for (const e of entries) {
          if (e.isDirectory) continue;
          const rawName = e.entryName.replace(/\\/g, '/');
          // 防 zip-slip：跳过绝对路径、盘符、父目录回溯、macOS 元数据
          if (
            !rawName ||
            rawName.startsWith('/') ||
            /^[a-zA-Z]:\//.test(rawName) ||
            rawName.split('/').includes('..') ||
            rawName === '.DS_Store' ||
            rawName.endsWith('/.DS_Store') ||
            rawName.startsWith('__MACOSX/')
          ) {
            continue;
          }
          const out = resolve(destDir, rawName);
          if (!out.startsWith(destDir + sep)) continue;
          const size = e.header.size ?? 0;
          totalBytes += size;
          if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
            return `Attachment: ${path}\nType: Zip (${formatSize(fileStat.size)})\n\n解压总大小超限（> ${formatSize(MAX_ZIP_TOTAL_BYTES)}），已中止，防止解压炸弹。请拆分后重试。`;
          }
          files.push({ name: rawName, size });
          await mkdir(dirname(out), { recursive: true });
          await writeFile(out, e.getData());
        }
        if (files.length === 0) {
          return `Attachment: ${path}\nType: Zip (${formatSize(fileStat.size)})\n\n未发现可安全解压的文件（可能均为系统隐藏文件或存在路径穿越）。`;
        }
        const listing = files
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((f) => `- ${f.name} (${formatSize(f.size)})`)
          .join('\n');
        return [
          `Attachment: ${path} (${formatSize(fileStat.size)}, zip, unpacked ${files.length} files)`,
          ``,
          `已安全解包到：homework/.unpacks/${hash}/（项目内目录）`,
          ``,
          `内部文件清单：`,
          listing,
          ``,
          `下一步：对包内目标文件逐个调用本工具读取内容，path 填 "homework/.unpacks/${hash}/<内部相对路径>"（文本/PDF/图片/Excel/Word 均按对应类型解析；包内再嵌套的 zip 同样会被安全解包）。`,
        ].join('\n');
      } catch (zipErr) {
        return `Attachment: ${path}\nType: Zip\nSize: ${formatSize((await stat(filePath)).size)}\n\n压缩包解析失败：${zipErr instanceof Error ? zipErr.message : String(zipErr)}（加密/损坏的 zip 请解压后上传，或提供单个文件）。`;
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
        READ_CAPACITY,
      );
    }

    // .docx 提取
    if (ext === '.docx') {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const tmpDir = `/tmp/bob-work-docx-${Date.now()}`;
        await execAsync(`mkdir -p "${tmpDir}" && unzip -o "${filePath}" word/document.xml -d "${tmpDir}"`, { timeout: 10000 });
        const xmlContent = await readFile(`${tmpDir}/word/document.xml`, 'utf-8');
        const text = xmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const fileStat = await stat(filePath);
        await execAsync(`rm -rf "${tmpDir}"`).catch(() => {});
        return truncate(
          `Material: ${path} (${formatSize(fileStat.size)}, .docx text extracted)\n\n${text}`,
          READ_CAPACITY,
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
            READ_CAPACITY,
          );
        }
        const fallback = await extractWithPdfParse(filePath);
        if (fallback.text && fallback.text.length > 20) {
          return truncate(
            `Material: ${path} (${formatSize(fileStat.size)}, PDF via pdf-parse)\n\n${fallback.text}`,
            READ_CAPACITY,
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

export const attachmentToolDefs: Tool[] = [
  {
    name: 'read_attachment',
    description: 'Read a user-uploaded attachment (path from the attachment list in the user message). Formats: text/code (GBK auto-detect), Excel (.xls/.xlsx), Word (.docx; legacy .doc/.rtf via textutil), PowerPoint, PDF (native extract or scanned OCR), images (OCR/vision), video frames, audio (STT), .zip (unpacked to homework/.unpacks/). Long content truncates with a next-offset marker — re-call with the returned offset=<value> to continue reading. Reads cache by content hash (re-reading the same file returns instantly). For scanned PDFs prefer pages="x-y" reads. Large scanned PDFs (>=15 pages or >=5MB full read) recognize in background: the first call returns a "⏳ recognizing in background" notice — call this tool again on the same path after a moment to get the result from cache (do NOT treat the notice as failure).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Attachment path: attachments/{nodeId}/{filename} from the attachment list in the user message (already copied into the project attachments/ folder — do NOT ask permission or a Downloads path, and do NOT emit AUTH_REQ). Absolute / ~/ paths inside a user-authorized directory are also resolved and read directly.',
        },
        pages: {
          type: 'string',
          description: '可选，仅扫描件 PDF：按页读取，如 "1-5" / "3" / "6,8-10"。长 PDF 分片用——返回头部会标注已返回页码区间并提示续读剩余页（如 pages="6-14"）。',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: '可选，通用续读偏移（文本/Word/Excel/PPT）：内容超限截断时头部标注 "offset=<数值>"，原样传回即可续读后半；不传=从头读。',
        },
        sheet: {
          type: 'string',
          description: '可选，仅 Excel(.xls/.xlsx)：按 sheet 名（不区分大小写）只读该表；不传=全部 sheet。指定不存在的 sheet 会返回可用清单。',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolReadAttachment,
    maxOutput: 8000,
  },
  {
    name: 'read_material',
    description: 'Read a material file from the project materials folder (reference docs the user uploaded: PDFs, reports, images, code). Call when the user refers to "@filename". NOTE: materials live at <project>/materials/, NOT the workspace root (which only holds scripts/) — always use THIS tool; never list_directory/read_file on the workspace root to find them.',
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
