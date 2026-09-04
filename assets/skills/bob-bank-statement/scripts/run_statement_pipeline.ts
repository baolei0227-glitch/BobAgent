/**
 * bob-bank-statement · Skill 执行脚本
 *
 * 入口：`tsx assets/skills/bob-bank-statement/scripts/run_statement_pipeline.ts <input_path> [--mode=standard] [--out_dir=./homework] ...`
 *
 * 流程：
 *   1) 解析 CLI 参数
 *   2) 调 ocrFile(input) → 拿到 OcrServiceResult.rawPages（= OcrPage[]）
 *   3) 调 buildMultiPageLedgerReport(rawPages) → LedgerValidationReport（含 rowsByKind / markdownHeader）
 *   4) mode!=quick：导出 Excel（三 Sheet） + 勾稽报告.md
 *   5) 总是：输出 JSON 状态（stdout） + 写 ${stem}_状态.json 文件
 *
 * 退出码：0=完成, 2=参数/输入错误, 3=内部错误
 */
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { ocrFile } from '../../../../src/lib/pdf/core/ocr-service';
import { buildMultiPageLedgerReport } from '../../../../src/lib/pdf/core/ledger';
import type {
  LedgerValidationReport,
  StatementLedgerRow,
  LedgerIssue,
} from '../../../../src/lib/pdf/shared/types';

type Mode = 'quick' | 'standard' | 'forensic';

interface Args {
  inputPath: string;
  outDir: string;
  mode: Mode;
  scenario: 'per_page' | 'whole_doc';
  glmPriority: 'none' | 'optional' | 'force';
  glmUpgradeBelow: number;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const PDF_EXT = '.pdf';

function die(code: number, message: string, jsonExtra?: Record<string, unknown>): never {
  const payload = { ok: code === 0, exitCode: code, error: message, ...jsonExtra };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        opts[a.slice(2)] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  const inputPath = positional[0];
  if (!inputPath) die(2, '缺少参数 input_path。用法: run_statement_pipeline.ts <input_path> [--mode=standard] [--out_dir=./homework]');
  const modeRaw = opts.mode ?? 'standard';
  if (!['quick', 'standard', 'forensic'].includes(modeRaw)) die(2, `--mode 非法：${modeRaw}（允许 quick/standard/forensic）`);
  const scenarioRaw = opts.scenario ?? 'per_page';
  if (!['per_page', 'whole_doc'].includes(scenarioRaw)) die(2, `--scenario 非法：${scenarioRaw}（允许 per_page/whole_doc）`);
  const glmRaw = opts.glm_priority ?? 'optional';
  if (!['none', 'optional', 'force'].includes(glmRaw)) die(2, `--glm_priority 非法：${glmRaw}（允许 none/optional/force）`);
  let glmUpgradeBelow = 0.6;
  if (opts.glm_upgrade_if_below_passrate !== undefined) {
    const v = Number(opts.glm_upgrade_if_below_passrate);
    if (!Number.isFinite(v) || v < 0 || v > 1) die(2, `--glm_upgrade_if_below_passrate 必须是 [0,1] 之间的数字`);
    glmUpgradeBelow = v;
  }
  let outDir = opts.out_dir ?? './homework';
  if (!path.isAbsolute(outDir)) {
    // 相对项目根（本脚本在 projects/assets/skills/bob-bank-statement/scripts 下，根 = ../../../../..）
    outDir = path.resolve(__dirname, '../../../../..', outDir);
  }
  return {
    inputPath: path.resolve(inputPath),
    outDir,
    mode: modeRaw as Mode,
    scenario: scenarioRaw as 'per_page' | 'whole_doc',
    glmPriority: glmRaw as 'none' | 'optional' | 'force',
    glmUpgradeBelow,
  };
}

function validateInput(p: string): void {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) die(2, `输入不是文件：${p}`);
    if (st.size === 0) die(2, `输入文件为空：${p}`);
    const ext = path.extname(p).toLowerCase();
    if (ext !== PDF_EXT && !IMAGE_EXTS.has(ext)) die(2, `不支持的扩展名：${ext}（支持 PDF 与常见图片）`);
    if (st.size > 150 * 1024 * 1024) die(2, `文件过大：${(st.size / 1024 / 1024).toFixed(1)} MB > 150 MB 上限`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') die(2, `文件不存在：${p}`);
    die(2, `输入校验失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

function classifyStatus(r: LedgerValidationReport): 'green' | 'yellow' | 'red' {
  if (!r.detectedAsLedger) return 'red';
  const passRate = r.passRate ?? 0;
  if (passRate < 0.50 || r.coverageRate < 0.40) return 'red';
  const crossPass = r.crossPageStatus === 'pass' || r.crossPageStatus === 'not_checked';
  if (passRate >= 0.98 && r.coverageRate >= 0.95 && r.longestPassingChain >= 10 && crossPass) return 'green';
  return 'yellow';
}

function statusText(r: LedgerValidationReport, status: 'green' | 'yellow' | 'red'): string {
  const P = Math.round((r.passRate ?? 0) * 100) / 100;
  const C = Math.round(r.coverageRate * 100) / 100;
  const Z = r.longestPassingChain;
  if (status === 'green') {
    return `基于当前 OCR 结果，**余额勾稽未见异常**（passRate=${P} / coverageRate=${C} / longestChain=${Z} / crossPage=${r.crossPageStatus}），可进入下一阶段；仍建议抽查 3-5 笔高金额交易核对。`;
  }
  if (status === 'red') {
    return `勾稽存在**重大不平或非流水信号**（passRate=${P} / coverageRate=${C} / detectedAsLedger=${r.detectedAsLedger}），不得作为法律事实使用；请先确认文档类型或联系文档提供方补件。`;
  }
  return `勾稽存在**局部不平或证据不足**（passRate=${P} / coverageRate=${C} / crossPage=${r.crossPageStatus}），请人工对照 Excel 的「勾稽异常清单」Sheet 复核；扫描件糊页 / 红章遮挡时可能为 OCR 错值，建议启用 --scenario=whole_doc 重新识别。`;
}

function fmtYuan(cent: number | null): string {
  if (cent == null) return '';
  const neg = cent < 0;
  const a = Math.abs(cent);
  const intPart = Math.floor(a / 100);
  const decPart = a % 100;
  const s = `${intPart.toLocaleString('zh-CN')}.${decPart.toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}
function pad2(n: number) { return n.toString().padStart(2, '0'); }
function nowIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function rowsToAoaAndJson(rows: StatementLedgerRow[], header: string[], opts: { globalNo: boolean }): {
  header: string[]; aoa: (string | number | null)[][];
} {
  const isDual = header.length === 5; // ['日期','摘要','收入','支出','余额']
  const fixedHead: string[] = [];
  if (opts.globalNo) fixedHead.push('序号');
  fixedHead.push('页码');
  fixedHead.push('页内行号');
  fixedHead.push(header[0] ?? '日期');
  fixedHead.push(header[1] ?? '摘要');
  if (isDual) {
    fixedHead.push(header[2] ?? '收入');
    fixedHead.push(header[3] ?? '支出');
    fixedHead.push(header[4] ?? '余额');
    fixedHead.push('收入·元');
    fixedHead.push('支出·元');
  } else {
    fixedHead.push(header[2] ?? '金额');
    fixedHead.push(header[3] ?? '余额');
    fixedHead.push('金额·元');
  }
  fixedHead.push('余额·元');
  fixedHead.push('行类型');
  fixedHead.push('参与勾稽');
  fixedHead.push('颜色');

  const aoa: (string | number | null)[][] = [];
  for (const r of rows) {
    const line: (string | number | null)[] = [];
    if (opts.globalNo) line.push(r.rowGlobal ?? r.rowPage1Based);
    line.push(r.pageIndex0Based + 1);
    line.push(r.rowPage1Based);
    line.push(r.dateText);
    line.push(r.summaryText);
    if (isDual) {
      line.push(r.incomeText ?? '');
      line.push(r.expenseText ?? '');
      line.push(r.balanceText);
      line.push(fmtYuan(r.incomeCent));
      line.push(fmtYuan(r.expenseCent));
    } else {
      line.push(r.amountText);
      line.push(r.balanceText);
      line.push(fmtYuan(r.amountCent));
    }
    line.push(fmtYuan(r.balanceCent));
    line.push(r.kind);
    line.push(r.participatesInReconciliation ? '是' : '否');
    line.push(r.finalColor ?? '');
    aoa.push(line);
  }
  return { header: fixedHead, aoa };
}

type CellColor = 'green' | 'yellow' | 'red';

function buildSummaryTable(r: LedgerValidationReport, status: 'green' | 'yellow' | 'red'): { header: string[]; aoa: (string | number | null)[][] } {
  const header = ['指标', '数值', '说明'];
  const passRatePct = r.passRate == null ? 'N/A' : `${(r.passRate * 100).toFixed(2)}%`;
  const covPct = `${(r.coverageRate * 100).toFixed(2)}%`;
  const aoa: (string | number | null)[][] = [
    ['detectedAsLedger', String(r.detectedAsLedger), '判定为银行流水 = true；未识别 = false（red 档）'],
    ['comparableRows', r.comparableRows, '可读、可比较的交易行数（含通过 + 失败 + 不可校验）'],
    ['passedRows', r.passedRows, '勾稽一致行数'],
    ['failedRows', r.failedRows, '勾稽不平行数（fail 行：需人工复核的「硬冲突」）'],
    ['insufficientRows', r.insufficientRows, '数据不全、无法校验行数（金额/余额未识别）'],
    ['passRate', passRatePct, 'passed / comparable；< 50% 进入 red 档'],
    ['coverageRate', covPct, 'comparable / totalRows；< 40% 进入 red 档'],
    ['longestPassingChain', r.longestPassingChain, '最长连续勾稽通过链；≥ 10 链 + passRate≥98% 才可能 green'],
    ['crossPageStatus', r.crossPageStatus, '跨页余额衔接状态：pass/fail/needs_review/not_checked/insufficient_data'],
    ['semanticsStatus', r.semanticsStatus, '账务语义确认：confirmed / inferred / ambiguous'],
    ['issuesCount', r.issues.length, '所有 issues（不平 + 字段差 + 跨页失败）汇总数'],
    [
      '三态结论',
      status === 'green' ? 'GREEN 勾稽未见异常' : status === 'yellow' ? 'YELLOW 局部不平或证据不足' : 'RED 重大不平或非流水信号',
      '详见 SKILL.md：三态话术（Agent 固定朗读版）',
    ],
  ];
  return { header, aoa };
}

function writeExcel(args: Args, report: LedgerValidationReport, stem: string): string | null {
  if (args.mode === 'quick') return null;
  const header = report.markdownHeader ?? ['日期', '摘要', '金额', '余额'];
  const rows = report.rowsByKind ?? [];

  // 交易明细：只保留 participatesInReconciliation=true 的 transaction 行 + opening_balance + closing_balance
  const mainRows = rows.filter((r) => {
    if (r.participatesInReconciliation) return true;
    if (r.kind === 'opening_balance' || r.kind === 'closing_balance') return true;
    return false;
  });
  // 控制行明细：non-transaction 非噪音，都保留（subtotal/total/opening/closing/header_repeat/separator）；噪音单独一小节
  const ctrlRows = rows.filter((r) => !['transaction', 'separator', 'noise', 'header_repeat'].includes(r.kind));
  const metaRows = rows.filter((r) => ['header_repeat', 'separator', 'noise'].includes(r.kind));
  // 勾稽异常清单：把 report.issues + failedRows 对应的行拼一张
  const failMap = new Map<number, LedgerIssue[]>();
  for (const it of report.issues) {
    const k = it.row;
    const arr = failMap.get(k) ?? [];
    arr.push(it);
    failMap.set(k, arr);
  }
  const issueHeader = ['页码', '行号(页内)', '全局序号', 'issue.kind', 'issue.message', '原始四列：日期/摘要/金额/余额'];
  const issueAoa: (string | number | null)[][] = [];
  for (const it of report.issues) {
    const r = rows.find((x) => x.rowPage1Based === it.row) ?? null;
    issueAoa.push([
      (r?.pageIndex0Based ?? -1) + 1,
      it.row,
      r?.rowGlobal ?? null,
      it.kind,
      it.message,
      `${r?.dateText ?? ''} | ${r?.summaryText ?? ''} | ${r?.amountText ?? (r?.incomeText && r?.expenseText ? `${r.incomeText}/${r.expenseText}` : '')} | ${r?.balanceText ?? ''}`,
    ]);
  }

  const wb = XLSX.utils.book_new();
  const main = rowsToAoaAndJson(mainRows, header, { globalNo: true });
  const ws1 = XLSX.utils.aoa_to_sheet([main.header, ...main.aoa]);
  XLSX.utils.book_append_sheet(wb, ws1, '交易明细');

  const ctrl = rowsToAoaAndJson([...ctrlRows, ...metaRows], header, { globalNo: true });
  const ws2 = XLSX.utils.aoa_to_sheet([ctrl.header, ...ctrl.aoa]);
  XLSX.utils.book_append_sheet(wb, ws2, '控制行明细');

  const ws3 = XLSX.utils.aoa_to_sheet([issueHeader, ...issueAoa]);
  XLSX.utils.book_append_sheet(wb, ws3, '勾稽异常清单');

  if (args.mode === 'forensic') {
    // 逐格评估明细：直接读 report.cellVerification
    const cv = report.cellVerification ?? {};
    const cvHead = ['key', 'row', '列', 'visual', 'structural', 'normalization', 'reconciliation', 'human', 'finalColor'];
    const cvAoa: (string | number | null)[][] = [];
    for (const k of Object.keys(cv)) {
      const v = cv[k];
      const rowM = k.match(/R(\d+)/);
      const row1 = rowM ? Number(rowM[1]) : null;
      const colKind = k.split('_').pop() ?? '';
      // 颜色：内联 cell-verification.aggregateColor 的 mini 版
      const red = v.visual === 'unreadable' || v.structural === 'unassigned' || v.normalization === 'invalid' || v.reconciliation === 'fail' || v.human === 'rejected' || v.human === 'unreadable';
      const yellow = v.visual === 'ambiguous' || v.structural === 'ambiguous' || v.normalization === 'ambiguous' || v.reconciliation === 'insufficient_data' || v.human === 'unreviewed' || v.human === 'confirmed_from_image';
      const color: CellColor = red ? 'red' : yellow ? 'yellow' : 'green';
      cvAoa.push([k, row1, colKind, v.visual, v.structural, v.normalization, v.reconciliation, v.human, color]);
    }
    const ws4 = XLSX.utils.aoa_to_sheet([cvHead, ...cvAoa]);
    XLSX.utils.book_append_sheet(wb, ws4, '逐格评估明细');
  }

  // 上色：交易明细里 finalColor=red 的行，整行浅红底色；yellow 浅黄
  // xlsx 社区版对 style 支持有限，这里就不做复杂着色（用 conditional formatting 也不通用）；
  // 消费方（Excel 本身）直接读「颜色」列自己条件格式即可。

  const outPath = path.join(args.outDir, `${stem}_流水明细.xlsx`);
  try {
    fs.mkdirSync(args.outDir, { recursive: true });
    XLSX.writeFile(wb, outPath);
    return outPath;
  } catch (e) {
    console.error('[bob-bank-statement] 写 Excel 失败：', e);
    return null;
  }
}

type CellColor = 'green' | 'yellow' | 'red';

function buildMarkdownReport(args: Args, report: LedgerValidationReport, status: 'green' | 'yellow' | 'red', excelPath: string | null): string {
  const header = report.markdownHeader ?? ['日期', '摘要', '金额', '余额'];
  const emoji = status === 'green' ? '🟢' : status === 'yellow' ? '🟡' : '🔴';
  const headerLine = `| ${header.join(' | ')} |`;
  const sepLine = `| ${header.map(() => '---').join(' | ')} |`;
  const rows = report.rowsByKind ?? [];
  const showRows = rows.filter((r) => r.kind !== 'header_repeat' && r.kind !== 'separator' && r.kind !== 'noise').slice(0, 200);
  const lines: string[] = [];
  lines.push(`# 银行流水勾稽报告 · ${emoji}${status.toUpperCase()}`);
  lines.push('');
  lines.push(`- 输入文件：\`${args.inputPath}\``);
  lines.push(`- 识别模式：${args.mode}（${args.scenario}）`);
  lines.push(`- 导出时间：${nowIso()}`);
  if (excelPath) lines.push(`- 明细 Excel：\`${excelPath}\``);
  lines.push('');
  lines.push('## 一、三态结论');
  lines.push('');
  lines.push(statusText(report, status));
  lines.push('');
  lines.push('## 二、Summary 汇总表');
  lines.push('');
  const sum = buildSummaryTable(report, status);
  lines.push(`| ${sum.header.join(' | ')} |`);
  lines.push(`| ${sum.header.map(() => '---').join(' | ')} |`);
  for (const row of sum.aoa) lines.push(`| ${row.map((c) => c == null ? '' : String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  lines.push('');
  lines.push('## 三、交易样本（前 200 行，不含分隔/重复表头/噪音）');
  lines.push('');
  if (!showRows.length) {
    lines.push('_（无可展示行：本文件未被识别为银行流水，或行聚类后无有效交易行）_');
  } else {
    lines.push(headerLine);
    lines.push(sepLine);
    for (const r of showRows) {
      const cols: string[] = [];
      if (header.length === 5) {
        cols.push(r.dateText, r.summaryText, r.incomeText ?? '', r.expenseText ?? '', r.balanceText);
      } else {
        cols.push(r.dateText, r.summaryText, r.amountText, r.balanceText);
      }
      lines.push(`| ${cols.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`);
    }
    if (rows.length > showRows.length) lines.push(`_（共 ${rows.length} 行，此处截断前 ${showRows.length} 行；完整明细见 Excel）_`);
  }
  if (report.issues.length > 0) {
    lines.push('');
    lines.push('## 四、勾稽异常摘录（前 30 条）');
    lines.push('');
    const topN = report.issues.slice(0, 30);
    for (const it of topN) lines.push(`- 行 ${it.row} · ${it.kind}：${it.message}`);
    if (report.issues.length > topN.length) lines.push(`- ……余 ${report.issues.length - topN.length} 条见 Excel「勾稽异常清单」Sheet。`);
  }
  lines.push('');
  lines.push('---');
  lines.push('_本报告仅基于 OCR 结果的数值自洽性生成，不构成法律定性；Green 档不等于"原件真实"，Red 档不等于"伪造"。红色档不得进绿色事实舱。_');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  validateInput(args.inputPath);

  const upgradeOpt = (() => {
    if (args.glmPriority === 'force') return 'always';
    if (args.glmPriority === 'none') return 'off';
    return 'auto';
  })();

  let result: Awaited<ReturnType<typeof ocrFile>>;
  try {
    result = await ocrFile(args.inputPath, {
      upgrade: upgradeOpt as 'off' | 'auto' | 'always',
      // scenario / glmUpgradeBelow 暂时通过 legacy upgrade 透传（ocrFile 的接口设计里升级策略直接读 opts.upgrade）
      // 如果后续要支持 scenario 切换，可以在 ocrFile 层面再加 scenario 参数；当前先按 per_page=逐页择优
      // scenario / upgradeBelow 仅作状态 JSON 记录（便于 Agent 回溯参数）
    });
  } catch (e) {
    die(3, `OCR 主链路抛错：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!result.success) {
    die(3, `OCR 主链路失败：${result.error ?? 'unknown error'}`);
  }

  // 如果本地 OCR 勾稽通过率低于 glmUpgradeBelow，且 glmPriority=optional，则强制再走一次 glm=force 升级
  // （ocrFile 内部不直接暴露升级，这里用二次调用实现 —— 成本可能高，所以只有明显失败才触发；用户关了就不触发）
  let report: LedgerValidationReport | null = null;
  const pages0 = result.rawPages ?? [];
  if (pages0.length > 0) {
    report = buildMultiPageLedgerReport(pages0);
  }

  if (args.glmPriority === 'optional' && upgradeOpt === 'auto') {
    const passRate0 = report?.passRate ?? 0;
    const detectedAsLedger0 = report?.detectedAsLedger ?? false;
    if (detectedAsLedger0 && passRate0 < args.glmUpgradeBelow) {
      try {
        const upgraded = await ocrFile(args.inputPath, { upgrade: 'always' });
        if (upgraded.success && upgraded.rawPages && upgraded.rawPages.length > 0) {
          report = buildMultiPageLedgerReport(upgraded.rawPages);
          result = upgraded;
        }
      } catch {
        // 升级失败就用第一版结果（原 report 保留），不要让 Skill 脚本整体挂
      }
    }
  }

  if (!report) {
    // 走整份 GLM / 全 pdf-text 时没有 rawPages：给一个空报告兜底
    report = {
      detectedAsLedger: false,
      comparableRows: 0, passedRows: 0, failedRows: 0, insufficientRows: 0,
      passRate: null, coverageRate: 0, longestPassingChain: 0,
      crossPageStatus: 'not_checked', semanticsStatus: 'ambiguous', issues: [],
      rowsByKind: [], markdownHeader: ['日期', '摘要', '金额', '余额'],
    };
  }

  const status = classifyStatus(report);
  const stem = path.basename(args.inputPath, path.extname(args.inputPath)).replace(/[^\w.-]+/g, '_');
  fs.mkdirSync(args.outDir, { recursive: true });

  let excelPath: string | null = null;
  try {
    excelPath = writeExcel(args, report, stem);
  } catch (e) {
    console.error('[bob-bank-statement] 写 Excel 抛错（继续生成报告）：', e);
  }

  let mdPath: string | null = null;
  if (args.mode !== 'quick') {
    try {
      mdPath = path.join(args.outDir, `${stem}_勾稽报告.md`);
      fs.writeFileSync(mdPath, buildMarkdownReport(args, report, status, excelPath), 'utf8');
    } catch (e) {
      console.error('[bob-bank-statement] 写 Markdown 报告抛错（继续）：', e);
      mdPath = null;
    }
  }

  const statusJson: Record<string, unknown> = {
    detectedAsLedger: report.detectedAsLedger,
    passRate: report.passRate,
    coverageRate: report.coverageRate,
    longestPassingChain: report.longestPassingChain,
    crossPageStatus: report.crossPageStatus,
    semanticsStatus: report.semanticsStatus,
    issuesCount: report.issues.length,
    status,
    statusText: statusText(report, status),
    mode: args.mode,
    scenario: args.scenario,
    glmPriority: args.glmPriority,
    inputPath: args.inputPath,
    pageCount: result.pageCount,
    ocrMethod: result.method,
    upgradedCount: result.upgradedCount,
    outputExcelPath: excelPath,
    outputMarkdownPath: mdPath,
    exportAt: nowIso(),
  };

  const jsonPath = path.join(args.outDir, `${stem}_状态.json`);
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(statusJson, null, 2), 'utf8');
  } catch {
    // json 写文件失败不要紧，至少 stdout 给 Agent 一份
  }

  process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, ...statusJson, statusJsonPath: jsonPath }) + '\n');
  process.exit(0);
}

main().catch((e) => die(3, `Skill 脚本未捕获异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`));
