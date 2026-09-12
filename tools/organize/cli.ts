/**
 * 文件自动整理 CLI —— 就地整理：在目标目录内建分类子文件夹，把文件改名后移进去。
 *
 * 用法：
 *   tsx tools/organize/cli.ts [目录] [选项]
 *
 * 目录可缺省：缺省时读取设置里的「File Organizer → 投递箱目录」，
 * 分类清单同样来自设置（未配置则用内置默认分类）。
 *
 * 选项：
 *   --apply          真正执行（默认只预览，绝不动文件）
 *   --watch          常驻监听，放入文件即自动整理（等价于 --apply + 监听）
 *   --undo           按 _整理日志.json 回滚
 *   --model <p:m>    指定模型，如 deepseek:deepseek-flash
 *   --help
 *
 * 整理流程（扫描 / 规划 / 落盘）复用 core.ts，与应用运行期的常驻监听
 * （src/lib/file-organizer/watcher.ts）保持同一套实现。
 */
import { promises as fs, watch } from 'fs';
import { isAbsolute, join, resolve } from 'path';

import { CATEGORIES, normalizeCategories } from './model';
import { readSettingsFromFile } from '@/lib/settings-server';
import { LOG_NAME, appendLog, todayStamp, undo, type MoveRecord } from './naming';
import { SETTLE_MS, commitPlan, scanAndPlan } from './core';

/** 监听模式的事件防抖窗口（毫秒） */
const DEBOUNCE_MS = 2500;

/* ==================== 输出美化 ==================== */

/** 显示宽度：CJK / 全角按 2 列计 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe10-\ufe19\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - width(s)));
}

function truncate(s: string, n: number): string {
  return width(s) <= n ? s : s.slice(0, n - 1) + '…';
}

/* ==================== 参数 ==================== */

/** 命令行解析结果：root 可缺省，缺省时回退设置里的投递箱目录 */
interface ParsedArgs {
  rootArg?: string;
  apply: boolean;
  watch: boolean;
  undo: boolean;
  model?: string;
}

/** 本次运行的全部入参：目录与分类清单均已解析完成 */
interface Args extends ParsedArgs {
  root: string;
  categories: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let apply = false;
  let watching = false;
  let doUndo = false;
  let model: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--watch') { watching = true; apply = true; }
    else if (a === '--undo') doUndo = true;
    else if (a === '--model') model = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a.startsWith('-')) { console.error(`未知选项：${a}`); printHelp(); process.exit(1); }
    else positional.push(a);
  }
  if (positional.length > 1) { printHelp(); process.exit(1); }
  const rootArg = positional[0]
    ? (isAbsolute(positional[0]) ? positional[0] : resolve(process.cwd(), positional[0]))
    : undefined;
  return { rootArg, apply, watch: watching, undo: doUndo, model };
}

function printHelp(): void {
  console.log(`文件自动整理 —— 就地建分类子文件夹，文件改名后移入

用法：
  tsx tools/organize/cli.ts [目录] [选项]

选项：
  --apply          真正执行（默认只预览，绝不动文件）
  --watch          常驻监听，放入文件即自动整理
  --undo           按 ${LOG_NAME} 回滚
  --model <p:m>    指定模型，如 deepseek:deepseek-flash

目录缺省时读取设置的「File Organizer → 投递箱目录」。
命名规则：{日期}_{版本号}_{主题}.{扩展名}   如 2026-09-12_v01_房屋租赁合同.pdf
分类枚举：内置默认 ${CATEGORIES.join(' / ')}（可在设置中自定义）`);
}

/* ==================== 核心流程 ==================== */

/** 跑一轮：扫描 → 规划 → 打印 → （可选）落盘。返回因仍在写入而跳过、需重试的文件数 */
async function runOnce(args: Args, settle: boolean): Promise<number> {
  const { root, apply, model } = args;
  const stamp = todayStamp();
  const { plans, total, writing } = await scanAndPlan({
    root,
    categories: args.categories,
    stamp,
    model,
    settle,
  });
  if (total === 0) {
    console.log(`（${root} 下没有待整理的文件）`);
    return 0;
  }

  console.log(`\n目录：${root}`);
  console.log(`日期：${stamp}　模式：${apply ? '执行' : '预览（不改动任何文件）'}\n`);
  for (const name of writing) console.log(`· 跳过（文件仍在写入）：${name}`);

  const rows: string[][] = [];
  const records: MoveRecord[] = [];
  for (const p of plans) {
    const targetAbs = join(p.targetDir, p.targetName);
    rows.push([
      truncate(p.from.slice(root.length + 1), 30),
      truncate(targetAbs.slice(root.length + 1), 48),
      `${Math.round(p.confidence * 100)}%`,
      p.note,
    ]);

    if (apply) records.push(await commitPlan(p));
  }

  const header = ['原文件', '整理为', '置信度', '备注'];
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))) + 2);
  console.log(header.map((h, i) => pad(h, widths[i])).join(''));
  console.log(widths.map((w) => '-'.repeat(w - 1)).join(' '));
  for (const r of rows) console.log(r.map((c, i) => pad(c, widths[i])).join(''));

  if (apply && records.length > 0) {
    await appendLog(root, records);
    console.log(`\n已整理 ${records.length} 个文件（日志：${LOG_NAME}，可用 --undo 回滚）`);
  } else if (!apply) {
    console.log(`\n预览结束 —— 共 ${plans.length} 个文件。确认无误后加 --apply 执行。`);
  } else {
    console.log('\n没有可执行的文件。');
  }
  return writing.length;
}

/** 监听模式：放入文件 → 防抖 → 整理一轮；未写入完成的文件稍后自动重试 */
async function runWatch(args: Args): Promise<void> {
  console.log(`监听中：${args.root}（放入文件后自动整理，Ctrl+C 退出）`);

  let timer: NodeJS.Timeout | null = null;
  let busy = false;

  function schedule(ms: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), ms);
  }

  async function tick(): Promise<void> {
    if (busy) return; // 上一轮未跑完，本轮事件丢弃（后续事件会再触发）
    busy = true;
    let pending = 0;
    try {
      pending = await runOnce(args, true);
    } catch (e) {
      console.error('整理出错：', (e as Error)?.message || e);
    } finally {
      busy = false;
    }
    if (pending > 0) schedule(SETTLE_MS); // 仍有文件在写入 → 等静置窗口后再来一轮
  }

  await tick();
  watch(args.root, { persistent: true }, () => schedule(DEBOUNCE_MS));
}

/* ==================== 入口 ==================== */

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  // 目录与分类清单都来自设置（目录可用位置参数覆盖）
  const settings = await readSettingsFromFile();
  const fileOrg = settings.fileOrganizer ?? {};
  const rootRaw = parsed.rootArg ?? (fileOrg.inboxDir ?? '').trim();
  if (!rootRaw) {
    console.error('未指定目录，且设置里也未配置投递箱目录。\n'
      + '请在 BobWork「设置 → File Organizer」中配置投递箱目录，或直接传入目录：\n'
      + '  tsx tools/organize/cli.ts <目录>');
    process.exit(1);
  }
  const root = isAbsolute(rootRaw) ? rootRaw : resolve(process.cwd(), rootRaw);
  const args: Args = { ...parsed, root, categories: normalizeCategories(fileOrg.categories) };

  const st = await fs.stat(args.root).catch(() => null);
  if (!st?.isDirectory()) {
    console.error(`目录不存在或不是目录：${args.root}`);
    process.exit(1);
  }

  if (args.undo) {
    const { restored, skipped } = await undo(args.root);
    console.log(`回滚完成：已还原 ${restored} 个，跳过 ${skipped} 个（原位置已被占用）。`);
    return;
  }

  if (args.watch) {
    await runWatch(args);
    return;
  }

  await runOnce(args, false);
}

main().catch((e) => {
  console.error('执行失败：', (e as Error)?.stack || e);
  process.exit(1);
});
