/**
 * PDF OCR 结构化后处理（纯函数，无 IO）——法律合同扫描件典型痛点治理。
 * 供 ocr-service.ts 与 tools.ts（read_attachment）复用，
 * 保证两条链路的文本形态完全一致，避免下游主 LLM 拿到不同结构的文本出现不一致的分析质量。
 *
 *  两项能力：
 *   1) 页眉页脚去重：跨 ≥3 页（或 ≥60% 页数）重复出现且严格位于头部/尾部 2 行的全行 → 剔除。
 *      —— 法律合同中常见「XX律师事务所 保密文件 / 第 X 页 / 共 Y 页」这类行，主 LLM 读到会混淆正文段落边界。
 *   2) 跨页续接：上一页末行是「未写完的短标题」（≤8 中文字、无句末标点），而首页首行字数少且以中文起头 → 自动拼接。
 *      —— 常见如「第七条 违约责」→ 页脚打断 → 下页 「任」，否则主 LLM 会把「违约责」当成独立词。
 *
 *  注意：两种处理都极其保守，宁可漏处理也不误拼接/误删除（法律文本宁缺毋滥原则）。
 */

/** 行的"原始标准化"：去空白标点 → 再把阿拉伯数字通配成 #
 *  这样「第 1 页 / 共 5 页」「第 2 页 / 共 5 页」会得到同一个 key「第#页共#页」，
 *  能正确识别页码型页脚为重复行。*/
function normLine(s: string): string {
  return s
    .trim()
    .replace(/[\s\-—_|\.。,，:：;；""''（）()【】\[\]{}《》<>、/\\]+/g, '')
    .replace(/\d+/g, '#');
}

/** 判断某一行是否具备「典型页眉/页脚特征词」——保护合同正文行（甲方、第一条等）不被误删。
 *  有任一命中 → 允许走页眉页脚判定；否则即使跨页重复也放过。*/
const HF_HINT_RE = /(?:页|共.*页|第.*页|保密|机密|CONFIDENTIAL|CONFIDENTIAL|confidential|内部资料|绝密|draft|草稿|版本|v\d|版权|©|所有权利|footer|header|打印|日期|编制|审核|复核|批准|经办|签章|盖章|公司|律师事务所|会计师事务所|事务所)/i;

/** 典型合同正文开头词：出现这些字样的行，即使跨页重复，也**绝不能**当页眉页脚删。*/
const CONTRACT_BODY_HINTS = /(?:第[一二三四五六七八九十百千万零〇两0-9]+[条款章节编部篇]|甲方[:：]?|乙方[:：]?|丙方[:：]?|出租方|承租方|借款方|贷款方|转让方|受让方|保证人|抵押人|出质人|根据《|依照《|依据《|双方约定|特此约定|合同双方|本合同(?:项下|约定|签订|生效|期限)|第一条|第二条|第三条|一、|二、|三、|四、|五、|六、|七、|八、|九、|十、|(?:原告|被告|上诉人|被上诉人|申请人|被申请人|第三人)[:：\s])/u;

export interface PageLike {
  index: number;
  text: string;
}

/** 页眉页脚去重 + 跨页续接，原地修改传入 pages 数组元素的 text 字段。
 *  @returns 变更摘要（供日志输出） */
export function structuralPostprocess(pages: PageLike[]): {
  removedHeaderFooterLines: number;
  mergedPageBoundaries: number;
} {
  const result = { removedHeaderFooterLines: 0, mergedPageBoundaries: 0 };
  if (pages.length < 3) return result;

  // ============== (1) 页眉页脚去重 ==============
  const lineOccurrences = new Map<string, Array<{ pageIdx: number; lineIdx: number; rawLine: string }>>();
  pages.forEach((p, pageIdx) => {
    const lines = (p.text ?? '').split(/\r?\n/);
    lines.forEach((line, lineIdx) => {
      const key = normLine(line);
      if (key.length < 4) return;
      if (!/[一-龥A-Za-z]/.test(key)) return; // 必须含中文或英文（避免纯数字/符号页号误识别为页眉）
      // 保护 1：命中"典型合同正文关键词"→ 直接放过，不进入候选
      if (CONTRACT_BODY_HINTS.test(line)) return;
      // 保护 2：连"页眉/页脚特征词"都没命中的 → 即使跨页重复也不当页眉页脚（避免合同每章标题恰好重复时误删）
      if (!HF_HINT_RE.test(line)) return;
      const arr = lineOccurrences.get(key);
      const payload = { pageIdx, lineIdx, rawLine: line };
      if (arr) arr.push(payload);
      else lineOccurrences.set(key, [payload]);
    });
  });

  const hfNorms = new Set<string>();
  const total = pages.length;
  lineOccurrences.forEach((locs, norm) => {
    // 出现范围：≥3 页 或 ≥60% 页数（短文档用前者，长文档用后者压）
    if (locs.length < Math.min(3, Math.ceil(total * 0.6))) return;
    const headerLike = locs.filter((l) => l.lineIdx <= 1).length;
    const footerLike = locs.filter((l) => {
      const pageLines = (pages[l.pageIdx].text ?? '').split(/\r?\n/).length;
      return l.lineIdx >= pageLines - 2;
    }).length;
    // 全部命中都在头部 或 全部命中都在尾部 → 认定为页眉/页脚
    if (headerLike === locs.length || footerLike === locs.length) hfNorms.add(norm);
  });

  if (hfNorms.size > 0) {
    for (const p of pages) {
      const lines = (p.text ?? '').split(/\r?\n/);
      const before = lines.length;
      const kept = lines.filter((ln) => !hfNorms.has(normLine(ln)));
      if (kept.length !== before) {
        result.removedHeaderFooterLines += before - kept.length;
        p.text = kept.join('\n');
      }
    }
  }

  // ============== (2) 跨页续接 ==============
  const hanziRe = /[一-龥]/;
  for (let i = 0; i < pages.length - 1; i++) {
    const curr = pages[i];
    const next = pages[i + 1];
    const currLines = (curr.text ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0);
    const nextLines = (next.text ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (currLines.length === 0 || nextLines.length === 0) continue;
    const tail = currLines[currLines.length - 1].trim();
    const head = nextLines[0].trim();
    const tailHanziCount = (tail.match(/[一-龥]/g) || []).length;
    // 只对典型「断标题」场景生效：
    //   末行中文>0、总长度≤8（短标题被页脚截断）、首字符是中文、末行无句末标点、
    //   首行长度≤10（单字/两字的续接）
    if (
      tailHanziCount > 0 &&
      tail.length <= 8 &&
      hanziRe.test(head.charAt(0)) &&
      head.length <= 10 &&
      !/[。！？：；.!?…—\-]$/.test(tail)
    ) {
      currLines[currLines.length - 1] = tail + head;
      nextLines.shift();
      curr.text = currLines.join('\n');
      next.text = nextLines.join('\n');
      result.mergedPageBoundaries++;
    }
  }

  return result;
}
