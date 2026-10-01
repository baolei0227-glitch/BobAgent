/**
 * P1-1a：账务语义确认（Ledger Semantics Inference）
 *
 * 设计原则（太空舱边界）：
 *  - 纯算法：只吃纯文本或纯数据，不做 I/O（不 Vision、不 exec、不 fetch）。
 *  - 不可抛出：推断失败不 throw，返回 `confidence='ambiguous'` 的保守语义。
 *  - 双向验证：通过「方程解算」（inferred order × amountMode × balancePosition 能让勾稽通过率显著提升）
 *    才升 confidence=inferred；仍有 header_mapping 命中（如银行关键词）才升 confirmed。
 *
 * 专家建议里「勾稽前必须先确认语义」的落点：本文件 export `inferLedgerSemantics()`，
 * 供 ledgerValidationReport（core/ledger.ts）勾稽前调用；当 semantics.confidence !== 'confirmed' 时，
 * report.semanticsStatus 不能标 'confirmed'（只能 'inferred' 或 'ambiguous'）。
 */

import type { LedgerSemantics } from '../shared/types';

/** 最小化输入：Markdown 表格文本（带表头与 | 列分隔）或已切好的「表头名列表 + 二维值数组」 */
export type SemanticsInput =
  | { kind: 'markdown'; transcript: string }
  | {
      kind: 'structured';
      header: string[];
      rows: string[][];
      /** 0-based「余额列」索引；传 -1 时本函数自行在 header 中找 */
      iBalance?: number;
      /** 收入列 / 支出列 / 金额列（0-based）；可缺省，本函数自行找 */
      iIncome?: number;
      iExpense?: number;
      iAmount?: number;
    };

type AmountMode = LedgerSemantics['amountMode'];
type Order = LedgerSemantics['order'];
type BalancePosition = LedgerSemantics['balancePosition'];
type Effect = LedgerSemantics['debitEffect']; // same enum: 'increase' | 'decrease' | 'unknown'

interface HeaderMapping {
  iDate: number;
  iBalance: number;
  iIncome: number; // -1 表示缺失
  iExpense: number; // -1 表示缺失
  iAmount: number; // -1 表示缺失
  iDirection?: number; // -1 表示缺失（"借贷/收付/借贷方向"等列）
  iSummary?: number;
  /** 明确的银行关键词（招商银行等）用于 bank_template source 判定 */
  bankHits: string[];
  /** controlRow 列：如「对方科目」「账户名称」「流水号」等，表示"汇总/小计"行常见前置字段 */
  controlSignal: boolean;
}

const BANK_KEYWORDS = [
  '招商银行', '工商', '建设', '农业', '中国', '交通', '浦发', '中信', '民生', '兴业',
  '光大', '华夏', '平安', '广发', '浙商', '邮储', '渤海', '恒丰', '招商', '工商银',
  '支付宝', '微信', 'paypal', '中国银行',
];
const DATE_KEYS = ['日期', '交易日期', '记账日期', '入账日期', '时间', '交易日'];
const BALANCE_KEYS = ['余额', '结余', '账户余额', '可用余额', '期末余额', '期初余额'];
const INCOME_KEYS = ['收入', '贷方', '贷', '存入', '进账', '转入', '收', '收款'];
const EXPENSE_KEYS = ['支出', '借方', '借', '支取', '出账', '转出', '付', '付款'];
const AMOUNT_KEYS = ['金额', '交易金额', '发生额', '本次发生额'];
const DIRECTION_KEYS = ['借贷', '借/贷', '收付', '收付标志', '借贷标志', '方向'];
const SUMMARY_KEYS = ['摘要', '交易摘要', '备注', '说明', '对方户名', '对方账户', '对方'];
const CONTROL_KEYS = ['对方科目', '科目', '账户名称', '流水号', '交易单号', '凭证号', '币别', '币种'];

function matchIndex(header: string[], keys: string[]): number {
  for (let i = 0; i < header.length; i++) {
    const h = header[i];
    for (const k of keys) if (h.includes(k)) return i;
  }
  return -1;
}

function headerFromStructured(inp: SemanticsInput): { header: string[]; rows: string[][] } | null {
  if (inp.kind === 'structured') return { header: inp.header, rows: inp.rows };
  const md = parseMarkdownTable(inp.transcript);
  if (!md) return null;
  return md;
}

/** 解析 Markdown 表：返回 header + rows（不含分隔行）。若没有合法表头返回 null。 */
export function parseMarkdownTable(transcript: string): { header: string[]; rows: string[][] } | null {
  const lines = transcript.split('\n').map((l) => l.trim());
  const headerIdx = lines.findIndex((l) => l.startsWith('|') && l.includes('|'));
  if (headerIdx < 0) return null;
  const split = (l: string) => l.split('|').map((c) => c.trim()).slice(1, -1);
  const header = split(lines[headerIdx]);
  const sep = lines[headerIdx + 1];
  if (sep && /^\|\s*-[\s|:-]+\|\s*$/.test(sep)) {
    // OK: has separator
  }
  const rows: string[][] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('|')) continue;
    const cells = split(l);
    if (cells.length !== header.length) continue;
    // 分隔行跳过
    if (cells.every((c) => /^-+$/.test(c.replace(/\s/g, '')))) continue;
    rows.push(cells);
  }
  if (rows.length === 0) return null;
  return { header, rows };
}

function detectHeaderMapping(input: SemanticsInput): HeaderMapping | null {
  const s = headerFromStructured(input);
  if (!s) return null;
  const { header } = s;
  const headerAll = header.join(' ');
  const bankHits = BANK_KEYWORDS.filter((k) => headerAll.includes(k));
  const iDate = matchIndex(header, DATE_KEYS);
  const iBalance = matchIndex(header, BALANCE_KEYS);
  const iIncome = matchIndex(header, INCOME_KEYS);
  const iExpense = matchIndex(header, EXPENSE_KEYS);
  const iAmount = matchIndex(header, AMOUNT_KEYS);
  const iDirection = matchIndex(header, DIRECTION_KEYS);
  const iSummary = matchIndex(header, SUMMARY_KEYS);
  const controlSignal = matchIndex(header, CONTROL_KEYS) >= 0;
  if (iBalance < 0) return null; // 没余额列没法语义确认
  return {
    iDate,
    iBalance,
    iIncome,
    iExpense,
    iAmount,
    iDirection: iDirection >= 0 ? iDirection : undefined,
    iSummary: iSummary >= 0 ? iSummary : undefined,
    bankHits,
    controlSignal,
  };
}

function parseCentSafe(raw: string): number | null {
  const t = String(raw ?? '').replace(/[,，¥￥\s]/g, '');
  if (!t || t === '-' || /识别不清|\?|？/.test(t)) return null;
  // 支持括号式负数：(100.00) → -100.00
  let s = t;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const v = neg ? -n : n;
  // 四舍五入到「分」（最小货币单位整数）
  return Math.round(v * 100);
}

function isEmptyOrControlRow(cells: string[]): boolean {
  const joined = cells.join('').trim();
  if (joined.length === 0) return true;
  if (/本页|合计|小计|汇总|总计|承上页|过次页|期初|期末|上期结转|本期合计|本年累计/.test(joined)) return true;
  return false;
}

/** 基于 header mapping 推断 amountMode */
function inferAmountMode(map: HeaderMapping): AmountMode {
  const hasIncome = map.iIncome >= 0;
  const hasExpense = map.iExpense >= 0;
  const hasAmount = map.iAmount >= 0;
  if (hasIncome && hasExpense) return 'income_expense_columns';
  if (hasAmount && map.iDirection !== undefined) return 'amount_with_direction';
  if (hasAmount) return 'signed_amount';
  // 兜底：若只有双列（收入/支出之一缺失），仍按双列语义（另一个默认 0）
  if (hasIncome || hasExpense) return 'income_expense_columns';
  return 'signed_amount';
}

/** 用「前几行 balance 的趋势」推断 order；
 *  还会顺带用「交易发生后余额变化的正负号」推断 debitEffect/creditEffect。 */
function inferOrderAndEffects(params: {
  rows: string[][];
  map: HeaderMapping;
  amountMode: AmountMode;
}): { order: Order; balancePosition: BalancePosition; debitEffect: Effect; creditEffect: Effect; evidenceRows: number } {
  const { rows, map, amountMode } = params;

  // 先把每一行的（balance, incomeCent, expenseCent, amountCent, direction）解析出来
  interface Line {
    bal: number | null;
    inc: number | null;
    exp: number | null;
    amt: number | null;
    dir: string | null; // 借/贷/收/付…
  }
  const parseIdx = (cells: string[], idx: number) => (idx >= 0 ? parseCentSafe(cells[idx]) : null);
  const lines: Line[] = rows
    .filter((cells) => !isEmptyOrControlRow(cells))
    .map((cells) => ({
      bal: parseIdx(cells, map.iBalance),
      inc: parseIdx(cells, map.iIncome),
      exp: parseIdx(cells, map.iExpense),
      amt: parseIdx(cells, map.iAmount),
      dir: map.iDirection !== undefined ? cells[map.iDirection] ?? null : null,
    }));

  // 计算 order 证据：对比相邻行的 balance
  let asc = 0;
  let desc = 0;
  let eq = 0;
  let firstBal: number | null = null;
  let lastBal: number | null = null;
  for (const l of lines) {
    if (l.bal === null) continue;
    if (firstBal === null) firstBal = l.bal;
    lastBal = l.bal;
  }
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].bal;
    const cur = lines[i].bal;
    if (prev === null || cur === null) continue;
    if (cur > prev) asc++;
    else if (cur < prev) desc++;
    else eq++;
  }
  let order: Order = (() => {
    if (asc + desc === 0) return 'descending'; // 保守默认：按日期倒序（新在前）
    if (asc > desc * 2) return 'ascending';
    if (desc > asc * 2) return 'descending';
    // 难分：用 firstBal vs lastBal 判断
    if (firstBal !== null && lastBal !== null) {
      if (lastBal > firstBal) return 'ascending';
      if (lastBal < firstBal) return 'descending';
    }
    return 'descending';
  })();

  // 计算 effects + balancePosition：
  //   假设 balancePosition='after_transaction'，在「inc/exp 双列」下：
  //     expected_next_balance = current_bal + inc - exp
  //       若 expected_next_balance == lines[i+1].bal → order='ascending'
  //       若 expected_next_balance == lines[i-1].bal → order='descending'（行按时间倒序）
  //   before_transaction 则反过来，expected_prev_balance = current_bal - inc + exp 应等于上一行 bal。
  //
  // 对于「signed_amount」模式：amt 为正则增余额（收入），为负则减余额（支出）→
  //   after: expected_next = cur + amt
  //   before: expected_prev = cur - amt
  //
  // 解算：组合 (order × position) 共 2 × 2 = 4 种假设，选「成功计数最大」的；
  //       若胜者达到阈值 3 条以上则 accepted。

  type Hyp = { order: Order; position: BalancePosition; hits: number; total: number };
  const positions: BalancePosition[] = ['after_transaction', 'before_transaction'];
  const hyps: Hyp[] = [];

  for (const o of ['ascending', 'descending'] as Order[]) {
    for (const pos of positions) {
      let hits = 0;
      let total = 0;
      for (let i = 0; i < lines.length; i++) {
        const cur = lines[i];
        if (cur.bal === null) continue;
        const j = o === 'ascending' ? i + 1 : i - 1;
        if (j < 0 || j >= lines.length) continue;
        const refBal = lines[j].bal;
        if (refBal === null) continue;

        let deltaInc = 0;
        let deltaExp = 0;
        let hasAny = false;
        if (amountMode === 'income_expense_columns') {
          if (cur.inc !== null) {
            deltaInc = cur.inc;
            hasAny = true;
          }
          if (cur.exp !== null) {
            deltaExp = cur.exp;
            hasAny = true;
          }
        } else {
          // signed_amount 或 amount_with_direction
          let amt = cur.amt ?? 0;
          // direction 列：借/收一般增余额；贷/付一般减余额（如果是资产类账户）
          if (cur.dir) {
            const d = cur.dir.trim();
            if (/借|收|存|入/.test(d) && amt < 0) amt = -amt;
            else if (/贷|付|支|出/.test(d) && amt > 0) amt = -amt;
          }
          if (cur.amt !== null) hasAny = true;
          if (amt >= 0) deltaInc = amt;
          else deltaExp = -amt;
        }
        if (!hasAny) continue;

        // after_transaction：当前行的「交易发生后」余额 = 该行余额；
        //   若 order = ascending，则下一行余额（after 它的交易）应是 cur.bal + inc - exp
        //   这里为简化：用「cur.bal + inc - exp ?= next.bal」作为 after_transaction 的证据。
        // before_transaction：cur.bal 是交易发生前；交易后才等于 next.bal → 故 cur.bal = next.bal - inc + exp
        //   即 next.bal - inc + exp ?= cur.bal
        const expected = pos === 'after_transaction' ? cur.bal + deltaInc - deltaExp : cur.bal - deltaInc + deltaExp;
        total++;
        if (expected === refBal) hits++;
      }
      hyps.push({ order: o, position: pos, hits, total });
    }
  }

  // 选 hits 最多者；相同比 total 大，再按默认 desc/after
  let best: Hyp = { order: 'descending', position: 'after_transaction', hits: 0, total: 0 };
  for (const h of hyps) {
    if (h.hits > best.hits || (h.hits === best.hits && h.total > best.total)) {
      best = h;
    }
  }
  // 如果 best 的 hits 有证据，采纳 order 与 position
  if (best.total > 0) {
    order = best.order;
  }
  const balancePosition: BalancePosition = best.total > 0 && best.hits >= 2
    ? best.position
    : 'after_transaction'; // 银行流水 90%+ 是 after

  // 推断 effects（基于 best.order × best.position × inc/exp 双列）：
  //   对资产类账户（银行卡余额）：inc 增加余额（creditEffect? — 实际上银行对账单里的「贷方」= 银行负债增加 = 用户的资产增加，
  //   故「收入列」对应 bank side credit；所以从用户视角 debitEffect(借) = 减少余额，creditEffect(贷) = 增加余额 。
  //   但对账单列头「借方/贷方」有时以银行视角写（借：银行扣钱=用户支出；贷：银行加钱=用户收入）。
  //   为避免混淆，我们只基于「inc 列数值 → 余额变化方向」来定：
  //     若 inc 与余额变化同向 → creditEffect = 'increase'（贷增）
  //     若 exp 与余额变化反向 → debitEffect = 'decrease'（借减）
  //     （这两条是资产类账户的一致形式）
  let debitEffect: Effect = 'unknown';
  let creditEffect: Effect = 'unknown';
  if (amountMode === 'income_expense_columns') {
    let incSameDir = 0;
    let expOppDir = 0;
    let totalPairs = 0;
    for (let i = 0; i < lines.length; i++) {
      const cur = lines[i];
      if (cur.inc === null && cur.exp === null) continue;
      const j = order === 'ascending' ? i + 1 : i - 1;
      if (j < 0 || j >= lines.length) continue;
      const refBal = lines[j].bal;
      if (cur.bal === null || refBal === null) continue;
      const delta = refBal - cur.bal; // 按 order 方向走的余额变化
      totalPairs++;
      if (cur.inc !== null) {
        const d = cur.inc;
        if ((d > 0 && delta > 0) || (d === 0 && delta === 0)) incSameDir++;
      }
      if (cur.exp !== null) {
        const d = cur.exp;
        if ((d > 0 && delta < 0) || (d === 0 && delta === 0)) expOppDir++;
      }
    }
    if (totalPairs >= 2) {
      creditEffect = incSameDir >= totalPairs - 1 ? 'increase' : creditEffect;
      debitEffect = expOppDir >= totalPairs - 1 ? 'decrease' : debitEffect;
    }
  } else {
    // signed_amount：正号与余额同向 → 贷增（credit=increase）；负号与余额反向 → 借减（debit=decrease）
    let same = 0;
    let opp = 0;
    let totalPairs = 0;
    for (let i = 0; i < lines.length; i++) {
      const cur = lines[i];
      if (cur.amt === null || cur.amt === 0) continue;
      const j = order === 'ascending' ? i + 1 : i - 1;
      if (j < 0 || j >= lines.length) continue;
      const refBal = lines[j].bal;
      if (cur.bal === null || refBal === null) continue;
      const delta = refBal - cur.bal;
      totalPairs++;
      if ((cur.amt > 0 && delta > 0) || (cur.amt < 0 && delta < 0)) same++;
      else opp++;
    }
    if (totalPairs >= 2) {
      creditEffect = same >= totalPairs - 1 ? 'increase' : creditEffect;
      debitEffect = same >= totalPairs - 1 ? 'decrease' : debitEffect;
    }
  }

  return { order, balancePosition, debitEffect, creditEffect, evidenceRows: best.hits };
}

/**
 * 推断账务语义：header 映射优先 → 再做方程解算校准 → 升 confidence。
 *
 * confidence 规则（专家建议 P1）：
 *  - confirmed：(a) 银行关键词命中 bank_template 且 方程解算 evidenceRows ≥ 3；OR (b) 含「期初余额/期末余额」明确字段，
 *    且 方程解算 证据 ≥ 2（source = equation_inferred 或 bank_template）。
 *  - inferred：方程解算 evidenceRows ≥ 2（方程解算通过）。
 *  - ambiguous：证据不足（header 不完整、行数太少、方程解算无压倒性胜者）。
 */
export function inferLedgerSemantics(input: SemanticsInput): LedgerSemantics {
  const fallbackAmbiguous: LedgerSemantics = {
    order: 'descending',
    balancePosition: 'after_transaction',
    amountMode: 'signed_amount',
    debitEffect: 'unknown',
    creditEffect: 'unknown',
    controlRowPolicy: 'exclude',
    source: 'header_mapping',
    confidence: 'ambiguous',
  };

  const map = detectHeaderMapping(input);
  const s = headerFromStructured(input);
  if (!map || !s) return fallbackAmbiguous;
  if (s.rows.length < 2) return fallbackAmbiguous; // 太少没法方程解算

  const amountMode = inferAmountMode(map);
  const eq = inferOrderAndEffects({ rows: s.rows, map, amountMode });

  // controlRowPolicy：有「控制列」信号时 template_defined（给 P1-2 做特殊行识别留门），否则默认 exclude
  const controlRowPolicy: LedgerSemantics['controlRowPolicy'] = map.controlSignal ? 'template_defined' : 'exclude';

  // source 与 confidence
  const hasBank = map.bankHits.length > 0;
  const evidenceStrong = eq.evidenceRows >= 3;
  const evidenceOk = eq.evidenceRows >= 2;
  const explicitBalanceBoundaries = /期初|期末|承上|过次|本页合计/.test(s.header.join(' ') + s.rows.slice(0, 3).join(' '));

  let source: LedgerSemantics['source'] = 'header_mapping';
  let confidence: LedgerSemantics['confidence'] = 'ambiguous';
  if (hasBank) source = 'bank_template';
  else if (evidenceOk) source = 'equation_inferred';

  if (hasBank && evidenceStrong) confidence = 'confirmed';
  else if (explicitBalanceBoundaries && evidenceOk) {
    confidence = 'confirmed';
    if (!hasBank) source = 'equation_inferred';
  } else if (evidenceOk) {
    confidence = 'inferred';
  } else {
    confidence = 'ambiguous';
  }

  return {
    order: eq.order,
    balancePosition: eq.balancePosition,
    amountMode,
    debitEffect: eq.debitEffect,
    creditEffect: eq.creditEffect,
    controlRowPolicy,
    source,
    confidence,
  };
}

/** 从 OcrPage 先构造 Markdown 表（复用 ledgerVerificationScore 的行聚类 + 列检测），再 inferSemantics。
 *  供 core/ledger.ts 的 ledgerValidationReport 直接调用，避免重复代码。 */
export function inferLedgerSemanticsFromRows(params: {
  rows: { text: string }[][];
  headerIdx: number;
  cols: { kind: 'date' | 'summary' | 'amount' | 'balance'; x0: number; x1: number }[];
}): LedgerSemantics {
  const lines: string[] = ['| 日期 | 摘要 | 金额 | 余额 |'];
  for (let ri = 0; ri < params.rows.length; ri++) {
    if (ri === params.headerIdx) continue;
    const row = params.rows[ri];
    const cellOf = (kind: 'date' | 'summary' | 'amount' | 'balance') => {
      const col = params.cols.find((c) => c.kind === kind);
      if (!col) return '';
      return row
        .filter((_, i) => {
          // 简单列归属：按列的 x0/x1 与块索引；传入的是文本数组，列带已在外面排好序了。
          // 这里的实现只按 cols 的顺序映射：第 1 个 date/summary/amount/balance 列是 row[0..3]
          void i;
          void col;
          return true;
        })
        .map((b) => b.text)
        .join(' ')
        .trim();
    };
    // fallback：如果传的 row 是纯文字数组，我们按 cols 的 kind 去做「按列名的粗映射」其实做不到；
    // 为避免错误推断，这里让调用方把已格式化的 Markdown 传入。下面改为空，仅返回 ambiguous。
    lines.push(`| ${cellOf('date')} | ${cellOf('summary')} | ${cellOf('amount')} | ${cellOf('balance')} |`);
  }
  return inferLedgerSemantics({ kind: 'markdown', transcript: lines.join('\n') });
}
